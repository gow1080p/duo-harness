import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import ignore from "ignore";
import { z } from "zod";
import type { ImageAttachment, ToolCall, ToolContract, ToolExecuteOutput, ToolResultMessage } from "../core/contracts.js";
import { toPosixRelative } from "./platform.js";
import { resolveSafePath, type SandboxGrants } from "./sandbox-policy.js";

export { resolveSafePath, type SandboxGrants };

export interface AdapterToolOutputObject { content: string; images?: ImageAttachment[]; details?: unknown; terminate?: boolean; }
export type AdapterToolOutput = string | AdapterToolOutputObject;
export interface AdapterToolResultMessage extends ToolResultMessage { details?: unknown; terminate?: boolean; }
export interface AdapterToolContract<TArgs = any> extends Omit<ToolContract<TArgs>, "execute"> {
  execute: (args: TArgs) => Promise<AdapterToolOutput> | AdapterToolOutput;
}

const ReadFileArgsSchema = z.object({
  path: z.string().min(1).describe("要读取的文件路径（支持工作区相对路径或已授权技能路径）"),
  startLine: z.number().int().min(0).optional().describe("起始行号（1-based，可选）"),
  endLine: z.number().int().positive().optional().describe("结束行号（含，可选）"),
  maxLines: z.number().int().positive().optional().describe("最大读取行数（可选）"),
});

const ListDirArgsSchema = z.object({
  path: z.string().default(".").describe("要列出的目录路径（默认当前工作区根目录 .）"),
});

const GrepArgsSchema = z.object({
  pattern: z.string().min(1).describe("要搜索的正则表达式或关键词"),
  path: z.string().default(".").describe("搜索的文件或目录路径（默认 .）"),
  contextLines: z.number().int().min(0).optional().describe("附带的前后上下文行数（0-15）"),
});

export const IGNORED_DIRS = new Set([".git", "node_modules", ".sessions", ".debug", "venv", ".venv", "__pycache__", "dist", "build", ".next"]);
export const BINARY_EXT_RE = /\.(png|jpe?g|gif|webp|ico|pdf|zip|tar|gz|woff2?|ttf|eot|mp[34]|mov|pyc|so|dylib|dll|exe|db|sqlite3?|lock)$/i;

function createWorkspaceIgnoreFilter(realRoot: string): (relPosixPath: string, isDir?: boolean) => boolean {
  const ig = ignore();
  for (const d of IGNORED_DIRS) ig.add(`${d}/`);
  try {
    const gitignorePath = path.join(realRoot, ".gitignore");
    if (fsSync.existsSync(gitignorePath)) ig.add(fsSync.readFileSync(gitignorePath, "utf-8"));
  } catch {}
  return (relPosixPath: string, isDir = false) => {
    const clean = relPosixPath.replace(/\\/g, "/").replace(/^(?:\.\/|\/)+|\/+$/g, "");
    if (!clean || clean === "." || clean.startsWith("..")) return false;
    try { return ig.ignores(isDir ? `${clean}/` : clean); } catch { return false; }
  };
}

async function runGrepSearch(workspaceRoot: string, args: z.infer<typeof GrepArgsSchema>, grants?: SandboxGrants): Promise<string> {
  const realRoot = resolveSafePath(workspaceRoot, ".", "read", grants), fullPath = resolveSafePath(workspaceRoot, args.path, "read", grants);
  const isIgnored = createWorkspaceIgnoreFilter(realRoot);
  const stat = await fs.stat(fullPath);
  const files = stat.isDirectory()
    ? (await fs.readdir(fullPath, { recursive: true, withFileTypes: true }))
        .filter((e) => {
          if (!e.isFile() || BINARY_EXT_RE.test(e.name)) return false;
          const entryFull = path.join(e.parentPath, e.name);
          if (path.relative(fullPath, e.parentPath).split(path.sep).some((p) => IGNORED_DIRS.has(p))) return false;
          return !isIgnored(toPosixRelative(realRoot, entryFull), false);
        })
        .map((e) => path.join(e.parentPath, e.name))
    : [fullPath];
  let regex: RegExp;
  try { regex = new RegExp(args.pattern, "i"); } catch { regex = new RegExp(args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
  const ctx = Math.min(Math.max(0, args.contextLines ?? 0), 15), matches: string[] = [];
  for (const file of files) {
    const fStat = await fs.stat(file).catch(() => null);
    if (!fStat || !fStat.isFile() || fStat.size > 512_000) continue;
    const raw = await fs.readFile(file, "utf-8").catch(() => "");
    if (!raw || raw.includes("\u0000")) continue;
    const lines = raw.split("\n"), rel = toPosixRelative(realRoot, file);
    lines.forEach((line, idx) => {
      if (regex.test(line)) {
        const snippet = lines.slice(Math.max(0, idx - ctx), Math.min(lines.length - 1, idx + ctx) + 1).map((l) => l.trim()).join(" | ");
        matches.push(`${rel}:${idx + 1}: ${snippet}`);
      }
    });
  }
  if (matches.length === 0) return "未找到匹配内容";
  const shown = matches.slice(0, 50).join("\n");
  return matches.length > 50 ? `${shown}\n... [共找到 ${matches.length} 处匹配，仅展示前 50 处，请缩小 path 或 pattern 范围]` : shown;
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

const BITMAP_IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|ico)$/i;

function detectBitmapMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".ico") return "image/x-icon";
  return "image/png";
}

async function runReadFile(
  workspaceRoot: string,
  args: z.infer<typeof ReadFileArgsSchema>,
  grants?: SandboxGrants,
): Promise<ToolExecuteOutput> {
  const realRoot = resolveSafePath(workspaceRoot, ".", "read", grants);
  const fullPath = resolveSafePath(workspaceRoot, args.path, "read", grants);
  const stat = await fs.stat(fullPath);
  if (BITMAP_IMAGE_EXT_RE.test(fullPath)) {
    const mimeType = detectBitmapMimeType(fullPath);
    if (stat.size > 5 * 1024 * 1024) {
      return `Read image file [${mimeType}] failed: file size (${stat.size} bytes) exceeds 5MB limit.`;
    }
    const rel = toPosixRelative(realRoot, fullPath) || path.basename(fullPath);
    const imgPath = rel.startsWith("..") ? fullPath : rel;
    const kb = Math.max(1, Math.round(stat.size / 1024));
    return {
      content: `Read image file [${mimeType}] (${kb} KB)`,
      images: [{ path: imgPath, mimeType, byteSize: stat.size }],
    };
  }
  if (BINARY_EXT_RE.test(fullPath) || stat.size > 2_000_000) {
    return `[二进制或超大文件 (${stat.size} bytes)，无法通过 read_file 作为 UTF-8 文本读取]`;
  }
  const raw = await fs.readFile(fullPath, "utf-8");
  if (raw.includes("\u0000")) {
    return `[二进制文件 (含 NUL 字节)，无法作为 UTF-8 文本读取]`;
  }
  const lines = raw.split("\n");
  const startIdx = Math.max(0, (args.startLine ?? 1) - 1);
  const endIdx = Math.min(lines.length, args.endLine ? args.endLine : startIdx + (args.maxLines ?? lines.length));
  const out = lines.slice(startIdx, endIdx).map((line, i) => `${startIdx + i + 1}: ${line}`).join("\n");
  const rangeNote = startIdx > 0 || endIdx < lines.length ? `\n... [文件共 ${lines.length} 行，当前显示第 ${startIdx + 1}-${Math.max(startIdx + 1, endIdx)} 行]` : "";
  return out.length > 80_000 ? `${out.slice(0, 80_000)}\n... [单次读取超出 80,000 字符已截断，请传 startLine/endLine 分片读取]` : `${out}${rangeNote}`;
}

async function runListDir(workspaceRoot: string, args: z.infer<typeof ListDirArgsSchema>, grants?: SandboxGrants): Promise<string> {
  const realRoot = resolveSafePath(workspaceRoot, ".", "read", grants);
  const fullPath = resolveSafePath(workspaceRoot, args.path, "read", grants);
  const isIgnored = createWorkspaceIgnoreFilter(realRoot);
  const entries = await fs.readdir(fullPath, { withFileTypes: true });
  const lines: string[] = [], ignoredFound: string[] = [];
  for (const e of entries) {
    const entryFull = path.join(fullPath, e.name);
    if (IGNORED_DIRS.has(e.name) || (e.isDirectory() && isIgnored(toPosixRelative(realRoot, entryFull), true))) {
      if (e.isDirectory() && e.name !== ".git" && e.name !== ".sessions" && e.name !== ".debug") ignoredFound.push(`${e.name}/`);
      continue;
    }
    if (e.isDirectory()) {
      lines.push(`${e.name}/`);
      const subPath = path.join(fullPath, e.name);
      const subEntries = await fs.readdir(subPath, { withFileTypes: true }).catch(() => []);
      for (const sub of subEntries.slice(0, 25)) {
        const subFull = path.join(subPath, sub.name);
        if (!IGNORED_DIRS.has(sub.name) && !(sub.isDirectory() && isIgnored(toPosixRelative(realRoot, subFull), true))) {
          const relSub = `${e.name}/${sub.name}`;
          lines.push(`  ${sub.isDirectory() ? `${relSub}/` : formatFileWithLineCount(subFull, relSub)}`);
        } else if (sub.isDirectory() && sub.name !== ".git" && sub.name !== ".sessions" && sub.name !== ".debug") {
          ignoredFound.push(`${e.name}/${sub.name}/`);
        }
      }
      if (subEntries.length > 25) lines.push(`  ... (其余 ${subEntries.length - 25} 项已省略，可对该子目录单独调用 list_dir)`);
    } else {
      lines.push(formatFileWithLineCount(entryFull, e.name));
    }
  }
  if (ignoredFound.length > 0) lines.push(`[已过滤忽略目录: ${ignoredFound.join(", ")}]`);
  return lines.join("\n");
}

export function createBuiltinTools(workspaceRoot: string = process.cwd(), grants?: SandboxGrants): ToolContract<any>[] {
  const readFileTool: ToolContract<z.infer<typeof ReadFileArgsSchema>> = {
    name: "read_file",
    description: "读取指定文件的内容（支持文本代码 startLine/endLine 行区间切片，以及读取 png/jpg/gif/webp 图片并作为多模态附件返回）",
    parameters: ReadFileArgsSchema,
    readonly: true,
    execute: (args) => runReadFile(workspaceRoot, args, grants),
  };

  const listDirTool: ToolContract<z.infer<typeof ListDirArgsSchema>> = {
    name: "list_dir",
    description:
      "列出指定目录的项目结构树（自动展开 2 层子目录、附带每个代码文件的行数并提示已过滤目录，看项目结构或评估文件规模请直接调本工具）",
    parameters: ListDirArgsSchema,
    readonly: true,
    execute: (args) => runListDir(workspaceRoot, args, grants),
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
): Promise<AdapterToolResultMessage> {
  const tool = toolMap.get(call.name);
  if (!tool) {
    return { role: "tool", toolCallId: call.id, name: call.name, content: `未知工具: ${call.name}`, isError: true };
  }
  try {
    if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments) || "_invalidJson" in call.arguments) {
      throw new Error(`工具参数 JSON 格式非法或流式输出被截断: ${String((call.arguments as any)?._invalidJson ?? JSON.stringify(call.arguments)).slice(0, 200)}`);
    }
    const parsedArgs = tool.parameters ? tool.parameters.parse(call.arguments) : call.arguments;
    const output = (await tool.execute(parsedArgs)) as AdapterToolOutput;
    if (typeof output === "object" && output !== null && "content" in output) {
      return {
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: String(output.content),
        ...(output.images && output.images.length > 0 ? { images: output.images } : {}),
        ...(output.details !== undefined ? { details: output.details } : {}),
        ...(output.terminate !== undefined ? { terminate: Boolean(output.terminate) } : {}),
        isError: false,
      };
    }
    return { role: "tool", toolCallId: call.id, name: call.name, content: String(output), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { role: "tool", toolCallId: call.id, name: call.name, content: `执行异常：${msg}`, isError: true };
  }
}

export async function executeToolCalls(
  toolCalls: readonly ToolCall[],
  tools: readonly ToolContract<any>[],
): Promise<AdapterToolResultMessage[]> {
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
