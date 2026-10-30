import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { marked } from "marked";
import { parseFileLineTarget, renderSourceCodeBox } from "./diff-presenter.js";
import { editFileInExternalEditor, expandHomePath, runTerminalPager } from "./platform.js";
import { writeFileAtomicSync } from "./store.js";
import { renderMarkdownDocument } from "./ui-logger.js";

export interface MdPreviewLaunchResult {
  ok: boolean; resolved: string; mode?: "terminal-preview" | "md-preview" | "editor" | "system-app";
  rendered?: string; edited?: boolean; editor?: string; url?: string; error?: string;
}
const MAX_SAVE_BYTES = 5 * 1024 * 1024;

export function escapeHtml(raw: string): string { return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }

export function resolveDefaultOpenTarget(workspaceRoot: string, recentPaths: readonly string[] = []): string {
  for (let i = recentPaths.length - 1; i >= 0; i--) {
    const candidate = path.resolve(workspaceRoot, recentPaths[i]!);
    if (fs.existsSync(candidate)) return candidate;
  }
  const planFile = path.join(workspaceRoot, ".debug", "plan.md");
  if (fs.existsSync(planFile)) return planFile;
  try {
    const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith(".")).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const preferred = entries.find((e) => /\.(?:html?|svg|pdf|md)$/i.test(e.name)) ?? entries[0];
    if (preferred) return path.join(workspaceRoot, preferred.name);
  } catch {}
  return workspaceRoot;
}

export function resolveDefaultMdTarget(workspaceRoot: string, recentPaths: readonly string[] = []): string {
  const planFile = path.join(workspaceRoot, ".debug", "plan.md");
  if (fs.existsSync(planFile)) return planFile;
  for (let i = recentPaths.length - 1; i >= 0; i--) {
    const candidate = path.resolve(workspaceRoot, recentPaths[i]!);
    if (/\.(?:md|markdown)$/i.test(candidate) && fs.existsSync(candidate)) return candidate;
  }
  try {
    const mdFiles = fs.readdirSync(workspaceRoot, { withFileTypes: true }).filter((e) => e.isFile() && /\.(?:md|markdown)$/i.test(e.name))
      .map((e) => ({ full: path.join(workspaceRoot, e.name), mtime: fs.statSync(path.join(workspaceRoot, e.name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
    if (mdFiles[0]) return mdFiles[0].full;
  } catch {}
  return path.join(workspaceRoot, "README.md");
}

export function renderMdHtmlFragment(markdown: string): string {
  const rawHtml = String(marked.parse(markdown, { async: false, gfm: true, breaks: true }));
  const alertTransformed = rawHtml.replace(
    /<blockquote>\s*<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s*<br\s*\/?>|\s*\n)?([\s\S]*?)<\/blockquote>/gi,
    (fullMatch, kind: string, rest: string) => {
      if (/<blockquote\b/i.test(rest)) return fullMatch;
      const normalizedRest = rest.replace(/^\s*<\/p>\s*/i, "");
      const bodyHtml = normalizedRest === rest ? `<p>${rest}` : normalizedRest;
      return `<div class="md-alert alert-${kind.toLowerCase()}"><div class="alert-title">${kind.toUpperCase()}</div>${bodyHtml}</div>`;
    },
  );
  return alertTransformed.replace(/<(\/?(?:script|article)\b)/gi, "&lt;$1");
}

function buildMdPreviewPageHtml(filePath: string, initialMd: string, initialHtml: string): string {
  const escJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");
  const safeTitle = escapeHtml(path.basename(filePath)), safeFullPath = escapeHtml(filePath);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>📝 ${safeTitle} — Markdown Preview</title><style>
:root{--bg:#0b0f17;--panel:#111827;--border:#1f2937;--text:#e5e7eb;--muted:#9ca3af;--accent:#38bdf8;--code:#0f172a}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;height:100vh;display:flex;flex-direction:column;overflow:hidden}
header{height:48px;background:rgba(17,24,39,.92);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 16px;gap:12px;flex-shrink:0;user-select:none}.file-info{display:flex;align-items:center;gap:10px;min-width:0}.badge{background:#1e293b;color:var(--accent);font-weight:600;padding:3px 9px;border-radius:6px;font-size:13px;white-space:nowrap}
.path{color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.status{font-size:12px;color:#22c55e;white-space:nowrap}.actions{display:flex;gap:8px}.btn{background:#1f2937;color:var(--text);border:1px solid #374151;padding:5px 11px;border-radius:6px;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:5px}.btn:hover{border-color:var(--accent);color:#fff}.btn.active{background:#0284c7;border-color:#38bdf8;color:#fff}
main{flex:1;display:flex;min-height:0;overflow:hidden}aside#toc{width:230px;background:var(--panel);border-right:1px solid var(--border);padding:14px 10px;overflow-y:auto;font-size:13px;flex-shrink:0}aside#toc a{display:block;color:var(--muted);text-decoration:none;padding:4px 8px;border-radius:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}aside#toc a:hover{color:#fff;background:#1f2937}.toc-h2{padding-left:16px!important}.toc-h3{padding-left:28px!important;font-size:12px}
#editor-pane{display:none;width:50%;border-right:1px solid var(--border);flex-direction:column;background:#090d14}body.editing #editor-pane{display:flex}body.editing aside#toc{display:none}textarea#md-input{flex:1;width:100%;background:transparent;color:#f3f4f6;border:0;outline:0;padding:20px;font:13.5px/1.65 "JetBrains Mono",Consolas,monospace;resize:none;tab-size:2}#preview-wrap{flex:1;overflow-y:auto;padding:28px 40px}#preview{max-width:860px;margin:0 auto}
h1,h2,h3,h4{color:#f8fafc;line-height:1.35;margin:1.3em 0 .5em}h1{font-size:1.75em;border-bottom:1px solid var(--border);padding-bottom:.3em}h2{font-size:1.38em;border-bottom:1px solid var(--border);padding-bottom:.25em}a{color:var(--accent)}code{background:rgba(148,163,184,.14);color:#e2e8f0;border:1px solid rgba(148,163,184,.22);padding:1px 5px;border-radius:4px;font:13px "JetBrains Mono",Consolas,monospace}
pre{background:var(--code);border:1px solid var(--border);border-radius:8px;padding:14px 16px;overflow-x:auto;position:relative}pre code{background:0;color:#e2e8f0;border:0;padding:0}.copy-code{position:absolute;top:8px;right:8px;background:#1e293b;color:var(--muted);border:1px solid #334155;border-radius:5px;padding:2px 8px;font-size:11px;cursor:pointer}
table{border-collapse:collapse;width:100%;margin:14px 0;font-size:14px}th,td{border:1px solid var(--border);padding:8px 12px;text-align:left}th{background:#161f30;color:#f8fafc}tr:nth-child(even){background:rgba(255,255,255,.02)}blockquote{margin:12px 0;padding:8px 16px;border-left:4px solid var(--accent);background:rgba(56,189,248,.07);border-radius:0 6px 6px 0}
.md-alert{margin:14px 0;padding:10px 16px;border-left:4px solid var(--accent);background:#111c2d;border-radius:6px}.alert-title{font-weight:700;font-size:12px;margin-bottom:4px;color:var(--accent)}.alert-warning,.alert-caution{border-color:#f59e0b}.alert-warning .alert-title,.alert-caution .alert-title{color:#fbbf24}
</style></head><body><header><div class="file-info"><span class="badge">📄 ${safeTitle}</span><span class="path" title="${safeFullPath}">${safeFullPath}</span><span id="save-status" class="status">● 已同步</span></div><div class="actions"><button id="btn-edit" class="btn">✏️ 编辑 (E)</button><button id="btn-copy" class="btn">📋 复制全文</button><button id="btn-close" class="btn">✖ 关闭 (Esc)</button></div></header>
<main><aside id="toc"></aside><section id="editor-pane"><textarea id="md-input" spellcheck="false"></textarea></section><section id="preview-wrap"><article id="preview">${initialHtml}</article></section></main><script>
const input = document.getElementById("md-input"), preview = document.getElementById("preview"), toc = document.getElementById("toc"), statusEl = document.getElementById("save-status"), btnEdit = document.getElementById("btn-edit");
let rawMd = ${escJson(initialMd)}, isEditing = false, dirty = false, saveTimer = null;
input.value = rawMd;
function enhancePreview() {
  toc.innerHTML = "<div style='color:#64748b;font-weight:600;padding:4px 8px 8px'>📑 目录大纲</div>";
  preview.querySelectorAll("h1,h2,h3").forEach((h, i) => { h.id = "heading-" + i; const a = document.createElement("a"); a.href = "#heading-" + i; a.textContent = h.textContent; a.className = "toc-" + h.tagName.toLowerCase(); toc.appendChild(a); });
  preview.querySelectorAll("pre").forEach((pre) => {
    if (pre.querySelector(".copy-code")) return;
    const b = document.createElement("button"); b.className = "copy-code"; b.textContent = "复制";
    b.onclick = () => { const codeEl = pre.querySelector("code"); navigator.clipboard.writeText(codeEl ? codeEl.textContent : pre.innerText); b.textContent = "已复制!"; setTimeout(() => { b.textContent = "复制"; }, 1200); };
    pre.appendChild(b);
  });
}
enhancePreview();
function toggleEdit(force) { isEditing = typeof force === "boolean" ? force : !isEditing; document.body.classList.toggle("editing", isEditing); btnEdit.classList.toggle("active", isEditing); btnEdit.textContent = isEditing ? "👁️ 仅预览 (Esc)" : "✏️ 编辑 (E)"; if (isEditing) input.focus(); }
async function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const content = input.value; rawMd = content; statusEl.textContent = "⏳ 保存中...";
  const res = await fetch("/api/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) }).then((r) => r.json()).catch(() => ({ ok: false }));
  if (res.ok) { if (input.value === content) { dirty = false; preview.innerHTML = res.html; enhancePreview(); statusEl.textContent = "● 已自动保存"; } } else statusEl.textContent = "⚠️ 保存失败";
}
input.addEventListener("input", () => { dirty = true; statusEl.textContent = "● 编辑中..."; if (saveTimer) clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 380); });
input.addEventListener("keydown", (e) => { if (e.key === "Tab") { e.preventDefault(); input.setRangeText("  ", input.selectionStart, input.selectionEnd, "end"); input.dispatchEvent(new Event("input")); } });
btnEdit.onclick = () => toggleEdit();
document.getElementById("btn-copy").onclick = (e) => { navigator.clipboard.writeText(rawMd); e.target.textContent = "✅ 已复制"; setTimeout(() => { e.target.textContent = "📋 复制全文"; }, 1200); };
async function closeApp() { if (dirty) await saveNow(); fetch("/api/close", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", keepalive: true }).catch(() => {}); window.close(); }
document.getElementById("btn-close").onclick = closeApp;
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveNow(); }
  else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "e" && !isEditing && document.activeElement !== input) { e.preventDefault(); toggleEdit(true); }
  else if (e.key === "Escape") { if (isEditing) toggleEdit(false); else closeApp(); }
});
new EventSource("/events").onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.type === "reload" && msg.content !== rawMd) { rawMd = msg.content; preview.innerHTML = msg.html; enhancePreview(); if (!dirty && document.activeElement !== input) input.value = msg.content; statusEl.textContent = "● 外部已更新"; } };
</script></body></html>`;
}

export function openBrowserAppWindow(url: string): void {
  let browser: string | null = null;
  if (process.platform === "win32") {
    const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean) as string[];
    for (const rel of ["Microsoft\\Edge\\Application\\msedge.exe", "Google\\Chrome\\Application\\chrome.exe", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"]) {
      for (const r of roots) if (!browser && fs.existsSync(path.join(r, rel))) browser = path.join(r, rel);
    }
  } else if (process.platform === "darwin") {
    browser = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"].find((a) => fs.existsSync(a)) ?? null;
  }
  const cmd = browser ?? (process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open");
  const args = browser ? [`--user-data-dir=${path.join(os.tmpdir(), "mdp-browser-profile")}`, "--no-first-run", "--no-default-browser-check", `--app=${url}`, "--new-window"] : process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: false });
  child.on("error", () => {});
  child.unref();
}

function isAllowedLocalMutation(req: http.IncomingMessage): boolean {
  const ct = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!ct.includes("application/json")) return false;
  const secSite = String(req.headers["sec-fetch-site"] ?? "").toLowerCase();
  if (secSite && secSite !== "same-origin" && secSite !== "none") return false;
  const origin = String(req.headers.origin ?? "").trim();
  if (origin) {
    const host = String(req.headers.host ?? "");
    if (origin !== `http://${host}` && origin !== `https://${host}`) return false;
  }
  return true;
}

function handleMdPreviewHttp(
  req: http.IncomingMessage, res: http.ServerResponse, resolved: string,
  state: { getLast: () => string; setLast: (s: string) => void; onConnect: (res: http.ServerResponse) => void; triggerExit: () => void },
): void {
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (req.method === "GET" && pathname === "/") {
    const md = fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf-8") : state.getLast();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(buildMdPreviewPageHtml(resolved, md, renderMdHtmlFragment(md)));
    return;
  }
  if (req.method === "GET" && pathname === "/api/doc") {
    const content = fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf-8") : state.getLast();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ ok: true, filePath: resolved, content, html: renderMdHtmlFragment(content) }));
    return;
  }
  if (req.method === "GET" && pathname === "/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(": connected\n\n");
    state.onConnect(res);
    return;
  }
  if (req.method === "POST" && (pathname === "/api/save" || pathname === "/api/close")) {
    if (!isAllowedLocalMutation(req)) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ ok: false, error: "Forbidden cross-origin or non-JSON mutation" }));
      return;
    }
    if (pathname === "/api/close") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ ok: true }));
      setTimeout(state.triggerExit, 40);
      return;
    }
    let body = "", byteCount = 0, aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      byteCount += chunk.byteLength;
      if (byteCount > MAX_SAVE_BYTES) {
        aborted = true;
        res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ ok: false, error: "Payload too large" }));
        req.destroy();
        return;
      }
      body += chunk.toString("utf-8");
    });
    req.on("end", () => {
      if (aborted || res.headersSent) return;
      try {
        const parsed = JSON.parse(body || "{}") as { content?: string };
        if (typeof parsed.content !== "string") throw new Error("Missing content");
        state.setLast(parsed.content);
        writeFileAtomicSync(resolved, parsed.content);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ ok: true, html: renderMdHtmlFragment(parsed.content), mtime: Date.now() }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      }
    });
    return;
  }
  res.writeHead(404).end("Not Found");
}

export async function createMdPreviewServer(
  targetFile: string, opts: { initialTimeoutMs?: number; disconnectGraceMs?: number; onAutoExit?: () => void } = {},
): Promise<{ server: http.Server; url: string; port: number; close: () => Promise<void> }> {
  const resolved = path.resolve(targetFile);
  if (!fs.existsSync(resolved)) writeFileAtomicSync(resolved, `# ${path.basename(resolved, path.extname(resolved))}\n\n`);
  let lastSavedContent = fs.readFileSync(resolved, "utf-8"), hasConnectedOnce = false, closed = false;
  const clients = new Set<http.ServerResponse>();
  let initTimer: ReturnType<typeof setTimeout> | undefined, graceTimer: ReturnType<typeof setTimeout> | undefined;
  const triggerExit = () => { if (!closed) void close().then(() => opts.onAutoExit?.()); };
  if (opts.initialTimeoutMs) initTimer = setTimeout(triggerExit, opts.initialTimeoutMs);
  fs.watchFile(resolved, { interval: 350 }, () => {
    try {
      if (!fs.existsSync(resolved)) return;
      const disk = fs.readFileSync(resolved, "utf-8");
      if (disk === lastSavedContent) return;
      lastSavedContent = disk;
      const payload = `data: ${JSON.stringify({ type: "reload", content: disk, html: renderMdHtmlFragment(disk), mtime: Date.now() })}\n\n`;
      for (const c of clients) c.write(payload);
    } catch {}
  });
  const server = http.createServer((req, res) =>
    handleMdPreviewHttp(req, res, resolved, {
      getLast: () => lastSavedContent,
      setLast: (s) => { lastSavedContent = s; },
      onConnect: (clientRes) => {
        hasConnectedOnce = true;
        if (initTimer) { clearTimeout(initTimer); initTimer = undefined; }
        if (graceTimer) { clearTimeout(graceTimer); graceTimer = undefined; }
        clients.add(clientRes);
        req.on("close", () => {
          clients.delete(clientRes);
          if (hasConnectedOnce && clients.size === 0 && opts.disconnectGraceMs) graceTimer = setTimeout(triggerExit, opts.disconnectGraceMs);
        });
      },
      triggerExit,
    }),
  );
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const port = (server.address() as { port: number }).port;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (initTimer) clearTimeout(initTimer);
    if (graceTimer) clearTimeout(graceTimer);
    fs.unwatchFile(resolved);
    for (const c of clients) c.end();
    clients.clear();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return { server, url: `http://127.0.0.1:${port}`, port, close };
}

export function launchMarkdownPreview(targetFile: string, workspaceRoot = process.cwd(), opts: { allowCreate?: boolean } = {}): MdPreviewLaunchResult {
  const resolved = path.resolve(workspaceRoot, expandHomePath(targetFile.trim()));
  if (!fs.existsSync(resolved) && !opts.allowCreate) return { ok: false, resolved, mode: "md-preview", error: `未找到 Markdown 文件: ${resolved} (如需新建请加 --new)` };
  if (process.env.VITEST) return { ok: true, resolved, mode: "md-preview" };
  try {
    const selfFile = fileURLToPath(import.meta.url), distDir = path.join(path.resolve(path.dirname(selfFile), "..", ".."), "node_modules", "tsx", "dist");
    const preflight = path.join(distDir, "preflight.cjs"), loader = path.join(distDir, "loader.mjs");
    const args = fs.existsSync(loader) ? ["--require", preflight, "--import", pathToFileURL(loader).href, selfFile, "--serve-md-preview", resolved] : [selfFile, "--serve-md-preview", resolved];
    const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return { ok: true, resolved, mode: "md-preview" };
  } catch (err) {
    return { ok: false, resolved, mode: "md-preview", error: err instanceof Error ? err.message : String(err) };
  }
}

function previewFileInTerminal(resolved: string, startLine?: number, endLine?: number, expandCodeBlocks = false): MdPreviewLaunchResult {
  const raw = fs.readFileSync(resolved, "utf-8");
  const isMd = /\.(?:md|markdown)$/i.test(resolved) && !startLine && !endLine;
  const rendered = isMd ? renderMarkdownDocument(raw.trim(), { expandCodeBlocks }) : renderSourceCodeBox(raw, resolved, { startLine, endLine });
  if (!runTerminalPager(rendered) && !process.env.VITEST) console.log(rendered);
  return { ok: true, resolved, mode: "terminal-preview", rendered };
}

function spawnSystemOpen(resolved: string): MdPreviewLaunchResult {
  if (process.env.VITEST) return { ok: true, resolved, mode: "system-app" };
  try {
    const cmd = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", resolved] : [resolved];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", () => {});
    child.unref();
    return { ok: true, resolved, mode: "system-app" };
  } catch (err) {
    return { ok: false, resolved, mode: "system-app", error: err instanceof Error ? err.message : String(err) };
  }
}

export function openInDefaultApp(targetPathOrUrl: string, workspaceRoot = process.cwd()): MdPreviewLaunchResult {
  const forceRaw = /(?:^|\s)--raw(?=\s|$)/.test(targetPathOrUrl) || process.env.DUO_RAW_OPEN === "1";
  const forceWeb = /(?:^|\s)(?:--web|-w)(?=\s|$)/.test(targetPathOrUrl);
  const forceEdit = /(?:^|\s)(?:--edit|-e)(?=\s|$)/.test(targetPathOrUrl);
  const forceFull = /(?:^|\s)(?:--full|-f)(?=\s|$)/.test(targetPathOrUrl);
  const cleanArg = targetPathOrUrl.replace(/(?:^|\s)(?:--raw|--web|-w|--edit|-e|--full|-f)(?=\s|$)/g, "").trim();
  if (/^(?:https?|file):\/\//i.test(cleanArg)) return spawnSystemOpen(cleanArg);
  const { filePath, startLine, endLine } = parseFileLineTarget(cleanArg);
  const resolved = path.resolve(workspaceRoot, expandHomePath(filePath));
  if (!fs.existsSync(resolved)) return { ok: false, resolved, mode: "system-app", error: `未找到目标文件或目录: ${resolved}` };
  const isFile = fs.statSync(resolved).isFile(), isMd = isFile && /\.(?:md|markdown)$/i.test(resolved);
  if (forceEdit && isFile) {
    const ed = editFileInExternalEditor(resolved, { line: startLine });
    return { ok: ed.ok, resolved, mode: "editor", edited: ed.edited, editor: ed.editor, error: ed.error };
  }
  if (forceWeb && isMd) return launchMarkdownPreview(resolved, workspaceRoot);
  if (!forceRaw && (isMd || (isFile && (Boolean(startLine) || /\.(?:[cm]?[tj]sx?|go|py|rs|sql|sh|zsh|json|ya?ml|toml|css|scss|txt)$/i.test(resolved))))) {
    return previewFileInTerminal(resolved, startLine, endLine, forceFull);
  }
  return spawnSystemOpen(resolved);
}

export function runMdpCli(rawArgs: readonly string[], workspaceRoot = process.cwd()): MdPreviewLaunchResult {
  const joined = rawArgs.join(" ").trim();
  const allowCreate = /(?:^|\s)(?:--new|-n)(?=\s|$)/.test(joined);
  const forceWeb = /(?:^|\s)(?:--web|-w)(?=\s|$)/.test(joined) || allowCreate;
  const forceEdit = /(?:^|\s)(?:--edit|-e)(?=\s|$)/.test(joined);
  const forceFull = /(?:^|\s)(?:--full|-f)(?=\s|$)/.test(joined);
  const rawTarget = joined.replace(/(?:^|\s)(?:--new|-n|--web|-w|--edit|-e|--full|-f)(?=\s|$)/g, "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  const { filePath, startLine, endLine } = rawTarget ? parseFileLineTarget(rawTarget) : { filePath: resolveDefaultMdTarget(workspaceRoot), startLine: undefined, endLine: undefined };
  const resolved = path.resolve(workspaceRoot, expandHomePath(filePath));
  if (allowCreate && !fs.existsSync(resolved)) writeFileAtomicSync(resolved, `# ${path.basename(resolved, path.extname(resolved))}\n\n`);
  if (forceEdit) {
    const ed = editFileInExternalEditor(resolved, { line: startLine });
    return { ok: ed.ok, resolved, mode: "editor", edited: ed.edited, editor: ed.editor, error: ed.error };
  }
  if (forceWeb) return launchMarkdownPreview(resolved, workspaceRoot, { allowCreate });
  if (!fs.existsSync(resolved)) return { ok: false, resolved, mode: "terminal-preview", error: `未找到目标文件: ${resolved} (如需新建请加 --new)` };
  return previewFileInTerminal(resolved, startLine, endLine, forceFull);
}

const isMain = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) {
  if (process.argv[2] === "--serve-md-preview" && process.argv[3]) {
    void createMdPreviewServer(process.argv[3], { initialTimeoutMs: 25_000, disconnectGraceMs: 4_000, onAutoExit: () => process.exit(0) }).then(({ url }) => openBrowserAppWindow(url));
  } else {
    const res = runMdpCli(process.argv.slice(2), process.cwd());
    if (!res.ok) { console.error(`⚠️ ${res.error}`); process.exitCode = 1; }
    else if (res.mode === "md-preview") console.log(`📝 已拉起 Markdown 浏览器预览窗: ${res.resolved} (按 E 编辑 · Ctrl+S/自动保存 · Esc 关闭)`);
    else if (res.mode === "editor") console.log(`📝 [${res.edited ? "已保存修改" : "未做修改"} (${res.editor ?? "editor"})]: ${res.resolved}`);
    else console.log(`\n💡 终端预览: ${res.resolved} (加 -f 展开全部代码 | 加 -e 用编辑器修改 | 加 --web 用浏览器预览)`);
  }
}
