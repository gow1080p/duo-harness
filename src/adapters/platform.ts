import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";

export function toPosixPath(rawPath: string): string { return rawPath.replace(/\\/g, "/"); }
export function toPosixRelative(fromDir: string, toTarget: string): string { return toPosixPath(path.relative(fromDir, toTarget)); }

export function expandHomePath(targetPath: string, homeDir: string = os.homedir()): string {
  if (targetPath === "~") return homeDir;
  if (targetPath.startsWith("~/") || targetPath.startsWith("~\\")) return path.join(homeDir, targetPath.slice(2));
  return targetPath;
}

export function isPathInside(childPath: string, rootDir: string): boolean {
  const normChild = process.platform === "win32" ? childPath.toLowerCase() : childPath;
  const normRoot = process.platform === "win32" ? rootDir.toLowerCase() : rootDir;
  if (normChild === normRoot) return true;
  const rel = path.relative(normRoot, normChild);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function shortenWorkspaceText(raw: string, workspaceRoot?: string): string {
  if (!raw) return raw;
  let res = raw;
  if (workspaceRoot) {
    for (const rootVariant of [workspaceRoot.replace(/[\\/]+$/, ""), toPosixPath(workspaceRoot).replace(/\/+$/, "")]) {
      if (rootVariant) res = res.split(`${rootVariant}/`).join("").split(`${rootVariant}\\`).join("").split(rootVariant).join(".");
    }
  }
  return res.replace(/^\s*cd\s+(?:"\."|'\.'|\.)\s*(?:&&|;)\s*/, "");
}

export function sanitizeTerminalText(str: string): string {
  return Array.from(str)
    .filter((ch) => {
      const cp = ch.codePointAt(0);
      if (cp === undefined) return false;
      if (cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x1b) return true;
      if (cp <= 0x1f || cp === 0x7f || (cp >= 0xfff9 && cp <= 0xfffb)) return false;
      return true;
    })
    .join("");
}

export function getCharVisualWidth(cp: number): number {
  if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return 0;
  return stringWidth(String.fromCodePoint(cp));
}

export function getVisualCols(s: string): number {
  return stringWidth(s.replace(/\r/g, ""));
}

export function truncateCols(str: string, maxCols: number, suffix = ".."): string {
  const clean = sanitizeTerminalText(str.replace(/\r/g, ""));
  if (getVisualCols(clean) <= maxCols) return clean;
  const sfxCols = getVisualCols(suffix);
  const budget = Math.max(1, maxCols - sfxCols);
  return `${sliceAnsi(clean, 0, budget)}${suffix}`;
}

export function padCols(str: string, targetCols: number, align: "left" | "right" = "left"): string {
  const pad = Math.max(0, targetCols - getVisualCols(str));
  return align === "right" ? " ".repeat(pad) + str : str + " ".repeat(pad);
}

export function formatClickablePath(targetPath: string, workspaceRoot?: string): string {
  return toPosixPath(workspaceRoot ? path.resolve(workspaceRoot, expandHomePath(targetPath)) : path.resolve(expandHomePath(targetPath)));
}

export const SENSITIVE_SUBPROCESS_ENV_RE =
  /^(?:MIMO_|DEEPSEEK_|OPENAI_|ANTHROPIC_|GEMINI_|ANTIGRAVITY_CSRF_TOKEN|DUO_API)|(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY)(?:_|$)/i;

export function sanitizeSubprocessEnv(rawEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(rawEnv)) {
    if (v !== undefined && !SENSITIVE_SUBPROCESS_ENV_RE.test(k)) clean[k] = v;
  }
  return clean;
}

let cachedShell: { bin: string; env: NodeJS.ProcessEnv } | null = null;

export function resolvePosixShell(): { bin: string; env: NodeJS.ProcessEnv } {
  if (cachedShell) return cachedShell;
  const baseEnv = sanitizeSubprocessEnv(process.env);
  const winEnvPatch = process.platform === "win32" ? { MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" } : {};
  if (process.env.DUO_BASH_BIN && fs.existsSync(process.env.DUO_BASH_BIN)) {
    cachedShell = { bin: process.env.DUO_BASH_BIN, env: { ...baseEnv, ...winEnvPatch } };
    return cachedShell;
  }
  if (process.platform !== "win32") {
    const bin = ["/bin/zsh", "/bin/bash", "/bin/sh"].find((p) => fs.existsSync(p)) ?? "/bin/sh";
    cachedShell = { bin, env: baseEnv };
    return cachedShell;
  }
  const roots = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Programs"),
  ].filter((x): x is string => Boolean(x));

  for (const r of roots) {
    const gitDir = path.join(r, "Git");
    const bashBin = [path.join(gitDir, "bin", "bash.exe"), path.join(gitDir, "usr", "bin", "bash.exe")].find((p) => fs.existsSync(p));
    if (bashBin) {
      const extraPaths = [path.join(gitDir, "usr", "bin"), path.join(gitDir, "bin")].filter((p) => fs.existsSync(p));
      const pathKey = Object.keys(baseEnv).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
      const curPath = baseEnv[pathKey] ?? "";
      const env = { ...baseEnv, ...winEnvPatch, [pathKey]: [...extraPaths, curPath].join(path.delimiter) };
      cachedShell = { bin: bashBin, env };
      return cachedShell;
    }
  }
  cachedShell = { bin: "bash.exe", env: { ...baseEnv, ...winEnvPatch } };
  return cachedShell;
}

export function killProcessGroup(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
      return;
    } catch {}
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

export function querySqliteFirstValue(dbPath: string, sql: string): string {
  if (!fs.existsSync(dbPath)) return "";
  try {
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req("node:sqlite") as { DatabaseSync: new (p: string, opts?: any) => any };
    const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 1500 });
    try {
      const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
      const firstVal = row ? Object.values(row)[0] : "";
      return firstVal ? String(firstVal).trim() : "";
    } finally {
      db.close();
    }
  } catch {
    try {
      return execFileSync("sqlite3", ["-list", dbPath, sql], { timeout: 1000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).toString().trim();
    } catch {
      return "";
    }
  }
}

export function resolveAntigravityLsBin(): string {
  if (process.env.ANTIGRAVITY_LS_BIN && fs.existsSync(process.env.ANTIGRAVITY_LS_BIN)) {
    return process.env.ANTIGRAVITY_LS_BIN;
  }
  if (process.platform === "win32") {
    const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const candidates = [
      path.join(localApp, "Programs", "Antigravity", "resources", "app", "extensions", "antigravity", "bin", "language_server_windows_x64.exe"),
      path.join(localApp, "Programs", "Antigravity", "resources", "bin", "language_server.exe"),
    ];
    return candidates.find((c) => fs.existsSync(c)) ?? candidates[0]!;
  }
  return "/Applications/Antigravity.app/Contents/Resources/bin/language_server";
}

export function discoverOsLsProcess(): { pid: string; token: string; ports: number[] } {
  let pid = "";
  let token = process.env.ANTIGRAVITY_CSRF_TOKEN?.trim() || "";
  const ports: number[] = [];
  try {
    if (process.platform === "win32") {
      const psCmd = "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'language_server*' -and $_.CommandLine -notlike '*agentapi*' } | Select-Object -First 1 ProcessId,CommandLine | ConvertTo-Json -Compress";
      const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psCmd], { timeout: 3000, windowsHide: true }).toString().trim();
      if (raw) {
        const proc = JSON.parse(raw) as { ProcessId?: number; CommandLine?: string };
        pid = String(proc?.ProcessId ?? "");
        const m = String(proc?.CommandLine ?? "").match(/--csrf_token[=\s]+"?([0-9a-fA-F-]+)"?/);
        if (m?.[1]) token = m[1];
      }
      if (pid) {
        const netOut = execFileSync("netstat", ["-ano", "-p", "tcp"], { timeout: 2000, windowsHide: true }).toString();
        for (const line of netOut.split(/\r?\n/)) {
          const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
          if (m?.[1] && m[2] === pid) ports.push(Number(m[1]));
        }
      }
      return { pid, token, ports };
    }
    const psOut = execFileSync("ps", ["-ww", "-axo", "pid=,command="], { timeout: 1500 }).toString();
    for (const line of psOut.split("\n")) {
      if (line.includes("language_server") && !line.includes("agentapi")) {
        const m = line.trim().match(/^(\d+)\s+.*--csrf_token[=\s]+([0-9a-fA-F-]+)/);
        if (m?.[1] && m?.[2]) {
          pid = m[1];
          token = m[2];
          break;
        }
      }
    }
    if (!token) return { pid, token, ports };
    const lsofArgs = pid ? ["-nP", "-a", "-p", pid, "-iTCP", "-sTCP:LISTEN"] : ["-iTCP", "-sTCP:LISTEN", "-n", "-P"];
    const lsofOut = execFileSync("lsof", lsofArgs, { timeout: 1500 }).toString();
    for (const line of lsofOut.split("\n")) {
      if (line.includes("language_")) {
        const p = Number(line.match(/:(\d+)\s+\(LISTEN\)/)?.[1] ?? 0);
        if (p) ports.push(p);
      }
    }
  } catch {}
  return { pid, token, ports };
}

export function runTerminalPager(ansiText: string, opts: { forcePager?: boolean } = {}): boolean {
  if (!process.stdout.isTTY || process.env.VITEST) return false;
  const rows = process.stdout.rows || 28;
  if (!opts.forcePager && ansiText.split("\n").length <= rows - 4) {
    console.log(ansiText);
    return true;
  }
  const wasRaw = Boolean(process.stdin.isTTY && (process.stdin as any).isRaw);
  try {
    process.stdout.write("\x1b[?2004l");
    if (wasRaw) process.stdin.setRawMode(false);
    const res = spawnSync("less", ["-FR", "-P?e[已到底部 · 按 q 退出预览]:[按 q 退出预览 · ↑/↓/空格 翻页 · / 搜索]. "], { input: ansiText, encoding: "utf-8", stdio: ["pipe", "inherit", "inherit"] });
    if (res.error) console.log(ansiText);
  } finally {
    if (wasRaw) process.stdin.setRawMode(true);
    process.stdout.write("\x1b[?2004h");
  }
  return true;
}

function findExecutableInPath(binName: string): string | null {
  if (path.isAbsolute(binName) && fs.existsSync(binName)) return binName;
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" && !/\.(?:exe|cmd|bat)$/i.test(binName) ? [".cmd", ".exe", ""] : [""];
  for (const d of dirs) {
    for (const ext of exts) {
      const full = path.join(d, `${binName}${ext}`);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

export function resolveExternalEditor(): { bin: string; args: string[]; isGui: boolean; label: string } | null {
  const envRaw = process.env.VISUAL?.trim() || process.env.EDITOR?.trim() || "";
  if (envRaw) {
    const tokens = (envRaw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [envRaw]).map((t) => t.replace(/^["']|["']$/g, ""));
    const rawBin = tokens[0] ?? envRaw;
    const bin = findExecutableInPath(rawBin) ?? rawBin;
    const label = path.basename(bin).replace(/\.(?:exe|cmd|bat)$/i, "");
    const isGui = /^(?:code|cursor|windsurf|subl|sublime_text|zed|atom|gedit|notepad\+?)$/i.test(label);
    return { bin, args: tokens.slice(1), isGui, label };
  }
  const candidates = process.platform === "win32" ? ["code", "cursor", "windsurf", "notepad"] : ["code", "cursor", "windsurf", "vim", "vi", "nano"];
  for (const c of candidates) {
    const found = findExecutableInPath(c);
    if (found) {
      const isGui = /^(?:code|cursor|windsurf|notepad)$/i.test(c);
      return { bin: found, args: [], isGui, label: c };
    }
  }
  return null;
}

export function editFileInExternalEditor(filePath: string, opts: { line?: number; wait?: boolean } = {}): { ok: boolean; editor?: string; edited: boolean; content: string; error?: string } {
  const resolved = path.resolve(expandHomePath(filePath));
  if (!fs.existsSync(resolved)) return { ok: false, edited: false, content: "", error: `未找到待编辑文件: ${resolved}` };
  const before = fs.readFileSync(resolved, "utf-8");
  const ed = resolveExternalEditor();
  if (process.env.VITEST && !process.env.DUO_TEST_EDITOR_REAL) {
    if (process.env.DUO_TEST_EDITOR_CONTENT !== undefined) fs.writeFileSync(resolved, process.env.DUO_TEST_EDITOR_CONTENT, "utf-8");
    const after = fs.readFileSync(resolved, "utf-8");
    return { ok: true, editor: ed?.label ?? "vim", edited: after !== before, content: after };
  }
  if (!ed) return { ok: false, edited: false, content: before, error: "未检测到可用编辑器（请设置 $VISUAL 或 $EDITOR 环境变量）" };
  const runArgs = [...ed.args];
  if (ed.isGui) {
    if (opts.wait && !runArgs.includes("-w") && !runArgs.includes("--wait") && !/notepad/i.test(ed.label)) runArgs.push("--wait");
    if (opts.line && /^(?:code|cursor|windsurf|subl|zed)$/i.test(ed.label) && !runArgs.includes("-g") && !runArgs.includes("--goto")) runArgs.push("-g", `${resolved}:${opts.line}`);
    else runArgs.push(resolved);
  } else {
    if (opts.line && /^(?:vim|nvim|vi|nano|hx)$/i.test(ed.label)) runArgs.push(`+${opts.line}`, resolved);
    else runArgs.push(resolved);
  }
  const isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const wasRaw = Boolean(isTty && (process.stdin as any).isRaw);
  try {
    if (isTty) {
      process.stdout.write("\x1b[?2004l");
      if (wasRaw) process.stdin.setRawMode(false);
      if (!ed.isGui) process.stdout.write("\x1b[?1049h\x1b[0m\x1b[?25h\x1b[2J\x1b[H");
    }
    const isWinCmd = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(ed.bin);
    const child = isWinCmd
      ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${ed.bin}" ${runArgs.map((a) => `"${a.replace(/"/g, '""')}"`).join(" ")}`], { stdio: "inherit", windowsVerbatimArguments: true, windowsHide: false })
      : spawnSync(ed.bin, runArgs, { stdio: "inherit", windowsHide: false });
    if (child.error) return { ok: false, editor: ed.label, edited: false, content: before, error: child.error.message };
    const after = fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf-8") : before;
    return { ok: true, editor: ed.label, edited: after !== before, content: after };
  } finally {
    if (isTty) {
      if (!ed.isGui) process.stdout.write("\x1b[?1049l");
      if (wasRaw) process.stdin.setRawMode(true);
      process.stdout.write("\x1b[?2004h");
    }
  }
}

export function editBufferInExternalEditor(initialText: string): { ok: boolean; editor?: string; edited: boolean; content: string; error?: string } {
  const tmpFile = path.join(os.tmpdir(), `duo-prompt-${Date.now()}-${process.pid}.md`);
  fs.writeFileSync(tmpFile, initialText, "utf-8");
  try {
    const res = editFileInExternalEditor(tmpFile, { wait: true });
    const clean = !initialText.endsWith("\n") && res.content.endsWith("\n") && !res.content.endsWith("\n\n") ? res.content.slice(0, -1) : res.content;
    return { ...res, edited: clean !== initialText, content: clean };
  } finally {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
  }
}

export { type MdPreviewLaunchResult, launchMarkdownPreview, openInDefaultApp, resolveDefaultMdTarget, resolveDefaultOpenTarget } from "./md-preview.js";
