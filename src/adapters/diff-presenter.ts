import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolCall } from "../core/contracts.js";
import { getVisualCols } from "./sse-stream.js";
import { cleanDisplayBash, isReadonlyBashCommand, shortenWorkspaceText } from "./ui-logger.js";
import type { FileVersionSnapshot } from "./write-tools.js";

export interface FileDiffSummaryItem {
  file: string; isNew: boolean; edits: number; oldLines: number; newLines: number;
  addedLines: number; removedLines: number; removedPreview: string[]; addedPreview: string[];
  hunksPreview?: { removed: string[]; added: string[] }[];
}

export function normalizeEditsArray(rawEdits: unknown): { oldText?: string; newText?: string }[] {
  let arr: unknown[] = Array.isArray(rawEdits) ? rawEdits : [];
  if (!Array.isArray(rawEdits) && typeof rawEdits === "string") {
    try { const parsed = JSON.parse(rawEdits); if (Array.isArray(parsed)) arr = parsed; } catch {}
  }
  return arr.filter((x): x is { oldText?: string; newText?: string } => Boolean(x && typeof x === "object"));
}

export function truncateVisualCols(text: string, maxCols = 66): string {
  const clean = text.replace(/\r/g, "");
  if (getVisualCols(clean) <= maxCols) return clean;
  let cols = 0, out = "";
  for (const ch of clean) {
    const w = (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
    if (cols + w > maxCols - 3) break;
    out += ch;
    cols += w;
  }
  return `${out}...`;
}

function stripCommonPairIndent(removed: readonly string[], added: readonly string[]): { removed: string[]; added: string[] } {
  const nonEmpty = [...removed, ...added].filter((l) => l.trim().length > 0);
  const minIndent = nonEmpty.length > 0 ? Math.min(...nonEmpty.map((l) => l.match(/^[ \t]*/)?.[0].length ?? 0)) : 0;
  const strip = (arr: readonly string[]) => arr.map((l) => (l.trim().length > 0 ? l.slice(minIndent) : "")).filter((l) => l.length > 0);
  return { removed: strip(removed), added: strip(added) };
}

function diffMiddleLines(oMid: readonly string[], nMid: readonly string[]): { removed: string[]; added: string[] } {
  if (oMid.length === 0 || nMid.length === 0) return { removed: [...oMid], added: [...nMid] };
  if (oMid.length * nMid.length <= 60_000) {
    const m = oMid.length, n = nMid.length;
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i]![j] = oMid[i] === nMid[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
    const removed: string[] = [], added: string[] = [];
    let i = 0, j = 0;
    while (i < m || j < n) {
      if (i < m && j < n && oMid[i] === nMid[j]) { i++; j++; }
      else if (j < n && (i === m || dp[i]![j + 1]! >= dp[i + 1]![j]!)) added.push(nMid[j++]!);
      else removed.push(oMid[i++]!);
    }
    return { removed, added };
  }
  const oCounts = new Map<string, number>(), nCounts = new Map<string, number>();
  for (const l of oMid) oCounts.set(l, (oCounts.get(l) ?? 0) + 1);
  for (const l of nMid) nCounts.set(l, (nCounts.get(l) ?? 0) + 1);
  const removed = oMid.filter((l) => { const c = nCounts.get(l) ?? 0; if (c > 0) { nCounts.set(l, c - 1); return false; } return true; });
  const added = nMid.filter((l) => { const c = oCounts.get(l) ?? 0; if (c > 0) { oCounts.set(l, c - 1); return false; } return true; });
  return { removed, added };
}

function trimCommonEnds(oldText: string, newText: string): { oMid: string[]; nMid: string[] } {
  const oRaw = oldText ? oldText.replace(/\r\n/g, "\n").split("\n") : [];
  const nRaw = newText ? newText.replace(/\r\n/g, "\n").split("\n") : [];
  let pre = 0, suf = 0;
  while (pre < oRaw.length && pre < nRaw.length && oRaw[pre] === nRaw[pre]) pre++;
  while (suf < oRaw.length - pre && suf < nRaw.length - pre && oRaw[oRaw.length - 1 - suf] === nRaw[nRaw.length - 1 - suf]) suf++;
  return { oMid: oRaw.slice(pre, oRaw.length - suf), nMid: nRaw.slice(pre, nRaw.length - suf) };
}

export function extractChangedHunk(oldText: string, newText: string): { removed: string[]; added: string[] } {
  const { oMid, nMid } = trimCommonEnds(oldText, newText);
  const { removed, added } = diffMiddleLines(oMid, nMid);
  return stripCommonPairIndent(removed, added);
}

export function extractChangedHunks(oldText: string, newText: string): { removed: string[]; added: string[] }[] {
  const { oMid, nMid } = trimCommonEnds(oldText, newText);
  if (oMid.length === 0 && nMid.length === 0) return [];
  const hunks: { removed: string[]; added: string[] }[] = [];
  let curI = 0, curJ = 0, i = 0;
  while (i + 2 < oMid.length) {
    let matchJ = -1;
    for (let j = curJ; j + 2 < nMid.length; j++) {
      if (oMid[i] === nMid[j] && oMid[i + 1] === nMid[j + 1] && oMid[i + 2] === nMid[j + 2]) { matchJ = j; break; }
    }
    if (matchJ !== -1) {
      if (i > curI || matchJ > curJ) {
        const sub = diffMiddleLines(oMid.slice(curI, i), nMid.slice(curJ, matchJ));
        if (sub.removed.length > 0 || sub.added.length > 0) hunks.push(stripCommonPairIndent(sub.removed, sub.added));
      }
      let len = 3;
      while (i + len < oMid.length && matchJ + len < nMid.length && oMid[i + len] === nMid[matchJ + len]) len++;
      curI = i += len; curJ = matchJ + len;
    } else i++;
  }
  if (curI < oMid.length || curJ < nMid.length) {
    const tail = diffMiddleLines(oMid.slice(curI), nMid.slice(curJ));
    if (tail.removed.length > 0 || tail.added.length > 0) hunks.push(stripCommonPairIndent(tail.removed, tail.added));
  }
  return hunks.length > 0 ? hunks : [extractChangedHunk(oldText, newText)];
}

export function formatStepToolCalls(step: number, calls: readonly ToolCall[], readonlyMap: Map<string, boolean>, workspaceRoot?: string): string {
  const editCounts = new Map<string, { count: number; isNew: boolean }>();
  for (const c of calls) {
    if (c.name === "edit_file") {
      const args = (c.arguments ?? {}) as Record<string, unknown>;
      const rel = shortenWorkspaceText(String(args.path ?? ""), workspaceRoot);
      const edits = normalizeEditsArray(args.edits);
      const hunkCount = Math.max(1, edits.length);
      const fullPath = workspaceRoot ? path.resolve(workspaceRoot, String(args.path ?? "")) : "";
      const isNew = !args.oldText && (edits.length === 0 || edits.every((e) => !e.oldText)) && (!fullPath || !fs.existsSync(fullPath));
      const prev = editCounts.get(rel);
      editCounts.set(rel, { count: (prev?.count ?? 0) + hunkCount, isNew: prev ? prev.isNew && isNew : isNew });
    }
  }
  const seenEdits = new Set<string>();
  const items: { isWrite: boolean; text: string }[] = [];
  for (const call of calls) {
    const args = (call.arguments ?? {}) as Record<string, unknown>;
    const relPath = shortenWorkspaceText(String(args.path || "."), workspaceRoot);
    if (call.name === "edit_file") {
      const rel = shortenWorkspaceText(String(args.path ?? ""), workspaceRoot);
      if (seenEdits.has(rel)) continue;
      seenEdits.add(rel);
      const info = editCounts.get(rel)!;
      const suffix = !info.isNew && info.count > 1 ? ` (${info.count} 处修改)` : "";
      items.push({ isWrite: true, text: `📝 ${info.isNew ? "新建文件" : "修改文件"}: ${rel}${suffix}` });
    } else if (call.name === "list_dir") {
      items.push({ isWrite: false, text: `📂 查看目录: ${relPath}` });
    } else if (call.name === "read_file") {
      const range = args.startLine || args.endLine ? ` (第 ${args.startLine ?? 1}~${args.endLine ?? "末"} 行)` : "";
      items.push({ isWrite: false, text: `📘 读取文件: ${shortenWorkspaceText(String(args.path ?? ""), workspaceRoot)}${range}` });
    } else if (call.name === "grep") {
      items.push({ isWrite: false, text: `🔍 搜索代码: "${String(args.pattern ?? "")}" (${relPath})` });
    } else if (call.name === "rollback_version") {
      items.push({ isWrite: true, text: `🔄 回退版本: 撤回最近 ${String(args.stepsBack ?? 1)} 步修改` });
    } else if (call.name === "run_bash") {
      const rawCmd = String(args.command ?? "").trim();
      const isRo = isReadonlyBashCommand(rawCmd, args.readonly as boolean | undefined);
      const parts = cleanDisplayBash(rawCmd, workspaceRoot);
      const ordered = !isRo && parts.length > 1 ? [...parts.filter((p) => !isReadonlyBashCommand(p)), ...parts.filter((p) => isReadonlyBashCommand(p))] : parts;
      const shortCmd = truncateVisualCols(ordered.join(" · "), 64);
      items.push({ isWrite: !isRo, text: `${isRo ? "📊 统计/查询命令" : "💻 运行终端命令"}: ${shortCmd}` });
    } else {
      items.push({ isWrite: readonlyMap.get(call.name) === false, text: `🔧 调用工具 ${call.name}: ${truncateVisualCols(JSON.stringify(args), 54)}` });
    }
  }
  const header = items.some((i) => i.isWrite) ? `\n🔧 [第 ${step} 步 · 准备执行修改或命令]` : `\n🔍 [第 ${step} 步 · 正在探索与读取项目]`;
  return [header, ...items.map((item, idx) => `${idx === items.length - 1 ? "  └─ " : "  ├─ "}${item.text}`)].join("\n");
}

export function formatApprovalBox(toolCalls: readonly ToolCall[], workspaceRoot?: string): string {
  const hasEdit = toolCalls.some((c) => c.name === "edit_file"), hasBash = toolCalls.some((c) => c.name === "run_bash");
  const title = hasEdit && hasBash ? "⚠️  [阶段：申请修改文件并执行命令 · 需你确认]" : hasEdit ? "📝 [阶段：申请修改文件 · 需你确认]" : "💻 [阶段：申请执行终端命令 · 需你确认]";
  const lines: string[] = [`\n┌─ ${title} ──────────────────────`];
  const groupedEdits = new Map<string, { rawPath: string; hunks: { oldText: string; newText: string }[] }>();
  for (const c of toolCalls) {
    if (c.name !== "edit_file") continue;
    const args = (c.arguments ?? {}) as Record<string, unknown>;
    const rawPath = String(args.path ?? "");
    const rel = shortenWorkspaceText(rawPath, workspaceRoot);
    const parsed = normalizeEditsArray(args.edits);
    const list = parsed.length > 0 ? parsed : [{ oldText: String(args.oldText ?? ""), newText: String(args.newText ?? "") }];
    const entry = groupedEdits.get(rel) ?? { rawPath, hunks: [] };
    for (const h of list) entry.hunks.push({ oldText: String(h.oldText ?? ""), newText: String(h.newText ?? "") });
    groupedEdits.set(rel, entry);
  }
  for (const [rel, { rawPath, hunks }] of groupedEdits.entries()) {
    const fullPath = workspaceRoot ? path.resolve(workspaceRoot, rawPath) : "";
    const existed = Boolean(fullPath && fs.existsSync(fullPath));
    const diffs = hunks.map((h) => extractChangedHunk(h.oldText, h.newText));
    const oldLines = diffs.reduce((a, d) => a + d.removed.length, 0), newLines = diffs.reduce((a, d) => a + d.added.length, 0);
    const isAllEmptyOld = hunks.every((h) => !h.oldText);
    const diffSummary = isAllEmptyOld ? (existed ? `覆盖文件 (+${newLines} 行)` : `新建文件 (+${newLines} 行)`) : `${hunks.length > 1 ? `共 ${hunks.length} 处修改 · ` : ""}替换内容 (-${oldLines} 行 / +${newLines} 行)`;
    lines.push(`│ 📘 目标文件: ${rel} (${diffSummary})`);
    for (let i = 0; i < Math.min(diffs.length, 4); i++) {
      const d = diffs[i]!;
      if (diffs.length > 1) lines.push(`│   \x1b[90m@@ 修改点 #${i + 1} (-${d.removed.length} / +${d.added.length} 行) @@\x1b[0m`);
      for (const l of d.removed.slice(0, 2)) lines.push(`│   \x1b[31m- ${truncateVisualCols(l, 66)}\x1b[0m`);
      if (d.removed.length > 2) lines.push(`│   \x1b[90m  ... (此段其余 ${d.removed.length - 2} 行删除已折叠)\x1b[0m`);
      for (const l of d.added.slice(0, 2)) lines.push(`│   \x1b[32m+ ${truncateVisualCols(l, 66)}\x1b[0m`);
      if (d.added.length > 2) lines.push(`│   \x1b[90m  ... (此段其余 ${d.added.length - 2} 行新增已折叠)\x1b[0m`);
    }
    if (diffs.length > 4) lines.push(`│   \x1b[90m... (其余 ${diffs.length - 4} 处修改已折叠)\x1b[0m`);
  }
  for (const c of toolCalls) {
    if (c.name === "edit_file") continue;
    const args = (c.arguments ?? {}) as Record<string, unknown>;
    if (c.name === "run_bash") {
      const parts = cleanDisplayBash(String(args.command ?? ""), workspaceRoot);
      if (parts.length === 1 && getVisualCols(parts[0]!) <= 58) lines.push(`│ 💻 待执行命令: ${parts[0]}`);
      else {
        lines.push(`│ 💻 待执行命令 (共 ${parts.length} 步):`);
        for (const p of parts.slice(0, 6)) lines.push(`│   $ ${truncateVisualCols(p, 66)}`);
        if (parts.length > 6) lines.push(`│   \x1b[90m... (其余 ${parts.length - 6} 步已折叠)\x1b[0m`);
      }
    } else lines.push(`│ 🔧 待执行操作: ${c.name} (${shortenWorkspaceText(String(args.path ?? ""), workspaceRoot)})`);
  }
  return lines.join("\n");
}

export function summarizeSnapshotsDiff(snapshots: readonly { path: string; beforeContent: string | null; afterContent: string; hunkCount?: number }[], workspaceRoot?: string): FileDiffSummaryItem[] {
  const byFile = new Map<string, { before: string | null; after: string; edits: number }>();
  for (const s of snapshots) {
    const rel = shortenWorkspaceText(s.path, workspaceRoot);
    const prev = byFile.get(rel);
    byFile.set(rel, { before: prev ? prev.before : s.beforeContent, after: s.afterContent, edits: (prev?.edits ?? 0) + Math.max(1, s.hunkCount ?? 1) });
  }
  const items: FileDiffSummaryItem[] = [];
  for (const [file, info] of byFile.entries()) {
    if (info.before !== null && info.before === info.after) continue;
    const oldArr = info.before === null ? [] : info.before.replace(/\r\n/g, "\n").split("\n");
    const newArr = info.after.replace(/\r\n/g, "\n").split("\n");
    const hunks = info.before === null ? [{ removed: [], added: stripCommonPairIndent([], newArr).added }] : extractChangedHunks(info.before, info.after);
    const removed = hunks.flatMap((h) => h.removed), added = hunks.flatMap((h) => h.added);
    const addedLines = info.before === null ? newArr.length : added.length, removedLines = info.before === null ? 0 : removed.length;
    const hunksPreview = hunks.slice(0, 4).map((h) => ({ removed: h.removed.slice(0, 3).map((l) => truncateVisualCols(l, 70)), added: h.added.slice(0, 3).map((l) => truncateVisualCols(l, 70)) }));
    items.push({ file, isNew: info.before === null, edits: info.edits, oldLines: oldArr.length, newLines: newArr.length, addedLines, removedLines, removedPreview: removed.slice(0, 5).map((l) => truncateVisualCols(l, 70)), addedPreview: added.slice(0, 5).map((l) => truncateVisualCols(l, 70)), hunksPreview });
  }
  return items;
}

export function formatSnapshotsDiff(snapshots: readonly FileVersionSnapshot[], workspaceRoot: string): string {
  const diffs = summarizeSnapshotsDiff(snapshots, workspaceRoot);
  if (diffs.length === 0) return "ℹ️  当前没有未撤回的文件修改记录。";
  const out = [`\n🔍 [文件修改审核对比 (共 ${diffs.length} 个文件, ${snapshots.length} 个快照版本 · 输入 /undo 可撤回上一轮修改 | /undo all 全部撤回)]:`];
  for (const d of diffs) {
    out.push(`  📘 ${d.file} (${d.isNew ? `新建文件 · +${d.newLines} 行` : `修改 ${d.edits} 处 · +${d.addedLines} / -${d.removedLines} 行 (${d.oldLines} -> ${d.newLines} 行)`})`);
    const hList = d.hunksPreview && d.hunksPreview.length > 1 ? d.hunksPreview : [{ removed: d.removedPreview, added: d.addedPreview }];
    hList.forEach((h, idx) => {
      if (hList.length > 1) out.push(`     \x1b[90m@@ 修改片段 #${idx + 1} @@\x1b[0m`);
      for (const r of h.removed) out.push(`     \x1b[31m- ${r}\x1b[0m`);
      for (const a of h.added) out.push(`     \x1b[32m+ ${a}\x1b[0m`);
    });
  }
  return out.join("\n");
}
