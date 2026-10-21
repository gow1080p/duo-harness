import { spawn } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { ToolContract } from "../core/contracts.js";
import { resolveSafePath } from "./tools.js";

const EditFileArgsSchema = z.object({
  path: z.string().min(1),
  oldText: z.string(),
  newText: z.string(),
});

const RunBashArgsSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().max(30_000).optional(),
});

const RollbackVersionArgsSchema = z.object({
  stepsBack: z.number().int().positive().max(100).default(1),
});

export interface FileVersionSnapshot {
  version: number;
  path: string;
  beforeContent: string | null;
  afterContent: string;
  timestamp: number;
}

/**
 * 按逆序回滚最近 stepsBack 个文件版本快照（beforeContent 为 null 表示原本不存在，回滚时直接删除）
 */
export async function rollbackFileSnapshots(
  workspaceRoot: string,
  snapshots: FileVersionSnapshot[],
  stepsBack = 1,
): Promise<{ rolledBackCount: number; currentVersion: number; touchedPaths: string[] }> {
  const count = Math.min(Math.max(0, stepsBack), snapshots.length);
  const touchedPaths: string[] = [];

  for (let i = 0; i < count; i++) {
    const snap = snapshots[snapshots.length - 1]!;
    const fullPath = resolveSafePath(workspaceRoot, snap.path, "write");
    if (snap.beforeContent === null) {
      await fs.rm(fullPath, { force: true });
    } else {
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, snap.beforeContent, "utf-8");
    }
    snapshots.pop();
    touchedPaths.push(snap.path);
  }

  return {
    rolledBackCount: count,
    currentVersion: snapshots.length,
    touchedPaths,
  };
}

export function killProcessGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 进程已退出
    }
  }
}

export function runCommandInSandbox(
  command: string,
  cwd: string,
  timeoutMs = 10_000,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const shellBin = fsSync.existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh";
    const child = spawn(shellBin, ["-c", command], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let combined = "";
    const appendChunk = (chunk: Buffer) => {
      if (combined.length < 16_000) {
        combined += chunk.toString("utf-8");
      }
    };

    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    child.stdout.on("data", appendChunk);
    child.stderr.on("data", appendChunk);

    let finished = false;
    const finish = (exitCode: number, prefix = "") => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      const text = (prefix + combined).trim().slice(0, 8_000);
      resolve({ exitCode, output: text || "(无输出)" });
    };

    const timer = setTimeout(() => {
      killProcessGroup(child.pid);
      finish(124, `[命令超时 (${timeoutMs}ms) 已强制终止进程组]\n`);
    }, timeoutMs);

    child.on("error", (err) => finish(1, `启动命令失败: ${err.message}\n`));
    child.on("close", (code) => finish(code ?? 1));
  });
}

async function applyFileEdit(
  workspaceRoot: string,
  snapshots: FileVersionSnapshot[],
  args: z.infer<typeof EditFileArgsSchema>,
): Promise<string> {
  const fullPath = resolveSafePath(workspaceRoot, args.path, "write");
  const existed = fsSync.existsSync(fullPath);
  const beforeContent = existed ? await fs.readFile(fullPath, "utf-8") : null;
  await fs.mkdir(path.dirname(fullPath), { recursive: true });

  let afterContent: string;
  if (args.oldText === "") {
    afterContent = args.newText;
  } else {
    if (beforeContent === null) {
      throw new Error(`文件不存在，无法替换 oldText: ${args.path}`);
    }
    const occurrences = beforeContent.split(args.oldText).length - 1;
    if (occurrences === 0) {
      throw new Error(`在 ${args.path} 中未找到匹配的 oldText，请先用 read_file 确认原文件内容`);
    }
    if (occurrences > 1) {
      throw new Error(`oldText 在 ${args.path} 中出现了 ${occurrences} 次，请补充前后几行代码保证唯一匹配`);
    }
    afterContent = beforeContent.replace(args.oldText, () => args.newText);
  }

  await fs.writeFile(fullPath, afterContent, "utf-8");
  const version = snapshots.length + 1;
  snapshots.push({
    version,
    path: args.path,
    beforeContent,
    afterContent,
    timestamp: Date.now(),
  });
  return `已写入文件: ${args.path} (当前版本 v${version})`;
}

/**
 * 创建 Stage 3 写工具集（edit_file、run_bash 与 rollback_version，支持按版本步数倒退还原文件）
 */
export function createWriteTools(
  workspaceRoot: string = process.cwd(),
  snapshots: FileVersionSnapshot[] = [],
): ToolContract<any>[] {
  const editFileTool: ToolContract<z.infer<typeof EditFileArgsSchema>> = {
    name: "edit_file",
    description: "修改或新建工作区内的文件（oldText 为空表示新建/覆盖文件，非空则唯一替换 oldText 为 newText）",
    parameters: EditFileArgsSchema,
    readonly: false,
    execute: (args) => applyFileEdit(workspaceRoot, snapshots, args),
  };

  const rollbackVersionTool: ToolContract<z.infer<typeof RollbackVersionArgsSchema>> = {
    name: "rollback_version",
    description: "将工作区文件按修改历史往回退指定的版本步数（例如用户说“回滚到之前2个版本”时传 stepsBack: 2）",
    parameters: RollbackVersionArgsSchema,
    readonly: false,
    async execute(args) {
      if (snapshots.length === 0) return "当前没有任何可回滚的文件修改记录";
      const res = await rollbackFileSnapshots(workspaceRoot, snapshots, args.stepsBack);
      return `已成功回退 ${res.rolledBackCount} 个版本（当前回到 v${res.currentVersion} 状态），还原文件: ${res.touchedPaths.join(", ")}`;
    },
  };

  const runBashTool: ToolContract<z.infer<typeof RunBashArgsSchema>> = {
    name: "run_bash",
    description: "在工作区目录下执行终端命令并返回输出",
    parameters: RunBashArgsSchema,
    readonly: false,
    async execute(args) {
      const res = await runCommandInSandbox(args.command, workspaceRoot, args.timeoutMs ?? 10_000);
      if (res.exitCode !== 0) throw new Error(`命令退出码 ${res.exitCode}:\n${res.output}`);
      return res.output;
    },
  };

  return [editFileTool, rollbackVersionTool, runBashTool];
}
