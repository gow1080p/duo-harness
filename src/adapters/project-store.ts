import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionEntry } from "../core/contracts.js";
import { loadJsonlEntries } from "./store.js";
import { shortenWorkspaceText } from "./ui-logger.js";
import type { FileVersionSnapshot } from "./write-tools.js";

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

export const SLASH_COMMANDS = [
  { cmd: "/history", label: "/history", desc: "查看当前项目历史提问与回答记录" },
  { cmd: "/diff", label: "/diff", desc: "查看文件修改对比 (-删除 / +新增)" },
  { cmd: "/undo", label: "/undo", desc: "撤回修改 (/undo 撤1步 | /undo all 全部撤回)" },
  { cmd: "/cd ", label: "/cd <项目>", desc: "切换项目工作区 (按回车直接展开项目列表)" },
  { cmd: "/projects", label: "/projects", desc: "查看本机已管理的所有项目列表" },
  { cmd: "/xray", label: "/xray", desc: "查看每步耗时、缓存命中与费用账单" },
  { cmd: "/tree", label: "/tree", desc: "查看对话历史节点树 ID" },
  { cmd: "/branch ", label: "/branch <id>", desc: "从指定历史节点分叉重聊" },
  { cmd: "/clear", label: "/clear", desc: "清空当前对话重新开始" },
  { cmd: "/exit", label: "/exit", desc: "退出交互终端" },
] as const;

export function resolveProjectSessionPaths(
  workspaceRoot = process.cwd(),
  homeBaseDir = path.join(os.homedir(), ".duo-harness", "projects"),
): ProjectSessionPaths {
  const resolved = path.resolve(workspaceRoot);
  const realRoot = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
  const baseName = path.basename(realRoot).replace(/[^a-zA-Z0-9_-]/g, "_") || "root";
  const hash8 = crypto.createHash("sha256").update(realRoot).digest("hex").slice(0, 8);
  const projectKey = `${baseName}-${hash8}`;
  const projectDir = path.join(homeBaseDir, projectKey);
  fs.mkdirSync(projectDir, { recursive: true });
  const metaFile = path.join(projectDir, "meta.json");
  fs.writeFileSync(
    metaFile,
    JSON.stringify({ projectKey, workspaceRoot: realRoot, updatedAt: new Date().toISOString() }, null, 2),
    "utf-8",
  );
  return {
    projectKey,
    workspaceRoot: realRoot,
    projectDir,
    sessionFile: path.join(projectDir, "chat.jsonl"),
    wireLogFile: path.join(projectDir, "http-wire.json"),
    snapshotsFile: path.join(projectDir, "snapshots.json"),
    metaFile,
  };
}

export function listManagedProjects(
  homeBaseDir = path.join(os.homedir(), ".duo-harness", "projects"),
): ManagedProjectSummary[] {
  if (!fs.existsSync(homeBaseDir)) return [];
  const dirs = fs.readdirSync(homeBaseDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  const list: ManagedProjectSummary[] = [];
  for (const d of dirs) {
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
    } catch {
      continue;
    }
  }
  return list.sort((a, b) => a.projectKey.localeCompare(b.projectKey));
}

export function resolveTargetWorkspace(targetArg: string, currentWorkspaceRoot: string, homeBaseDir?: string): string | null {
  const projects = listManagedProjects(homeBaseDir);
  const idx = Number(targetArg);
  if (Number.isInteger(idx) && idx >= 1 && idx <= projects.length) return projects[idx - 1]!.workspaceRoot;
  const byManaged = projects.find(
    (p) => p.projectKey === targetArg || path.basename(p.workspaceRoot) === targetArg || p.projectKey.startsWith(`${targetArg}-`),
  );
  if (byManaged && fs.existsSync(byManaged.workspaceRoot)) return byManaged.workspaceRoot;
  const expanded = targetArg.startsWith("~/") ? path.join(os.homedir(), targetArg.slice(2)) : targetArg;
  const candidate = path.resolve(currentWorkspaceRoot, expanded);
  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
  for (const up of ["..", "../.."]) {
    const sibling = path.resolve(currentWorkspaceRoot, up, targetArg);
    if (fs.existsSync(sibling) && fs.statSync(sibling).isDirectory()) return sibling;
  }
  return null;
}

export function createReplCompleter(getWorkspaceRoot: () => string, getSessionFile: () => string) {
  return (line: string): [string[], string] => {
    if (line.startsWith("/cd ")) {
      const rawArg = line.slice(4);
      const managedNames = listManagedProjects()
        .map((p) => path.basename(p.workspaceRoot))
        .filter((name) => name.startsWith(rawArg))
        .map((name) => `/cd ${name}`);
      const expanded = rawArg.startsWith("~/") ? path.join(os.homedir(), rawArg.slice(2)) : rawArg;
      const fullTarget = path.resolve(getWorkspaceRoot(), expanded || ".");
      const searchDir = rawArg.endsWith("/") && fs.existsSync(fullTarget) ? fullTarget : path.dirname(fullTarget);
      const prefix = rawArg.endsWith("/") ? "" : path.basename(expanded);
      try {
        const dirs = fs
          .readdirSync(searchDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name.startsWith(prefix))
          .map((d) => `/cd ${rawArg.slice(0, rawArg.length - prefix.length)}${d.name}/`);
        return [[...new Set([...managedNames, ...dirs])], line];
      } catch {
        return [managedNames, line];
      }
    }
    if (line.startsWith("/branch ")) {
      const sFile = getSessionFile();
      const entries = fs.existsSync(sFile) ? loadJsonlEntries(sFile) : [];
      const hits = entries.map((e) => `/branch ${e.id}`).filter((c) => c.startsWith(line));
      return [hits, line];
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
    fs.mkdirSync(path.dirname(snapshotsFile), { recursive: true });
    fs.writeFileSync(snapshotsFile, JSON.stringify(snapshots.slice(-40), null, 2), "utf-8");
  } catch {}
}

export function formatRecentHistoryRecap(entries: readonly SessionEntry[], maxTurns = 3): string {
  const turns: { id: string; user: string; reply: string }[] = [];
  for (const e of entries) {
    if (e.message.role === "user") {
      turns.push({ id: e.id, user: e.message.content.replace(/\s+/g, " ").trim(), reply: "" });
    } else if (e.message.role === "assistant" && turns.length > 0 && e.message.content.trim()) {
      turns[turns.length - 1]!.reply = e.message.content.replace(/\s+/g, " ").trim();
      turns[turns.length - 1]!.id = e.id;
    }
  }
  if (turns.length === 0) return "";
  const recent = turns.slice(-maxTurns);
  const lines = [`📜 [最近对话记录 (共 ${turns.length} 轮 · 输入 /history 查看更多 | /branch <id> 切回历史节点)]:`];
  recent.forEach((t, idx) => {
    const turnNum = turns.length - recent.length + idx + 1;
    const uShort = t.user.length > 68 ? `${t.user.slice(0, 65)}...` : t.user;
    const rShort = t.reply ? (t.reply.length > 76 ? `${t.reply.slice(0, 73)}...` : t.reply) : "(执行工具中/未完成)";
    lines.push(`  [${turnNum}] (${t.id}) 👤 ${uShort}\n             🤖 \x1b[2m${rShort}\x1b[0m`);
  });
  return lines.join("\n");
}

export function formatSnapshotsDiff(snapshots: readonly FileVersionSnapshot[], workspaceRoot: string): string {
  if (snapshots.length === 0) return "ℹ️ 当前没有未撤回的文件修改记录。";
  const byFile = new Map<string, { before: string | null; after: string; count: number; lastVer: number }>();
  for (const s of snapshots) {
    const rel = shortenWorkspaceText(s.path, workspaceRoot);
    const prev = byFile.get(rel);
    byFile.set(rel, {
      before: prev ? prev.before : s.beforeContent,
      after: s.afterContent,
      count: (prev?.count ?? 0) + 1,
      lastVer: s.version,
    });
  }
  const out = [`\n🔍 [文件修改审核对比 (共 ${byFile.size} 个文件, ${snapshots.length} 个快照版本 · 输入 /undo [步数|all] 可撤回)]:`];
  for (const [file, info] of byFile.entries()) {
    const oldLines = info.before === null ? [] : info.before.split("\n");
    const newLines = info.after.split("\n");
    const oldSet = new Set(oldLines.map((l) => l.trim()).filter(Boolean));
    const newSet = new Set(newLines.map((l) => l.trim()).filter(Boolean));
    const removed = oldLines.filter((l) => l.trim() && !newSet.has(l.trim())).slice(0, 5);
    const added = newLines.filter((l) => l.trim() && !oldSet.has(l.trim())).slice(0, 5);
    out.push(`  📘 ${file} (${info.before === null ? "新建文件" : `修改 ${info.count} 次 · ${oldLines.length} -> ${newLines.length} 行`})`);
    for (const r of removed) out.push(`     \x1b[31m- ${r.slice(0, 84)}\x1b[0m`);
    for (const a of added) out.push(`     \x1b[32m+ ${a.slice(0, 84)}\x1b[0m`);
  }
  return out.join("\n");
}
