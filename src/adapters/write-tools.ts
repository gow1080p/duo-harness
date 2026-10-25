import { spawn } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { ToolContract } from "../core/contracts.js";
import { checkFileSyntax } from "./bash-policy.js";
import { extractChangedHunk } from "./diff-presenter.js";
import { expandHomePath, killProcessGroup, resolvePosixShell, toPosixRelative } from "./platform.js";
import { writeFileAtomicSync } from "./store.js";
import { resolveSafePath, type SandboxGrants } from "./tools.js";
import { analyzeBashSandbox, checkHardDeniedPath, resolveExistingRealPath } from "./sandbox-policy.js";
import { isReadonlyBashCommand } from "./ui-logger.js";

export { killProcessGroup };

const SEATBELT_READONLY_PROFILE =
  '(version 1)(allow default)(deny file-write*)(deny file-read* (regex #"^/Users/[^/]+/\\.(ssh|aws|gnupg|claude|codex|config|kube|docker|netrc|git-credentials|npmrc)"))(allow file-write* (literal "/dev/null") (literal "/private/dev/null") (subpath "/dev/fd"))(allow process-exec (literal "/bin/ps") (with no-sandbox))';

const SingleEditItemSchema = z.object({ oldText: z.string(), newText: z.string() });
const EditFileArgsSchema = z.object({
  path: z.string().min(1),
  oldText: z.string().optional(),
  newText: z.string().optional(),
  edits: z.preprocess((val) => {
    if (typeof val === "string") {
      try { return JSON.parse(val); } catch { return val; }
    }
    return val;
  }, z.array(SingleEditItemSchema).optional()),
});
const RunBashArgsSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
  readonly: z.boolean().optional(),
});
const RollbackVersionArgsSchema = z.object({ stepsBack: z.number().int().positive().max(100).default(1) });

export interface FileVersionSnapshot {
  version: number; path: string; beforeContent: string | null; afterContent: string; timestamp: number; turnId?: string; hunkCount?: number;
}

export async function rollbackFileSnapshots(workspaceRoot: string, snapshots: FileVersionSnapshot[], stepsBack = 1, onSnapshotChange?: () => void, redoBatches?: FileVersionSnapshot[][]): Promise<{ rolledBackCount: number; currentVersion: number; touchedPaths: string[] }> {
  const count = Math.min(Math.max(0, stepsBack), snapshots.length), touchedPaths: string[] = [], batch: FileVersionSnapshot[] = [];
  if (count > 0 && redoBatches) redoBatches.push(batch);
  const realRoot = resolveExistingRealPath(workspaceRoot);
  for (let i = 0; i < count; i++) {
    const snap = snapshots[snapshots.length - 1]!;
    const fullPath = resolveExistingRealPath(path.resolve(workspaceRoot, expandHomePath(snap.path)));
    if (checkHardDeniedPath(fullPath, realRoot, "write")) throw new Error(`禁止回滚敏感路径: ${snap.path}`);
    if (snap.beforeContent === null) await fs.rm(fullPath, { force: true });
    else writeFileAtomicSync(fullPath, snap.beforeContent);
    snapshots.pop();
    batch.unshift(snap);
    onSnapshotChange?.();
    touchedPaths.push(snap.path);
  }
  return { rolledBackCount: count, currentVersion: snapshots.length, touchedPaths };
}

export function redoFileSnapshots(workspaceRoot: string, snapshots: FileVersionSnapshot[], redoBatches: FileVersionSnapshot[][], batchesToRedo = 1, onSnapshotChange?: () => void) {
  const count = Math.min(Math.max(0, batchesToRedo), redoBatches.length), touchedPaths: string[] = [];
  let redoneCount = 0;
  const realRoot = resolveExistingRealPath(workspaceRoot);
  for (let i = 0; i < count; i++) {
    const batch = redoBatches[redoBatches.length - 1]!;
    while (batch.length > 0) {
      const snap = batch[0]!;
      const fullPath = resolveExistingRealPath(path.resolve(workspaceRoot, expandHomePath(snap.path)));
      if (checkHardDeniedPath(fullPath, realRoot, "write")) throw new Error(`禁止重做敏感路径: ${snap.path}`);
      writeFileAtomicSync(fullPath, snap.afterContent);
      batch.shift();
      snapshots.push({ ...snap, version: snapshots.length + 1 });
      redoneCount++;
      touchedPaths.push(snap.path);
    }
    redoBatches.pop();
    onSnapshotChange?.();
  }
  return { redoneCount, totalVersions: snapshots.length, remainingRedoBatches: redoBatches.length, touchedPaths: [...new Set(touchedPaths)] };
}

export function runCommandInSandbox(
  command: string,
  cwd: string,
  timeoutMs = 10_000,
  signal?: AbortSignal,
  readonly = false,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const { bin: shellBin, env: shellEnv } = resolvePosixShell();
    const useSeatbelt = readonly && process.platform === "darwin" && fsSync.existsSync("/usr/bin/sandbox-exec");
    const spawnBin = useSeatbelt ? "/usr/bin/sandbox-exec" : shellBin;
    const spawnArgs = useSeatbelt ? ["-p", SEATBELT_READONLY_PROFILE, shellBin, "-c", command] : ["-c", command];
    const child = spawn(spawnBin, spawnArgs, {
      cwd,
      env: shellEnv,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let combined = "";
    const appendChunk = (chunk: Buffer) => {
      if (combined.length < 16_000) combined += chunk.toString("utf-8");
    };
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    child.stdout.on("data", appendChunk);
    child.stderr.on("data", appendChunk);

    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      killProcessGroup(child.pid);
      finish(130, "[收到取消信号已终止进程组]\n");
    };
    const finish = (exitCode: number, prefix = "") => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (exitTimer) clearTimeout(exitTimer);
      signal?.removeEventListener("abort", onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      let text = (prefix + combined).trim().slice(0, 8_000);
      if (useSeatbelt && exitCode !== 0 && /Operation not permitted|No usable temporary directory|Read-only file system/i.test(text)) {
        text += "\n[沙箱提示：该命令在只读沙箱中运行，禁止写入任何磁盘或临时文件；若需写盘请传 readonly: false]";
      }
      resolve({ exitCode, output: text || "(无输出)" });
    };

    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
    timer = setTimeout(() => {
      killProcessGroup(child.pid);
      finish(124, `[命令超时 (${timeoutMs}ms) 已强制终止进程组]\n`);
    }, timeoutMs);

    child.on("error", (err) => finish(1, `启动命令失败: ${err.message}\n`));
    child.on("exit", (code) => {
      exitTimer = setTimeout(() => {
        if (!finished && readonly) killProcessGroup(child.pid);
        finish(code ?? 1);
      }, 150);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}

function replaceSingleItem(workingContent: string, oldText: string, newText: string, filePath: string, wasCreatedEmpty: boolean): string {
  if (wasCreatedEmpty && workingContent === "") throw new Error(`文件不存在，无法替换 oldText: ${filePath}`);
  const exactCount = workingContent.split(oldText).length - 1;
  if (exactCount === 1) return workingContent.replace(oldText, () => newText);
  if (exactCount > 1) throw new Error(`oldText 在 ${filePath} 中出现了 ${exactCount} 次，请补充前后几行保证唯一匹配`);
  const eol = workingContent.includes("\r\n") ? "\r\n" : "\n";
  const normOld = oldText.replace(/\r\n/g, "\n").split("\n").join(eol);
  const normNew = newText.replace(/\r\n/g, "\n").split("\n").join(eol);
  const eolCount = normOld !== oldText ? workingContent.split(normOld).length - 1 : 0;
  if (eolCount === 1) return workingContent.replace(normOld, () => normNew);
  if (eolCount > 1) throw new Error(`oldText 在 ${filePath} 中出现了 ${eolCount} 次，请补充前后几行保证唯一匹配`);
  const wLines = workingContent.split(/\r?\n/), oLines = oldText.split(/\r?\n/);
  const matchIdxs: number[] = [];
  for (let i = 0; i <= wLines.length - oLines.length; i++) {
    if (oLines.every((ol, j) => wLines[i + j]?.trimEnd() === ol.trimEnd())) matchIdxs.push(i);
  }
  if (matchIdxs.length === 1) {
    const idx = matchIdxs[0]!;
    return [...wLines.slice(0, idx), ...normNew.split(/\r?\n/), ...wLines.slice(idx + oLines.length)].join(eol);
  }
  if (matchIdxs.length > 1) throw new Error(`oldText 在 ${filePath} 中出现了 ${matchIdxs.length} 次，请补充前后几行保证唯一匹配`);
  throw new Error(`在 ${filePath} 中未找到匹配的 oldText，请先用 read_file 确认原文件内容`);
}

async function applyFileEdit(workspaceRoot: string, snapshots: FileVersionSnapshot[], args: z.infer<typeof EditFileArgsSchema>, onSnapshotChange?: () => void, grants?: SandboxGrants): Promise<string> {
  const fullPath = resolveSafePath(workspaceRoot, args.path, "write", grants);
  const beforeContent = fsSync.existsSync(fullPath) ? await fs.readFile(fullPath, "utf-8") : null;
  const hasBatch = Array.isArray(args.edits) && args.edits.length > 0;
  if (!hasBatch && (args.oldText === undefined || args.newText === undefined)) throw new Error(`edit_file 参数缺失：必须提供 oldText/newText 或非空 edits 数组`);
  const editList = hasBatch ? args.edits! : [{ oldText: args.oldText!, newText: args.newText! }];
  if (editList.length > 1 && editList.some((item) => item.oldText === "")) throw new Error(`批量 edits 中禁止混入 oldText 为空串的全量覆盖项: ${args.path}`);

  let workingContent = beforeContent ?? "";
  for (const item of editList) {
    workingContent = item.oldText === "" ? item.newText : replaceSingleItem(workingContent, item.oldText, item.newText, args.path, beforeContent === null);
  }

  writeFileAtomicSync(fullPath, workingContent);
  const relPath = toPosixRelative(resolveSafePath(workspaceRoot, ".", "read", grants), fullPath) || args.path;
  const version = snapshots.length + 1;
  snapshots.push({ version, path: relPath, beforeContent, afterContent: workingContent, timestamp: Date.now(), hunkCount: editList.length });
  onSnapshotChange?.();
  const hunks = editList.map((e) => extractChangedHunk(e.oldText, e.newText));
  const added = beforeContent === null ? workingContent.split(/\r?\n/).length : hunks.reduce((a, h) => a + h.added.length, 0);
  const removed = beforeContent === null ? 0 : hunks.reduce((a, h) => a + h.removed.length, 0);
  const baseMsg = `已写入文件: ${relPath} (共应用 ${editList.length} 处修改 · +${added} / -${removed} 行，当前版本 v${version}，语法自检已通过)`;
  const syntaxErr = checkFileSyntax(relPath, workingContent);
  return syntaxErr ? `已写入文件: ${relPath} (v${version})\n⚠️ [语法自检未通过] 检测到语法错误:\n${syntaxErr}\n请立即调用 edit_file 修复上述语法错误后再结束本轮回答。` : baseMsg;
}

export function createWriteTools(workspaceRoot: string = process.cwd(), snapshots: FileVersionSnapshot[] = [], signal?: AbortSignal, onSnapshotChange?: () => void, grants?: SandboxGrants): ToolContract<any>[] {
  const editFileTool: ToolContract<z.infer<typeof EditFileArgsSchema>> = {
    name: "edit_file",
    description: "修改或新建工作区内的文件（oldText 为空表示新建/覆盖文件，非空则唯一替换 oldText 为 newText）",
    parameters: EditFileArgsSchema,
    readonly: false,
    execute: (args) => applyFileEdit(workspaceRoot, snapshots, EditFileArgsSchema.parse(args), onSnapshotChange, grants),
  };

  const rollbackVersionTool: ToolContract<z.infer<typeof RollbackVersionArgsSchema>> = {
    name: "rollback_version",
    description: "将工作区文件按修改历史往回退指定的版本步数（例如用户说“回滚到之前2个版本”时传 stepsBack: 2）",
    parameters: RollbackVersionArgsSchema,
    readonly: false,
    async execute(args) {
      if (snapshots.length === 0) return "当前没有任何可回滚的文件修改记录";
      const res = await rollbackFileSnapshots(workspaceRoot, snapshots, args.stepsBack, onSnapshotChange);
      return `已成功回退 ${res.rolledBackCount} 个版本（当前回到 v${res.currentVersion} 状态），还原文件: ${res.touchedPaths.join(", ")}`;
    },
  };

  const runBashTool: ToolContract<z.infer<typeof RunBashArgsSchema>> = {
    name: "run_bash",
    description: "在工作区根目录下执行终端命令并返回输出（默认已在工作区启动，请勿前置拼接 cd）",
    parameters: RunBashArgsSchema,
    readonly: false,
    async execute(args) {
      const check = analyzeBashSandbox(args.command, workspaceRoot, grants);
      if (check.tier === "deny") {
        throw new Error(`[沙箱安全拦截] ${check.reason ?? "命令触碰安全红线"}。若缺少配置或 API Key，请立即停止探测并直接向用户询问。`);
      }
      const isRo = check.tier === "allow" && isReadonlyBashCommand(args.command, args.readonly, workspaceRoot);
      const timeoutMs = Math.min(Math.max(args.timeoutMs ?? 15_000, 100), 120_000);
      const res = await runCommandInSandbox(args.command, workspaceRoot, timeoutMs, signal, isRo);
      if (res.exitCode !== 0) throw new Error(`命令退出码 ${res.exitCode}:\n${res.output}`);
      return res.output;
    },
  };

  return [editFileTool, rollbackVersionTool, runBashTool];
}
