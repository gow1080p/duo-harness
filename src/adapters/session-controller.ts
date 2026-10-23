import * as fs from "node:fs";
import * as path from "node:path";
import type { LlmProvider, SessionEntry } from "../core/contracts.js";
import { runAgentSession, type RunSessionOptions } from "./cli.js";
import { loadAndFormatWireCost } from "./cost-tracker.js";
import {
  type ConversationTurnSummary,
  extractConversationTurns,
  formatRecentHistoryRecap,
  formatSnapshotsDiff,
  loadProjectMeta,
  loadProjectSnapshots,
  type ProjectSessionPaths,
  resolveProjectSessionPaths,
  resolveTargetWorkspace,
  saveProjectMeta,
  saveProjectSnapshots,
} from "./project-store.js";
import { createRouterProvider, type ModelMode, resolveActiveModelTarget } from "./router.js";
import { loadJsonlEntries } from "./store.js";
import { computeTurnMetrics, type FileDiffSummaryItem, summarizeSnapshotsDiff } from "./ui-logger.js";
import { type FileVersionSnapshot, rollbackFileSnapshots } from "./write-tools.js";
import { analyzeSessionXray, formatXrayReport } from "./xray.js";

export interface SessionStatusSummary {
  projectKey: string;
  projectName: string;
  workspaceRoot: string;
  isNew: boolean;
  activeTurnIndex: number | null;
  totalTurns: number;
  leafId: string | null;
  modelMode: ModelMode;
  activeModel: string;
  modelLabel: string;
}

export interface TurnExecutionSummary {
  finalAnswer: string;
  stepsUsed: number;
  leafId: string | null;
  activeModel: string;
  turnCostCny: number;
  totalCostCny: number;
  cacheHitRatePct: number;
  modifiedFiles: FileDiffSummaryItem[];
}

export interface SessionControllerOptions {
  workspaceRoot?: string;
  homeBaseDir?: string;
  provider?: LlmProvider;
}

interface ControllerMutableState {
  paths: ProjectSessionPaths;
  snapshots: FileVersionSnapshot[];
  leafId: string | null;
  modelMode: ModelMode;
  provider: LlmProvider;
  customProvider?: LlmProvider;
  homeBaseDir?: string;
}

function loadDiskEntries(sessionFile: string): SessionEntry[] {
  return fs.existsSync(sessionFile) ? loadJsonlEntries(sessionFile) : [];
}

function syncStateFromDisk(st: ControllerMutableState): SessionEntry[] {
  const entries = loadDiskEntries(st.paths.sessionFile);
  const meta = loadProjectMeta(st.paths.metaFile);
  st.modelMode =
    meta.modelMode === "auto" || meta.modelMode === "deepseek" || meta.modelMode === "mimo" || meta.modelMode === "agy" || meta.modelMode === "openai"
      ? meta.modelMode
      : "auto";
  if (meta.activeLeafId === "__root__") {
    st.leafId = entries[0]?.id ?? null;
  } else if (meta.activeLeafId && entries.some((e) => e.id === meta.activeLeafId)) {
    st.leafId = meta.activeLeafId;
  } else {
    st.leafId = entries.length > 0 ? entries[entries.length - 1]!.id : null;
  }
  st.snapshots = loadProjectSnapshots(st.paths.snapshotsFile);
  return entries;
}

function buildStatusSummary(st: ControllerMutableState): SessionStatusSummary {
  const entries = syncStateFromDisk(st);
  const rootId = entries[0]?.id ?? null;
  const isNew = !st.leafId || st.leafId === rootId || entries.length <= 1;
  const turns = extractConversationTurns(entries, st.leafId);
  const cur = isNew ? undefined : (turns.find((t) => t.isCurrentLeaf) ?? turns[turns.length - 1]);
  const target = resolveActiveModelTarget(st.paths.wireLogFile, !isNew, st.modelMode);
  return {
    projectKey: st.paths.projectKey,
    projectName: path.basename(st.paths.workspaceRoot) || "root",
    workspaceRoot: st.paths.workspaceRoot,
    isNew,
    activeTurnIndex: cur?.turnIndex ?? null,
    totalTurns: turns.length,
    leafId: st.leafId,
    modelMode: st.modelMode,
    activeModel: target.model,
    modelLabel: target.shortLabel,
  };
}

async function executeControllerAsk(st: ControllerMutableState, prompt: string, runOpts: Partial<RunSessionOptions> = {}): Promise<TurnExecutionSummary> {
  syncStateFromDisk(st);
  const meta = loadProjectMeta(st.paths.metaFile);
  const effectivePrompt = meta.lastUndoNotice ? `${prompt}\n\n[系统提示：${meta.lastUndoNotice}，请以磁盘最新文件内容为准]` : prompt;
  saveProjectMeta(st.paths.metaFile, { activeLeafId: null, ...(meta.lastUndoNotice ? { lastUndoNotice: null } : {}) });
  const snapStart = st.snapshots.length;
  const turnId = `turn_${Date.now()}`;
  const persistTurnSnapshots = () => {
    for (let i = snapStart; i < st.snapshots.length; i++) if (!st.snapshots[i]!.turnId) st.snapshots[i]!.turnId = turnId;
    saveProjectSnapshots(st.paths.snapshotsFile, st.snapshots);
  };
  try {
    const res = await runAgentSession(effectivePrompt, {
      ...runOpts,
      workspaceRoot: st.paths.workspaceRoot,
      sessionFile: st.paths.sessionFile,
      wireLogFile: st.paths.wireLogFile,
      leafId: st.leafId ?? undefined,
      provider: runOpts.provider ?? st.provider,
      snapshots: st.snapshots,
      onSnapshotChange: persistTurnSnapshots,
      enableWriteTools: runOpts.enableWriteTools ?? true,
      showCostReport: runOpts.showCostReport ?? false,
    });
    st.leafId = res.leafId;
    saveProjectMeta(st.paths.metaFile, { activeLeafId: res.leafId });
    const turnSnaps = st.snapshots.slice(snapStart);
    persistTurnSnapshots();
    const m = computeTurnMetrics(st.paths.wireLogFile, res.stepsUsed);
    const status = buildStatusSummary(st);
    return {
      finalAnswer: res.finalAnswer,
      stepsUsed: res.stepsUsed,
      leafId: res.leafId,
      activeModel: m?.activeModel ?? status.activeModel,
      turnCostCny: m?.turnCostCny ?? 0,
      totalCostCny: m?.totalCostCny ?? 0,
      cacheHitRatePct: m?.cacheHitRatePct ?? 0,
      modifiedFiles: summarizeSnapshotsDiff(turnSnaps, st.paths.workspaceRoot),
    };
  } finally {
    persistTurnSnapshots();
  }
}

async function executeControllerUndo(st: ControllerMutableState, arg = "turn") {
  syncStateFromDisk(st);
  let stepsBack = 1;
  if (arg === "all") stepsBack = st.snapshots.length;
  else if (arg === "turn" || arg === "") {
    const top = st.snapshots[st.snapshots.length - 1];
    if (top?.turnId) {
      let cnt = 0;
      for (let i = st.snapshots.length - 1; i >= 0 && st.snapshots[i]?.turnId === top.turnId; i--) cnt++;
      stepsBack = Math.max(1, cnt);
    }
  } else {
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 1) return { rolledBackCount: 0, remainingVersions: st.snapshots.length, touchedPaths: [] };
    stepsBack = n;
  }
  const flushSnapshots = () => saveProjectSnapshots(st.paths.snapshotsFile, st.snapshots);
  const rb = await rollbackFileSnapshots(st.paths.workspaceRoot, st.snapshots, stepsBack, flushSnapshots);
  const touchedPaths = [...new Set(rb.touchedPaths)];
  flushSnapshots();
  if (rb.rolledBackCount > 0) saveProjectMeta(st.paths.metaFile, { lastUndoNotice: `用户刚才执行了 /undo，已撤回 ${rb.rolledBackCount} 处文件修改 (${touchedPaths.join(", ")})` });
  return { rolledBackCount: rb.rolledBackCount, remainingVersions: rb.currentVersion, touchedPaths };
}

export function createSessionController(options: SessionControllerOptions = {}) {
  const initialPaths = resolveProjectSessionPaths(options.workspaceRoot, options.homeBaseDir);
  const st: ControllerMutableState = {
    paths: initialPaths,
    snapshots: [],
    leafId: null,
    modelMode: "auto",
    provider: options.provider ?? createRouterProvider(initialPaths.wireLogFile, true, () => st.modelMode),
    customProvider: options.provider,
    homeBaseDir: options.homeBaseDir,
  };
  syncStateFromDisk(st);

  return {
    getPaths: () => st.paths,
    getLeafId: () => st.leafId,
    loadEntries: () => loadDiskEntries(st.paths.sessionFile),
    getStatus: () => buildStatusSummary(st),
    listTurns: (): ConversationTurnSummary[] => extractConversationTurns(syncStateFromDisk(st), st.leafId),
    newSession: (): SessionStatusSummary => {
      st.leafId = loadDiskEntries(st.paths.sessionFile)[0]?.id ?? null;
      saveProjectMeta(st.paths.metaFile, { activeLeafId: "__root__" });
      return buildStatusSummary(st);
    },
    resumeTurn: (rawTarget: string) => {
      const entries = syncStateFromDisk(st);
      const turns = extractConversationTurns(entries, st.leafId);
      const byTurn = turns.find((t) => `#${t.turnIndex}` === rawTarget || String(t.turnIndex) === rawTarget);
      const resolvedId = byTurn ? byTurn.leafEntryId : rawTarget;
      if (!entries.some((e) => e.id === resolvedId)) {
        return { ok: false, error: `未找到轮次或节点 ${rawTarget}，可输入 /resume 用 ↑/↓ 方向键选择。`, status: buildStatusSummary(st), recapText: "" };
      }
      st.leafId = resolvedId;
      saveProjectMeta(st.paths.metaFile, { activeLeafId: resolvedId });
      const snapHint = st.snapshots.length > 0 ? `\n💡 提示：工作区当前有 ${st.snapshots.length} 处未撤回的文件修改（可输入 /diff 查看或 /undo 撤回代码）。` : "";
      return { ok: true, status: buildStatusSummary(st), recapText: `${formatRecentHistoryRecap(entries, 1, st.leafId)}${snapHint}` };
    },
    setModelMode: (mode: ModelMode): SessionStatusSummary => {
      st.modelMode = mode;
      saveProjectMeta(st.paths.metaFile, { modelMode: mode });
      return buildStatusSummary(st);
    },
    getDiff: () => {
      syncStateFromDisk(st);
      return { files: summarizeSnapshotsDiff(st.snapshots, st.paths.workspaceRoot), totalSnapshots: st.snapshots.length, formattedText: formatSnapshotsDiff(st.snapshots, st.paths.workspaceRoot) };
    },
    undo: (arg = "turn") => executeControllerUndo(st, arg),
    switchWorkspace: (targetArg: string) => {
      const candidate = resolveTargetWorkspace(targetArg, st.paths.workspaceRoot, path.dirname(st.paths.projectDir));
      if (!candidate) return { ok: false, error: `未找到项目或目录 "${targetArg}"`, status: buildStatusSummary(st), entryCount: 0, recapText: "" };
      const realCandidate = fs.realpathSync(candidate);
      if (realCandidate === st.paths.workspaceRoot) return { ok: true, alreadyInWorkspace: true, status: buildStatusSummary(st), entryCount: loadDiskEntries(st.paths.sessionFile).length, recapText: "" };
      st.paths = resolveProjectSessionPaths(realCandidate, st.homeBaseDir);
      const entries = syncStateFromDisk(st);
      st.provider = st.customProvider ?? createRouterProvider(st.paths.wireLogFile, entries.length > 0, () => st.modelMode);
      return { ok: true, status: buildStatusSummary(st), entryCount: entries.length, recapText: formatRecentHistoryRecap(entries, 1, st.leafId) };
    },
    clearHistory: (): SessionStatusSummary => {
      for (const f of [st.paths.sessionFile, st.paths.wireLogFile, st.paths.snapshotsFile]) if (fs.existsSync(f)) fs.unlinkSync(f);
      st.leafId = null;
      st.snapshots = [];
      saveProjectMeta(st.paths.metaFile, { activeLeafId: null });
      return buildStatusSummary(st);
    },
    getXrayReport: () => ({ costText: loadAndFormatWireCost(st.paths.wireLogFile), xrayText: formatXrayReport(analyzeSessionXray(st.paths.sessionFile, st.paths.wireLogFile)) }),
    ask: (prompt: string, runOpts: Partial<RunSessionOptions> = {}) => executeControllerAsk(st, prompt, runOpts),
  };
}
export type SessionController = ReturnType<typeof createSessionController>;
