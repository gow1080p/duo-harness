import { execFileSync, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expandHomePath, killProcessGroup, openInDefaultApp, resolveDefaultOpenTarget, toPosixRelative } from "./platform.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function hasPngMagicBytes(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC);
}

export function persistHashedDebugPng(
  workspaceRoot: string,
  prefix: "shot" | "clipboard",
  rawBuf: Buffer,
): { latestRelPath: string; immutableRelPath: string; absPath: string; byteSize: number } {
  const debugDir = path.join(workspaceRoot, ".debug");
  fs.mkdirSync(debugDir, { recursive: true });
  const hash6 = crypto.createHash("sha256").update(rawBuf).digest("hex").slice(0, 6);
  const latestAbs = path.join(debugDir, `${prefix}.png`);
  const immutableAbs = path.join(debugDir, `${prefix}-${hash6}.png`);
  fs.writeFileSync(latestAbs, rawBuf);
  fs.writeFileSync(immutableAbs, rawBuf);
  return { latestRelPath: `.debug/${prefix}.png`, immutableRelPath: `.debug/${prefix}-${hash6}.png`, absPath: immutableAbs, byteSize: rawBuf.length };
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

export function parseShotCommandArgs(rawArgs: string, workspaceRoot: string): { openPreview: boolean; target: string; question: string } {
  let openPreview = false;
  const rest = rawArgs.trim().replace(/(?:^|\s+)(?:--open|-o)(?=\s|$)/g, () => { openPreview = true; return " "; }).trim();
  if (!rest) return { openPreview, target: "", question: "" };
  const tokenMatch = rest.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+([\s\S]*))?$/);
  if (!tokenMatch) return { openPreview, target: "", question: rest };
  const firstToken = (tokenMatch[1] ?? tokenMatch[2] ?? tokenMatch[3] ?? "").trim();
  const tailQuestion = (tokenMatch[4] ?? "").trim();
  if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/.*)?$/i.test(firstToken)) {
    return { openPreview, target: `http://${firstToken}`, question: tailQuestion };
  }
  if (/^(?:https?|file):\/\//i.test(firstToken) || /\.(?:html?|svg|pdf|md)$/i.test(firstToken)) {
    return { openPreview, target: firstToken, question: tailQuestion };
  }
  const candidateLocal = path.resolve(workspaceRoot, expandHomePath(firstToken));
  if (fs.existsSync(candidateLocal) && fs.statSync(candidateLocal).isFile()) {
    return { openPreview, target: firstToken, question: tailQuestion };
  }
  return { openPreview, target: "", question: rest };
}

export async function captureHeadlessScreenshot(
  targetPathOrUrl: string,
  workspaceRoot: string,
  recentFiles: readonly string[] = [],
  options: { openPreview?: boolean } = {},
): Promise<{ ok: boolean; shotPath: string; relShotPath: string; immutableRelPath: string; targetUrl: string; error?: string }> {
  const rawInput = targetPathOrUrl.trim();
  const normalizedInput = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/.*)?$/i.test(rawInput) ? `http://${rawInput}` : rawInput;
  const raw = normalizedInput || resolveDefaultOpenTarget(workspaceRoot, recentFiles);
  const isHttp = /^https?:\/\//i.test(raw);
  const resolvedLocal = isHttp ? raw : path.resolve(workspaceRoot, expandHomePath(raw));
  const shotPath = path.join(workspaceRoot, ".debug", "shot.png");
  if (!isHttp && (!fs.existsSync(resolvedLocal) || !fs.statSync(resolvedLocal).isFile())) {
    return { ok: false, shotPath, relShotPath: ".debug/shot.png", immutableRelPath: ".debug/shot.png", targetUrl: resolvedLocal, error: `未找到可截图的目标文件: ${resolvedLocal}` };
  }
  const browserBin = findHeadlessBrowserBinary();
  if (!browserBin) return { ok: false, shotPath, relShotPath: ".debug/shot.png", immutableRelPath: ".debug/shot.png", targetUrl: resolvedLocal, error: "未检测到本机 Edge 或 Chrome 浏览器可执行文件" };
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
    if (!fs.existsSync(shotPath)) return { ok: false, shotPath, relShotPath: ".debug/shot.png", immutableRelPath: ".debug/shot.png", targetUrl, error: "浏览器未生成截图文件 (.debug/shot.png)" };
    const saved = persistHashedDebugPng(workspaceRoot, "shot", fs.readFileSync(shotPath));
    if (options.openPreview) openInDefaultApp(shotPath, workspaceRoot);
    return { ok: true, shotPath, relShotPath: saved.latestRelPath, immutableRelPath: saved.immutableRelPath, targetUrl };
  } finally {
    try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch {}
  }
}

export function captureClipboardImage(
  workspaceRoot: string,
): { ok: boolean; relPath: string; immutableRelPath: string; absPath: string; byteSize: number; error?: string } {
  const mockPath = process.env.DUO_MOCK_CLIPBOARD_IMAGE?.trim();
  if (mockPath && fs.existsSync(mockPath)) {
    const buf = fs.readFileSync(mockPath);
    if (!hasPngMagicBytes(buf)) return { ok: false, relPath: "", immutableRelPath: "", absPath: "", byteSize: 0, error: "剪贴板中没有检测到有效的 PNG 图片数据" };
    const saved = persistHashedDebugPng(workspaceRoot, "clipboard", buf);
    return { ok: true, relPath: saved.latestRelPath, immutableRelPath: saved.immutableRelPath, absPath: saved.absPath, byteSize: saved.byteSize };
  }
  const tmpFile = path.join(os.tmpdir(), `duo-clip-${process.pid}-${Date.now()}.png`);
  try {
    if (process.platform === "darwin") {
      execFileSync(
        "osascript",
        [
          "-e", "on run argv",
          "-e", "try",
          "-e", "set pngData to (the clipboard as «class PNGf»)",
          "-e", "set f to open for access POSIX file (item 1 of argv) with write permission",
          "-e", "set eof f to 0",
          "-e", "write pngData to f",
          "-e", "close access f",
          "-e", "end try",
          "-e", "end run",
          tmpFile,
        ],
        { timeout: 8_000, stdio: "ignore" },
      );
    } else if (process.platform === "win32") {
      const psCmd = "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $img.Save($env:DUO_CLIP_OUT, [System.Drawing.Imaging.ImageFormat]::Png); $img.Dispose() }";
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Sta", "-Command", psCmd], { env: { ...process.env, DUO_CLIP_OUT: tmpFile }, timeout: 5_000, stdio: "ignore", windowsHide: true });
    } else {
      try {
        fs.writeFileSync(tmpFile, execFileSync("wl-paste", ["--type", "image/png"], { timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] }));
      } catch {
        fs.writeFileSync(tmpFile, execFileSync("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"], { timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] }));
      }
    }
    if (!fs.existsSync(tmpFile)) return { ok: false, relPath: "", immutableRelPath: "", absPath: "", byteSize: 0, error: "系统剪贴板中未检测到截图或图片（请先使用截图快捷键复制图片到剪贴板）" };
    const rawBuf = fs.readFileSync(tmpFile);
    if (!hasPngMagicBytes(rawBuf)) return { ok: false, relPath: "", immutableRelPath: "", absPath: "", byteSize: 0, error: "系统剪贴板当前内容不是有效图片格式" };
    const saved = persistHashedDebugPng(workspaceRoot, "clipboard", rawBuf);
    return { ok: true, relPath: saved.latestRelPath, immutableRelPath: saved.immutableRelPath, absPath: saved.absPath, byteSize: saved.byteSize };
  } catch {
    return { ok: false, relPath: "", immutableRelPath: "", absPath: "", byteSize: 0, error: "读取系统剪贴板图片失败（请确认剪贴板中有截图）" };
  } finally {
    if (fs.existsSync(tmpFile)) try { fs.unlinkSync(tmpFile); } catch {}
  }
}

export function tryExpandClipboardInLine(
  line: string,
  cursor: number,
  workspaceRoot: string,
  isPasteShortcut = false,
): { line: string; cursor: number; pastedRelPath: string; byteSize: number } | null {
  const match = isPasteShortcut ? null : /(^|\s)@clipboard\s/.exec(line);
  if (!isPasteShortcut && !match) return null;
  const clip = captureClipboardImage(workspaceRoot);
  if (!clip.ok) return null;
  const token = `@${clip.immutableRelPath} `;
  if (isPasteShortcut) {
    const safeCur = Math.max(0, Math.min(cursor, line.length));
    const before = line.slice(0, safeCur), after = line.slice(safeCur);
    const prefix = before.length > 0 && !/\s$/.test(before) ? `${before} ` : before;
    const nextLine = `${prefix}${token}${after.startsWith(" ") ? after.slice(1) : after}`;
    return { line: nextLine, cursor: prefix.length + token.length, pastedRelPath: clip.immutableRelPath, byteSize: clip.byteSize };
  }
  const prefixLen = match!.index + match![1]!.length;
  const nextLine = `${line.slice(0, prefixLen)}${token}${line.slice(match!.index + match![0].length)}`;
  return { line: nextLine, cursor: prefixLen + token.length, pastedRelPath: clip.immutableRelPath, byteSize: clip.byteSize };
}

export function getPasteShortcutLabel(platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? "Control+V (⌃V) / Option+V (⌥V)" : platform === "win32" ? "Alt+V / Ctrl+V" : "Ctrl+V / Alt+V";
}

export async function executeVisionSlashCommand(
  cmd: string,
  workspaceRoot: string,
  recentFiles: readonly string[] = [],
): Promise<boolean | string | null> {
  if (cmd === "/shot" || cmd.startsWith("/shot ")) {
    const parsed = parseShotCommandArgs(cmd.slice("/shot".length), workspaceRoot);
    const res = await captureHeadlessScreenshot(parsed.target, workspaceRoot, recentFiles, { openPreview: parsed.openPreview });
    if (!res.ok) { console.log(`⚠️ ${res.error}`); return true; }
    if (parsed.question) {
      console.log(`📸 已截取网页画面: ${res.relShotPath} (源: ${res.targetUrl})，正在连带问题发送给视觉模型...`);
      return `@${res.immutableRelPath} ${parsed.question}`;
    }
    console.log(`📸 已生成网页无头截图${parsed.openPreview ? "并打开预览" : ""}: ${res.relShotPath} (源: ${res.targetUrl} · 提问时输入 @.debug/shot.png 或直接敲 /shot <URL> <问题> 即可发给视觉模型)`);
    return true;
  }
  if (cmd === "/paste" || cmd.startsWith("/paste ") || cmd === "/clip" || cmd.startsWith("/clip ")) {
    const question = cmd.replace(/^\/(?:paste|clip)\b/, "").trim();
    const clip = captureClipboardImage(workspaceRoot);
    if (!clip.ok) { console.log(`⚠️ ${clip.error}`); return true; }
    const kb = Math.max(1, Math.round(clip.byteSize / 1024));
    if (question) {
      console.log(`📋 已读取系统剪贴板截图: ${clip.relPath} (${kb} KB)，正在连带问题发送给视觉模型...`);
      return `@${clip.immutableRelPath} ${question}`;
    }
    console.log(`📋 已从系统剪贴板提取截图: ${clip.relPath} (${kb} KB · 提问时按 ${getPasteShortcutLabel()} 或输入 @clipboard 即可发给视觉模型)`);
    return true;
  }
  return null;
}

export { toPosixRelative };
