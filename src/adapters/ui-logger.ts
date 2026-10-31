import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolCall, ToolResultMessage } from "../core/contracts.js";
import { buildDefaultSystemPrompt, cleanDisplayBash, isReadonlyBashCommand, resolveBashWorkingDir } from "./bash-policy.js";
import { computeTurnMetrics, type TurnMetricsSummary } from "./cost-tracker.js";
import { extractChangedHunk, type FileDiffSummaryItem, formatIntraLineDiffPair, normalizeEditsArray, summarizeSnapshotsDiff, truncateVisualCols } from "./diff-presenter.js";
import { formatMarkdownLine, formatWrappedMarkdownLine, renderMarkdownDocument, renderMarkdownTable, wrapReasoningLines } from "./md-renderer.js";
import { formatClickablePath, getCharVisualWidth, getVisualCols, shortenWorkspaceText } from "./platform.js";

export {
  buildDefaultSystemPrompt, cleanDisplayBash, computeTurnMetrics, type FileDiffSummaryItem, formatMarkdownLine,
  formatWrappedMarkdownLine, getCharVisualWidth, getVisualCols, isReadonlyBashCommand, normalizeEditsArray,
  renderMarkdownDocument, renderMarkdownTable, shortenWorkspaceText, summarizeSnapshotsDiff, type TurnMetricsSummary, wrapReasoningLines,
};

export function formatStepToolCalls(step: number, calls: readonly ToolCall[], readonlyMap: Map<string, boolean>, workspaceRoot?: string): string {
  const editCounts = new Map<string, { count: number; isNew: boolean }>();
  for (const c of calls) {
    if (c.name !== "edit_file") continue;
    const args = (c.arguments ?? {}) as Record<string, unknown>;
    const rel = shortenWorkspaceText(String(args.path ?? ""), workspaceRoot);
    const edits = normalizeEditsArray(args.edits);
    const fullPath = workspaceRoot ? path.resolve(workspaceRoot, String(args.path ?? "")) : "";
    const isNew = !args.oldText && (edits.length === 0 || edits.every((e) => !e.oldText)) && (!fullPath || !fs.existsSync(fullPath));
    const prev = editCounts.get(rel);
    editCounts.set(rel, { count: (prev?.count ?? 0) + Math.max(1, edits.length), isNew: prev ? prev.isNew && isNew : isNew });
  }
  const seenEdits = new Set<string>(), items: { isWrite: boolean; text: string }[] = [];
  for (const call of calls) {
    const args = (call.arguments ?? {}) as Record<string, unknown>;
    const relPath = shortenWorkspaceText(String(args.path || "."), workspaceRoot);
    if (call.name === "edit_file") {
      const rel = shortenWorkspaceText(String(args.path ?? ""), workspaceRoot);
      if (seenEdits.has(rel)) continue;
      seenEdits.add(rel);
      const info = editCounts.get(rel)!, suffix = !info.isNew && info.count > 1 ? ` (${info.count} 处修改)` : "";
      items.push({ isWrite: true, text: `📝 ${info.isNew ? "新建文件" : "修改文件"}: ${rel}${suffix}` });
    } else if (call.name === "list_dir") items.push({ isWrite: false, text: `📂 查看目录: ${relPath}` });
    else if (call.name === "read_file") {
      const range = args.startLine || args.endLine ? ` (第 ${args.startLine ?? 1}~${args.endLine ?? "末"} 行)` : "";
      items.push({ isWrite: false, text: `📘 读取文件: ${shortenWorkspaceText(String(args.path ?? ""), workspaceRoot)}${range}` });
    } else if (call.name === "grep") items.push({ isWrite: false, text: `🔍 搜索代码: "${String(args.pattern ?? "")}" (${relPath})` });
    else if (call.name === "fetch_url") items.push({ isWrite: false, text: `🌐 读取网页/文档: ${truncateVisualCols(String(args.url ?? ""), 60)}` });
    else if (call.name === "delegate_research") {
      const count = Array.isArray(args.tasks) ? args.tasks.length : 1;
      const desc = Array.isArray(args.tasks) ? `并行 ${count} 路探路任务` : truncateVisualCols(String(args.task ?? ""), 54);
      items.push({ isWrite: false, text: `🤖 委派子代理探路: ${desc}` });
    } else if (call.name === "rollback_version") items.push({ isWrite: true, text: `🔄 回退版本: 撤回最近 ${String(args.stepsBack ?? 1)} 步修改` });
    else if (call.name === "run_bash") {
      const { relCwd, effectiveCwd, command } = resolveBashWorkingDir(args, workspaceRoot);
      const isRo = isReadonlyBashCommand(command, args.readonly as boolean | undefined, workspaceRoot, effectiveCwd);
      const parts = cleanDisplayBash(command, workspaceRoot, effectiveCwd);
      const ordered = !isRo && parts.length > 1 ? [...parts.filter((p) => !isReadonlyBashCommand(p, undefined, workspaceRoot, effectiveCwd)), ...parts.filter((p) => isReadonlyBashCommand(p, undefined, workspaceRoot, effectiveCwd))] : parts;
      items.push({ isWrite: !isRo, text: `${isRo ? "📊 统计/查询命令" : "💻 运行终端命令"}${relCwd ? ` [${relCwd}]` : ""}: ${truncateVisualCols(ordered.join(" · "), 64)}` });
    } else items.push({ isWrite: readonlyMap.get(call.name) === false, text: `🔧 调用工具 ${call.name}: ${truncateVisualCols(JSON.stringify(args), 54)}` });
  }
  const header = items.some((i) => i.isWrite) ? `\n🔧 [第 ${step} 步 · 准备执行修改或命令]` : `\n🔍 [第 ${step} 步 · 正在探索与读取项目]`;
  return [header, ...items.map((item, idx) => `${idx === items.length - 1 ? "  └─ " : "  ├─ "}${item.text}`)].join("\n");
}

export function formatApprovalBox(toolCalls: readonly ToolCall[], workspaceRoot?: string, expandAll = false, escalatedReasons: readonly string[] = []): string {
  const groupedEdits = new Map<string, { rawPath: string; hunks: { oldText: string; newText: string }[] }>();
  let totalHunks = 0, bashCount = 0;
  for (const c of toolCalls) {
    const args = (c.arguments ?? {}) as Record<string, unknown>;
    if (c.name === "edit_file") {
      const rawPath = String(args.path ?? ""), rel = shortenWorkspaceText(rawPath, workspaceRoot);
      const parsed = normalizeEditsArray(args.edits), list = parsed.length > 0 ? parsed : [{ oldText: String(args.oldText ?? ""), newText: String(args.newText ?? "") }];
      const entry = groupedEdits.get(rel) ?? { rawPath, hunks: [] };
      for (const h of list) entry.hunks.push({ oldText: String(h.oldText ?? ""), newText: String(h.newText ?? "") });
      groupedEdits.set(rel, entry); totalHunks += list.length;
    } else if (c.name === "run_bash") bashCount++;
  }
  const scopeParts = [...(groupedEdits.size > 0 ? [`申请修改文件 ${groupedEdits.size} 个 (共 ${totalHunks} 处)`] : []), ...(bashCount > 0 ? [`申请执行终端命令 ${bashCount} 条`] : [])];
  const isEsc = escalatedReasons.length > 0, icon = isEsc ? "🚨" : groupedEdits.size > 0 && bashCount > 0 ? "⚠️ " : groupedEdits.size > 0 ? "📝" : "💻";
  const lines: string[] = [`\n┌─ ${icon} [${isEsc ? "跨界/系统级提权确认：" : "待确认：本次"}${scopeParts.join(" · ") || "申请执行工具操作"}${expandAll ? " · 已展开全部明细" : ""}] ──────────────`];
  for (const r of escalatedReasons) lines.push(`│ \x1b[33m⚠️ 提权原因: ${r}\x1b[0m`);
  const defaultCols = Math.max(66, Math.min((process.stdout.columns || 96) - 8, 120));
  const maxHunks = expandAll ? 1000 : 4, maxLines = expandAll ? 120 : 2, maxCols = expandAll ? 140 : defaultCols;
  for (const [rel, { rawPath, hunks }] of groupedEdits.entries()) {
    const existed = Boolean(workspaceRoot && fs.existsSync(path.resolve(workspaceRoot, rawPath)));
    const diffs = hunks.map((h) => extractChangedHunk(h.oldText, h.newText));
    const oldLines = diffs.reduce((a, d) => a + d.removed.length, 0), newLines = diffs.reduce((a, d) => a + d.added.length, 0);
    const diffSummary = hunks.every((h) => !h.oldText) ? (existed ? `覆盖文件 (+${newLines} 行)` : `新建文件 (+${newLines} 行)`) : `${hunks.length > 1 ? `共 ${hunks.length} 处修改 · ` : ""}替换内容 (-${oldLines} 行 / +${newLines} 行)`;
    lines.push(`│ 📘 目标文件: ${rel} (${diffSummary})`);
    for (let i = 0; i < Math.min(diffs.length, maxHunks); i++) {
      const d = diffs[i]!;
      if (diffs.length > 1) lines.push(`│   \x1b[90m@@ 修改点 #${i + 1} (-${d.removed.length} / +${d.added.length} 行) @@\x1b[0m`);
      if (d.removed.length === 1 && d.added.length === 1) {
        const pair = formatIntraLineDiffPair(d.removed[0]!, d.added[0]!, maxCols);
        lines.push(`│   ${pair.remFormatted}`, `│   ${pair.addFormatted}`);
        continue;
      }
      for (const l of d.removed.slice(0, maxLines)) lines.push(`│   \x1b[31m- ${truncateVisualCols(l, maxCols)}\x1b[0m`);
      if (d.removed.length > maxLines) lines.push(`│   \x1b[90m  ... (此段其余 ${d.removed.length - maxLines} 行删除已折叠，输入 d 展开)\x1b[0m`);
      for (const l of d.added.slice(0, maxLines)) lines.push(`│   \x1b[32m+ ${truncateVisualCols(l, maxCols)}\x1b[0m`);
      if (d.added.length > maxLines) lines.push(`│   \x1b[90m  ... (此段其余 ${d.added.length - maxLines} 行新增已折叠，输入 d 展开)\x1b[0m`);
    }
    if (diffs.length > maxHunks) lines.push(`│   \x1b[90m... (其余 ${diffs.length - maxHunks} 处修改已折叠，输入 d 展开全部 ${diffs.length} 处详情)\x1b[0m`);
  }
  for (const c of toolCalls) {
    if (c.name === "edit_file") continue;
    const args = (c.arguments ?? {}) as Record<string, unknown>;
    if (c.name === "run_bash") {
      const { relCwd, effectiveCwd, command } = resolveBashWorkingDir(args, workspaceRoot);
      const parts = cleanDisplayBash(command, workspaceRoot, effectiveCwd), maxBash = expandAll ? 100 : 6;
      if (relCwd) lines.push(`│ 📂 执行目录: ${relCwd}`);
      if (parts.length === 1 && getVisualCols(parts[0]!) <= 58) lines.push(`│ 💻 待执行命令${relCwd ? ` (${relCwd})` : ""}: ${parts[0]}`);
      else {
        lines.push(`│ 💻 待执行命令 (${relCwd ? `${relCwd} · ` : ""}共 ${parts.length} 步):`);
        for (const p of parts.slice(0, maxBash)) lines.push(`│   $ ${truncateVisualCols(p, maxCols)}`);
        if (parts.length > maxBash) lines.push(`│   \x1b[90m... (其余 ${parts.length - maxBash} 步已折叠，输入 d 展开)\x1b[0m`);
      }
    } else lines.push(`│ 🔧 待执行操作: ${c.name} (${shortenWorkspaceText(String(args.path ?? ""), workspaceRoot)})`);
  }
  return lines.join("\n");
}

export function formatToolResultLine(result: ToolResultMessage): string {
  if (result.isError) {
    const errPreview = result.content.replace(/\s+/g, " ").slice(0, 72);
    return `     ⚠️ 执行出错 (${result.name}): ${errPreview}${result.content.length > 72 ? "..." : ""}`;
  }
  if ((result.name === "edit_file" || result.name === "rollback_version") && result.content) return `     ↳ ✏️  ${result.content.replace(/\s+/g, " ").trim()}`;
  const lineCount = result.content ? result.content.split("\n").length : 0;
  return `     ↳ 完成 (${result.name} · 共 ${lineCount} 行)`;
}

export function formatDurationMs(ms?: number): string {
  if (ms === undefined || ms < 0) return "";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.round(ms / 1000);
  return `${Math.floor(totalSec / 60)}m${totalSec % 60}s`;
}

export function formatCompactTurnFooter(
  wireLogFile: string, stepsUsed: number, isReplay = false,
  turnSnapshots: readonly { path: string; beforeContent: string | null; afterContent: string; hunkCount?: number }[] = [],
  workspaceRoot?: string, elapsedMs?: number,
): string {
  const diffs = summarizeSnapshotsDiff(turnSnapshots, workspaceRoot);
  const totalAdd = diffs.reduce((a, d) => a + d.addedLines, 0), totalRem = diffs.reduce((a, d) => a + d.removedLines, 0);
  const modLines = diffs.length > 0
    ? [
        `\n📋 [本轮共修改 ${diffs.length} 个文件 (\x1b[32m+${totalAdd}\x1b[0m / \x1b[31m-${totalRem}\x1b[0m 行) · 输入 /diff 查看对比 | 输入 /open 打开文件 | 输入 /undo 撤回]:`,
        ...diffs.map((d) => {
          const fullClickable = workspaceRoot ? formatClickablePath(d.file, workspaceRoot) : d.file;
          const summary = d.isNew ? `新建 \x1b[32m+${d.newLines}\x1b[0m 行` : `\x1b[32m+${d.addedLines}\x1b[0m / \x1b[31m-${d.removedLines}\x1b[0m 行 · ${d.edits} 处修改`;
          return `  ✏️  ${fullClickable} (${summary})`;
        }),
      ]
    : [];
  const modPrefix = modLines.length > 0 ? `${modLines.join("\n")}\n` : "\n", durTag = elapsedMs !== undefined ? ` · ⏱️ ${formatDurationMs(elapsedMs)}` : "";
  const m = computeTurnMetrics(wireLogFile, stepsUsed, isReplay);
  if (!m) return `${modPrefix}✅ 本轮完成 (${durTag ? `⏱️ ${formatDurationMs(elapsedMs)} · ` : ""}共 ${stepsUsed} 步)`;
  const savedTag = m.turnSavedCny >= 0.005 ? ` (省¥${m.turnSavedCny.toFixed(2)})` : "";
  const isSubModel = m.turnQuotaPct > 0 || /agy|antigravity|argon|gemini|claude/i.test(m.activeModel);
  const subTotalTag = m.totalQuotaPct > m.sessionQuotaPct + 0.005 ? ` (项目累计 ${m.totalQuotaPct.toFixed(2)}%)` : "";
  const costStr = isSubModel
    ? `🎯 额度 本轮 ${m.turnQuotaPct.toFixed(2)}% / 当前对话 ${m.sessionQuotaPct.toFixed(2)}%${subTotalTag}`
    : m.totalCostCny > m.sessionCostCny + 0.00005
      ? `💰 本轮 ¥${m.turnCostCny.toFixed(4)}${savedTag} / 当前对话 ¥${m.sessionCostCny.toFixed(4)} (项目总计 ¥${m.totalCostCny.toFixed(4)})`
      : `💰 本轮 ¥${m.turnCostCny.toFixed(4)}${savedTag} / 当前对话 ¥${m.sessionCostCny.toFixed(4)}`;
  const ctxTag = m.contextTokens > 0 ? `🧠 ${(m.contextTokens / 1000).toFixed(1)}k词 · ` : "";
  const lastStepTag = m.lastStepCacheHitRatePct - m.cacheHitRatePct >= 4 ? `(末步${m.lastStepCacheHitRatePct.toFixed(0)}%)` : "";
  const cacheTag = Math.abs(m.sessionCacheHitRatePct - m.cacheHitRatePct) >= 1 || lastStepTag ? `⚡缓存 本轮${m.cacheHitRatePct.toFixed(0)}%${lastStepTag} / 累计${m.sessionCacheHitRatePct.toFixed(0)}%` : `⚡缓存命中 ${m.cacheHitRatePct.toFixed(0)}%`;
  return `${modPrefix}✅ 本轮完成 (🤖 ${m.activeModel}${durTag} · 共 ${stepsUsed} 步 · ${costStr} · ${ctxTag}${cacheTag} · 输入 /xray 查账单)`;
}
