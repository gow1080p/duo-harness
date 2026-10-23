import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

export function toPosixPath(rawPath: string): string {
  return rawPath.replace(/\\/g, "/");
}

export function toPosixRelative(fromDir: string, toTarget: string): string {
  return toPosixPath(path.relative(fromDir, toTarget));
}

export function expandHomePath(targetPath: string, homeDir: string = os.homedir()): string {
  if (targetPath === "~") return homeDir;
  if (targetPath.startsWith("~/") || targetPath.startsWith("~\\")) {
    return path.join(homeDir, targetPath.slice(2));
  }
  return targetPath;
}

export function isPathInside(childPath: string, rootDir: string): boolean {
  const normChild = process.platform === "win32" ? childPath.toLowerCase() : childPath;
  const normRoot = process.platform === "win32" ? rootDir.toLowerCase() : rootDir;
  if (normChild === normRoot) return true;
  const rel = path.relative(normRoot, normChild);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

let cachedShell: { bin: string; env: NodeJS.ProcessEnv } | null = null;

export function resolvePosixShell(): { bin: string; env: NodeJS.ProcessEnv } {
  if (cachedShell) return cachedShell;
  const winEnvPatch = process.platform === "win32" ? { MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" } : {};
  if (process.env.DUO_BASH_BIN && fs.existsSync(process.env.DUO_BASH_BIN)) {
    cachedShell = { bin: process.env.DUO_BASH_BIN, env: { ...process.env, ...winEnvPatch } };
    return cachedShell;
  }
  if (process.platform !== "win32") {
    const bin = ["/bin/zsh", "/bin/bash", "/bin/sh"].find((p) => fs.existsSync(p)) ?? "/bin/sh";
    cachedShell = { bin, env: process.env };
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
      const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
      const curPath = process.env[pathKey] ?? "";
      const env = { ...process.env, ...winEnvPatch, [pathKey]: [...extraPaths, curPath].join(path.delimiter) };
      cachedShell = { bin: bashBin, env };
      return cachedShell;
    }
  }
  cachedShell = { bin: "bash.exe", env: { ...process.env, ...winEnvPatch } };
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
        if (m?.[1] && m?.[2]) { pid = m[1]; token = m[2]; break; }
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
