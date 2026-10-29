import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import type { ToolContract } from "../core/contracts.js";
import { isPathInside, killProcessGroup, resolvePosixShell, toPosixPath } from "./platform.js";
import { analyzeBashSandbox, isSystemEscalatedCommand, resolveExistingRealPath, resolveSafePath } from "./sandbox-policy.js";
import type { SandboxGrants } from "./tools.js";
import { isReadonlyBashCommand } from "./ui-logger.js";

export { killProcessGroup };
export type SandboxMode = "readonly" | "workspace_write" | "unrestricted";

const trackedChildPids = new Set<number>();
let exitHookRegistered = false;

export function killTrackedChildren(): void {
  for (const pid of trackedChildPids) killProcessGroup(pid);
  trackedChildPids.clear();
}

function trackChildPid(pid: number | undefined): void {
  if (!pid) return;
  trackedChildPids.add(pid);
  if (!exitHookRegistered) {
    exitHookRegistered = true;
    process.once("exit", killTrackedChildren);
  }
}

const SEATBELT_DENY_READ_CLAUSE =
  '(deny file-read* (regex #"^/Users/[^/]+/\\.(ssh|aws|gnupg|claude|codex|gemini|continue|config|kube|docker|netrc|git-credentials|npmrc|pypirc|env)"))';

const SEATBELT_WORKSPACE_DENY_READ_CLAUSE =
  '(deny file-read* (regex #"^/Users/[^/]+/\\.(ssh|aws|gnupg|claude|codex|gemini|continue|kube|netrc|git-credentials|env)"))';

const SEATBELT_READONLY_PROFILE =
  `(version 1)(allow default)(deny file-write*)${SEATBELT_DENY_READ_CLAUSE}(allow file-write* (literal "/dev/null") (literal "/private/dev/null") (literal "/dev/tty") (subpath "/dev/fd"))(allow process-exec (literal "/bin/ps") (with no-sandbox))`;

export function buildWorkspaceWriteSeatbeltProfile(workspaceRoot: string, grants?: SandboxGrants): string {
  const home = os.homedir();
  const rawDirs = [
    workspaceRoot,
    os.tmpdir(),
    "/tmp",
    "/private/tmp",
    "/var/folders",
    "/private/var/folders",
    "/private/var/tmp",
    ...["Library/Caches", "Library/pnpm", ".local/share/pnpm", ".cache", ".npm", ".pnpm-store", "go", ".cargo"].map((rel) => path.join(home, rel)),
    ...(grants?.trustedWriteDirs ?? []),
    ...(grants?.onceAllowedPaths ?? []),
  ];
  const uniquePaths = new Set<string>();
  for (const d of rawDirs) {
    if (!d) continue;
    uniquePaths.add(path.resolve(d));
    uniquePaths.add(resolveExistingRealPath(d));
  }
  const subpaths = [...uniquePaths]
    .map((p) => `(subpath "${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`)
    .join(" ");
  return `(version 1)(allow default)(deny file-write*)${SEATBELT_WORKSPACE_DENY_READ_CLAUSE}(allow file-write* (literal "/dev/null") (literal "/private/dev/null") (literal "/dev/tty") (subpath "/dev/fd") ${subpaths})(allow process-exec (literal "/bin/ps") (with no-sandbox))`;
}

export const RunBashArgsSchema = z.object({
  command: z.string().min(1).describe("要执行的 Shell 命令"),
  cwd: z.string().optional().describe("可选工作区子目录（相对于工作区根目录，如 'backend' 或 'frontend'）"),
  timeoutMs: z.number().int().positive().optional().describe("超时毫秒数（默认 120000，最大 600000）"),
  readonly: z.boolean().optional().describe("是否为不修改磁盘的只读命令"),
});

function formatBashOutputWithSpill(rawText: string): string {
  if (rawText.length <= 8_000) return rawText;
  const id = randomBytes(6).toString("hex");
  const logPath = toPosixPath(path.join(resolveExistingRealPath(os.tmpdir()), `duo-bash-${id}.log`));
  try { fsSync.writeFileSync(logPath, rawText, "utf-8"); } catch {}
  const lines = rawText.split("\n");
  const kb = (Buffer.byteLength(rawText, "utf-8") / 1024).toFixed(1);
  const body =
    lines.length > 140
      ? `${lines.slice(0, 20).join("\n").slice(0, 1_500)}\n... [中间省略 ${lines.length - 140} 行输出] ...\n${lines.slice(-120).join("\n").slice(-6_000)}`
      : `${rawText.slice(0, 1_500)}\n... [中间省略 ${rawText.length - 7_500} 字符] ...\n${rawText.slice(-6_000)}`;
  return `${body}\n[输出已截断：共 ${lines.length} 行 (${kb} KB)，当前保留首部与尾部关键错误输出。完整日志已保存至 ${logPath}，可调用 read_file(path, startLine, endLine) 或 grep 检索明细]`;
}

export function runCommandInSandbox(
  command: string,
  cwd: string,
  timeoutMs = 10_000,
  signal?: AbortSignal,
  mode: boolean | SandboxMode = false,
  workspaceRoot = cwd,
  grants?: SandboxGrants,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const { bin: shellBin, env: shellEnv } = resolvePosixShell();
    const sandboxMode: SandboxMode = typeof mode === "boolean" ? (mode ? "readonly" : "workspace_write") : mode;
    const canSeatbelt = process.platform === "darwin" && fsSync.existsSync("/usr/bin/sandbox-exec") && sandboxMode !== "unrestricted";
    const profile = sandboxMode === "readonly" ? SEATBELT_READONLY_PROFILE : buildWorkspaceWriteSeatbeltProfile(workspaceRoot, grants);
    const spawnBin = canSeatbelt ? "/usr/bin/sandbox-exec" : shellBin;
    const spawnArgs = canSeatbelt ? ["-p", profile, shellBin, "-c", command] : ["-c", command];
    const child = spawn(spawnBin, spawnArgs, {
      cwd,
      env: shellEnv,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    trackChildPid(child.pid);

    const decoder = new TextDecoder("utf-8");
    let combined = "";
    const appendChunk = (chunk: Buffer) => {
      if (combined.length < 512_000) combined += decoder.decode(chunk, { stream: true });
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
      combined += decoder.decode();
      if (child.pid) trackedChildPids.delete(child.pid);
      if (timer) clearTimeout(timer);
      if (exitTimer) clearTimeout(exitTimer);
      signal?.removeEventListener("abort", onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      let text = formatBashOutputWithSpill((prefix + combined).trim());
      if (canSeatbelt && exitCode !== 0 && /Operation not permitted|No usable temporary directory|Read-only file system/i.test(text)) {
        text += sandboxMode === "readonly"
          ? "\n[沙箱提示：该命令在只读沙箱中运行，禁止写入任何磁盘或临时文件；若需写盘请传 readonly: false]"
          : "\n[沙箱提示：该命令被工作区沙箱拦截（禁止写入工作区外目录或读取敏感主目录凭据）]";
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
        if (!finished && sandboxMode === "readonly") killProcessGroup(child.pid);
        finish(code ?? 1);
      }, 150);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}

export function createRunBashTool(workspaceRoot: string, signal?: AbortSignal, grants?: SandboxGrants): ToolContract<z.infer<typeof RunBashArgsSchema>> {
  return {
    name: "run_bash",
    description: "在工作区执行终端命令并返回输出（可通过 cwd 指定子目录，如 'backend' 或 'frontend'）",
    parameters: RunBashArgsSchema,
    readonly: false,
    async execute(args) {
      const rawCwd = args.cwd?.trim();
      const execCwd = rawCwd ? resolveSafePath(workspaceRoot, rawCwd, "read", grants) : workspaceRoot;
      const realRoot = resolveExistingRealPath(workspaceRoot);
      const initialCwdRel = isPathInside(execCwd, realRoot) ? (toPosixPath(path.relative(realRoot, execCwd)) || ".") : toPosixPath(execCwd);
      const check = analyzeBashSandbox(args.command, workspaceRoot, grants, initialCwdRel);
      if (check.tier === "deny") {
        throw new Error(`[沙箱安全拦截] ${check.reason ?? "命令触碰安全红线"}。若缺少配置或 API Key，请立即停止探测并直接向用户询问。`);
      }
      const isRo = check.tier === "allow" && isReadonlyBashCommand(args.command, args.readonly, workspaceRoot, execCwd);
      const mode: SandboxMode = isRo ? "readonly" : isSystemEscalatedCommand(args.command) ? "unrestricted" : "workspace_write";
      const timeoutMs = Math.min(Math.max(args.timeoutMs ?? 120_000, 100), 600_000);
      const res = await runCommandInSandbox(args.command, execCwd, timeoutMs, signal, mode, workspaceRoot, grants);
      if (res.exitCode !== 0) throw new Error(`命令退出码 ${res.exitCode}:\n${res.output}`);
      return res.output;
    },
  };
}
