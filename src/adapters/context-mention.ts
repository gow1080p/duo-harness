import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageAttachment } from "../core/contracts.js";
import { expandHomePath, toPosixRelative } from "./platform.js";
import { checkHardDeniedPath, resolveExistingRealPath } from "./sandbox-policy.js";
import { BINARY_EXT_RE, IGNORED_DIRS, resolveSafePath, type SandboxGrants } from "./tools.js";
import { captureClipboardImage, captureHeadlessScreenshot, findHeadlessBrowserBinary, hasPngMagicBytes, parseShotCommandArgs, persistHashedDebugPng } from "./vision-capture.js";
import { runCommandInSandbox } from "./write-tools.js";

export { captureClipboardImage, captureHeadlessScreenshot, findHeadlessBrowserBinary, hasPngMagicBytes, parseShotCommandArgs, persistHashedDebugPng };

export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;

function getImageMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

const workspaceFilesCache = new Map<string, { ts: number; files: string[] }>();
const ALLOWED_DOT_DIRS = new Set([".debug", ".claude", ".agents", ".pi", ".duo-harness", ".github"]);
const HOME_HEAVY_DIRS = new Set(["AppData", "Library", "Applications", "Downloads", "Pictures", "Movies", "Music", "Videos", "OneDrive", "scoop", "target", "coverage"]);

export function listWorkspaceFiles(workspaceRoot: string, maxFiles = 1200): string[] {
  const realRoot = fs.existsSync(workspaceRoot) ? fs.realpathSync(workspaceRoot) : path.resolve(workspaceRoot);
  const now = Date.now(), cached = workspaceFilesCache.get(realRoot);
  if (cached && now - cached.ts < 3_000) return cached.files;
  try {
    const seen = new Set<string>(), isHomeRoot = path.resolve(realRoot).toLowerCase() === path.resolve(os.homedir()).toLowerCase();
    for (const debugImg of ["shot.png", "clipboard.png"]) {
      if (fs.existsSync(path.join(realRoot, ".debug", debugImg))) seen.add(`.debug/${debugImg}`);
    }
    const maxDepth = isHomeRoot ? 1 : 6, queue: Array<{ dir: string; depth: number }> = [{ dir: realRoot, depth: 0 }];
    while (queue.length > 0 && seen.size < maxFiles) {
      const { dir, depth } = queue.shift()!;
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < maxDepth && (e.name.startsWith(".") ? ALLOWED_DOT_DIRS.has(e.name) : !IGNORED_DIRS.has(e.name) && !(isHomeRoot && HOME_HEAVY_DIRS.has(e.name)))) queue.push({ dir: full, depth: depth + 1 });
        } else if (e.isFile() && !e.name.startsWith(".") && (!BINARY_EXT_RE.test(e.name) || IMAGE_EXT_RE.test(e.name))) {
          seen.add(toPosixRelative(realRoot, full));
          if (seen.size >= maxFiles) break;
        }
      }
    }
    const files = [...seen].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    workspaceFilesCache.set(realRoot, { ts: now, files });
    return files;
  } catch {
    return [];
  }
}

export function filterAndRankFiles(files: readonly string[], rawQuery: string, limit = 8): string[] {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return files.slice(0, limit);
  const scored: Array<{ file: string; score: number }> = [];
  for (const file of files) {
    const lower = file.toLowerCase(), base = path.posix.basename(lower);
    const score = base === q ? 100 : base.startsWith(q) ? 80 : base.includes(q) ? 50 : lower.includes(q) ? 30 : 0;
    if (score > 0) scored.push({ file, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.file.split("/").length - b.file.split("/").length || a.file.localeCompare(b.file)).slice(0, limit).map((x) => x.file);
}

export function buildAtMentionDropdown(
  line: string,
  cursor: number,
  workspaceRoot: string,
): { label: string; desc: string; fillText: string; expandOnly: boolean; cursorAfter: number }[] {
  const safeCursor = Math.max(0, Math.min(cursor, line.length));
  const before = line.slice(0, safeCursor), after = line.slice(safeCursor);
  const pastedImg = before.match(/(?:^|[\s(])@(\.debug\/(?:clipboard|shot)-[0-9a-f]{6}\.png)\s$/);
  if (pastedImg?.[1] && !after.trim()) {
    const rel = pastedImg[1], full = path.join(workspaceRoot, rel);
    const kb = fs.existsSync(full) ? Math.max(1, Math.round(fs.statSync(full).size / 1024)) : 0;
    return [{ label: `@${rel}`, desc: `📋 已粘贴剪贴板截图 (${kb} KB · 直接继续输入问题或按回车即可发送)`, fillText: line, expandOnly: false, cursorAfter: safeCursor }];
  }
  const m = before.match(/(?:^|[\s(])@([^\s]*)$/);
  if (!m) return [];
  const rawQuery = m[1]!, query = rawQuery.toLowerCase(), atIndex = before.length - rawQuery.length - 1;
  const trimmedAfter = after.startsWith(" ") ? after.slice(1) : after;
  const items = filterAndRankFiles(listWorkspaceFiles(workspaceRoot), query, 7).map((relPath) => {
    const formattedRef = relPath.includes(" ") ? `@"${relPath}"` : `@${relPath}`;
    const replacedPrefix = `${before.slice(0, atIndex)}${formattedRef} `;
    return { label: formattedRef, desc: `📎 引用工作区文件 (${relPath})`, fillText: `${replacedPrefix}${trimmedAfter}`, expandOnly: true, cursorAfter: replacedPrefix.length };
  });
  if (!query || "clipboard".startsWith(query) || "paste".startsWith(query)) {
    const replacedPrefix = `${before.slice(0, atIndex)}@clipboard `;
    items.push({ label: "@clipboard", desc: "📋 粘贴系统剪贴板最新截图 (.debug/clipboard.png)", fillText: `${replacedPrefix}${trimmedAfter}`, expandOnly: true, cursorAfter: replacedPrefix.length });
  }
  return items.slice(0, 8);
}

export function stripAttachedFiles(raw: string): string {
  if (!raw || (!raw.includes("<attached_file") && !raw.includes("<context_state") && !raw.includes("[已折叠历史引用文件 @") && !raw.includes("[已折叠历史图片 @") && !raw.includes("[已折叠历史上下文状态"))) return raw;
  const stripped = raw
    .replace(/\s*<attached_file\b[^>]*>[\s\S]*?<\/attached_file>/g, "")
    .replace(/\s*<context_state\b[^>]*>[\s\S]*?<\/context_state>/g, "")
    .replace(/\s*\[已折叠历史(?:引用文件|图片) @[^\]]+\]/g, "")
    .replace(/\s*\[已折叠历史上下文状态 [^\]]+\]/g, "")
    .trim();
  if (stripped) return stripped;
  const paths = [...raw.matchAll(/(?:<attached_file\s+path="([^"]+)"|\[已折叠历史(?:引用文件|图片) @([^\]]+?)(?:\s*\((?:原长|\d+\s*KB)[^\]]*\))?\])/g)].map((m) => `@${(m[1] ?? m[2] ?? "").trim()}`);
  return paths.length > 0 ? `[引用文件: ${paths.join(", ")}]` : raw.slice(0, 80).trim();
}

export interface ParsedAttachmentToken {
  target: string;
  startLine?: number;
  endLine?: number;
  isClipboard?: boolean;
}

export function extractAttachmentTokens(prompt: string): ParsedAttachmentToken[] {
  const tokens: ParsedAttachmentToken[] = [];
  const pushFileToken = (rawToken: string, explicitRange?: { start?: string; end?: string }, isExplicitAt = true) => {
    const unescaped = rawToken.replace(/\\ /g, " ").replace(/[.:;!?]+$/, "").trim();
    if (!unescaped) return;
    if (isExplicitAt && (unescaped.toLowerCase() === "clipboard" || unescaped.toLowerCase() === "paste")) {
      tokens.push({ target: "@clipboard", isClipboard: true });
      return;
    }
    const rangeMatch = !explicitRange?.start ? unescaped.match(/^(.+?):(\d+)(?:-(\d+))?$/) : null;
    const target = rangeMatch ? rangeMatch[1]! : unescaped;
    const sStr = explicitRange?.start ?? rangeMatch?.[2], eStr = explicitRange?.end ?? rangeMatch?.[3];
    tokens.push({ target, ...(sStr ? { startLine: Math.max(1, Number(sStr)) } : {}), ...(eStr ? { endLine: Number(eStr) } : {}) });
  };
  const pattern =
    /(?:^|[\s(])@"([^"]+)"(?::(\d+)(?:-(\d+))?)?|(?:^|[\s(])@'([^']+)'(?::(\d+)(?:-(\d+))?)?|(?:^|[\s(])@((?:\\ |[^\s,;'"`<>()])+)|(?:'((?:\/|~\/|[A-Za-z]:[\\/])[^'\r\n]+)'|"((?:\/|~\/|[A-Za-z]:[\\/])[^"\r\n]+)")|(?:^|[\s(])((?:\/|~\/|[A-Za-z]:[\\/])(?:\\ |[^\s,;'"`<>()])+)/g;
  for (const m of prompt.matchAll(pattern)) {
    if (m[1] !== undefined) pushFileToken(m[1], { start: m[2], end: m[3] }, true);
    else if (m[4] !== undefined) pushFileToken(m[4], { start: m[5], end: m[6] }, true);
    else if (m[7] !== undefined) pushFileToken(m[7], undefined, true);
    else if (m[8] !== undefined || m[9] !== undefined) pushFileToken((m[8] ?? m[9])!, undefined, false);
    else if (m[10] !== undefined) {
      const unescapedBare = m[10].replace(/\\ /g, " ").replace(/[.:;!?]+$/, "");
      if (m[10].includes("\\ ") || IMAGE_EXT_RE.test(unescapedBare)) pushFileToken(m[10], undefined, false);
    }
  }
  return tokens;
}

export function expandAtMentions(
  prompt: string,
  workspaceRoot: string,
  maxLinesPerFile = 300,
  grants?: SandboxGrants,
): { expandedPrompt: string; attachedPaths: string[]; attachedImages: ImageAttachment[] } {
  const tokens = extractAttachmentTokens(prompt);
  if (tokens.length === 0) return { expandedPrompt: prompt, attachedPaths: [], attachedImages: [] };
  const realRoot = fs.existsSync(workspaceRoot) ? fs.realpathSync(workspaceRoot) : path.resolve(workspaceRoot);
  const seen = new Set<string>(), blocks: string[] = [], attachedPaths: string[] = [], attachedImages: ImageAttachment[] = [];

  for (const tok of tokens) {
    if (attachedPaths.length >= 6) {
      blocks.push(`[系统提示：单次提问最多附加 6 个文件/图片，其余 @引用已省略]`);
      break;
    }
    if (tok.isClipboard) {
      if (seen.has("img:clipboard")) continue;
      const clip = captureClipboardImage(realRoot);
      if (clip.ok) {
        seen.add("img:clipboard");
        attachedPaths.push(clip.relPath);
        attachedImages.push({ path: clip.immutableRelPath, mimeType: "image/png", byteSize: clip.byteSize });
      }
      continue;
    }
    try {
      const candidate = resolveExistingRealPath(path.resolve(realRoot, expandHomePath(tok.target)));
      if (grants && fs.existsSync(candidate) && !checkHardDeniedPath(candidate, realRoot, "read")) {
        if (fs.statSync(candidate).isFile()) grants.onceAllowedPaths.add(candidate);
      }
      const fullPath = resolveSafePath(realRoot, tok.target, "read", grants);
      const stat = fs.existsSync(fullPath) ? fs.statSync(fullPath) : null;
      if (!stat || !stat.isFile()) continue;
      const relPath = toPosixRelative(realRoot, fullPath) || path.basename(fullPath);
      if (IMAGE_EXT_RE.test(fullPath)) {
        if (stat.size > 5 * 1024 * 1024) {
          const mb = (stat.size / (1024 * 1024)).toFixed(1);
          console.warn(`⚠️ [图片超限已跳过] ${relPath} (${mb}MB > 5MB 上限)`);
          blocks.push(`[图片附件已跳过: ${relPath} 体积 ${mb}MB 超出 5MB 上限]`);
        } else if (!seen.has(`img:${relPath}`)) {
          seen.add(`img:${relPath}`);
          attachedPaths.push(relPath);
          attachedImages.push({ path: relPath.startsWith("..") ? fullPath : relPath, mimeType: getImageMimeType(fullPath), byteSize: stat.size });
        }
        continue;
      }
      if (BINARY_EXT_RE.test(fullPath)) continue;
      const cacheKey = `${relPath}:${tok.startLine ?? ""}-${tok.endLine ?? ""}`;
      if (seen.has(cacheKey)) continue;
      const content = fs.readFileSync(fullPath, "utf-8");
      if (content.includes("\u0000")) continue;
      const allLines = content.split("\n"), startLine = tok.startLine ?? 1;
      const requestedEnd = tok.endLine ?? (tok.startLine ? startLine + maxLinesPerFile - 1 : maxLinesPerFile);
      const endLine = Math.min(allLines.length, Math.max(startLine, requestedEnd));
      const numbered = allLines.slice(startLine - 1, endLine).map((l, idx) => `${startLine + idx}: ${l}`);
      if (endLine < allLines.length && !tok.endLine) numbered.push(`... (其余 ${allLines.length - endLine} 行已省略，如需查看后续内容请调用 read_file)`);
      seen.add(cacheKey);
      attachedPaths.push(relPath);
      blocks.push(`<attached_file path="${relPath}" lines="${startLine}-${endLine}">\n${numbered.join("\n")}\n</attached_file>`);
    } catch {}
  }
  const hasBareImageOnly = attachedImages.length > 0 && blocks.length === 0 && !prompt.replace(/@(?:"[^"]+"|'[^']+'|\S+)/g, "").trim();
  const basePrompt = hasBareImageOnly ? `${prompt}\n\n请查看并分析这张截图。` : prompt;
  return { expandedPrompt: blocks.length > 0 ? `${basePrompt}\n\n${blocks.join("\n\n")}` : basePrompt, attachedPaths, attachedImages };
}

export async function runLocalBangCommand(
  rawLine: string,
  workspaceRoot: string,
  rl?: { on: (ev: string, fn: () => void) => unknown; off: (ev: string, fn: () => void) => unknown },
): Promise<void> {
  const cmd = rawLine.slice(1).trim();
  if (!cmd) {
    console.log("💡 用法: !<本地命令> (例如: !git status 或 !pnpm test，直接在终端秒跑且 0 Token 消耗)");
    return;
  }
  const abortCtrl = new AbortController(), onSigint = () => abortCtrl.abort();
  rl?.on("SIGINT", onSigint);
  try {
    console.log(`⚡ [本地直跑] $ ${cmd}`);
    const res = await runCommandInSandbox(cmd, workspaceRoot, 30_000, abortCtrl.signal, false);
    if (res.output.trim()) console.log(res.output.trimEnd());
    console.log(res.exitCode === 0 ? `✅ [命令完成 · exit 0]` : `⚠️ [命令退出 · exit ${res.exitCode}]`);
  } finally {
    rl?.off("SIGINT", onSigint);
  }
}
