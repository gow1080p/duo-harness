import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolCall, ToolResultMessage } from "../core/contracts.js";
import { buildDefaultSystemPrompt, cleanDisplayBash, isReadonlyBashCommand, resolveBashWorkingDir } from "./bash-policy.js";
import { computeTurnMetrics, type TurnMetricsSummary } from "./cost-tracker.js";
import { extractChangedHunk, extractCodeOutline, type FileDiffSummaryItem, formatIntraLineDiffPair, highlightCodeLine, normalizeEditsArray, summarizeSnapshotsDiff, truncateVisualCols } from "./diff-presenter.js";
import { formatClickablePath, getCharVisualWidth, getVisualCols, padCols, shortenWorkspaceText } from "./platform.js";

export { buildDefaultSystemPrompt, cleanDisplayBash, computeTurnMetrics, type FileDiffSummaryItem, getCharVisualWidth, getVisualCols, isReadonlyBashCommand, normalizeEditsArray, shortenWorkspaceText, summarizeSnapshotsDiff, type TurnMetricsSummary };

function formatInlineMarkdown(line: string, restore = ""): string {
  const rst = `\x1b[0m${restore}`;
  return line.replace(/`([^`]+)`|\*\*([^*]+)\*\*|(?<!\*)\*([^*]+)\*(?!\*)/g, (_m, code, bold, italic) => {
    if (code !== undefined) return `\x1b[36m${code}${rst}`;
    if (bold !== undefined) return `\x1b[1;97m${bold}${rst}`;
    return `\x1b[3m${italic}${rst}`;
  });
}

export function formatMarkdownLine(rawLine: string, inCodeBlock: boolean, codeLineNum?: number): { text: string; nextInCodeBlock: boolean } {
  const fenceMatch = rawLine.match(/^\s*```(\w*)\s*$/);
  if (fenceMatch) {
    return inCodeBlock
      ? { text: "\x1b[90m  ╰────────────────────────\x1b[0m", nextInCodeBlock: false }
      : { text: `\x1b[90m  ╭── ${fenceMatch[1] || "code"} ────────────────\x1b[0m`, nextInCodeBlock: true };
  }
  if (inCodeBlock) return { text: `\x1b[90m  │ ${codeLineNum ? `${String(codeLineNum).padStart(3)} │ ` : ""}\x1b[0m${highlightCodeLine(rawLine)}\x1b[0m`, nextInCodeBlock: true };
  if (/^\s*(?:---+|\*\*\*+)\s*$/.test(rawLine)) return { text: "\x1b[90m  ────────────────────────────────────────\x1b[0m", nextInCodeBlock: false };
  if (/^\s*\|[\s:|-]+\|\s*$/.test(rawLine)) return { text: "\x1b[90m  ├────────────────────────────────────────┤\x1b[0m", nextInCodeBlock: false };
  if (/^\s*\|.*\|\s*$/.test(rawLine)) {
    const cells = rawLine.trim().replace(/^\||\|$/g, "").split("|").map((c) => formatInlineMarkdown(c.trim()));
    return { text: `  \x1b[90m│\x1b[0m ${cells.join(" \x1b[90m│\x1b[0m ")} \x1b[90m│\x1b[0m`, nextInCodeBlock: false };
  }
  const headingMatch = rawLine.match(/^(#{1,6})\s+(.*)$/);
  if (headingMatch) {
    const hStyle = headingMatch[1]!.length <= 2 ? "\x1b[1;36m" : "\x1b[1;33m";
    return { text: `${hStyle}${headingMatch[1]!.length <= 2 ? "▍" : "▸"} ${formatInlineMarkdown(headingMatch[2]!, hStyle)}\x1b[0m`, nextInCodeBlock: false };
  }
  const quoteMatch = rawLine.match(/^(\s*)>\s?(.*)$/);
  if (quoteMatch) return { text: `${quoteMatch[1]!}\x1b[90m▎\x1b[0m \x1b[3m${formatInlineMarkdown(quoteMatch[2]!, "\x1b[3m")}\x1b[0m`, nextInCodeBlock: false };
  const bulletMatch = rawLine.match(/^(\s*)[-*]\s+(.*)$/);
  if (bulletMatch) return { text: `${bulletMatch[1]!}\x1b[36m•\x1b[0m ${formatInlineMarkdown(bulletMatch[2]!)}`, nextInCodeBlock: false };
  const numMatch = rawLine.match(/^(\s*)(\d+\.)\s+(.*)$/);
  if (numMatch) return { text: `${numMatch[1]!}\x1b[36m${numMatch[2]!}\x1b[0m ${formatInlineMarkdown(numMatch[3]!)}`, nextInCodeBlock: false };
  return { text: formatInlineMarkdown(rawLine), nextInCodeBlock: false };
}

function wrapVisualTokens(text: string, maxCols: number): string[] {
  const punc = "[，。！？；：、）》”’,.!?;:)\\]]*";
  const tokens = text.match(new RegExp(`\\*\\*[^*]+\\*\\*${punc}|\`[^\`]+\`${punc}|\\([A-Za-z0-9_.:-]+\\/?${punc}|[A-Za-z0-9_.:-]+\\/?${punc}|\\s+|[\\u4e00-\\u9fa5]${punc}|[^\\sA-Za-z0-9_.:\\u4e00-\\u9fa5]`, "g")) ?? [text];
  const out: string[] = [];
  let cur = "", cols = 0;
  const pushPiece = (piece: string) => {
    const pw = getVisualCols(formatInlineMarkdown(piece));
    if (cols > 0 && cols + pw > maxCols) { out.push(cur.trimEnd()); cur = /^\s+$/.test(piece) ? "" : piece; cols = /^\s+$/.test(piece) ? 0 : pw; }
    else { cur += piece; cols += pw; }
  };
  for (const tok of tokens) {
    if (getVisualCols(formatInlineMarkdown(tok)) > maxCols) {
      const m = tok.match(/^(\*\*|`)(.*)\1(.*)$/), inner = m ? m[2]! : tok, wrapSym = m ? m[1]! : "", tailPunc = m ? m[3]! : "";
      const subs = inner.split(/(?<=[\s/\\,，、+-])/);
      subs.forEach((sub, idx) => {
        const sfx = idx === subs.length - 1 ? tailPunc : "";
        const wrapPart = (s: string) => (/^\s+$/.test(s) || !wrapSym ? s : `${wrapSym}${s}${wrapSym}`);
        const piece = `${wrapPart(sub)}${sfx}`;
        if (getVisualCols(formatInlineMarkdown(piece)) > maxCols) {
          Array.from(sub).forEach((ch, cIdx, arr) => pushPiece(`${wrapPart(ch)}${cIdx === arr.length - 1 ? sfx : ""}`));
        } else pushPiece(piece);
      });
    } else pushPiece(tok);
  }
  if (cur.trim() || out.length === 0) out.push(cur.trimEnd());
  return out;
}

export function renderMarkdownTable(rawLines: readonly string[], maxCols = 88): string[] {
  const dataLines = rawLines.filter((l) => !/^\s*\|[\s:|-]+\|\s*$/.test(l));
  if (dataLines.length === 0) return [];
  const rows = dataLines.map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
  const numCols = Math.max(...rows.map((r) => r.length));
  const normRows = rows.map((r) => Array.from({ length: numCols }, (_, i) => r[i] ?? ""));
  const natural = Array.from({ length: numCols }, (_, c) => Math.max(1, ...normRows.map((r) => getVisualCols(formatInlineMarkdown(r[c]!)))));
  const minW = natural.map((w) => (w <= 22 ? w : Math.min(w, 16)));
  const avail = Math.max(numCols * 4, maxCols - (3 * numCols + 3));
  const sumNat = natural.reduce((a, b) => a + b, 0), sumMin = minW.reduce((a, b) => a + b, 0);
  let colW: number[];
  if (sumNat <= avail) colW = [...natural];
  else if (sumMin >= avail) colW = minW.map((w) => Math.max(3, Math.floor((w / sumMin) * avail)));
  else {
    const extra = avail - sumMin, growPool = natural.reduce((a, w, i) => a + (w - minW[i]!), 0);
    colW = minW.map((m, i) => m + (growPool > 0 ? Math.floor(((natural[i]! - m) / growPool) * extra) : 0));
  }
  const drawSep = (l: string, m: string, r: string) => `\x1b[90m  ${l}─${colW.map((w) => "─".repeat(w)).join(`─${m}─`)}─${r}\x1b[0m`;
  const out = [drawSep("┌", "┬", "┐")];
  const multiLine = normRows.some((r) => r.some((cell, c) => getVisualCols(formatInlineMarkdown(cell)) > colW[c]!));
  normRows.forEach((row, rIdx) => {
    const wrapped = row.map((cell, c) => wrapVisualTokens(cell, colW[c]!));
    const h = Math.max(1, ...wrapped.map((w) => w.length));
    for (let lineIdx = 0; lineIdx < h; lineIdx++) {
      const parts = wrapped.map((lines, c) => {
        const raw = lines[lineIdx] ?? "";
        const styled = rIdx === 0 ? `\x1b[1;97m${formatInlineMarkdown(raw, "\x1b[1;97m")}\x1b[0m` : formatInlineMarkdown(raw);
        return padCols(styled, colW[c]!);
      });
      out.push(`  \x1b[90m│\x1b[0m ${parts.join(" \x1b[90m│\x1b[0m ")} \x1b[90m│\x1b[0m`);
    }
    if (rIdx === 0 || (multiLine && rIdx < normRows.length - 1)) out.push(drawSep("├", "┼", "┤"));
  });
  out.push(drawSep("└", "┴", "┘"));
  return out;
}

export function formatWrappedMarkdownLine(line: string, maxCols: number): string[] {
  const hm = line.match(/^(#{1,6})\s+(.*)$/), qm = !hm ? line.match(/^(\s*)>\s?(.*)$/) : null, bm = !hm && !qm ? line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/) : null;
  if (hm) {
    const hStyle = hm[1]!.length <= 2 ? "\x1b[1;36m" : "\x1b[1;33m", pfx = hm[1]!.length <= 2 ? `${hStyle}▍ ` : `${hStyle}▸ `;
    return wrapVisualTokens(hm[2]!, maxCols - 4).map((wl, idx) => `${idx === 0 ? pfx : `  ${hStyle}`}${formatInlineMarkdown(wl, hStyle)}\x1b[0m`);
  }
  if (qm || bm) {
    const indent = qm ? qm[1]! : bm![1]!, body = qm ? qm[2]! : bm![3]!;
    const bulletLabel = !qm ? (bm![2]! === "-" || bm![2]! === "*" ? "•" : bm![2]!) : "";
    const contPad = " ".repeat(bulletLabel.length + 1);
    return wrapVisualTokens(body, Math.max(20, maxCols - getVisualCols(indent) - contPad.length - 2)).map((wl, idx) =>
      qm ? `${indent}\x1b[90m▎\x1b[0m \x1b[3m${formatInlineMarkdown(wl, "\x1b[3m")}\x1b[0m` : `${indent}${idx === 0 ? `\x1b[36m${bulletLabel}\x1b[0m ` : contPad}${formatInlineMarkdown(wl)}`
    );
  }
  if (!line.trim().startsWith("|") && !/^\s*(?:---+|\*\*\*+)\s*$/.test(line) && getVisualCols(formatInlineMarkdown(line)) > maxCols) {
    return wrapVisualTokens(line, maxCols).map((wl) => formatInlineMarkdown(wl));
  }
  return [formatMarkdownLine(line, false).text];
}

export function renderMarkdownDocument(raw: string, opts: { expandCodeBlocks?: boolean; maxCols?: number } = {}): string {
  const maxCols = Math.min(Math.max(58, opts.maxCols ?? (process.stdout.columns ?? 92) - 4), 108);
  const srcLines = raw.replace(/\r\n/g, "\n").split("\n"), out: string[] = [];
  for (let i = 0; i < srcLines.length; i++) {
    const line = srcLines[i]!, fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] || "code", block: string[] = [];
      for (i++; i < srcLines.length && !/^\s*```\s*$/.test(srcLines[i]!); i++) block.push(srcLines[i]!);
      const total = block.length, fold = !opts.expandCodeBlocks && total > 14, headCount = fold ? 6 : total;
      out.push(`\x1b[90m  ╭── 💻 ${lang} (${total} 行) ${"─".repeat(Math.max(8, maxCols - 22 - lang.length))}\x1b[0m`);
      const pushCodeLine = (idx: number) => {
        const clean = block[idx]!.replace(/\t/g, "  "), codeWidth = maxCols - 10;
        if (!fold && getVisualCols(clean) > codeWidth) {
          wrapReasoningLines(clean, codeWidth).forEach((seg, sIdx) => {
            out.push(`\x1b[90m  │ ${sIdx === 0 ? String(idx + 1).padStart(3) : "  ↪"} │ \x1b[0m${highlightCodeLine(seg)}`);
          });
        } else out.push(`\x1b[90m  │ ${String(idx + 1).padStart(3)} │ \x1b[0m${highlightCodeLine(truncateVisualCols(clean, codeWidth))}`);
      };
      for (let k = 0; k < headCount; k++) pushCodeLine(k);
      if (fold) {
        const syms = extractCodeOutline(block);
        if (syms.length > 0) {
          out.push(`\x1b[90m  │  ⋮  │ \x1b[36m🔎 核心符号骨架 (共 ${syms.length} 项):\x1b[0m`);
          for (const sl of wrapVisualTokens(syms.join(" · "), maxCols - 14).slice(0, 3)) out.push(`\x1b[90m  │  ⋮  │   \x1b[36m${sl}\x1b[0m`);
        }
        out.push(`\x1b[90m  │  ⋮  │ ... (已折叠中间 ${total - 8} 行代码 · 输入 /plan full 或 mdp -f 展开 | 按 Ctrl+G 编辑器打开)\x1b[0m`);
        for (let k = total - 2; k < total; k++) pushCodeLine(k);
      }
      out.push(`\x1b[90m  ╰${"─".repeat(Math.max(24, maxCols - 6))}\x1b[0m`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const tbl: string[] = [line];
      while (i + 1 < srcLines.length && /^\s*\|.*\|\s*$/.test(srcLines[i + 1]!)) tbl.push(srcLines[++i]!);
      out.push(...renderMarkdownTable(tbl, maxCols));
      continue;
    }
    out.push(...formatWrappedMarkdownLine(line, maxCols));
  }
  return out.join("\n");
}

export function wrapReasoningLines(raw: string, maxCols: number): string[] {
  const out: string[] = [];
  for (const para of raw.split(/\r?\n/)) {
    if (!para) { out.push(""); continue; }
    let line = "", cols = 0;
    for (const ch of para) {
      const w = getCharVisualWidth(ch.codePointAt(0) ?? 0);
      if (cols + w > maxCols) { out.push(line); line = ch; cols = w; }
      else { line += ch; cols += w; }
    }
    if (line) out.push(line);
  }
  return out.length > 0 ? out : [""];
}

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
    } else if (call.name === "list_dir") items.push({ isWrite: false, text: `📂 查看目录: ${relPath}` });
    else if (call.name === "read_file") {
      const range = args.startLine || args.endLine ? ` (第 ${args.startLine ?? 1}~${args.endLine ?? "末"} 行)` : "";
      items.push({ isWrite: false, text: `📘 读取文件: ${shortenWorkspaceText(String(args.path ?? ""), workspaceRoot)}${range}` });
    } else if (call.name === "grep") items.push({ isWrite: false, text: `🔍 搜索代码: "${String(args.pattern ?? "")}" (${relPath})` });
    else if (call.name === "rollback_version") items.push({ isWrite: true, text: `🔄 回退版本: 撤回最近 ${String(args.stepsBack ?? 1)} 步修改` });
    else if (call.name === "run_bash") {
      const { relCwd, effectiveCwd, command } = resolveBashWorkingDir(args, workspaceRoot);
      const isRo = isReadonlyBashCommand(command, args.readonly as boolean | undefined, workspaceRoot, effectiveCwd);
      const parts = cleanDisplayBash(command, workspaceRoot, effectiveCwd);
      const ordered = !isRo && parts.length > 1 ? [...parts.filter((p) => !isReadonlyBashCommand(p, undefined, workspaceRoot, effectiveCwd)), ...parts.filter((p) => isReadonlyBashCommand(p, undefined, workspaceRoot, effectiveCwd))] : parts;
      items.push({ isWrite: !isRo, text: `${isRo ? "📊 统计/查询命令" : "💻 运行终端命令"}${relCwd ? ` [${relCwd}]` : ""}: ${truncateVisualCols(ordered.join(" · "), 64)}` });
    } else {
      items.push({ isWrite: readonlyMap.get(call.name) === false, text: `🔧 调用工具 ${call.name}: ${truncateVisualCols(JSON.stringify(args), 54)}` });
    }
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
      const parsed = normalizeEditsArray(args.edits);
      const list = parsed.length > 0 ? parsed : [{ oldText: String(args.oldText ?? ""), newText: String(args.newText ?? "") }];
      const entry = groupedEdits.get(rel) ?? { rawPath, hunks: [] };
      for (const h of list) entry.hunks.push({ oldText: String(h.oldText ?? ""), newText: String(h.newText ?? "") });
      groupedEdits.set(rel, entry);
      totalHunks += list.length;
    } else if (c.name === "run_bash") bashCount++;
  }
  const scopeParts = [
    ...(groupedEdits.size > 0 ? [`申请修改文件 ${groupedEdits.size} 个 (共 ${totalHunks} 处)`] : []),
    ...(bashCount > 0 ? [`申请执行终端命令 ${bashCount} 条`] : []),
  ];
  const isEsc = escalatedReasons.length > 0;
  const icon = isEsc ? "🚨" : groupedEdits.size > 0 && bashCount > 0 ? "⚠️ " : groupedEdits.size > 0 ? "📝" : "💻";
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
  if ((result.name === "edit_file" || result.name === "rollback_version") && result.content) {
    return `     ↳ ✏️  ${result.content.replace(/\s+/g, " ").trim()}`;
  }
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
  const modPrefix = modLines.length > 0 ? `${modLines.join("\n")}\n` : "\n";
  const durTag = elapsedMs !== undefined ? ` · ⏱️ ${formatDurationMs(elapsedMs)}` : "";
  const m = computeTurnMetrics(wireLogFile, stepsUsed, isReplay);
  if (!m) return `${modPrefix}✅ 本轮完成 (${durTag ? `⏱️ ${formatDurationMs(elapsedMs)} · ` : ""}共 ${stepsUsed} 步)`;
  const savedTag = m.turnSavedCny >= 0.005 ? ` (省¥${m.turnSavedCny.toFixed(2)})` : "";
  const costStr = m.totalCostCny > m.sessionCostCny + 0.00005
    ? `本轮 ¥${m.turnCostCny.toFixed(4)}${savedTag} / 当前对话 ¥${m.sessionCostCny.toFixed(4)} (项目总计 ¥${m.totalCostCny.toFixed(4)})`
    : `本轮 ¥${m.turnCostCny.toFixed(4)}${savedTag} / 当前对话 ¥${m.sessionCostCny.toFixed(4)}`;
  const ctxTag = m.contextTokens > 0 ? `🧠 ${(m.contextTokens / 1000).toFixed(1)}k词 · ` : "";
  const lastStepTag = m.lastStepCacheHitRatePct - m.cacheHitRatePct >= 4 ? `(末步${m.lastStepCacheHitRatePct.toFixed(0)}%)` : "";
  const cacheTag = Math.abs(m.sessionCacheHitRatePct - m.cacheHitRatePct) >= 1 || lastStepTag
    ? `⚡缓存 本轮${m.cacheHitRatePct.toFixed(0)}%${lastStepTag} / 累计${m.sessionCacheHitRatePct.toFixed(0)}%`
    : `⚡缓存命中 ${m.cacheHitRatePct.toFixed(0)}%`;
  return `${modPrefix}✅ 本轮完成 (🤖 ${m.activeModel}${durTag} · 共 ${stepsUsed} 步 · 💰 ${costStr} · ${ctxTag}${cacheTag} · 输入 /xray 查账单)`;
}
