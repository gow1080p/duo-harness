import { extractCodeOutline, highlightCodeLine, truncateVisualCols } from "./diff-presenter.js";
import { getCharVisualWidth, getVisualCols, padCols } from "./platform.js";

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

export function wrapVisualTokens(text: string, maxCols: number): string[] {
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
