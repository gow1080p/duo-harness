import * as fs from "node:fs";
import * as path from "node:path";
import { estimateMessagesChars, foldSingleMessage } from "../core/compactor.js";
import type { LlmProvider, SessionEntry } from "../core/contracts.js";
import { projectToMessages } from "../core/session-tree.js";
import { runAgentSession, type RunSessionOptions } from "./cli.js";
import { expandAtMentions } from "./context-mention.js";
import { loadAndFormatWireCost } from "./cost-tracker.js";
import { type ConversationTurnSummary, extractConversationTurns, formatRecentHistoryRecap, formatSnapshotsDiff, loadProjectMeta, loadProjectRedoBatches, loadProjectSnapshots, type ProjectSessionPaths, resolveProjectSessionPaths, resolveTargetWorkspace, saveProjectMeta, saveProjectSnapshots } from "./project-store.js";
import { createRouterProvider, listAvailableModelModes, type ModelMode, resolveActiveModelTarget } from "./router.js";
import { appendJsonlEntries, loadJsonlEntries, withSessionLock } from "./store.js";
import { computeTurnMetrics, type FileDiffSummaryItem, summarizeSnapshotsDiff } from "./ui-logger.js";
import { createSandboxGrants, type SandboxGrants } from "./sandbox-policy.js";
import { type FileVersionSnapshot, redoFileSnapshots, rollbackFileSnapshots, rollbackFileSnapshotsSync } from "./write-tools.js";
import { analyzeSessionXray, formatXrayReport } from "./xray.js";

export interface SessionStatusSummary {
  projectKey: string; projectName: string; workspaceRoot: string; isNew: boolean;
  activeTurnIndex: number | null; totalTurns: number; leafId: string | null;
  modelMode: ModelMode; activeModel: string; modelLabel: string;
}

export interface TurnExecutionSummary {
  finalAnswer: string; stepsUsed: number; leafId: string | null; activeModel: string;
  turnCostCny: number; totalCostCny: number; cacheHitRatePct: number; modifiedFiles: FileDiffSummaryItem[];
}

export interface SessionControllerOptions {
  workspaceRoot?: string; homeBaseDir?: string; provider?: LlmProvider;
}

interface ControllerMutableState {
  paths: ProjectSessionPaths; snapshots: FileVersionSnapshot[]; redoBatches: FileVersionSnapshot[][]; leafId: string | null;
  modelMode: ModelMode; provider: LlmProvider; customProvider?: LlmProvider; homeBaseDir?: string; sandboxGrants: SandboxGrants;
}

function loadDiskEntries(sessionFile: string): SessionEntry[] {
  return fs.existsSync(sessionFile) ? loadJsonlEntries(sessionFile) : [];
}

function syncStateFromDisk(st: ControllerMutableState): SessionEntry[] {
  const entries = loadDiskEntries(st.paths.sessionFile), meta = loadProjectMeta(st.paths.metaFile), validModes = listAvailableModelModes(st.paths.workspaceRoot);
  const rootId = entries[0]?.parentId === null && entries[0]?.message.role === "system" ? entries[0].id : null;
  st.modelMode = meta.modelMode && validModes.includes(meta.modelMode) ? meta.modelMode : "auto";
  if (meta.activeLeafId === "__root__") st.leafId = rootId;
  else if (meta.activeLeafId && entries.some((e) => e.id === meta.activeLeafId)) st.leafId = meta.activeLeafId;
  else st.leafId = entries.length > 0 ? entries[entries.length - 1]!.id : null;
  st.snapshots = loadProjectSnapshots(st.paths.snapshotsFile);
  st.redoBatches = loadProjectRedoBatches(st.paths.snapshotsFile);
  return entries;
}

function buildStatusSummary(st: ControllerMutableState): SessionStatusSummary {
  const entries = syncStateFromDisk(st);
  const rootId = entries[0]?.id ?? null, isNew = !st.leafId || st.leafId === rootId || entries.length <= 1;
  const turns = extractConversationTurns(entries, st.leafId);
  const cur = isNew ? undefined : (turns.find((t) => t.isCurrentLeaf) ?? turns[turns.length - 1]);
  const target = resolveActiveModelTarget(st.paths.wireLogFile, !isNew, st.modelMode, Date.now(), false, st.paths.workspaceRoot);
  return {
    projectKey: st.paths.projectKey, projectName: path.basename(st.paths.workspaceRoot) || "root",
    workspaceRoot: st.paths.workspaceRoot, isNew, activeTurnIndex: cur?.turnIndex ?? null,
    totalTurns: turns.length, leafId: st.leafId, modelMode: st.modelMode, activeModel: target.model, modelLabel: target.shortLabel,
  };
}

export function squashTurnSnapshots(snapshots: FileVersionSnapshot[], startIndex: number, turnId: string, leafId?: string | null): void {
  if (snapshots.length <= startIndex) return;
  const byPath = new Map<string, FileVersionSnapshot>();
  for (let i = startIndex; i < snapshots.length; i++) {
    const s = snapshots[i]!;
    const prev = byPath.get(s.path);
    const resolvedLeaf = leafId ?? s.leafId ?? prev?.leafId;
    byPath.set(s.path, { version: 0, path: s.path, beforeContent: prev ? prev.beforeContent : s.beforeContent, afterContent: s.afterContent, timestamp: s.timestamp, turnId, ...(resolvedLeaf ? { leafId: resolvedLeaf } : {}), hunkCount: (prev?.hunkCount ?? 0) + (s.hunkCount ?? 1) });
  }
  const merged = [...byPath.values()].filter((s) => s.beforeContent !== s.afterContent).map((s, idx) => ({ ...s, version: startIndex + idx + 1 }));
  snapshots.splice(startIndex, snapshots.length - startIndex, ...merged);
}

function countSnapshotsAfterTarget(entries: readonly SessionEntry[], snapshots: readonly FileVersionSnapshot[], rawTarget: string): number {
  const turns = extractConversationTurns(entries);
  const byTurn = turns.find((t) => `#${t.turnIndex}` === rawTarget || t.userEntryId === rawTarget || t.leafEntryId === rawTarget);
  const targetId = byTurn ? byTurn.leafEntryId : rawTarget;
  const idxMap = new Map(entries.map((e, i) => [e.id, i]));
  const targetIdx = idxMap.get(targetId) ?? -1;
  if (targetIdx < 0) return -1;
  const targetTs = entries[targetIdx]!.timestamp;
  let steps = 0;
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const s = snapshots[i]!;
    const sIdx = s.leafId ? idxMap.get(s.leafId) : undefined;
    const isAfter = sIdx !== undefined ? sIdx > targetIdx : s.timestamp > targetTs;
    if (isAfter) steps++;
    else break;
  }
  return steps;
}

async function executeControllerAsk(st: ControllerMutableState, prompt: string, runOpts: Partial<RunSessionOptions> = {}): Promise<TurnExecutionSummary> {
  return withSessionLock(st.paths.sessionFile, async () => {
    syncStateFromDisk(st);
    const meta = loadProjectMeta(st.paths.metaFile);
    const { expandedPrompt, attachedPaths, attachedImages } = expandAtMentions(prompt, st.paths.workspaceRoot, 300, st.sandboxGrants);
    if (attachedPaths.length > 0) console.log(`📎 [已自动附加 ${attachedPaths.length} 个文件/图片上下文]: ${attachedPaths.join(", ")}`);
    const effectivePrompt = meta.lastUndoNotice
      ? `${expandedPrompt}\n\n[系统提示：${meta.lastUndoNotice}。若本轮仅为普通问答请直接作答，严禁调用 run_bash；若后续需查看或修改该文件，请用免确认的 read_file / list_dir 读取最新状态]`
      : expandedPrompt;
    saveProjectMeta(st.paths.metaFile, { activeLeafId: null, ...(meta.lastUndoNotice ? { lastUndoNotice: null } : {}) });
    const snapStart = st.snapshots.length, turnId = `turn_${Date.now()}`;
    const persistTurnSnapshots = () => {
      for (let i = snapStart; i < st.snapshots.length; i++) {
        if (!st.snapshots[i]!.turnId) { st.snapshots[i]!.turnId = turnId; st.redoBatches.length = 0; }
      }
      saveProjectSnapshots(st.paths.snapshotsFile, st.snapshots, st.redoBatches);
    };
    let finalLeafId = st.leafId;
    try {
      const res = await runAgentSession(effectivePrompt, {
        ...runOpts, workspaceRoot: st.paths.workspaceRoot, sessionFile: st.paths.sessionFile, wireLogFile: st.paths.wireLogFile,
        leafId: st.leafId ?? undefined, provider: runOpts.provider ?? st.provider, snapshots: st.snapshots, redoBatches: st.redoBatches, sandboxGrants: st.sandboxGrants,
        userImages: runOpts.userImages ?? attachedImages, onSnapshotChange: persistTurnSnapshots, enableWriteTools: runOpts.enableWriteTools ?? true, showCostReport: runOpts.showCostReport ?? false,
      });
      finalLeafId = res.leafId;
      squashTurnSnapshots(st.snapshots, snapStart, turnId, finalLeafId);
      const turnSnaps = st.snapshots.slice(snapStart), m = computeTurnMetrics(st.paths.wireLogFile, res.stepsUsed), status = buildStatusSummary(st);
      return {
        finalAnswer: res.finalAnswer, stepsUsed: res.stepsUsed, leafId: res.leafId, activeModel: m?.activeModel ?? status.activeModel,
        turnCostCny: m?.turnCostCny ?? 0, totalCostCny: m?.totalCostCny ?? 0, cacheHitRatePct: m?.cacheHitRatePct ?? 0,
        modifiedFiles: summarizeSnapshotsDiff(turnSnaps, st.paths.workspaceRoot),
      };
    } catch (err) {
      const disk = loadDiskEntries(st.paths.sessionFile), last = disk[disk.length - 1];
      if (last && last.message.role !== "user") finalLeafId = last.id;
      else if (!finalLeafId && disk[0]) finalLeafId = disk[0].id;
      if (st.snapshots.length > snapStart) console.log(`💾 [本轮中途异常前已落盘 ${st.snapshots.length - snapStart} 处文件修改 · 可直接输入“继续”接力收尾，或输入 /diff 查看 | /undo 撤回]`);
      throw err;
    } finally {
      st.leafId = finalLeafId; squashTurnSnapshots(st.snapshots, snapStart, turnId, finalLeafId);
      saveProjectMeta(st.paths.metaFile, { activeLeafId: finalLeafId }); persistTurnSnapshots();
    }
  }, runOpts.signal);
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
  } else if (arg.startsWith("#") || arg.startsWith("msg_")) {
    const afterSteps = countSnapshotsAfterTarget(loadDiskEntries(st.paths.sessionFile), st.snapshots, arg);
    if (afterSteps <= 0) return { rolledBackCount: 0, remainingVersions: st.snapshots.length, touchedPaths: [] };
    stepsBack = afterSteps;
  } else {
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 1) return { rolledBackCount: 0, remainingVersions: st.snapshots.length, touchedPaths: [] };
    stepsBack = n;
  }
  const flushSnapshots = () => saveProjectSnapshots(st.paths.snapshotsFile, st.snapshots, st.redoBatches);
  const rb = await rollbackFileSnapshots(st.paths.workspaceRoot, st.snapshots, stepsBack, flushSnapshots, st.redoBatches);
  const touchedPaths = [...new Set(rb.touchedPaths)];
  flushSnapshots();
  if (rb.rolledBackCount > 0) saveProjectMeta(st.paths.metaFile, { lastUndoNotice: `用户刚才执行了 /undo，已撤回 ${rb.rolledBackCount} 处文件修改 (${touchedPaths.join(", ")})` });
  return { rolledBackCount: rb.rolledBackCount, remainingVersions: rb.currentVersion, touchedPaths };
}

async function executeControllerRedo(st: ControllerMutableState, arg = "turn") {
  syncStateFromDisk(st);
  const n = arg === "all" ? st.redoBatches.length : arg === "turn" || arg === "" ? 1 : Number(arg);
  if (!Number.isInteger(n) || n < 1) return { redoneCount: 0, totalVersions: st.snapshots.length, remainingRedoBatches: st.redoBatches.length, touchedPaths: [] };
  const flushSnapshots = () => saveProjectSnapshots(st.paths.snapshotsFile, st.snapshots, st.redoBatches);
  const rd = redoFileSnapshots(st.paths.workspaceRoot, st.snapshots, st.redoBatches, n, flushSnapshots);
  flushSnapshots();
  if (rd.redoneCount > 0) saveProjectMeta(st.paths.metaFile, { lastUndoNotice: `用户刚才执行了 /redo，已重做恢复 ${rd.redoneCount} 处文件修改 (${rd.touchedPaths.join(", ")})` });
  return rd;
}

function executeControllerCompact(st: ControllerMutableState) {
  const entries = syncStateFromDisk(st);
  if (entries.length <= 1 || !st.leafId) return { compactedCount: 0, beforeChars: 0, afterChars: 0 };
  const byId = new Map(entries.map((e) => [e.id, e])), onBranch = new Set<string>();
  for (let cur = byId.get(st.leafId); cur && !onBranch.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) onBranch.add(cur.id);
  const beforeChars = estimateMessagesChars(projectToMessages(entries, st.leafId));
  let compactedCount = 0;
  const nextEntries = entries.map((e) => {
    if (!onBranch.has(e.id)) return e;
    const folded = foldSingleMessage(e.message, 200);
    if (folded === e.message) return e;
    compactedCount += 1;
    return { ...e, message: folded };
  });
  if (compactedCount > 0) appendJsonlEntries(st.paths.sessionFile, nextEntries, true);
  const afterChars = compactedCount > 0 ? estimateMessagesChars(projectToMessages(nextEntries, st.leafId)) : beforeChars;
  return { compactedCount, beforeChars, afterChars };
}

export function createSessionController(options: SessionControllerOptions = {}) {
  const initialPaths = resolveProjectSessionPaths(options.workspaceRoot, options.homeBaseDir);
  const st: ControllerMutableState = {
    paths: initialPaths, snapshots: [], redoBatches: [], leafId: null, modelMode: "auto",
    provider: options.provider ?? createRouterProvider(initialPaths.wireLogFile, true, () => st.modelMode),
    customProvider: options.provider, homeBaseDir: options.homeBaseDir, sandboxGrants: createSandboxGrants(),
  };
  syncStateFromDisk(st);

  return {
    getPaths: () => st.paths,
    getLeafId: () => st.leafId,
    getSandboxGrants: () => st.sandboxGrants,
    loadEntries: () => loadDiskEntries(st.paths.sessionFile),
    getStatus: () => buildStatusSummary(st),
    listTurns: (): ConversationTurnSummary[] => extractConversationTurns(syncStateFromDisk(st), st.leafId),
    newSession: (): SessionStatusSummary => {
      st.sandboxGrants.reset();
      const first = loadDiskEntries(st.paths.sessionFile)[0];
      st.leafId = first?.parentId === null && first?.message.role === "system" ? first.id : null;
      saveProjectMeta(st.paths.metaFile, { activeLeafId: "__root__" });
      return buildStatusSummary(st);
    },
    resumeTurn: (rawTarget: string) => {
      const entries = syncStateFromDisk(st);
      const rewindCode = /(?:^|\s)(?:--code|-c)(?:\s|$)/i.test(rawTarget);
      const cleanTarget = rawTarget.replace(/(?:^|\s)(?:--code|-c)(?=\s|$)/gi, "").trim();
      const turns = extractConversationTurns(entries, st.leafId);
      const byTurn = turns.find((t) => `#${t.turnIndex}` === cleanTarget || String(t.turnIndex) === cleanTarget);
      const resolvedId = byTurn ? byTurn.leafEntryId : cleanTarget;
      if (!entries.some((e) => e.id === resolvedId)) {
        return { ok: false, error: `未找到轮次或节点 ${cleanTarget}，可输入 /resume 用 ↑/↓ 方向键选择。`, status: buildStatusSummary(st), recapText: "" };
      }
      st.leafId = resolvedId;
      let codeNote = "";
      if (rewindCode && st.snapshots.length > 0) {
        const afterSteps = countSnapshotsAfterTarget(entries, st.snapshots, resolvedId);
        if (afterSteps > 0) {
          const flush = () => saveProjectSnapshots(st.paths.snapshotsFile, st.snapshots, st.redoBatches);
          const rb = rollbackFileSnapshotsSync(st.paths.workspaceRoot, st.snapshots, afterSteps, flush, st.redoBatches);
          const touched = [...new Set(rb.touchedPaths)];
          flush();
          saveProjectMeta(st.paths.metaFile, { activeLeafId: resolvedId, lastUndoNotice: `用户已将对话与代码同步回滚至 ${cleanTarget}，撤回了 ${rb.rolledBackCount} 处后续文件修改 (${touched.join(", ")})` });
          codeNote = `\n🔄 已同步将工作区代码回滚至该轮结束状态 (撤回 ${rb.rolledBackCount} 处修改: ${touched.join(", ")})`;
        } else saveProjectMeta(st.paths.metaFile, { activeLeafId: resolvedId });
      } else {
        saveProjectMeta(st.paths.metaFile, { activeLeafId: resolvedId });
      }
      const targetHint = byTurn ? `#${byTurn.turnIndex}` : resolvedId;
      const snapHint = !codeNote && st.snapshots.length > 0 ? `\n💡 提示：工作区当前有 ${st.snapshots.length} 处未撤回的文件修改（可输入 /diff 查看、/undo ${targetHint} 还原至该轮代码，或 /resume ${targetHint} --code 同步回滚）。` : codeNote;
      return { ok: true, status: buildStatusSummary(st), recapText: `${formatRecentHistoryRecap(entries, 1, st.leafId)}${snapHint}` };
    },
    setModelMode: (mode: ModelMode): SessionStatusSummary => {
      st.modelMode = mode;
      saveProjectMeta(st.paths.metaFile, { modelMode: mode });
      return buildStatusSummary(st);
    },
    getDiff: (arg = "turn") => {
      syncStateFromDisk(st);
      const rawTokens = arg.trim().split(/\s+/).filter(Boolean), lower = rawTokens.map((t) => t.toLowerCase());
      const isAll = lower.includes("all"), isFull = lower.includes("full");
      const fileFilter = rawTokens.find((t) => !/^(?:turn|all|full)$/i.test(t));
      const top = st.snapshots[st.snapshots.length - 1];
      const targetSnaps = !isAll && top?.turnId ? st.snapshots.filter((s) => s.turnId === top.turnId) : st.snapshots;
      return { files: summarizeSnapshotsDiff(targetSnaps, st.paths.workspaceRoot, isFull), totalSnapshots: st.snapshots.length, formattedText: formatSnapshotsDiff(targetSnaps, st.paths.workspaceRoot, { full: isFull, totalVersions: st.snapshots.length, fileFilter }) };
    },
    undo: (arg = "turn") => executeControllerUndo(st, arg),
    redo: (arg = "turn") => executeControllerRedo(st, arg),
    switchWorkspace: (targetArg: string) => {
      const candidate = resolveTargetWorkspace(targetArg, st.paths.workspaceRoot, path.dirname(st.paths.projectDir));
      if (!candidate) return { ok: false, error: `未找到项目或目录 "${targetArg}"`, status: buildStatusSummary(st), entryCount: 0, recapText: "" };
      const realCandidate = fs.realpathSync(candidate);
      if (realCandidate === st.paths.workspaceRoot) return { ok: true, alreadyInWorkspace: true, status: buildStatusSummary(st), entryCount: loadDiskEntries(st.paths.sessionFile).length, recapText: "" };
      st.sandboxGrants.reset();
      st.paths = resolveProjectSessionPaths(realCandidate, st.homeBaseDir);
      const entries = syncStateFromDisk(st);
      st.provider = st.customProvider ?? createRouterProvider(st.paths.wireLogFile, entries.length > 0, () => st.modelMode);
      return { ok: true, status: buildStatusSummary(st), entryCount: entries.length, recapText: formatRecentHistoryRecap(entries, 1, st.leafId) };
    },
    clearHistory: (): SessionStatusSummary => {
      for (const f of [st.paths.sessionFile, st.paths.wireLogFile, st.paths.snapshotsFile]) if (fs.existsSync(f)) fs.unlinkSync(f);
      st.leafId = null; st.snapshots.length = 0; st.redoBatches.length = 0; st.sandboxGrants.reset();
      saveProjectMeta(st.paths.metaFile, { activeLeafId: null, lastUndoNotice: null, lastPlanLeafId: null, lastExecutedPlanHash: null });
      return buildStatusSummary(st);
    },
    compact: () => executeControllerCompact(st),
    getXrayReport: () => ({ costText: loadAndFormatWireCost(st.paths.wireLogFile), xrayText: formatXrayReport(analyzeSessionXray(st.paths.sessionFile, st.paths.wireLogFile)) }),
    ask: (prompt: string, runOpts: Partial<RunSessionOptions> = {}) => executeControllerAsk(st, prompt, runOpts),
  };
}
export type SessionController = ReturnType<typeof createSessionController>;
