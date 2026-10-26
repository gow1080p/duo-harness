import { spawn } from "node:child_process";
import * as fsSync from "node:fs";
import { z } from "zod";
import type { ToolContract } from "../core/contracts.js";
import { killProcessGroup, resolvePosixShell } from "./platform.js";
import { analyzeBashSandbox } from "./sandbox-policy.js";
import type { SandboxGrants } from "./tools.js";
import { isReadonlyBashCommand } from "./ui-logger.js";

export { killProcessGroup };

const SEATBELT_READONLY_PROFILE =
  '(version 1)(allow default)(deny file-write*)(deny file-read* (regex #"^/Users/[^/]+/\\.(ssh|aws|gnupg|claude|codex|gemini|continue|config|kube|docker|netrc|git-credentials|npmrc|pypirc|env)"))(allow file-write* (literal "/dev/null") (literal "/private/dev/null") (subpath "/dev/fd"))(allow process-exec (literal "/bin/ps") (with no-sandbox))';

export const RunBashArgsSchema = z.object({
  command: z.string().min(1).describe("要在工作区根目录执行的 Shell 命令（请勿前置拼接 cd）"),
  timeoutMs: z.number().int().positive().optional().describe("超时毫秒数（默认 15000，最大 120000）"),
  readonly: z.boolean().optional().describe("是否为不修改磁盘的只读命令"),
});

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

export function createRunBashTool(workspaceRoot: string, signal?: AbortSignal, grants?: SandboxGrants): ToolContract<z.infer<typeof RunBashArgsSchema>> {
  return {
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
}
