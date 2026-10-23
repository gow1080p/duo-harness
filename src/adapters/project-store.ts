import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionEntry } from "../core/contracts.js";
import { formatSnapshotsDiff } from "./diff-presenter.js";
import { loadJsonlEntries, writeFileAtomicSync } from "./store.js";
import type { FileVersionSnapshot } from "./write-tools.js";

export { formatSnapshotsDiff };

export interface ProjectMetaState {
  projectKey: string;
  workspaceRoot: string;
  updatedAt: string;
  activeLeafId?: string | null;
  modelMode?: "auto" | "deepseek" | "mimo" | "agy" | "openai";
  lastUndoNotice?: string | null;
}

export function loadProjectMeta(metaFile: string): Partial<ProjectMetaState> {
  if (!fs.existsSync(metaFile)) return {};
  try { return JSON.parse(fs.readFileSync(metaFile, "utf-8")); } catch { return {}; }
}

export function saveProjectMeta(metaFile: string, patch: Partial<ProjectMetaState>): void {
  try {
    const prev = loadProjectMeta(metaFile);
    writeFileAtomicSync(metaFile, JSON.stringify({ ...prev, ...patch, updatedAt: new Date().toISOString() }, null, 2));
  } catch {}
}

export interface ProjectSessionPaths {
  projectKey: string;
  workspaceRoot: string;
  projectDir: string;
  sessionFile: string;
  wireLogFile: string;
  snapshotsFile: string;
  metaFile: string;
}

export interface ManagedProjectSummary {
  projectKey: string;
  workspaceRoot: string;
  updatedAt: string;
  entryCount: number;
  lastLeafId: string | null;
}

export interface ConversationTurnSummary {
  turnIndex: number;
  userEntryId: string;
  leafEntryId: string;
  userText: string;
  replyText: string;
  toolSteps: number;
  isCurrentLeaf: boolean;
}

export const SLASH_COMMANDS = [
  { cmd: "/resume ", label: "/resume", desc: "用 ↑/↓ 方向键选择历史轮次或切换会话" },
  { cmd: "/new", label: "/new", desc: "开启全新对话 (保留旧历史，可随时 /resume 切回)" },
  { cmd: "/model ", label: "/model", desc: "用 ↑/↓ 方向键切换模型 (auto/deepseek/mimo/agy)" },
  { cmd: "/history", label: "/history", desc: "查看当前项目所有历史问答列表" },
  { cmd: "/diff", label: "/diff", desc: "查看文件修改对比 (-删除 / +新增)" },
  { cmd: "/undo", label: "/undo", desc: "撤回修改 (/undo 撤上一轮 | /undo N 撤N步 | /undo all 全部撤回)" },
  { cmd: "/cd ", label: "/cd <项目>", desc: "切换项目工作区 (按回车直接展开项目列表)" },
  { cmd: "/projects", label: "/projects", desc: "查看本机已管理的所有项目列表" },
  { cmd: "/xray", label: "/xray", desc: "查看每步耗时、缓存命中与费用账单" },
  { cmd: "/branch ", label: "/branch <id>", desc: "从指定历史节点分叉重聊" },
  { cmd: "/clear", label: "/clear", desc: "彻底清空当前项目磁盘历史记录" },
  { cmd: "/exit", label: "/exit", desc: "退出交互终端" },
] as const;

export function resolveProjectSessionPaths(workspaceRoot = process.cwd(), homeBaseDir = path.join(os.homedir(), ".duo-harness", "projects")): ProjectSessionPaths {
  const resolved = path.resolve(workspaceRoot);
  const realRoot = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
  const baseName = path.basename(realRoot).replace(/[^a-zA-Z0-9_-]/g, "_") || "root";
  const hash8 = crypto.createHash("sha256").update(realRoot).digest("hex").slice(0, 8);
  const projectKey = `${baseName}-${hash8}`;
  const projectDir = path.join(homeBaseDir, projectKey);
  fs.mkdirSync(projectDir, { recursive: true });
  const metaFile = path.join(projectDir, "meta.json");
  saveProjectMeta(metaFile, { projectKey, workspaceRoot: realRoot });
  return { projectKey, workspaceRoot: realRoot, projectDir, sessionFile: path.join(projectDir, "chat.jsonl"), wireLogFile: path.join(projectDir, "http-wire.json"), snapshotsFile: path.join(projectDir, "snapshots.json"), metaFile };
}

export function listManagedProjects(homeBaseDir = path.join(os.homedir(), ".duo-harness", "projects")): ManagedProjectSummary[] {
  if (!fs.existsSync(homeBaseDir)) return [];
  const list: ManagedProjectSummary[] = [];
  for (const d of fs.readdirSync(homeBaseDir, { withFileTypes: true }).filter((x) => x.isDirectory())) {
    try {
      const pDir = path.join(homeBaseDir, d.name);
      const meta = JSON.parse(fs.readFileSync(path.join(pDir, "meta.json"), "utf-8"));
      const sFile = path.join(pDir, "chat.jsonl");
      const entries = fs.existsSync(sFile) ? loadJsonlEntries(sFile) : [];
      list.push({
        projectKey: String(meta.projectKey ?? d.name),
        workspaceRoot: String(meta.workspaceRoot ?? ""),
        updatedAt: String(meta.updatedAt ?? ""),
        entryCount: entries.length,
        lastLeafId: entries.length > 0 ? entries[entries.length - 1]!.id : null,
      });
    } catch {}
  }
  return list.sort((a, b) => a.projectKey.localeCompare(b.projectKey));
}

export function resolveTargetWorkspace(targetArg: string, currentWorkspaceRoot: string, homeBaseDir?: string): string | null {
  const projects = listManagedProjects(homeBaseDir);
  const idx = Number(targetArg);
  if (Number.isInteger(idx) && idx >= 1 && idx <= projects.length) return projects[idx - 1]!.workspaceRoot;
  const byManaged = projects.find((p) => p.projectKey === targetArg || path.basename(p.workspaceRoot) === targetArg || p.projectKey.startsWith(`${targetArg}-`));
  if (byManaged && fs.existsSync(byManaged.workspaceRoot)) return byManaged.workspaceRoot;
  const expanded = targetArg.startsWith("~/") ? path.join(os.homedir(), targetArg.slice(2)) : targetArg;
  for (const candidate of [path.resolve(currentWorkspaceRoot, expanded), path.resolve(currentWorkspaceRoot, "..", targetArg), path.resolve(currentWorkspaceRoot, "../..", targetArg)]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
  }
  return null;
}

export function createReplCompleter(getWorkspaceRoot: () => string, getSessionFile: () => string) {
  return (line: string): [string[], string] => {
    if (line.startsWith("/cd ")) {
      const rawArg = line.slice(4);
      const managed = listManagedProjects().map((p) => path.basename(p.workspaceRoot)).filter((n) => n.startsWith(rawArg)).map((n) => `/cd ${n}`);
      const expanded = rawArg.startsWith("~/") ? path.join(os.homedir(), rawArg.slice(2)) : rawArg;
      const fullTarget = path.resolve(getWorkspaceRoot(), expanded || ".");
      const searchDir = rawArg.endsWith("/") && fs.existsSync(fullTarget) ? fullTarget : path.dirname(fullTarget);
      const prefix = rawArg.endsWith("/") ? "" : path.basename(expanded);
      try {
        const dirs = fs.readdirSync(searchDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name.startsWith(prefix)).map((d) => `/cd ${rawArg.slice(0, rawArg.length - prefix.length)}${d.name}/`);
        return [[...new Set([...managed, ...dirs])], line];
      } catch {
        return [managed, line];
      }
    }
    if (line.startsWith("/branch ") || line.startsWith("/resume ")) {
      const cmdPrefix = line.startsWith("/resume ") ? "/resume " : "/branch ";
      const entries = fs.existsSync(getSessionFile()) ? loadJsonlEntries(getSessionFile()) : [];
      const turnHits = extractConversationTurns(entries).map((t) => `${cmdPrefix}#${t.turnIndex}`);
      const idHits = entries.map((e) => `${cmdPrefix}${e.id}`);
      return [[...turnHits, ...idHits].filter((c) => c.startsWith(line)), line];
    }
    if (line.startsWith("/")) {
      const all = SLASH_COMMANDS.map((c) => c.cmd);
      const hits = all.filter((c) => c.startsWith(line));
      return [hits.length > 0 ? hits : all, line];
    }
    return [[], line];
  };
}

export function loadProjectSnapshots(snapshotsFile: string): FileVersionSnapshot[] {
  if (!fs.existsSync(snapshotsFile)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(snapshotsFile, "utf-8"));
    return Array.isArray(parsed) ? (parsed as FileVersionSnapshot[]) : [];
  } catch {
    return [];
  }
}

export function saveProjectSnapshots(snapshotsFile: string, snapshots: readonly FileVersionSnapshot[]): void {
  try {
    let toSave = [...snapshots];
    if (toSave.length > 80) {
      const earliestBefore = new Map<string, string | null>();
      for (const s of toSave) if (!earliestBefore.has(s.path)) earliestBefore.set(s.path, s.beforeContent);
      toSave = toSave.slice(-80).map((s) => ({ ...s }));
      const patched = new Set<string>();
      for (const s of toSave) {
        if (!patched.has(s.path) && earliestBefore.has(s.path)) {
          s.beforeContent = earliestBefore.get(s.path)!;
          patched.add(s.path);
        }
      }
    }
    writeFileAtomicSync(snapshotsFile, JSON.stringify(toSave, null, 2));
  } catch {}
}

function cleanPreviewText(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, "[代码块]")
    .replace(/#{1,6}\s*/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractConversationTurns(entries: readonly SessionEntry[], activeLeafId?: string | null): ConversationTurnSummary[] {
  const rawTurns: Omit<ConversationTurnSummary, "turnIndex" | "isCurrentLeaf">[] = [];
  for (const e of entries) {
    if (e.message.role === "user") {
      rawTurns.push({
        userEntryId: e.id,
        leafEntryId: e.id,
        userText: cleanPreviewText(e.message.content),
        replyText: "",
        toolSteps: 0,
      });
    } else if (rawTurns.length > 0) {
      const cur = rawTurns[rawTurns.length - 1]!;
      cur.leafEntryId = e.id;
      if (e.message.role === "assistant") {
        if (e.message.toolCalls && e.message.toolCalls.length > 0) cur.toolSteps += 1;
        if (e.message.content.trim()) cur.replyText = cleanPreviewText(e.message.content);
      }
    }
  }
  const filtered = rawTurns.filter((t, i) => t.replyText !== "" || i === rawTurns.length - 1 || t.userText !== rawTurns[i + 1]?.userText);
  return filtered.map((t, idx) => ({
    ...t,
    turnIndex: idx + 1,
    isCurrentLeaf: Boolean(activeLeafId && (t.leafEntryId === activeLeafId || t.userEntryId === activeLeafId)),
  }));
}

export function formatRecentHistoryRecap(entries: readonly SessionEntry[], maxTurns = 3, activeLeafId?: string | null): string {
  const turns = extractConversationTurns(entries, activeLeafId);
  if (turns.length === 0) return "";
  if (maxTurns === 1) {
    if (activeLeafId && entries[0]?.id === activeLeafId) return "";
    const cur = turns.find((t) => t.isCurrentLeaf) ?? turns[turns.length - 1]!;
    const uShort = cur.userText.length > 68 ? `${cur.userText.slice(0, 65)}...` : cur.userText;
    const rShort = cur.replyText ? (cur.replyText.length > 74 ? `${cur.replyText.slice(0, 71)}...` : cur.replyText) : `已执行 ${cur.toolSteps} 步工具调用`;
    return [
      `╭─ 💬 当前续接对话 (#${cur.turnIndex}/${turns.length} · 直接输入将继续追问 | /new 开启新会话 | /resume 切换历史)`,
      `│ 👤 你: ${uShort}`,
      `╰─ 🤖 AI (${cur.toolSteps}步): \x1b[2m${rShort}\x1b[0m`,
    ].join("\n");
  }
  const recent = turns.slice(-maxTurns);
  const lines = [`📜 [对话历史 (共 ${turns.length} 轮 · 输入 /resume 用 ↑/↓ 方向键切换轮次 | /new 开启新对话)]:`];
  for (const t of recent) {
    const badge = t.isCurrentLeaf ? "\x1b[32;1m●当前续接\x1b[0m " : "          ";
    const uShort = t.userText.length > 58 ? `${t.userText.slice(0, 55)}...` : t.userText;
    const rShort = t.replyText ? (t.replyText.length > 66 ? `${t.replyText.slice(0, 63)}...` : t.replyText) : `(执行了 ${t.toolSteps} 步工具调用)`;
    lines.push(`  #${t.turnIndex} ${badge}👤 ${uShort}\n               🤖 \x1b[2m[${t.toolSteps}步] ${rShort}\x1b[0m`);
  }
  return lines.join("\n");
}
