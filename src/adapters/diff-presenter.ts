import * as Diff from "diff";
import { getVisualCols, shortenWorkspaceText, truncateCols } from "./platform.js";
import type { FileVersionSnapshot } from "./write-tools.js";

export interface FileDiffSummaryItem {
  file: string;
  isNew: boolean;
  edits: number;
  oldLines: number;
  newLines: number;
  addedLines: number;
  removedLines: number;
  removedPreview: string[];
  addedPreview: string[];
  totalHunks?: number;
  hunksPreview?: { removed: string[]; added: string[]; totalRemoved?: number; totalAdded?: number }[];
}

export function normalizeEditsArray(rawEdits: unknown): { oldText?: string; newText?: string }[] {
  let arr: unknown[] = Array.isArray(rawEdits) ? rawEdits : [];
  if (!Array.isArray(rawEdits) && typeof rawEdits === "string") {
    try {
      const parsed = JSON.parse(rawEdits);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {}
  }
  return arr.filter((x): x is { oldText?: string; newText?: string } => Boolean(x && typeof x === "object"));
}

export function truncateVisualCols(text: string, maxCols = 66): string {
  return truncateCols(text, maxCols, "...");
}

export function highlightCodeLine(raw: string): string {
  const expanded = raw.replace(/\t/g, "  ");
  if (/^(?:\/\/|#|--)/.test(expanded.trim())) return `\x1b[90m\x1b[3m${expanded}\x1b[0m`;
  return expanded.replace(
    /("[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|`[^`]*`)|\b(package|import|func|type|struct|interface|return|if|else|for|range|switch|case|default|defer|go|var|const|let|export|from|async|await|class|CREATE|TABLE|IF|NOT|EXISTS|INSERT|INTO|VALUES|SELECT|FROM|WHERE|JOIN|ON|UPDATE|SET|ORDER|BY|PRIMARY|KEY)\b/g,
    (_m, strLit: string | undefined, kw: string | undefined) => (strLit ? `\x1b[32m${strLit}\x1b[0m` : `\x1b[1;35m${kw}\x1b[0m`)
  );
}

export function extractCodeOutline(lines: readonly string[]): string[] {
  const symbols: string[] = [];
  for (const l of lines) {
    const m = l.match(/^\s*(?:export\s+)?(?:async\s+)?(?:func\s+(?:\([^)]+\)\s*)?([A-Za-z0-9_]+)|type\s+([A-Za-z0-9_]+)\s+(?:struct|interface)|function\s+([A-Za-z0-9_]+)|class\s+([A-Za-z0-9_]+)|def\s+([A-Za-z0-9_]+)|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z0-9_]+))/i);
    const sym = m?.[1] ? `func ${m[1]}` : m?.[2] ? `type ${m[2]}` : m?.[3] ? `fn ${m[3]}` : m?.[4] ? `class ${m[4]}` : m?.[5] ? `def ${m[5]}` : m?.[6] ? `table ${m[6]}` : "";
    if (sym && !symbols.includes(sym)) symbols.push(sym);
  }
  return symbols;
}

const BG_REM_LINE = "\x1b[48;2;45;18;22m\x1b[31m";
const BG_REM_WORD = "\x1b[48;2;115;32;42m\x1b[1;97m";
const BG_ADD_LINE = "\x1b[48;2;16;46;28m\x1b[32m";
const BG_ADD_WORD = "\x1b[48;2;28;105;55m\x1b[1;97m";

export function formatIntraLineDiffPair(oldLine: string, newLine: string, maxCols = 70): { remFormatted: string; addFormatted: string } {
  const tokenize = (s: string) => s.slice(0, 300).match(/[A-Za-z0-9_]+|\s+|[\u4e00-\u9fa5]+|[^\sA-Za-z0-9_\u4e00-\u9fa5]/g) ?? [s.slice(0, 300)];
  const oTok = tokenize(oldLine);
  const nTok = tokenize(newLine);
  if (oTok.length * nTok.length > 16_000) {
    return {
      remFormatted: `${BG_REM_LINE}- ${truncateVisualCols(oldLine, maxCols)}\x1b[0m`,
      addFormatted: `${BG_ADD_LINE}+ ${truncateVisualCols(newLine, maxCols)}\x1b[0m`,
    };
  }
  const remChanged: string[] = [];
  const addChanged: string[] = [];
  for (const part of Diff.diffWords(oldLine.slice(0, 400), newLine.slice(0, 400))) {
    const tok = part.value.trim();
    if (!tok) continue;
    if (part.removed) remChanged.push(tok);
    else if (part.added) addChanged.push(tok);
  }
  const remTag = remChanged.length > 0 && remChanged.join("").length < oldLine.trim().length ? ` -${truncateVisualCols(remChanged.join(" "), 20)} ` : "";
  const addTag = addChanged.length > 0 && addChanged.join("").length < newLine.trim().length ? ` +${truncateVisualCols(addChanged.join(" "), 20)} ` : "";
  const oClip = truncateVisualCols(oldLine, remTag ? Math.max(20, maxCols - getVisualCols(remTag) - 2) : maxCols);
  const nClip = truncateVisualCols(newLine, addTag ? Math.max(20, maxCols - getVisualCols(addTag) - 2) : maxCols);
  return {
    remFormatted: `${BG_REM_LINE}- ${oClip}\x1b[0m${remTag ? `  ${BG_REM_WORD}${remTag}\x1b[0m` : ""}`,
    addFormatted: `${BG_ADD_LINE}+ ${nClip}\x1b[0m${addTag ? `  ${BG_ADD_WORD}${addTag}\x1b[0m` : ""}`,
  };
}

function stripCommonPairIndent(removed: readonly string[], added: readonly string[]): { removed: string[]; added: string[] } {
  const nonEmpty = [...removed, ...added].filter((l) => l.trim().length > 0);
  const minIndent = nonEmpty.length > 0 ? Math.min(...nonEmpty.map((l) => l.match(/^[ \t]*/)?.[0].length ?? 0)) : 0;
  const strip = (arr: readonly string[]) => arr.map((l) => (l.trim().length > 0 ? l.slice(minIndent) : "")).filter((l) => l.length > 0);
  return { removed: strip(removed), added: strip(added) };
}

function diffMiddleLines(oMid: readonly string[], nMid: readonly string[]): { removed: string[]; added: string[] } {
  if (oMid.length === 0 || nMid.length === 0) return { removed: [...oMid], added: [...nMid] };
  const parts = Diff.diffLines(oMid.join("\n"), nMid.join("\n"));
  const removed: string[] = [];
  const added: string[] = [];
  for (const part of parts) {
    if (!part.added && !part.removed) continue;
    const lines = part.value.replace(/\n$/, "").split("\n");
    if (part.removed) removed.push(...lines);
    else if (part.added) added.push(...lines);
  }
  return { removed, added };
}

function trimCommonEnds(oldText: string, newText: string): { oMid: string[]; nMid: string[] } {
  const oRaw = oldText ? oldText.replace(/\r\n/g, "\n").split("\n") : [];
  const nRaw = newText ? newText.replace(/\r\n/g, "\n").split("\n") : [];
  let pre = 0;
  let suf = 0;
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
  let curI = 0;
  let curJ = 0;
  let i = 0;
  while (i + 2 < oMid.length) {
    let matchJ = -1;
    for (let j = curJ; j + 2 < nMid.length; j++) {
      if (oMid[i] === nMid[j] && oMid[i + 1] === nMid[j + 1] && oMid[i + 2] === nMid[j + 2]) {
        matchJ = j;
        break;
      }
    }
    if (matchJ !== -1) {
      if (i > curI || matchJ > curJ) {
        const sub = diffMiddleLines(oMid.slice(curI, i), nMid.slice(curJ, matchJ));
        if (sub.removed.length > 0 || sub.added.length > 0) hunks.push(stripCommonPairIndent(sub.removed, sub.added));
      }
      let len = 3;
      while (i + len < oMid.length && matchJ + len < nMid.length && oMid[i + len] === nMid[matchJ + len]) len++;
      curI = i += len;
      curJ = matchJ + len;
    } else i++;
  }
  if (curI < oMid.length || curJ < nMid.length) {
    const tail = diffMiddleLines(oMid.slice(curI), nMid.slice(curJ));
    if (tail.removed.length > 0 || tail.added.length > 0) hunks.push(stripCommonPairIndent(tail.removed, tail.added));
  }
  return hunks.length > 0 ? hunks : [extractChangedHunk(oldText, newText)];
}

export function summarizeSnapshotsDiff(snapshots: readonly { path: string; beforeContent: string | null; afterContent: string; hunkCount?: number }[], workspaceRoot?: string, full = false): FileDiffSummaryItem[] {
  const byFile = new Map<string, { before: string | null; after: string; edits: number }>();
  for (const s of snapshots) {
    const rel = shortenWorkspaceText(s.path, workspaceRoot);
    const prev = byFile.get(rel);
    byFile.set(rel, { before: prev ? prev.before : s.beforeContent, after: s.afterContent, edits: (prev?.edits ?? 0) + Math.max(1, s.hunkCount ?? 1) });
  }
  const items: FileDiffSummaryItem[] = [];
  const isMulti = byFile.size >= 3 && !full;
  const maxH = full ? 1000 : isMulti ? 2 : 8;
  const maxL = full ? 10_000 : isMulti ? 5 : 15;
  const maxC = full ? 160 : 76;
  for (const [file, info] of byFile.entries()) {
    if (info.before !== null && info.before === info.after) continue;
    const oldArr = info.before === null ? [] : info.before.replace(/\r\n/g, "\n").split("\n");
    const newArr = info.after.replace(/\r\n/g, "\n").split("\n");
    const hunks = info.before === null ? [{ removed: [], added: stripCommonPairIndent([], newArr).added }] : extractChangedHunks(info.before, info.after);
    const removed = hunks.flatMap((h) => h.removed);
    const added = hunks.flatMap((h) => h.added);
    const hunksPreview = hunks.slice(0, maxH).map((h) => ({
      removed: h.removed.slice(0, maxL).map((l) => truncateVisualCols(l, maxC)),
      added: h.added.slice(0, maxL).map((l) => truncateVisualCols(l, maxC)),
      totalRemoved: h.removed.length,
      totalAdded: h.added.length,
    }));
    items.push({
      file,
      isNew: info.before === null,
      edits: info.edits,
      oldLines: oldArr.length,
      newLines: newArr.length,
      addedLines: info.before === null ? newArr.length : added.length,
      removedLines: info.before === null ? 0 : removed.length,
      removedPreview: removed.slice(0, 5).map((l) => truncateVisualCols(l, 70)),
      addedPreview: added.slice(0, 5).map((l) => truncateVisualCols(l, 70)),
      totalHunks: hunks.length,
      hunksPreview,
    });
  }
  return items;
}

export function formatSnapshotsDiff(snapshots: readonly FileVersionSnapshot[], workspaceRoot: string, opts: { full?: boolean; totalVersions?: number; fileFilter?: string } = {}): string {
  const allDiffs = summarizeSnapshotsDiff(snapshots, workspaceRoot, opts.full);
  if (allDiffs.length === 0) return "ℹ️  当前没有未撤回的文件修改记录。";
  const flt = opts.fileFilter?.trim().toLowerCase();
  const matched = flt ? (/^\d+$/.test(flt) ? (allDiffs[Number(flt) - 1] ? [allDiffs[Number(flt) - 1]!.file] : []) : allDiffs.filter((d) => d.file.toLowerCase().includes(flt)).map((d) => d.file)) : null;
  if (matched && matched.length === 0) return `⚠️ 未找到匹配 "${opts.fileFilter}" 的修改文件（当前共修改 ${allDiffs.length} 个文件）。`;
  const diffs = matched ? summarizeSnapshotsDiff(snapshots.filter((s) => matched.includes(shortenWorkspaceText(s.path, workspaceRoot))), workspaceRoot, opts.full) : allDiffs;
  const totalVer = opts.totalVersions ?? snapshots.length;
  const scopeStr = totalVer > snapshots.length ? `当前展示最新第 v${totalVer} 版 · 输入 /diff all 查看累计 ${totalVer} 版` : `共 ${totalVer} 个版本`;
  const out = [`\n🔍 [文件修改审核对比 (共 ${allDiffs.length} 个文件, ${scopeStr} · 输入 /undo 撤回本轮 | /diff full 展开全部代码)]:`];
  if (!matched && diffs.length >= 2) {
    out.push(`  📂 修改文件清单 (输入 /diff <序号或文件名> 可单独展开某文件):`);
    diffs.forEach((d, i) => out.push(`     [${i + 1}] ${d.file} (${d.isNew ? `新建 +${d.newLines} 行` : `+${d.addedLines} / -${d.removedLines} 行 · ${d.edits} 处修改`})`));
  }
  for (const d of diffs) {
    out.push(`  📘 ${d.file} (${d.isNew ? `新建文件 · +${d.newLines} 行` : `修改 ${d.edits} 处 · +${d.addedLines} / -${d.removedLines} 行 (${d.oldLines} -> ${d.newLines} 行)`})`);
    const hList = d.hunksPreview?.length ? d.hunksPreview : [{ removed: d.removedPreview, added: d.addedPreview, totalRemoved: d.removedLines, totalAdded: d.addedLines }];
    hList.forEach((h, idx) => {
      const tRem = h.totalRemoved ?? h.removed.length;
      const tAdd = h.totalAdded ?? h.added.length;
      if (hList.length > 1) out.push(`     \x1b[90m@@ 修改片段 #${idx + 1} (-${tRem} / +${tAdd} 行) @@\x1b[0m`);
      if (h.removed.length === 1 && h.added.length === 1 && tRem === 1 && tAdd === 1) {
        const pair = formatIntraLineDiffPair(h.removed[0]!, h.added[0]!, opts.full ? 160 : 76);
        out.push(`     ${pair.remFormatted}`, `     ${pair.addFormatted}`);
        return;
      }
      for (const r of h.removed) out.push(`     \x1b[31m- ${r}\x1b[0m`);
      if (tRem > h.removed.length) out.push(`     \x1b[90m  ... (此段其余 ${tRem - h.removed.length} 行删除已折叠，输入 /diff full 查看全部)\x1b[0m`);
      for (const a of h.added) out.push(`     \x1b[32m+ ${a}\x1b[0m`);
      if (tAdd > h.added.length) out.push(`     \x1b[90m  ... (此段其余 ${tAdd - h.added.length} 行新增已折叠，输入 /diff full 查看全部)\x1b[0m`);
    });
    if ((d.totalHunks ?? 0) > hList.length) out.push(`     \x1b[90m... (其余 ${(d.totalHunks ?? 0) - hList.length} 处修改片段已折叠，输入 /diff full 查看全部)\x1b[0m`);
  }
  return out.join("\n");
}
