import * as fs from "node:fs";
import type { ToolCall, ToolResultMessage } from "../core/contracts.js";
import { summarizeWireCost } from "./cost-tracker.js";
import { formatMarkdownLine, getVisualCols, type HttpWireLogEntry } from "./sse-stream.js";

export { formatMarkdownLine, getVisualCols };

const WRITE_VERBS_RE =
  /^(?:rm|mv|cp|mkdir|rmdir|touch|chmod|chown|chgrp|ln|unlink|tee|dd|install|truncate|shred|mkfs|mount|umount|kill|pkill|killall|sudo|su|doas|patch|tar|unzip|zip|gzip|gunzip|bzip2|xz|curl|wget|scp|rsync|ssh|sftp|nc|netcat|socat|apt|apt-get|yum|dnf|pacman|brew|npm|pnpm|yarn|bun|pip3?|poetry|uv|cargo|go|make|cmake|gradle|mvn|pytest|vitest|jest|docker|kubectl|systemctl|launchctl|service|crontab|at|eval|exec|source|\.)\b/;

const GIT_WRITE_SUBCMD_RE =
  /^git\s+(?:add|commit|push|pull|fetch|merge|rebase|cherry-pick|revert|reset|checkout|switch|restore|clean|stash|init|clone|am|apply|mv|rm|bisect|submodule|worktree|gc|prune|filter-branch|notes|replace|tag\s+-(?:d|-delete|a|s|f)|branch\s+(?:-[dDmM]|--(?:delete|move|copy))|remote\s+(?:add|remove|rm|rename|set-url|prune)|config\s+(?!--(?:get|get-all|list)\b)(?!-l\b))/;

export function shortenWorkspaceText(raw: string, workspaceRoot?: string): string {
  if (!raw) return raw;
  let res = raw;
  if (workspaceRoot) {
    const cleanRoot = workspaceRoot.replace(/\/$/, "");
    if (cleanRoot) {
      res = res.split(`${cleanRoot}/`).join("").split(cleanRoot).join(".");
    }
  }
  return res.replace(/^\s*cd\s+(?:"\."|'\.'|\.)\s*(?:&&|;)\s*/, "");
}

export function buildDefaultSystemPrompt(workspaceRoot: string): string {
  return [
    `你是运行在 Duo-Harness 宿主环境中的本地编程智能体（严禁自称 Claude 或 Anthropic 模型；当用户询问你的模型身份时，请按自身真实底层模型如实回答，如 DeepSeek 或小米 MiMo）。`,
    `- 当前工作区根目录 (workspaceRoot): ${workspaceRoot} (操作系统: ${process.platform})`,
    `- 工具使用纪律（必须严格遵守）：`,
    `  1. 查看目录与文件行数分布必须直接调用 list_dir（已自带 2 层目录树、每个代码文件的行数及忽略目录提示），读取文件内容调用 read_file（1000 行以内的文件请直接一次读完，不要拆成多步分段读；多个独立文件请在同一轮并发调用 tool_calls 读取），搜索代码调用 grep；严禁在可用内置只读工具时调用 run_bash 执行 cat/find/grep/ls/wc。`,
    `  2. 调用工具时 path 参数请直接传相对于工作区根目录的简短相对路径（如 "."、"README.md"、"src/index.ts"），不要重复拼接长绝对路径。`,
    `  3. run_bash 默认已在工作区根目录 (${workspaceRoot}) 下启动，严禁在命令开头拼接 cd "${workspaceRoot}" &&。`,
    `  4. 修改同一个文件的多处内容时，请使用 edit_file 的 edits 批量数组在单次调用中完成（或同一步并发调用多个 edit_file）；严禁通过 run_bash 调用 sed -i 或脚本改写源码文件。`,
    `  5. 思考过程（reasoning）请统一使用简明中文，调工具取证阶段思考控制在 150 字以内，聚焦下一步动作，不要长篇英文独白；最终回答请基于真实读取到的文件内容，直接给出清晰结论。`,
  ].join("\n");
}

export function isReadonlyBashCommand(cmd: string, explicitReadonly?: boolean): boolean {
  if (explicitReadonly === false) return false;
  const raw = cmd.trim();
  if (!raw || /`|\$\(|[\n\r]/.test(raw)) return false;
  if (/\bsed\b/.test(raw) && /\/[gIimM]*[ew](?:\s|$|['";])/.test(raw)) return false;
  const maskedQuotes = raw.replace(/(?:'[^']*'|"(?:[^"\\]|\\.)*")/g, '"__STR__"');
  if (/['"]/.test(maskedQuotes.replace(/"__STR__"/g, ""))) return false;
  const cleaned = maskedQuotes.replace(/\b2>\s*\/dev\/null\b|<\s*\/dev\/null\b|\b2>&1\b/g, "").trim();
  if (!cleaned || /[><]|(?:^|\s)(?:-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)|--(?:output|in-place))\b/.test(cleaned)) {
    return false;
  }
  const segments = cleaned.split(/\s*(?:\|\||&&|;|\|)\s*/);
  return segments.every((seg) => {
    const core = seg.trim().replace(/^(?:(?:[A-Za-z_]\w*=\S+|cd\s+\S+|(?:env|command|nice|time|nohup|xargs)(?:\s+-\S+)*)\s+)*/, "");
    if (!core || /(^|\s)&(\s|$)/.test(core) || /^(?:\.\.?\/|\/|~\/)/.test(core)) return false;
    if (/^(?:sort|tree)\b/.test(core) && /(?:^|\s)-o\b/.test(core)) return false;
    if (/^sed\b/.test(core) && /(?:^|\s)-[a-zA-Z]*[if]/.test(core)) return false;
    if (WRITE_VERBS_RE.test(core) || GIT_WRITE_SUBCMD_RE.test(core)) return false;
    if (/^(?:node|nodejs|deno|tsx|ts-node|python3?|ruby|perl|php|lua|sh|bash|zsh|fish|dash|ksh)\b/.test(core) && !/^(?:node|python3?)\s+(?:-v|--version|-V)\s*$/.test(core)) {
      return false;
    }
    return true;
  });
}

function describeSingleToolCall(call: ToolCall, readonlyMap: Map<string, boolean>, workspaceRoot?: string): { isWrite: boolean; text: string } {
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  const relPath = shortenWorkspaceText(String(args.path || "."), workspaceRoot);
  if (call.name === "list_dir") return { isWrite: false, text: `📂 查看目录: ${relPath}` };
  if (call.name === "read_file") {
    const range = args.startLine || args.endLine ? ` (第 ${args.startLine ?? 1}~${args.endLine ?? "末"} 行)` : "";
    return { isWrite: false, text: `📘 读取文件: ${shortenWorkspaceText(String(args.path ?? ""), workspaceRoot)}${range}` };
  }
  if (call.name === "grep") return { isWrite: false, text: `🔍 搜索代码: "${String(args.pattern ?? "")}" (${relPath})` };
  if (call.name === "edit_file") {
    const edits = Array.isArray(args.edits) ? args.edits : [];
    const isNew = !args.oldText && edits.length === 0;
    return { isWrite: true, text: `📝 ${isNew ? "新建文件" : "修改文件"}: ${shortenWorkspaceText(String(args.path ?? ""), workspaceRoot)}` };
  }
  if (call.name === "rollback_version") return { isWrite: true, text: `🔄 回退版本: 撤回最近 ${String(args.stepsBack ?? 1)} 步修改` };
  if (call.name === "run_bash") {
    const rawCmd = String(args.command ?? "").trim();
    const isRo = isReadonlyBashCommand(rawCmd, args.readonly as boolean | undefined);
    const displayCmd = shortenWorkspaceText(rawCmd, workspaceRoot);
    const shortCmd = displayCmd.length > 76 ? `${displayCmd.slice(0, 73)}...` : displayCmd;
    return { isWrite: !isRo, text: `${isRo ? "📊 统计/查询命令" : "💻 运行终端命令"}: ${shortCmd}` };
  }
  return { isWrite: readonlyMap.get(call.name) === false, text: `🔧 调用工具 ${call.name}: ${JSON.stringify(args).slice(0, 60)}` };
}

export function formatStepToolCalls(step: number, calls: readonly ToolCall[], readonlyMap: Map<string, boolean>, workspaceRoot?: string): string {
  const items = calls.map((c) => describeSingleToolCall(c, readonlyMap, workspaceRoot));
  const header = items.some((i) => i.isWrite) ? `\n🔧 [第 ${step} 步 · 准备执行修改或命令]` : `\n🔍 [第 ${step} 步 · 正在探索与读取项目]`;
  const treeLines = items.map((item, idx) => `${idx === items.length - 1 ? "  └─ " : "  ├─ "}${item.text}`);
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
      const rawEdits =
        Array.isArray(args.edits) && args.edits.length > 0
          ? (args.edits as { oldText?: string; newText?: string }[])
          : [{ oldText: String(args.oldText ?? ""), newText: String(args.newText ?? "") }];
      let oldLines = 0, newLines = 0;
      const preview: string[] = [];
      for (const ed of rawEdits) {
        const oArr = ed.oldText ? String(ed.oldText).split("\n") : [];
        const nArr = ed.newText ? String(ed.newText).split("\n") : [];
        oldLines += oArr.length;
        newLines += nArr.length;
        for (const l of oArr.slice(0, 2)) preview.push(`│   \x1b[31m- ${l.slice(0, 76)}\x1b[0m`);
        if (oArr.length > 2) preview.push(`│   \x1b[90m  ... (共删改 ${oArr.length} 行)\x1b[0m`);
        for (const l of nArr.slice(0, 2)) preview.push(`│   \x1b[32m+ ${l.slice(0, 76)}\x1b[0m`);
        if (nArr.length > 2) preview.push(`│   \x1b[90m  ... (共新增 ${nArr.length} 行)\x1b[0m`);
      }
      const diffSummary = oldLines === 0 ? `新建文件 (+${newLines} 行)` : `替换内容 (-${oldLines} 行 / +${newLines} 行)`;
      lines.push(`│ 📘 目标文件: ${shortenWorkspaceText(String(args.path ?? ""), workspaceRoot)} (${diffSummary})`);
      lines.push(...preview.slice(0, 6));
    } else if (c.name === "run_bash") {
      lines.push(`│ 💻 待执行命令: ${shortenWorkspaceText(String(args.command ?? ""), workspaceRoot)}`);
    } else {
      lines.push(`│ 🔧 待执行操作: ${c.name} (${shortenWorkspaceText(String(args.path ?? ""), workspaceRoot)})`);
    }
  }
  return lines.join("\n");
}

export interface FileDiffSummaryItem {
  file: string;
  isNew: boolean;
  edits: number;
  oldLines: number;
  newLines: number;
  removedPreview: string[];
  addedPreview: string[];
}

export function summarizeSnapshotsDiff(
  snapshots: readonly { path: string; beforeContent: string | null; afterContent: string }[],
  workspaceRoot?: string,
): FileDiffSummaryItem[] {
  const byFile = new Map<string, { before: string | null; after: string; edits: number }>();
  for (const s of snapshots) {
    const rel = shortenWorkspaceText(s.path, workspaceRoot);
    const prev = byFile.get(rel);
    byFile.set(rel, { before: prev ? prev.before : s.beforeContent, after: s.afterContent, edits: (prev?.edits ?? 0) + 1 });
  }
  return Array.from(byFile.entries()).map(([file, info]) => {
    const oldArr = info.before === null ? [] : info.before.split("\n");
    const newArr = info.after.split("\n");
    const oldSet = new Set(oldArr.map((l) => l.trim()).filter(Boolean));
    const newSet = new Set(newArr.map((l) => l.trim()).filter(Boolean));
    return {
      file,
      isNew: info.before === null,
      edits: info.edits,
      oldLines: oldArr.length,
      newLines: newArr.length,
      removedPreview: oldArr.filter((l) => l.trim() && !newSet.has(l.trim())).slice(0, 5),
      addedPreview: newArr.filter((l) => l.trim() && !oldSet.has(l.trim())).slice(0, 5),
    };
  });
}

export interface TurnMetricsSummary {
  activeModel: string;
  turnCostCny: number;
  totalCostCny: number;
  cacheHitRatePct: number;
}

export function computeTurnMetrics(wireLogFile: string, stepsUsed: number, isReplay = false): TurnMetricsSummary | null {
  try {
    if (!fs.existsSync(wireLogFile)) return null;
    const entries = JSON.parse(fs.readFileSync(wireLogFile, "utf-8")) as HttpWireLogEntry[];
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const s = summarizeWireCost(entries, { isReplay });
    if (s.rounds.length === 0) return null;
    const turnRounds = s.rounds.slice(-Math.max(1, (stepsUsed ?? 0) + 1));
    const turnIn = turnRounds.reduce((acc, r) => acc + r.promptTokens, 0);
    const turnHit = turnRounds.reduce((acc, r) => acc + r.cacheHitTokens, 0);
    return {
      activeModel: turnRounds[turnRounds.length - 1]?.model || "unknown",
      turnCostCny: turnRounds.reduce((acc, r) => acc + r.costCny, 0),
      totalCostCny: s.totalCostCny,
      cacheHitRatePct: turnIn > 0 ? (turnHit / turnIn) * 100 : s.overallCacheRatePct,
    };
  } catch {
    return null;
  }
}

export function formatCompactTurnFooter(
  wireLogFile: string,
  stepsUsed: number,
  isReplay = false,
  turnSnapshots: readonly { path: string; beforeContent: string | null; afterContent: string }[] = [],
  workspaceRoot?: string,
): string {
  const diffs = summarizeSnapshotsDiff(turnSnapshots, workspaceRoot);
  const modLines = diffs.length > 0 ? [`\n📋 [本轮共修改 ${diffs.length} 个文件 · 输入 /diff 查看代码对比 | 输入 /undo 撤回修改]:`, ...diffs.map((d) => `  ✏️  ${d.file} (${d.isNew ? `新建 +${d.newLines} 行` : `${d.oldLines} -> ${d.newLines} 行 (${d.edits} 处修改)`})`)] : [];
  const modPrefix = modLines.length > 0 ? `${modLines.join("\n")}\n` : "\n";
  const m = computeTurnMetrics(wireLogFile, stepsUsed, isReplay);
  if (m) {
    return `${modPrefix}✅ 本轮完成 (🤖 ${m.activeModel} · 共 ${stepsUsed} 步 · 💰 本轮 ¥${m.turnCostCny.toFixed(4)} / 累计 ¥${m.totalCostCny.toFixed(4)} · 缓存命中 ${m.cacheHitRatePct.toFixed(0)}% · 输入 /xray 查账单)`;
  }
  return `${modPrefix}✅ 本轮完成 (共 ${stepsUsed} 步)`;
}
