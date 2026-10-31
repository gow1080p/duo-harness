import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { ToolContract } from "../core/contracts.js";
import { checkFileSyntax } from "./bash-policy.js";
import { createRunBashTool, killProcessGroup, killTrackedChildren, runCommandInSandbox } from "./bash-tool.js";
import { extractChangedHunk } from "./diff-presenter.js";
import { expandHomePath, toPosixRelative } from "./platform.js";
import { writeFileAtomicSync } from "./store.js";
import { resolveSafePath, type SandboxGrants } from "./tools.js";
import { checkHardDeniedPath, resolveExistingRealPath } from "./sandbox-policy.js";

export { createRunBashTool, killProcessGroup, killTrackedChildren, runCommandInSandbox };

const SingleEditItemSchema = z.object({
  oldText: z.string().describe("原文件中待替换的精确代码片段"),
  newText: z.string().describe("替换后的新代码片段"),
});
const EditFileArgsSchema = z.object({
  path: z.string().min(1).describe("工作区内的目标文件路径"),
  oldText: z.string().optional().describe("待替换的原文本（新建或全量覆盖时传空字符串）"),
  newText: z.string().optional().describe("替换后的新文本"),
  edits: z.preprocess((val) => {
    if (typeof val === "string") {
      try { return JSON.parse(val); } catch { return val; }
    }
    return val;
  }, z.array(SingleEditItemSchema).optional()).describe("同文件多处顺序修改列表"),
});
const RollbackVersionArgsSchema = z.object({
  stepsBack: z.number().int().positive().max(100).default(1).describe("向前回退的版本步数（默认 1）"),
});

export interface FileVersionSnapshot {
  version: number; path: string; beforeContent: string | null; afterContent: string; timestamp: number; turnId?: string; leafId?: string; hunkCount?: number;
}

export function rollbackFileSnapshotsSync(workspaceRoot: string, snapshots: FileVersionSnapshot[], stepsBack = 1, onSnapshotChange?: () => void, redoBatches?: FileVersionSnapshot[][]): { rolledBackCount: number; currentVersion: number; touchedPaths: string[] } {
  const count = Math.min(Math.max(0, stepsBack), snapshots.length), touchedPaths: string[] = [], batch: FileVersionSnapshot[] = [];
  if (count > 0 && redoBatches) redoBatches.push(batch);
  const realRoot = resolveExistingRealPath(workspaceRoot);
  for (let i = 0; i < count; i++) {
    const snap = snapshots[snapshots.length - 1]!;
    const fullPath = resolveExistingRealPath(path.resolve(workspaceRoot, expandHomePath(snap.path)));
    if (checkHardDeniedPath(fullPath, realRoot, "write")) throw new Error(`禁止回滚敏感路径: ${snap.path}`);
    if (snap.beforeContent === null) fsSync.rmSync(fullPath, { force: true });
    else writeFileAtomicSync(fullPath, snap.beforeContent);
    snapshots.pop();
    batch.unshift(snap);
    onSnapshotChange?.();
    touchedPaths.push(snap.path);
  }
  return { rolledBackCount: count, currentVersion: snapshots.length, touchedPaths };
}

export async function rollbackFileSnapshots(workspaceRoot: string, snapshots: FileVersionSnapshot[], stepsBack = 1, onSnapshotChange?: () => void, redoBatches?: FileVersionSnapshot[][]): Promise<{ rolledBackCount: number; currentVersion: number; touchedPaths: string[] }> {
  return rollbackFileSnapshotsSync(workspaceRoot, snapshots, stepsBack, onSnapshotChange, redoBatches);
}

export function redoFileSnapshots(workspaceRoot: string, snapshots: FileVersionSnapshot[], redoBatches: FileVersionSnapshot[][], batchesToRedo = 1, onSnapshotChange?: () => void) {
  const count = Math.min(Math.max(0, batchesToRedo), redoBatches.length), touchedPaths: string[] = [];
  let redoneCount = 0;
  const realRoot = resolveExistingRealPath(workspaceRoot);
  for (let i = 0; i < count; i++) {
    const batch = redoBatches[redoBatches.length - 1]!;
    while (batch.length > 0) {
      const snap = batch[0]!;
      const fullPath = resolveExistingRealPath(path.resolve(workspaceRoot, expandHomePath(snap.path)));
      if (checkHardDeniedPath(fullPath, realRoot, "write")) throw new Error(`禁止重做敏感路径: ${snap.path}`);
      writeFileAtomicSync(fullPath, snap.afterContent);
      batch.shift();
      snapshots.push({ ...snap, version: snapshots.length + 1 });
      redoneCount++;
      touchedPaths.push(snap.path);
    }
    redoBatches.pop();
    onSnapshotChange?.();
  }
  return { redoneCount, totalVersions: snapshots.length, remainingRedoBatches: redoBatches.length, touchedPaths: [...new Set(touchedPaths)] };
}

function findSubstrLineNumbers(content: string, needle: string): number[] {
  const lines: number[] = [];
  let pos = 0;
  while (needle.length > 0 && (pos = content.indexOf(needle, pos)) !== -1) {
    lines.push(content.slice(0, pos).split("\n").length);
    pos += needle.length;
  }
  return lines;
}

function minLeadingIndent(lines: readonly string[]): number {
  let min = Infinity;
  for (const l of lines) {
    if (!l.trim()) continue;
    const m = l.match(/^[ \t]*/)?.[0]?.length ?? 0;
    if (m < min) min = m;
  }
  return Number.isFinite(min) ? min : 0;
}

function normalizeFuzzyLine(line: string): string {
  return line
    .normalize("NFKC")
    .trimEnd()
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function tryIndentOrFuzzyReplace(wLines: readonly string[], oLines: readonly string[], nLines: readonly string[], eol: string, filePath: string, fuzzy: boolean): string | null {
  if (!oLines.some((l) => l.trim().length > 0)) return null;
  const oldIndent = minLeadingIndent(oLines);
  const norm = fuzzy ? normalizeFuzzyLine : (s: string) => s.trimEnd();
  const matches: { idx: number; winIndent: number; indentChar: string }[] = [];
  for (let i = 0; i <= wLines.length - oLines.length; i++) {
    const win = wLines.slice(i, i + oLines.length), winIndent = minLeadingIndent(win);
    const ok = oLines.every((ol, j) => {
      const wl = win[j] ?? "";
      if (!ol.trim() || !wl.trim()) return !ol.trim() && !wl.trim();
      return norm(wl.slice(winIndent)) === norm(ol.slice(oldIndent));
    });
    if (ok) {
      const firstNonEmpty = win.find((l) => l.trim().length > 0) ?? "";
      matches.push({ idx: i, winIndent, indentChar: firstNonEmpty.startsWith("\t") ? "\t" : " " });
    }
  }
  if (matches.length > 1) {
    throw new Error(`oldText 在 ${filePath} 中出现了 ${matches.length} 次 (位于第 ${matches.map((m) => m.idx + 1).join(", ")} 行)，请补充前后几行保证唯一匹配`);
  }
  if (matches.length === 1) {
    const { idx, winIndent, indentChar } = matches[0]!, delta = winIndent - oldIndent;
    const shiftedNew = nLines.map((nl) => {
      if (!nl.trim()) return "";
      if (delta >= 0) return indentChar.repeat(delta) + nl;
      const lead = nl.match(/^[ \t]*/)?.[0]?.length ?? 0;
      return nl.slice(Math.min(lead, -delta));
    });
    return [...wLines.slice(0, idx), ...shiftedNew, ...wLines.slice(idx + oLines.length)].join(eol);
  }
  return null;
}

function replaceSingleItem(workingContent: string, oldText: string, newText: string, filePath: string, wasCreatedEmpty: boolean): string {
  if (wasCreatedEmpty && workingContent === "") throw new Error(`文件不存在，无法替换 oldText: ${filePath}`);
  const exactCount = workingContent.split(oldText).length - 1;
  if (exactCount === 1) return workingContent.replace(oldText, () => newText);
  if (exactCount > 1) {
    const ln = findSubstrLineNumbers(workingContent, oldText).join(", ");
    throw new Error(`oldText 在 ${filePath} 中出现了 ${exactCount} 次 (位于第 ${ln} 行)，请补充前后几行保证唯一匹配`);
  }
  const eol = workingContent.includes("\r\n") ? "\r\n" : "\n";
  const normOld = oldText.replace(/\r\n/g, "\n").split("\n").join(eol);
  const normNew = newText.replace(/\r\n/g, "\n").split("\n").join(eol);
  const eolCount = normOld !== oldText ? workingContent.split(normOld).length - 1 : 0;
  if (eolCount === 1) return workingContent.replace(normOld, () => normNew);
  if (eolCount > 1) {
    const ln = findSubstrLineNumbers(workingContent, normOld).join(", ");
    throw new Error(`oldText 在 ${filePath} 中出现了 ${eolCount} 次 (位于第 ${ln} 行)，请补充前后几行保证唯一匹配`);
  }
  const wLines = workingContent.split(/\r?\n/), oLines = oldText.split(/\r?\n/), nLines = normNew.split(/\r?\n/);
  const matchIdxs: number[] = [];
  for (let i = 0; i <= wLines.length - oLines.length; i++) {
    if (oLines.every((ol, j) => wLines[i + j]?.trimEnd() === ol.trimEnd())) matchIdxs.push(i);
  }
  if (matchIdxs.length === 1) {
    const idx = matchIdxs[0]!;
    return [...wLines.slice(0, idx), ...nLines, ...wLines.slice(idx + oLines.length)].join(eol);
  }
  if (matchIdxs.length > 1) {
    throw new Error(`oldText 在 ${filePath} 中出现了 ${matchIdxs.length} 次 (位于第 ${matchIdxs.map((i) => i + 1).join(", ")} 行)，请补充前后几行保证唯一匹配`);
  }
  const indentReplaced = tryIndentOrFuzzyReplace(wLines, oLines, nLines, eol, filePath, false);
  if (indentReplaced !== null) return indentReplaced;
  const fuzzyReplaced = tryIndentOrFuzzyReplace(wLines, oLines, nLines, eol, filePath, true);
  if (fuzzyReplaced !== null) return fuzzyReplaced;
  throw new Error(`在 ${filePath} 中未找到匹配的 oldText，请先用 read_file 确认原文件内容`);
}

const fileMutationQueues = new Map<string, Promise<unknown>>();

export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = resolveExistingRealPath(filePath);
  const prev = fileMutationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => { release = r; });
  const chained = prev.then(() => next);
  fileMutationQueues.set(key, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (fileMutationQueues.get(key) === chained) fileMutationQueues.delete(key);
  }
}

async function applyFileEdit(workspaceRoot: string, snapshots: FileVersionSnapshot[], args: z.infer<typeof EditFileArgsSchema>, onSnapshotChange?: () => void, grants?: SandboxGrants): Promise<string> {
  const fullPath = resolveSafePath(workspaceRoot, args.path, "write", grants);
  return withFileMutationQueue(fullPath, async () => {
    const rawBefore = fsSync.existsSync(fullPath) ? await fs.readFile(fullPath, "utf-8") : null;
    const bom = rawBefore?.startsWith("\uFEFF") ? "\uFEFF" : "";
    const beforeBody = rawBefore !== null && bom ? rawBefore.slice(1) : rawBefore;
    const hasBatch = Array.isArray(args.edits) && args.edits.length > 0;
    if (!hasBatch && (args.oldText === undefined || args.newText === undefined)) throw new Error(`edit_file 参数缺失：必须提供 oldText/newText 或非空 edits 数组`);
    const editList = hasBatch ? args.edits! : [{ oldText: args.oldText!, newText: args.newText! }];
    if (editList.length > 1 && editList.some((item) => item.oldText === "")) throw new Error(`批量 edits 中禁止混入 oldText 为空串的全量覆盖项: ${args.path}`);

    let workingContent = beforeBody ?? "";
    for (const item of editList) {
      const cleanOld = item.oldText.startsWith("\uFEFF") ? item.oldText.slice(1) : item.oldText;
      const cleanNew = item.newText.startsWith("\uFEFF") ? item.newText.slice(1) : item.newText;
      workingContent = cleanOld === "" ? cleanNew : replaceSingleItem(workingContent, cleanOld, cleanNew, args.path, rawBefore === null);
    }
    if (rawBefore !== null && workingContent === beforeBody) {
      throw new Error(`edit_file 未产生任何实际修改：${args.path} 的 newText 与原内容完全相同（+0 / -0 行），请传入实际修改后的代码`);
    }

    const finalContent = bom + workingContent;
    writeFileAtomicSync(fullPath, finalContent);
    const relPath = toPosixRelative(resolveSafePath(workspaceRoot, ".", "read", grants), fullPath) || args.path;
    const version = snapshots.length + 1;
    snapshots.push({ version, path: relPath, beforeContent: rawBefore, afterContent: finalContent, timestamp: Date.now(), hunkCount: editList.length });
    onSnapshotChange?.();
    const hunks = editList.map((e) => extractChangedHunk(e.oldText, e.newText));
    const added = rawBefore === null ? workingContent.split(/\r?\n/).length : hunks.reduce((a, h) => a + h.added.length, 0);
    const removed = rawBefore === null ? 0 : hunks.reduce((a, h) => a + h.removed.length, 0);
    const baseMsg = `已写入文件: ${relPath} (共应用 ${editList.length} 处修改 · +${added} / -${removed} 行，当前版本 v${version}，语法自检已通过)`;
    const syntaxErr = checkFileSyntax(relPath, workingContent);
    return syntaxErr ? `已写入文件: ${relPath} (v${version})\n⚠️ [语法自检未通过] 检测到语法错误:\n${syntaxErr}\n请立即调用 edit_file 修复上述语法错误后再结束本轮回答。` : baseMsg;
  });
}

export function createWriteTools(workspaceRoot: string = process.cwd(), snapshots: FileVersionSnapshot[] = [], signal?: AbortSignal, onSnapshotChange?: () => void, grants?: SandboxGrants): ToolContract<any>[] {
  const editFileTool: ToolContract<z.infer<typeof EditFileArgsSchema>> = {
    name: "edit_file",
    description: "修改或新建工作区内的文件（oldText 为空表示新建/覆盖文件，非空则唯一替换 oldText 为 newText）",
    parameters: EditFileArgsSchema,
    readonly: false,
    execute: (args) => applyFileEdit(workspaceRoot, snapshots, EditFileArgsSchema.parse(args), onSnapshotChange, grants),
  };

  const rollbackVersionTool: ToolContract<z.infer<typeof RollbackVersionArgsSchema>> = {
    name: "rollback_version",
    description: "将工作区文件按修改历史往回退指定的版本步数（例如用户说“回滚到之前2个版本”时传 stepsBack: 2）",
    parameters: RollbackVersionArgsSchema,
    readonly: false,
    async execute(args) {
      if (snapshots.length === 0) return "当前没有任何可回滚的文件修改记录";
      const res = await rollbackFileSnapshots(workspaceRoot, snapshots, args.stepsBack, onSnapshotChange);
      return `已成功回退 ${res.rolledBackCount} 个版本（当前回到 v${res.currentVersion} 状态），还原文件: ${res.touchedPaths.join(", ")}`;
    },
  };

  return [editFileTool, rollbackVersionTool, createRunBashTool(workspaceRoot, signal, grants)];
}
