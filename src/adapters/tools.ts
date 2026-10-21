import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import type { ToolCall, ToolContract, ToolResultMessage } from "../core/contracts.js";

const ReadFileArgsSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  maxLines: z.number().int().positive().optional(),
});

const ListDirArgsSchema = z.object({
  path: z.string().default("."),
});

const GrepArgsSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().default("."),
  contextLines: z.number().int().min(0).max(5).optional(),
});

function resolveExistingRealPath(targetPath: string): string {
  let curr = path.resolve(targetPath);
  const tailSegments: string[] = [];
  while (!fsSync.existsSync(curr)) {
    const parent = path.dirname(curr);
    if (parent === curr) break;
    tailSegments.unshift(path.basename(curr));
    curr = parent;
  }
  const realBase = fsSync.existsSync(curr) ? fsSync.realpathSync(curr) : curr;
  return path.join(realBase, ...tailSegments);
}

/**
 * 校验并解析安全路径：
 * - write 模式：100% 锁死在 workspaceRoot 内（含软链接真实路径还原与多层新建目录回溯）
 * - read 模式：允许 workspaceRoot 及全局只读 Skill 白名单目录
 */
export function resolveSafePath(
  workspaceRoot: string,
  targetPath: string,
  mode: "read" | "write" = "read",
): string {
  const home = os.homedir();
  const expanded =
    targetPath === "~"
      ? home
      : targetPath.startsWith("~/")
        ? path.join(home, targetPath.slice(2))
        : targetPath;
  const candidate = path.resolve(workspaceRoot, expanded);
  const realCandidate = resolveExistingRealPath(candidate);
  const realRoot = resolveExistingRealPath(workspaceRoot);

  const isInside = (child: string, rootDir: string) =>
    child === rootDir || child.startsWith(rootDir + path.sep);

  if (isInside(realCandidate, realRoot)) {
    return realCandidate;
  }

  if (mode === "read") {
    const readonlyRoots = [
      path.join(home, ".gemini", "config", "plugins"),
      path.join(home, ".codex", "skills"),
      path.join(home, ".agents", "skills"),
    ].map(resolveExistingRealPath);

    if (readonlyRoots.some((r) => isInside(realCandidate, r))) {
      return realCandidate;
    }
  }

  throw new Error(`禁止访问工作区以外的路径 (${mode}): ${targetPath}`);
}

async function runGrepSearch(
  workspaceRoot: string,
  args: z.infer<typeof GrepArgsSchema>,
): Promise<string> {
  const realRoot = resolveSafePath(workspaceRoot, ".", "read");
  const fullPath = resolveSafePath(workspaceRoot, args.path, "read");
  const stat = await fs.stat(fullPath);
  const files = stat.isDirectory()
    ? (await fs.readdir(fullPath, { recursive: true, withFileTypes: true }))
        .filter(
          (e) =>
            e.isFile() &&
            !e.parentPath.includes("node_modules") &&
            !e.parentPath.includes(".git") &&
            !e.parentPath.includes(".sessions") &&
            (e.name.endsWith(".ts") || e.name.endsWith(".md") || e.name.endsWith(".json")),
        )
        .map((e) => path.join(e.parentPath, e.name))
    : [fullPath];

  let regex: RegExp;
  try {
    regex = new RegExp(args.pattern, "i");
  } catch {
    const escaped = args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    regex = new RegExp(escaped, "i");
  }
  const ctx = args.contextLines ?? 0;
  const matches: string[] = [];
  for (const file of files) {
    const lines = (await fs.readFile(file, "utf-8")).split("\n");
    const rel = path.relative(realRoot, file);
    lines.forEach((line, idx) => {
      if (regex.test(line)) {
        const start = Math.max(0, idx - ctx);
        const end = Math.min(lines.length - 1, idx + ctx);
        const snippet = lines
          .slice(start, end + 1)
          .map((l) => l.trim())
          .join(" | ");
        matches.push(`${rel}:${idx + 1}: ${snippet}`);
      }
    });
  }
  return matches.length > 0 ? matches.slice(0, 50).join("\n") : "未找到匹配内容";
}

export function createBuiltinTools(workspaceRoot: string = process.cwd()): ToolContract<any>[] {
  const readFileTool: ToolContract<z.infer<typeof ReadFileArgsSchema>> = {
    name: "read_file",
    description: "读取指定文件的文本内容（支持 startLine/endLine 行区间切片，附带行号）",
    parameters: ReadFileArgsSchema,
    readonly: true,
    async execute(args) {
      const fullPath = resolveSafePath(workspaceRoot, args.path, "read");
      const raw = await fs.readFile(fullPath, "utf-8");
      const lines = raw.split("\n");
      const startIdx = Math.max(0, (args.startLine ?? 1) - 1);
      const maxCount = args.maxLines ?? lines.length;
      const endIdx = args.endLine ? Math.min(lines.length, args.endLine) : startIdx + maxCount;
      return lines
        .slice(startIdx, endIdx)
        .map((line, i) => `${startIdx + i + 1}: ${line}`)
        .join("\n");
    },
  };

  const listDirTool: ToolContract<z.infer<typeof ListDirArgsSchema>> = {
    name: "list_dir",
    description: "列出指定目录下的文件与子目录名称",
    parameters: ListDirArgsSchema,
    readonly: true,
    async execute(args) {
      const fullPath = resolveSafePath(workspaceRoot, args.path, "read");
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n");
    },
  };

  const grepTool: ToolContract<z.infer<typeof GrepArgsSchema>> = {
    name: "grep",
    description: "在指定文件或目录中递归搜索包含关键词的行（支持 contextLines 附带上下文行）",
    parameters: GrepArgsSchema,
    readonly: true,
    execute: (args) => runGrepSearch(workspaceRoot, args),
  };

  return [readFileTool, listDirTool, grepTool];
}

async function executeSingleToolCall(
  call: ToolCall,
  toolMap: Map<string, ToolContract<any>>,
): Promise<ToolResultMessage> {
  const tool = toolMap.get(call.name);
  if (!tool) {
    return {
      role: "tool",
      toolCallId: call.id,
      name: call.name,
      content: `未知工具: ${call.name}`,
      isError: true,
    };
  }
  try {
    const validatedArgs = tool.parameters.parse(call.arguments);
    const output = await tool.execute(validatedArgs);
    return {
      role: "tool",
      toolCallId: call.id,
      name: call.name,
      content: String(output),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      role: "tool",
      toolCallId: call.id,
      name: call.name,
      content: `执行异常：${msg}`,
      isError: true,
    };
  }
}

export async function executeToolCalls(
  toolCalls: readonly ToolCall[],
  tools: readonly ToolContract<any>[],
): Promise<ToolResultMessage[]> {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const hasWriteOrSequentialTool = toolCalls.some((c) => toolMap.get(c.name)?.readonly === false);

  if (hasWriteOrSequentialTool) {
    const results: ToolResultMessage[] = [];
    for (const call of toolCalls) {
      results.push(await executeSingleToolCall(call, toolMap));
    }
    return results;
  }

  return Promise.all(toolCalls.map((call) => executeSingleToolCall(call, toolMap)));
}

/** 扫描技能目录提取 SKILL.md 极简索引（静态固化于 systemPrompt 尾部，按需通过 read_file 懒加载） */
export function buildSkillsIndex(skillDirs: readonly string[]): string {
  const entries: string[] = [];
  for (const rawDir of skillDirs) {
    const dir = rawDir.startsWith("~/") ? path.join(os.homedir(), rawDir.slice(2)) : rawDir;
    if (!fsSync.existsSync(dir)) continue;
    for (const sub of fsSync.readdirSync(dir, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const skillFile = path.join(dir, sub.name, "SKILL.md");
      if (!fsSync.existsSync(skillFile)) continue;
      const head = fsSync.readFileSync(skillFile, "utf-8").slice(0, 600);
      const name = head.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? sub.name;
      const desc = head.match(/^description:\s*([^\n]+)/m)?.[1]?.trim() ?? "专业技能指令";
      entries.push(`- ${name} (${skillFile}): ${desc}`);
    }
  }
  return entries.length > 0
    ? `\n<skills>\n需要特定领域指南时，请调用 read_file 读取对应 SKILL.md：\n${entries.join("\n")}\n</skills>`
    : "";
}
