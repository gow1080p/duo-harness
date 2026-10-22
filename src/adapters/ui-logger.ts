import * as fs from "node:fs";
import type { ToolCall, ToolResultMessage } from "../core/contracts.js";
import { summarizeWireCost } from "./cost-tracker.js";
import type { HttpWireLogEntry } from "./sse-stream.js";

const SAFE_CMD_PREFIX =
  /^(ls|find|wc|head|tail|cat|pwd|which|stat|file|grep|rg|tree|du|df|echo|cd|sort|uniq|uname|realpath|basename|dirname|nl|cut|tr|sed|column|paste|comm|diff|xargs\s+(wc|head|tail|cat|grep|rg|file|stat)|git\s+(status|diff|log|show|rev-parse|remote\s+-v|tag\s+(-l|--list)|branch\s+(--show-current|-a|-r|--list))|node\s+(-v|--version)|python3?\s+(-V|--version))\b/;

export function shortenWorkspaceText(raw: string, workspaceRoot?: string): string {
  if (!raw || !workspaceRoot) return raw;
  const cleanRoot = workspaceRoot.replace(/\/$/, "");
  if (!cleanRoot) return raw;
  return raw
    .split(`${cleanRoot}/`)
    .join("")
    .split(cleanRoot)
    .join(".");
}

export function buildDefaultSystemPrompt(workspaceRoot: string): string {
  return [
    `你是一个运行在本地代码库中的专业编程智能体。`,
    `- 当前工作区根目录 (workspaceRoot): ${workspaceRoot} (操作系统: ${process.platform})`,
    `- 工具使用纪律（必须严格遵守）：`,
    `  1. 查看目录必须优先调用 list_dir，读取文件必须优先调用 read_file，搜索代码必须优先调用 grep；严禁在可用内置只读工具时调用 run_bash 执行 cat/find/grep/ls，也严禁盲猜 /home/user 等路径。`,
    `  2. 调用工具时 path 参数请直接传相对于工作区根目录的简短相对路径（如 "."、"README.md"、"src/index.ts"），不要重复拼接长绝对路径。`,
    `  3. 仅在需要统计行数 (wc -l)、运行测试、构建或执行 Git 命令时才调用 run_bash。`,
    `  4. 回答请基于真实读取到的文件内容，直接给出清晰结论，简明扼要。`,
  ].join("\n");
}

export function isReadonlyBashCommand(cmd: string): boolean {
  const raw = cmd.trim();
  if (!raw || /`|\$\(|[\n\r]/.test(raw)) return false;
  if (/\bsed\b/.test(raw) && /\/[gIimM]*[ew](?:\s|$|['";])/.test(raw)) return false;
  const maskedQuotes = raw
    .replace(/'[^']*'/g, '"__STR__"')
    .replace(/"(?:[^"\\]|\\.)*"/g, '"__STR__"');
  const cleaned = maskedQuotes
    .replace(/\b2>\s*\/dev\/null\b/g, "")
    .replace(/<\s*\/dev\/null\b/g, "")
    .replace(/\b2>&1\b/g, "")
    .trim();
  if (
    !cleaned ||
    /[><]|(?:^|\s)(?:-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)|--(?:output|in-place))\b/.test(
      cleaned,
    )
  ) {
    return false;
  }
  const segments = cleaned.split(/\s*(?:\|\||&&|;|\|)\s*/);
  return segments.every((seg) => {
    const s = seg.trim();
    if (!s || /(^|\s)&(\s|$)/.test(s)) return false;
    if (/^(?:sort|tree)\b/.test(s) && /(?:^|\s)-o\b/.test(s)) return false;
    if (/^sed\b/.test(s) && /(?:^|\s)-[a-zA-Z]*[if]/.test(s)) return false;
    return SAFE_CMD_PREFIX.test(s);
  });
}

function describeSingleToolCall(
  call: ToolCall,
  readonlyMap: Map<string, boolean>,
  workspaceRoot?: string,
): { isWrite: boolean; text: string } {
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  const relPath = shortenWorkspaceText(String(args.path || "."), workspaceRoot);
  if (call.name === "list_dir") {
    return { isWrite: false, text: `📂 查看目录: ${relPath}` };
  }
  if (call.name === "read_file") {
    const range =
      args.startLine || args.endLine ? ` (第 ${args.startLine ?? 1}~${args.endLine ?? "末"} 行)` : "";
    return { isWrite: false, text: `📘 读取文件: ${shortenWorkspaceText(String(args.path ?? ""), workspaceRoot)}${range}` };
  }
  if (call.name === "grep") {
    return { isWrite: false, text: `🔍 搜索代码: "${String(args.pattern ?? "")}" (${relPath})` };
  }
  if (call.name === "edit_file") {
    const isNew = !args.oldText;
    return { isWrite: true, text: `📝 ${isNew ? "新建文件" : "修改文件"}: ${shortenWorkspaceText(String(args.path ?? ""), workspaceRoot)}` };
  }
  if (call.name === "rollback_version") {
    return { isWrite: true, text: `🔄 回退版本: 撤回最近 ${String(args.stepsBack ?? 1)} 步修改` };
  }
  if (call.name === "run_bash") {
    const rawCmd = String(args.command ?? "").trim();
    const isRo = isReadonlyBashCommand(rawCmd);
    const displayCmd = shortenWorkspaceText(rawCmd, workspaceRoot);
    const shortCmd = displayCmd.length > 76 ? `${displayCmd.slice(0, 73)}...` : displayCmd;
    return { isWrite: !isRo, text: `${isRo ? "📊 统计/查询命令" : "💻 运行终端命令"}: ${shortCmd}` };
  }
  const isWrite = readonlyMap.get(call.name) === false;
  return { isWrite, text: `🔧 调用工具 ${call.name}: ${JSON.stringify(args).slice(0, 60)}` };
}

export function formatStepToolCalls(
  step: number,
  calls: readonly ToolCall[],
  readonlyMap: Map<string, boolean>,
  workspaceRoot?: string,
): string {
  const items = calls.map((c) => describeSingleToolCall(c, readonlyMap, workspaceRoot));
  const hasWrite = items.some((i) => i.isWrite);
  const header = hasWrite
    ? `\n🔧 [第 ${step} 步 · 准备执行修改或命令]`
    : `\n🔍 [第 ${step} 步 · 正在探索与读取项目]`;
  const treeLines = items.map((item, idx) => {
    const branch = idx === items.length - 1 ? "  └─ " : "  ├─ ";
    return `${branch}${item.text}`;
  });
  return [header, ...treeLines].join("\n");
}

export function formatToolResultLine(result: ToolResultMessage): string {
  if (result.isError) {
    const errPreview = result.content.replace(/\s+/g, " ").slice(0, 72);
    return `     ⚠️ 执行出错 (${result.name}): ${errPreview}${result.content.length > 72 ? "..." : ""}`;
  }
  const lineCount = result.content ? result.content.split("\n").length : 0;
  return `     ↳ 完成 (${result.name} · 共 ${lineCount} 行)`;
}

export function formatApprovalBox(toolCalls: readonly ToolCall[], workspaceRoot?: string): string {
  const hasEdit = toolCalls.some((c) => c.name === "edit_file");
  const hasBash = toolCalls.some((c) => c.name === "run_bash");
  const title =
    hasEdit && hasBash
      ? "⚠️  [阶段：申请修改文件并执行命令 · 需你确认]"
      : hasEdit
        ? "📝 [阶段：申请修改文件 · 需你确认]"
        : "💻 [阶段：申请执行终端命令 · 需你确认]";
  const lines: string[] = [`\n┌─ ${title} ──────────────────────`];
  for (const c of toolCalls) {
    const args = (c.arguments ?? {}) as Record<string, unknown>;
    if (c.name === "edit_file") {
      const oldStr = String(args.oldText ?? "");
      const newStr = String(args.newText ?? "");
      const oldLines = oldStr ? oldStr.split("\n").length : 0;
      const newLines = newStr ? newStr.split("\n").length : 0;
      const diffSummary = !oldStr ? `新建文件 (+${newLines} 行)` : `替换内容 (-${oldLines} 行 / +${newLines} 行)`;
      lines.push(`│ 📘 目标文件: ${shortenWorkspaceText(String(args.path ?? ""), workspaceRoot)} (${diffSummary})`);
    } else if (c.name === "run_bash") {
      lines.push(`│ 💻 待执行命令: ${shortenWorkspaceText(String(args.command ?? ""), workspaceRoot)}`);
    } else {
      lines.push(`│ 🔧 待执行操作: ${c.name} (${shortenWorkspaceText(String(args.path ?? ""), workspaceRoot)})`);
    }
  }
  return lines.join("\n");
}

export function formatCompactTurnFooter(wireLogFile: string, stepsUsed: number, isReplay = false): string {
  try {
    if (fs.existsSync(wireLogFile)) {
      const entries = JSON.parse(fs.readFileSync(wireLogFile, "utf-8")) as HttpWireLogEntry[];
      if (Array.isArray(entries) && entries.length > 0) {
        const s = summarizeWireCost(entries, { isReplay });
        if (s.rounds.length > 0) {
          return `\n✅ 本轮完成 (共 ${stepsUsed} 步 · 💰 累计实付 ¥${s.totalCostCny.toFixed(4)} · 缓存命中 ${s.overallCacheRatePct.toFixed(0)}% · 输入 /xray 查看完整账单)`;
        }
      }
    }
  } catch {
    // ignore wire read errors
  }
  return `\n✅ 本轮完成 (共 ${stepsUsed} 步)`;
}
