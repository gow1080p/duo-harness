import * as fsSync from "node:fs";
import * as path from "node:path";
import type { DropdownItem } from "./dropdown.js";
import { isPathInside, killProcessGroup } from "./platform.js";
import { resolveExistingRealPath } from "./sandbox-policy.js";

export interface BgTaskEntry {
  pid: number;
  bgKey: string;
  command: string;
  cwd: string;
  workspaceRoot: string;
  logPath: string;
  startedAt: number;
  readOffset: number;
  gateCheckedOffset: number;
  status: "running" | "crashed" | "stopped";
  exitCode?: number | null;
}

const trackedChildPids = new Set<number>();
const activeBgByKey = new Map<string, number>();
const bgTasksByPid = new Map<number, BgTaskEntry>();
let exitHookRegistered = false;

export const BG_READY_RE = /(?:https?:\/\/\S+|localhost:\d+|127\.0\.0\.1:\d+|0\.0\.0\.0:\d+|port[=:\s]+\d+|\blistening\b|\bready\b|\bstarted\b|已启动|监听)/i;
export const BG_FATAL_LOG_RE = /(?:EADDRINUSE|address already in use|Uncaught\s+\w*Error|UnhandledPromiseRejection|SyntaxError:|ReferenceError:|TypeError:|PayloadTooLargeError|ERR_UNHANDLED_ERROR)/i;

export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err: any) { return err?.code === "EPERM"; }
}

export function killTrackedChildren(): void {
  for (const pid of trackedChildPids) killProcessGroup(pid);
  trackedChildPids.clear();
  activeBgByKey.clear();
  bgTasksByPid.clear();
}

export function trackChildPid(pid: number | undefined): void {
  if (!pid) return;
  trackedChildPids.add(pid);
  if (!exitHookRegistered) { exitHookRegistered = true; process.once("exit", killTrackedChildren); }
}

export function untrackChildPid(pid: number | undefined): void {
  if (pid) trackedChildPids.delete(pid);
}

export function replacePreviousBgTask(bgCwd: string, command: string): string {
  const bgKey = `${resolveExistingRealPath(bgCwd).toLowerCase()}::${command.trim()}`;
  const prevPid = activeBgByKey.get(bgKey);
  if (prevPid) {
    const prevTask = bgTasksByPid.get(prevPid);
    if (prevTask) { prevTask.status = "stopped"; prevTask.gateCheckedOffset = -1; bgTasksByPid.delete(prevPid); }
    killProcessGroup(prevPid);
    trackedChildPids.delete(prevPid);
    activeBgByKey.delete(bgKey);
  }
  return bgKey;
}

export function registerBackgroundTask(pid: number | undefined, meta: { bgKey: string; command: string; cwd: string; workspaceRoot: string; logPath: string }): void {
  if (!pid) return;
  trackChildPid(pid);
  activeBgByKey.set(meta.bgKey, pid);
  bgTasksByPid.set(pid, {
    pid, bgKey: meta.bgKey, command: meta.command, cwd: meta.cwd, workspaceRoot: meta.workspaceRoot,
    logPath: meta.logPath, startedAt: Date.now(), readOffset: 0, gateCheckedOffset: 0, status: "running", exitCode: null,
  });
}

export function recordBackgroundTaskExit(pid: number | undefined, exitCode: number): void {
  if (!pid) return;
  untrackChildPid(pid);
  const task = bgTasksByPid.get(pid);
  if (!task || task.status !== "running") return;
  if (activeBgByKey.get(task.bgKey) === pid) activeBgByKey.delete(task.bgKey);
  task.exitCode = exitCode;
  task.status = exitCode === 0 ? "stopped" : "crashed";
}

function readLogTail(logPath: string, maxChars = 1500): string {
  if (!logPath || !fsSync.existsSync(logPath)) return "";
  try { return fsSync.readFileSync(logPath, "utf-8").trim().slice(-maxChars); } catch { return ""; }
}

export function refreshBgTasksLiveness(): void {
  for (const task of bgTasksByPid.values()) {
    if (task.status === "running" && !isPidAlive(task.pid)) {
      trackedChildPids.delete(task.pid);
      if (activeBgByKey.get(task.bgKey) === task.pid) activeBgByKey.delete(task.bgKey);
      const tail = readLogTail(task.logPath, 1500);
      task.status = BG_FATAL_LOG_RE.test(tail) ? "crashed" : "stopped";
    }
  }
}

function matchesWorkspace(task: BgTaskEntry, workspaceRoot?: string): boolean {
  if (!workspaceRoot) return true;
  const realWs = resolveExistingRealPath(workspaceRoot);
  return isPathInside( resolveExistingRealPath(task.cwd), realWs) || isPathInside(resolveExistingRealPath(task.workspaceRoot), realWs);
}

export function listBackgroundTasks(workspaceRoot?: string): BgTaskEntry[] {
  refreshBgTasksLiveness();
  return [...bgTasksByPid.values()].filter((t) => matchesWorkspace(t, workspaceRoot)).sort((a, b) => b.startedAt - a.startedAt);
}

export function readBackgroundTaskDelta(pid: number, maxBytes = 8192, advanceCursor = true): { text: string; newOffset: number } {
  const task = bgTasksByPid.get(pid);
  if (!task || !task.logPath || !fsSync.existsSync(task.logPath)) return { text: "", newOffset: task?.readOffset ?? 0 };
  try {
    const buf = fsSync.readFileSync(task.logPath);
    const start = Math.min(task.readOffset, buf.length), slice = buf.subarray(start);
    const text = (slice.length > maxBytes ? slice.subarray(slice.length - maxBytes) : slice).toString("utf-8");
    if (advanceCursor) task.readOffset = buf.length;
    return { text, newOffset: buf.length };
  } catch { return { text: "", newOffset: task.readOffset }; }
}

export function stopBackgroundTask(target: number | "all", workspaceRoot?: string): BgTaskEntry[] {
  refreshBgTasksLiveness();
  const stopped: BgTaskEntry[] = [];
  if (target === "all") {
    for (const task of bgTasksByPid.values()) {
      if (!matchesWorkspace(task, workspaceRoot)) continue;
      if (task.status === "running") {
        task.status = "stopped"; task.gateCheckedOffset = -1;
        killProcessGroup(task.pid); trackedChildPids.delete(task.pid); activeBgByKey.delete(task.bgKey);
        stopped.push(task);
      }
      bgTasksByPid.delete(task.pid);
    }
    return stopped;
  }
  const task = bgTasksByPid.get(target);
  if (!task || !matchesWorkspace(task, workspaceRoot)) return [];
  if (task.status === "running") {
    task.status = "stopped"; task.gateCheckedOffset = -1;
    killProcessGroup(task.pid); trackedChildPids.delete(task.pid); activeBgByKey.delete(task.bgKey);
  }
  bgTasksByPid.delete(target);
  return [task];
}

export function checkWorkspaceBackgroundHealth(workspaceRoot: string): { ok: boolean; errorOutput?: string } {
  for (const task of listBackgroundTasks(workspaceRoot)) {
    if (task.status === "crashed" && task.gateCheckedOffset >= 0) {
      task.gateCheckedOffset = -1;
      const tail = readLogTail(task.logPath, 1500) || "(无日志输出)";
      return { ok: false, errorOutput: `检测到后台常驻服务 (PID=${task.pid}: ${task.command}) 已异常退出 (exit ${task.exitCode ?? 1})，请排查修复并重新启动服务后再完成：\n${tail}` };
    }
    if (task.status === "running" && task.logPath && fsSync.existsSync(task.logPath)) {
      try {
        const buf = fsSync.readFileSync(task.logPath);
        const delta = buf.subarray(Math.min(task.gateCheckedOffset, buf.length)).toString("utf-8");
        task.gateCheckedOffset = buf.length;
        if (delta && BG_FATAL_LOG_RE.test(delta)) {
          return { ok: false, errorOutput: `检测到后台常驻服务 (PID=${task.pid}: ${task.command}) 运行日志出现异常报错，请修复后再完成：\n${delta.trim().slice(-1500)}` };
        }
      } catch {}
    }
  }
  return { ok: true };
}

export function createBackgroundDetachController(
  isBg: boolean, explicitWaitMs: number | undefined, getCombined: () => string, onDetach: () => void,
): { onChunk: () => void; clear: () => void } {
  if (!isBg) return { onChunk: () => {}, clear: () => {} };
  let mainTimer: ReturnType<typeof setTimeout> | undefined, quietTimer: ReturnType<typeof setTimeout> | undefined, extended = false;
  const clear = () => { if (mainTimer) clearTimeout(mainTimer); if (quietTimer) clearTimeout(quietTimer); };
  const trigger = () => { clear(); onDetach(); };
  mainTimer = setTimeout(() => {
    const cur = getCombined().trim();
    if (explicitWaitMs === undefined && !BG_READY_RE.test(cur) && /^(?:> [^\n]*\n?|\s)*$/.test(cur)) {
      extended = true; mainTimer = setTimeout(trigger, 2_000); return;
    }
    trigger();
  }, explicitWaitMs ?? 1_500);
  return {
    onChunk() {
      if (explicitWaitMs !== undefined) return;
      const cur = getCombined().trim();
      if (BG_READY_RE.test(cur) || (extended && cur && !/^(?:> [^\n]*\n?|\s)*$/.test(cur))) {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(trigger, 150);
      }
    },
    clear,
  };
}

export function buildPsDropdownItems(line: string, currentWorkspaceRoot: string): DropdownItem[] {
  const filter = line.replace(/^\/ps\b\s*/i, "").trim().toLowerCase();
  const running = [...bgTasksByPid.values()].filter((t) => t.status === "running" && matchesWorkspace(t, currentWorkspaceRoot));
  const items: DropdownItem[] = [
    { label: "/ps", desc: running.length > 0 ? `📋 查看后台常驻服务列表与最新增量日志 (当前 ${running.length} 个运行中)` : "ℹ️ 当前没有正在运行的后台常驻服务 (回车查看详情)", fillText: "/ps", expandOnly: false },
    ...running.map((t) => ({ label: `/ps kill ${t.pid}`, desc: `🛑 终止 PID=${t.pid}: ${t.command.slice(0, 36)} (${path.basename(t.cwd)})`, fillText: `/ps kill ${t.pid}`, expandOnly: false })),
  ];
  if (running.length > 0) items.push({ label: "/ps kill all", desc: `🛑 一键终止当前项目全部 ${running.length} 个后台常驻服务`, fillText: "/ps kill all", expandOnly: false });
  return items.filter((m) => !filter || m.label.toLowerCase().includes(filter) || m.desc.toLowerCase().includes(filter));
}

export function handlePsSlashCommand(cmd: string, workspaceRoot: string): boolean {
  const m = cmd.trim().match(/^\/ps(?:\s+(.*))?$/i);
  if (!m) return false;
  const arg = (m[1] ?? "").trim();
  if (/^(?:kill|stop)\s+all$|^clear$/i.test(arg)) {
    const stopped = stopBackgroundTask("all", workspaceRoot);
    console.log(stopped.length > 0 ? `🛑 已终止全部 ${stopped.length} 个后台常驻服务 (PID: ${stopped.map((t) => t.pid).join(", ")})。` : "ℹ️ 当前没有正在运行的后台常驻服务。");
    return true;
  }
  const killPidMatch = arg.match(/^(?:kill|stop)\s+(\d+)$/i);
  if (killPidMatch) {
    const pid = Number(killPidMatch[1]);
    const stopped = stopBackgroundTask(pid, workspaceRoot);
    console.log(stopped.length > 0 ? `🛑 已终止后台常驻服务 PID=${pid} (${stopped[0]!.command})。` : `⚠️ 未找到受托管的后台服务 PID=${pid}（仅允许终止当前会话启动的后台服务，可输入 /ps 查看列表）。`);
    return true;
  }
  const tasks = listBackgroundTasks(workspaceRoot);
  if (tasks.length === 0) { console.log("ℹ️ 当前没有正在运行的后台常驻服务。"); return true; }
  console.log(`\n⚙️ [后台常驻服务列表 (共 ${tasks.length} 个 · 输入 /ps kill <PID|all> 终止)]:`);
  for (const t of tasks) {
    const sec = Math.max(1, Math.round((Date.now() - t.startedAt) / 1000));
    const badge = t.status === "running" ? "🟢 运行中" : t.status === "crashed" ? `🔴 异常退出(exit ${t.exitCode ?? 1})` : "⚪ 已停止";
    const delta = readBackgroundTaskDelta(t.pid, 2048, true).text.trim() || readLogTail(t.logPath, 300);
    const lastLines = delta ? delta.split(/\r?\n/).slice(-2).map((l) => `     ↳ ${l.slice(0, 100)}`).join("\n") : "";
    console.log(`  • PID=${t.pid} [${badge} · ${sec}s] ${t.command} (${t.cwd})${lastLines ? `\n${lastLines}` : ""}`);
  }
  return true;
}
