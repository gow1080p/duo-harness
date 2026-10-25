import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ImageAttachment } from "../core/contracts.js";
import { expandHomePath, killProcessGroup, openInDefaultApp, resolveDefaultOpenTarget, toPosixRelative } from "./platform.js";
import { checkHardDeniedPath, resolveExistingRealPath, toGrantDir } from "./sandbox-policy.js";
import { BINARY_EXT_RE, IGNORED_DIRS, resolveSafePath, type SandboxGrants } from "./tools.js";
import { runCommandInSandbox } from "./write-tools.js";

export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;

function getImageMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

const workspaceFilesCache = new Map<string, { ts: number; files: string[] }>();

export function listWorkspaceFiles(workspaceRoot: string, maxFiles = 1200): string[] {
  const realRoot = fs.existsSync(workspaceRoot) ? fs.realpathSync(workspaceRoot) : path.resolve(workspaceRoot);
  const now = Date.now();
  const cached = workspaceFilesCache.get(realRoot);
  if (cached && now - cached.ts < 3_000) return cached.files;
  try {
    const entries = fs.readdirSync(realRoot, { recursive: true, withFileTypes: true });
    const files: string[] = [];
    if (fs.existsSync(path.join(realRoot, ".debug", "shot.png"))) files.push(".debug/shot.png");
    for (const e of entries) {
      if (!e.isFile() || e.name.startsWith(".") || (BINARY_EXT_RE.test(e.name) && !IMAGE_EXT_RE.test(e.name))) continue;
      const relDir = path.relative(realRoot, e.parentPath);
      if (relDir && relDir.split(path.sep).some((p) => IGNORED_DIRS.has(p) || p.startsWith("."))) continue;
      files.push(toPosixRelative(realRoot, path.join(e.parentPath, e.name)));
      if (files.length >= maxFiles) break;
    }
    files.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    workspaceFilesCache.set(realRoot, { ts: now, files });
    return files;
  } catch {
    return [];
  }
}

export function buildAtMentionDropdown(
  line: string,
  cursor: number,
  workspaceRoot: string,
): { label: string; desc: string; fillText: string; expandOnly: boolean; cursorAfter: number }[] {
  const safeCursor = Math.max(0, Math.min(cursor, line.length));
  const before = line.slice(0, safeCursor);
  const after = line.slice(safeCursor);
  const m = before.match(/(?:^|[\s(])@([^\s]*)$/);
  if (!m) return [];
  const rawQuery = m[1]!;
  const query = rawQuery.toLowerCase();
  const atIndex = before.length - rawQuery.length - 1;
  const allFiles = listWorkspaceFiles(workspaceRoot);
  const exactBase: string[] = [];
  const fuzzyPath: string[] = [];
  for (const f of allFiles) {
    const lower = f.toLowerCase();
    const base = path.posix.basename(lower);
    if (!query || base.startsWith(query)) exactBase.push(f);
    else if (lower.includes(query)) fuzzyPath.push(f);
  }
  return [...exactBase, ...fuzzyPath].slice(0, 8).map((relPath) => {
    const replacedPrefix = `${before.slice(0, atIndex)}@${relPath} `;
    const trimmedAfter = after.startsWith(" ") ? after.slice(1) : after;
    return {
      label: `@${relPath}`,
      desc: `📎 引用工作区文件 (${relPath})`,
      fillText: `${replacedPrefix}${trimmedAfter}`,
      expandOnly: true,
      cursorAfter: replacedPrefix.length,
    };
  });
}

export function stripAttachedFiles(raw: string): string {
  if (!raw || (!raw.includes("<attached_file") && !raw.includes("[已折叠历史引用文件 @"))) return raw;
  const stripped = raw
    .replace(/\s*<attached_file\b[^>]*>[\s\S]*?<\/attached_file>/g, "")
    .replace(/\s*\[已折叠历史引用文件 @[^\]]+\]/g, "")
    .trim();
  if (stripped) return stripped;
  const paths = [...raw.matchAll(/(?:<attached_file\s+path="([^"]+)"|\[已折叠历史引用文件 @([^\s\]]+))/g)].map((m) => `@${m[1] ?? m[2]}`);
  return paths.length > 0 ? `[引用文件: ${paths.join(", ")}]` : raw.slice(0, 80).trim();
}

export function expandAtMentions(
  prompt: string,
  workspaceRoot: string,
  maxLinesPerFile = 300,
  grants?: SandboxGrants,
): { expandedPrompt: string; attachedPaths: string[]; attachedImages: ImageAttachment[] } {
  const matches = [...prompt.matchAll(/(?:^|[\s(])@([^\s,;'"`<>()]+)/g)];
  if (matches.length === 0) return { expandedPrompt: prompt, attachedPaths: [], attachedImages: [] };
  const realRoot = fs.existsSync(workspaceRoot) ? fs.realpathSync(workspaceRoot) : path.resolve(workspaceRoot);
  const seen = new Set<string>();
  const blocks: string[] = [];
  const attachedPaths: string[] = [];
  const attachedImages: ImageAttachment[] = [];

  for (const m of matches) {
    if (attachedPaths.length >= 6) break;
    const token = m[1]!.replace(/[.:;!?]+$/, "");
    const rangeMatch = token.match(/^(.+?):(\d+)(?:-(\d+))?$/);
    const rawTarget = rangeMatch ? rangeMatch[1]! : token;
    try {
      const candidate = resolveExistingRealPath(path.resolve(realRoot, expandHomePath(rawTarget)));
      if (grants && fs.existsSync(candidate) && !checkHardDeniedPath(candidate, realRoot, "read")) {
        grants.trustedReadDirs.add(toGrantDir(candidate));
      }
      const fullPath = resolveSafePath(realRoot, rawTarget, "read", grants);
      const stat = fs.existsSync(fullPath) ? fs.statSync(fullPath) : null;
      if (!stat || !stat.isFile()) continue;
      const relPath = toPosixRelative(realRoot, fullPath) || path.basename(fullPath);
      if (IMAGE_EXT_RE.test(fullPath)) {
        if (stat.size <= 5 * 1024 * 1024 && !seen.has(`img:${relPath}`)) {
          seen.add(`img:${relPath}`);
          attachedPaths.push(relPath);
          attachedImages.push({ path: relPath.startsWith("..") ? fullPath : relPath, mimeType: getImageMimeType(fullPath), byteSize: stat.size });
        }
        continue;
      }
      if (BINARY_EXT_RE.test(fullPath)) continue;
      const cacheKey = `${relPath}:${rangeMatch?.[2] ?? ""}-${rangeMatch?.[3] ?? ""}`;
      if (seen.has(cacheKey)) continue;
      const content = fs.readFileSync(fullPath, "utf-8");
      if (content.includes("\u0000")) continue;
      const allLines = content.split("\n");
      const startLine = rangeMatch ? Math.max(1, Number(rangeMatch[2])) : 1;
      const requestedEnd = rangeMatch?.[3] ? Number(rangeMatch[3]) : rangeMatch ? startLine + maxLinesPerFile - 1 : maxLinesPerFile;
      const endLine = Math.min(allLines.length, Math.max(startLine, requestedEnd));
      const numbered = allLines.slice(startLine - 1, endLine).map((l, idx) => `${startLine + idx}: ${l}`);
      if (endLine < allLines.length && !rangeMatch?.[3]) {
        numbered.push(`... (其余 ${allLines.length - endLine} 行已省略，如需查看后续内容请调用 read_file)`);
      }
      seen.add(cacheKey);
      attachedPaths.push(relPath);
      blocks.push(`<attached_file path="${relPath}" lines="${startLine}-${endLine}">\n${numbered.join("\n")}\n</attached_file>`);
    } catch {}
  }
  return { expandedPrompt: blocks.length > 0 ? `${prompt}\n\n${blocks.join("\n\n")}` : prompt, attachedPaths, attachedImages };
}

export function findHeadlessBrowserBinary(): string | null {
  if (process.env.DUO_BROWSER_BIN && fs.existsSync(process.env.DUO_BROWSER_BIN)) return process.env.DUO_BROWSER_BIN;
  const candidates =
    process.platform === "win32"
      ? [
          path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe"),
          path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Microsoft\\Edge\\Application\\msedge.exe"),
          path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
          path.join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
          path.join(process.env.LOCALAPPDATA ?? "", "Microsoft\\Edge\\Application\\msedge.exe"),
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
        : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  return candidates.find((p) => p && fs.existsSync(p)) ?? null;
}

export async function captureHeadlessScreenshot(
  targetPathOrUrl: string,
  workspaceRoot: string,
  recentFiles: readonly string[] = [],
): Promise<{ ok: boolean; shotPath: string; targetUrl: string; error?: string }> {
  const raw = targetPathOrUrl.trim() || resolveDefaultOpenTarget(workspaceRoot, recentFiles);
  const isHttp = /^https?:\/\//i.test(raw);
  const resolvedLocal = isHttp ? raw : path.resolve(workspaceRoot, expandHomePath(raw));
  const shotPath = path.join(workspaceRoot, ".debug", "shot.png");
  if (!isHttp && (!fs.existsSync(resolvedLocal) || !fs.statSync(resolvedLocal).isFile())) {
    return { ok: false, shotPath, targetUrl: resolvedLocal, error: `未找到可截图的目标文件: ${resolvedLocal}` };
  }
  const browserBin = findHeadlessBrowserBinary();
  if (!browserBin) return { ok: false, shotPath, targetUrl: resolvedLocal, error: "未检测到本机 Edge 或 Chrome 浏览器可执行文件" };
  const targetUrl = isHttp ? raw : pathToFileURL(resolvedLocal).href;
  fs.mkdirSync(path.dirname(shotPath), { recursive: true });
  if (fs.existsSync(shotPath)) try { fs.unlinkSync(shotPath); } catch {}
  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), "duo-shot-"));
  try {
    await new Promise<void>((resolve) => {
      const args = [`--headless=new`, `--disable-gpu`, `--no-first-run`, `--no-default-browser-check`, `--user-data-dir=${tmpProfile}`, `--window-size=1280,800`, `--screenshot=${shotPath}`, targetUrl];
      const child = spawn(browserBin, args, { detached: process.platform !== "win32", stdio: "ignore", windowsHide: true });
      const timer = setTimeout(() => { killProcessGroup(child.pid); resolve(); }, 12_000);
      child.on("close", () => { clearTimeout(timer); resolve(); });
      child.on("error", () => { clearTimeout(timer); resolve(); });
    });
    if (!fs.existsSync(shotPath)) return { ok: false, shotPath, targetUrl, error: "浏览器未生成截图文件 (.debug/shot.png)" };
    openInDefaultApp(shotPath, workspaceRoot);
    return { ok: true, shotPath, targetUrl };
  } finally {
    try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch {}
  }
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
  const abortCtrl = new AbortController();
  const onSigint = () => abortCtrl.abort();
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
