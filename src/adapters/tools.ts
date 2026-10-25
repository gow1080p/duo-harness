import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { ToolCall, ToolContract, ToolResultMessage } from "../core/contracts.js";
import { toPosixRelative } from "./platform.js";
import { resolveSafePath, type SandboxGrants } from "./sandbox-policy.js";

export { resolveSafePath, type SandboxGrants };

const ReadFileArgsSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().min(0).optional(),
  endLine: z.number().int().positive().optional(),
  maxLines: z.number().int().positive().optional(),
});

const ListDirArgsSchema = z.object({
  path: z.string().default("."),
});

const GrepArgsSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().default("."),
  contextLines: z.number().int().min(0).optional(),
});

export const IGNORED_DIRS = new Set([".git", "node_modules", ".sessions", "venv", ".venv", "__pycache__", "dist", "build", ".next"]);
export const BINARY_EXT_RE = /\.(png|jpe?g|gif|webp|ico|pdf|zip|tar|gz|woff2?|ttf|eot|mp[34]|mov|pyc|so|dylib|dll|exe|db|sqlite3?|lock)$/i;

async function runGrepSearch(
  workspaceRoot: string,
  args: z.infer<typeof GrepArgsSchema>,
  grants?: SandboxGrants,
): Promise<string> {
  const realRoot = resolveSafePath(workspaceRoot, ".", "read", grants);
  const fullPath = resolveSafePath(workspaceRoot, args.path, "read", grants);
  const stat = await fs.stat(fullPath);
  const files = stat.isDirectory()
    ? (await fs.readdir(fullPath, { recursive: true, withFileTypes: true }))
        .filter((e) => {
          if (!e.isFile() || BINARY_EXT_RE.test(e.name)) return false;
          const relParts = path.relative(fullPath, e.parentPath).split(path.sep);
          return !relParts.some((p) => IGNORED_DIRS.has(p));
        })
        .map((e) => path.join(e.parentPath, e.name))
    : [fullPath];

  let regex: RegExp;
  try {
    regex = new RegExp(args.pattern, "i");
  } catch {
    const escaped = args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    regex = new RegExp(escaped, "i");
  }
  const ctx = Math.min(Math.max(0, args.contextLines ?? 0), 15);
  const matches: string[] = [];
  for (const file of files) {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat || !stat.isFile() || stat.size > 512_000) continue;
    const raw = await fs.readFile(file, "utf-8").catch(() => "");
    if (!raw || raw.includes("\u0000")) continue;
    const lines = raw.split("\n");
    const rel = toPosixRelative(realRoot, file);
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

function formatFileWithLineCount(fullFilePath: string, displayName: string): string {
  if (BINARY_EXT_RE.test(displayName)) return displayName;
  try {
    const stat = fsSync.statSync(fullFilePath);
    if (!stat.isFile() || stat.size > 512_000) return displayName;
    const raw = fsSync.readFileSync(fullFilePath, "utf-8");
    if (raw.includes("\u0000")) return displayName;
    return `${displayName} (${raw.split("\n").length} lines)`;
  } catch {
    return displayName;
  }
}

export function createBuiltinTools(workspaceRoot: string = process.cwd(), grants?: SandboxGrants): ToolContract<any>[] {
  const readFileTool: ToolContract<z.infer<typeof ReadFileArgsSchema>> = {
    name: "read_file",
    description: "读取指定文件的文本内容（支持 startLine/endLine 行区间切片，附带行号）",
    parameters: ReadFileArgsSchema,
    readonly: true,
    async execute(args) {
      const fullPath = resolveSafePath(workspaceRoot, args.path, "read", grants);
      const lines = (await fs.readFile(fullPath, "utf-8")).split("\n");
      const startIdx = Math.max(0, (args.startLine ?? 1) - 1);
      const endIdx = args.endLine ? Math.min(lines.length, args.endLine) : startIdx + (args.maxLines ?? lines.length);
      return lines.slice(startIdx, endIdx).map((line, i) => `${startIdx + i + 1}: ${line}`).join("\n");
    },
  };

  const listDirTool: ToolContract<z.infer<typeof ListDirArgsSchema>> = {
    name: "list_dir",
    description:
      "列出指定目录的项目结构树（自动展开 2 层子目录、附带每个代码文件的行数并提示已过滤目录，看项目结构或评估文件规模请直接调本工具）",
    parameters: ListDirArgsSchema,
    readonly: true,
    async execute(args) {
      const fullPath = resolveSafePath(workspaceRoot, args.path, "read", grants);
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      const lines: string[] = [];
      const ignoredFound: string[] = [];
      for (const e of entries) {
        if (IGNORED_DIRS.has(e.name)) {
          if (e.isDirectory() && e.name !== ".git" && e.name !== ".sessions") ignoredFound.push(`${e.name}/`);
          continue;
        }
        if (e.isDirectory()) {
          lines.push(`${e.name}/`);
          const subPath = path.join(fullPath, e.name);
          const subEntries = await fs.readdir(subPath, { withFileTypes: true }).catch(() => []);
          for (const sub of subEntries.slice(0, 25)) {
            if (!IGNORED_DIRS.has(sub.name)) {
              const relSub = `${e.name}/${sub.name}`;
              lines.push(`  ${sub.isDirectory() ? `${relSub}/` : formatFileWithLineCount(path.join(subPath, sub.name), relSub)}`);
            } else if (sub.isDirectory() && sub.name !== ".git" && sub.name !== ".sessions") {
              ignoredFound.push(`${e.name}/${sub.name}/`);
            }
          }
        } else {
          lines.push(formatFileWithLineCount(path.join(fullPath, e.name), e.name));
        }
      }
      if (ignoredFound.length > 0) lines.push(`[已过滤忽略目录: ${ignoredFound.join(", ")}]`);
      return lines.join("\n");
    },
  };

  const grepTool: ToolContract<z.infer<typeof GrepArgsSchema>> = {
    name: "grep",
    description: "在指定文件或目录中递归搜索包含关键词的行（支持 contextLines 附带上下文行）",
    parameters: GrepArgsSchema,
    readonly: true,
    execute: (args) => runGrepSearch(workspaceRoot, args, grants),
  };

  return [readFileTool, listDirTool, grepTool];
}

async function executeSingleToolCall(
  call: ToolCall,
  toolMap: Map<string, ToolContract<any>>,
): Promise<ToolResultMessage> {
  const tool = toolMap.get(call.name);
  if (!tool) {
    return { role: "tool", toolCallId: call.id, name: call.name, content: `未知工具: ${call.name}`, isError: true };
  }
  try {
    const output = await tool.execute(tool.parameters.parse(call.arguments));
    return { role: "tool", toolCallId: call.id, name: call.name, content: String(output), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { role: "tool", toolCallId: call.id, name: call.name, content: `执行异常：${msg}`, isError: true };
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
