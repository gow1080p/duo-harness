import * as fs from "node:fs";
import * as path from "node:path";
import { buildAtMentionDropdown } from "./context-mention.js";
import { summarizeSnapshotsDiff } from "./diff-presenter.js";
import { loadModelRegistryConfig } from "./model-config.js";
import { getVisualCols, padCols, truncateCols } from "./platform.js";
import { extractConversationTurns, listManagedProjects, loadProjectSnapshots, resolveProjectSessionPaths, SLASH_COMMANDS } from "./project-store.js";
import { buildSkillDropdownItems } from "./skill-loader.js";
import { loadJsonlEntries } from "./store.js";
import { tryExpandClipboardInLine } from "./vision-capture.js";

export interface DropdownItem { label: string; desc: string; fillText: string; expandOnly?: boolean; cursorAfter?: number; }
export interface LiveDropdownRuntimeHooks { isApprovalActive?: () => boolean; onAbortRun?: () => void; onSteerLine?: (text: string) => void; }
const MAX_MENU_ROWS = 8, PASTED_NEWLINE_TOKEN = "\u200b↵\u200b";
export function encodePastedNewlines(raw: string): string { return raw.replace(/\r\n|\r|\n/g, PASTED_NEWLINE_TOKEN); }
export function restorePastedNewlines(line: string): string { return line.split(PASTED_NEWLINE_TOKEN).join("\n"); }
export function getPromptVisualCols(promptStr: string): number { return getVisualCols(promptStr.split("\n").pop() ?? ""); }

function buildDiffOrOpenDropdown(line: string, currentWorkspaceRoot: string, homeBaseDir?: string): DropdownItem[] {
  const isDiff = line.startsWith("/diff "), cmdPrefix = line.startsWith("/shot ") ? "/shot" : "/open", filter = line.slice(6).trim().toLowerCase();
  const snaps = loadProjectSnapshots(resolveProjectSessionPaths(currentWorkspaceRoot, homeBaseDir).snapshotsFile), top = snaps[snaps.length - 1];
  const files = summarizeSnapshotsDiff(top?.turnId ? snaps.filter((s) => s.turnId === top.turnId) : snaps, currentWorkspaceRoot, false);
  if (isDiff) {
    const items: DropdownItem[] = files.map((d, i) => ({
      label: `/diff ${d.file}`, desc: `[#${i + 1}] ${d.isNew ? `新建 +${d.newLines} 行` : `+${d.addedLines} / -${d.removedLines} 行 (${d.edits}处修改)`}`, fillText: `/diff ${d.file}`,
    }));
    items.push(
      { label: "/diff full", desc: "🔍 展开本轮全部修改代码行（不折叠长片段）", fillText: "/diff full" },
      { label: "/diff all", desc: `📚 查看从第 1 版以来的累计对比 (共 ${snaps.length} 版)`, fillText: "/diff all" },
    );
    return items.filter((m) => !filter || m.label.toLowerCase().includes(filter) || m.desc.toLowerCase().includes(filter));
  }
  const seen = new Set<string>(), items: DropdownItem[] = [];
  if (cmdPrefix === "/open" && fs.existsSync(path.join(currentWorkspaceRoot, ".debug", "plan.md"))) {
    seen.add(".debug/plan.md");
    items.push({ label: "/open .debug/plan.md", desc: "📝 预览并实时编辑当前规划方案 (.debug/plan.md)", fillText: "/open .debug/plan.md" });
  }
  for (const d of files) {
    if (!seen.has(d.file)) { seen.add(d.file); items.push({ label: `${cmdPrefix} ${d.file}`, desc: `🌐 ${cmdPrefix === "/shot" ? "无头截图预览" : "打开本轮修改文件"} (${d.file})`, fillText: `${cmdPrefix} ${d.file}` }); }
  }
  try {
    for (const e of fs.readdirSync(currentWorkspaceRoot, { withFileTypes: true })) {
      if (e.isFile() && !e.name.startsWith(".") && !seen.has(e.name)) {
        const isMd = /\.(?:md|markdown)$/i.test(e.name);
        items.push({ label: `${cmdPrefix} ${e.name}`, desc: `${isMd && cmdPrefix === "/open" ? "📝 预览与编辑 Markdown" : cmdPrefix === "/shot" ? "📄 截取网页/文件预览图" : "📄 用系统默认应用打开"} ${e.name}`, fillText: `${cmdPrefix} ${e.name}` });
      }
    }
  } catch {}
  if (cmdPrefix === "/open") items.push({ label: "/open .", desc: `📂 在系统文件管理器中打开当前工作区 (${currentWorkspaceRoot})`, fillText: "/open ." });
  return items.filter((m) => !filter || m.label.toLowerCase().includes(filter) || m.desc.toLowerCase().includes(filter)).slice(0, 8);
}

export function buildDropdownItems(line: string, currentWorkspaceRoot: string, homeBaseDir?: string, activeLeafId?: string | null, cursor: number = line.length): DropdownItem[] {
  if (line.startsWith("/model ")) {
    const filter = line.slice(7).trim().toLowerCase(), cfg = loadModelRegistryConfig(currentWorkspaceRoot);
    const baseItems: DropdownItem[] = [
      { label: "/model auto", desc: "⚡ 智能模式 (新对话按高峰MiMo/低谷DS路由，续聊自动保持原模型防缓存失效)", fillText: "/model auto" },
      { label: "/model deepseek", desc: "🧠 锁定 DeepSeek (deepseek-reasoner · 深度中文推理)", fillText: "/model deepseek" },
      { label: "/model mimo", desc: "🚀 锁定 小米 MiMo (mimo-v2.6-pro · 高速主力模型)", fillText: "/model mimo" },
      { label: "/model agy", desc: "🪐 桥接 Antigravity (本机官方 language_server · 白嫖 5h 刷新额度)", fillText: "/model agy" },
    ];
    for (const [k, v] of Object.entries(cfg.models)) {
      if (!["deepseek", "mimo", "agy", "openai"].includes(k)) baseItems.push({ label: `/model ${k}`, desc: `🔌 自定义模型 (${v.label ?? k} · ${v.model})`, fillText: `/model ${k}` });
    }
    baseItems.push({ label: "/model config", desc: "⚙️ 打开模型配置文件 (~/.duo-harness/models.json · 添加/修改 API 与自定义模型)", fillText: "/model config" });
    return baseItems.filter((m) => !filter || m.label.toLowerCase().includes(filter) || m.desc.toLowerCase().includes(filter));
  }
  if (line.startsWith("/resume ") || line.startsWith("/branch ")) {
    const filter = line.replace(/^\/(?:resume|branch)\s+/, "").trim().toLowerCase(), sFile = resolveProjectSessionPaths(currentWorkspaceRoot, homeBaseDir).sessionFile;
    const turns = extractConversationTurns(fs.existsSync(sFile) ? loadJsonlEntries(sFile) : [], activeLeafId).reverse();
    const items: DropdownItem[] = turns
      .filter((t) => !filter || `#${t.turnIndex}`.includes(filter) || t.userText.toLowerCase().includes(filter) || t.leafEntryId.includes(filter))
      .slice(0, 7)
      .map((t) => ({ label: `/resume #${t.turnIndex}`, desc: `${t.isCurrentLeaf ? "[●当前续接] " : `[${t.toolSteps}步] `}👤 ${t.userText.slice(0, 22)} -> 🤖 ${(t.replyText || "未完成").slice(0, 26)}`, fillText: `/resume #${t.turnIndex}`, expandOnly: false }));
    items.push({ label: "/new", desc: "✨ 开启全新空白对话 (保留旧对话记录，随时可 /resume 切回)", fillText: "/new", expandOnly: false });
    return items;
  }
  if (line.startsWith("/diff ") || line.startsWith("/open ") || line.startsWith("/shot ")) return buildDiffOrOpenDropdown(line, currentWorkspaceRoot, homeBaseDir);
  if (line.startsWith("/skill ") || line === "/skills") return buildSkillDropdownItems(line, currentWorkspaceRoot);
  if (line.startsWith("/cd ")) {
    const filter = line.slice(4).trim().toLowerCase();
    return [...listManagedProjects(homeBaseDir)]
      .sort((a, b) => (a.workspaceRoot === currentWorkspaceRoot ? 1 : 0) - (b.workspaceRoot === currentWorkspaceRoot ? 1 : 0) || a.projectKey.localeCompare(b.projectKey))
      .filter((p) => !filter || path.basename(p.workspaceRoot).toLowerCase().includes(filter) || p.projectKey.toLowerCase().includes(filter))
      .slice(0, 8)
      .map((p) => ({ label: `/cd ${path.basename(p.workspaceRoot)}`, desc: `[${p.workspaceRoot === currentWorkspaceRoot ? "●当前项目" : `${p.entryCount}条记录`}] ${p.workspaceRoot}`, fillText: `/cd ${path.basename(p.workspaceRoot)}`, expandOnly: false }));
  }
  if (line.startsWith("/") && !line.includes(" ")) {
    return SLASH_COMMANDS.filter((c) => c.cmd.trim().startsWith(line.trim())).map((c) => ({
      label: c.label, desc: c.desc, fillText: c.cmd === "/projects" ? "/cd " : c.cmd, expandOnly: c.cmd.endsWith(" ") || c.cmd === "/projects",
    }));
  }
  return buildAtMentionDropdown(line, cursor, currentWorkspaceRoot);
}

export function findMethodKey(rl: any, name: string): string | symbol | null {
  if (typeof rl?.[name] === "function") return name;
  for (let cur = rl; cur && cur !== Object.prototype; cur = Object.getPrototypeOf(cur)) {
    for (const sym of Object.getOwnPropertySymbols(cur)) if (sym.description === name && typeof cur[sym] === "function") return sym;
  }
  return null;
}

function formatDropdownRows(items: DropdownItem[], selectedIdx: number, line: string): { text: string; rows: number } {
  const maxCols = Math.max(60, (process.stdout.columns || 100) - 4);
  const isWide = items[0]?.label.startsWith("@") || line.startsWith("/cd ") || line.startsWith("/diff ") || line.startsWith("/open ") || line.startsWith("/shot ") || line.startsWith("/skill");
  const labelWidth = isWide ? 26 : line.startsWith("/resume ") ? 13 : 16;
  const winStart = items.length > MAX_MENU_ROWS ? Math.max(0, Math.min(selectedIdx - 3, items.length - MAX_MENU_ROWS)) : 0;
  const visible = items.slice(winStart, winStart + MAX_MENU_ROWS);
  const text = visible.map((item, i) => {
    const active = winStart + i === selectedIdx, clipped = truncateCols(`${active ? "❯ " : "  "}${padCols(item.label, labelWidth)} ${item.desc}`, maxCols);
    return `\r\n\x1b[2K${active ? `\x1b[36;1m${clipped}\x1b[0m` : `\x1b[90m${clipped}\x1b[0m`}`;
  }).join("");
  return { text, rows: visible.length };
}

function isPasteShortcutKey(s: string, key?: { name?: string; ctrl?: boolean; meta?: boolean }): boolean {
  return Boolean((key?.ctrl && key?.name === "v") || s === "\x16" || (key?.meta && key?.name === "v") || s === "√" || s === "\x1bv");
}

function handleInactiveRunKey(s: string, key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined, curBuf: string, hooks?: LiveDropdownRuntimeHooks): string {
  if (key?.name === "escape" || s === "\x1b") return "";
  if (key?.name === "return" || key?.name === "enter") { const msg = restorePastedNewlines(curBuf).trim(); if (msg) hooks?.onSteerLine?.(msg); return ""; }
  if (key?.name === "backspace") return Array.from(curBuf).slice(0, -1).join("");
  return typeof s === "string" && !key?.ctrl && !key?.meta && s >= " " ? curBuf + s : curBuf;
}

function insertTextAtCursor(rl: any, text: string, refreshLine: () => void): void {
  const curLine: string = typeof rl.line === "string" ? rl.line : "", curCursor: number = typeof rl.cursor === "number" ? rl.cursor : curLine.length;
  if (curCursor === curLine.length && /^\/[a-z]+\s*$/i.test(curLine) && text.trimStart().toLowerCase().startsWith(`${curLine.trim().toLowerCase()} `)) {
    rl.line = text.trimStart(); rl.cursor = rl.line.length; refreshLine(); return;
  }
  rl.line = curLine.slice(0, curCursor) + text + curLine.slice(curCursor); rl.cursor = curCursor + text.length; refreshLine();
}

function checkAutoClipboardExpand(rl: any, wsRoot: string, lastFailed: string, refreshLine: () => void): string {
  const curLine = typeof rl.line === "string" ? rl.line : "", curCursor = typeof rl.cursor === "number" ? rl.cursor : curLine.length, beforeCursor = curLine.slice(0, curCursor);
  if (/(?:^|\s)@clipboard\s$/.test(beforeCursor) && beforeCursor !== lastFailed) {
    const exp = tryExpandClipboardInLine(curLine, curCursor, wsRoot, false);
    if (exp) { rl.line = exp.line; rl.cursor = exp.cursor; refreshLine(); return ""; }
    return beforeCursor;
  }
  return lastFailed;
}

function applyChosenDropdownItem(
  rl: any, chosen: DropdownItem, line: string, keyName: string | undefined, isRightAtEnd: boolean,
  wsRoot: string, homeBaseDir: string | undefined, activeLeafId: string | null | undefined,
  refreshLine: () => void, renderMenu: () => void, clearMenu: (cols: number) => void, getPromptCols: () => number,
): "expanded" | "submit" {
  const isEnter = keyName === "return" || keyName === "enter";
  const isExactEnterNoSub = isEnter && line.trim() === chosen.fillText.trim() && buildDropdownItems(chosen.fillText, wsRoot, homeBaseDir, activeLeafId, chosen.fillText.length).length === 0;
  if ((keyName === "tab" || isRightAtEnd || chosen.expandOnly) && !isExactEnterNoSub) {
    const exp = tryExpandClipboardInLine(chosen.fillText, chosen.cursorAfter ?? chosen.fillText.length, wsRoot, false);
    rl.line = exp ? exp.line : chosen.fillText; rl.cursor = exp ? exp.cursor : (chosen.cursorAfter ?? rl.line.length);
    refreshLine(); renderMenu();
    return "expanded";
  }
  rl.line = chosen.fillText.trim(); rl.cursor = rl.line.length; refreshLine();
  clearMenu(getPromptCols() + getPromptVisualCols(rl.line));
  return "submit";
}

export function attachLiveSlashDropdown(
  rl: any, isActivePrompt: () => boolean, getPromptCols: () => number, getWorkspaceRoot: () => string,
  homeBaseDir?: string, getActiveLeafId?: () => string | null, hooks?: LiveDropdownRuntimeHooks,
): () => void {
  const ttyKey = findMethodKey(rl, "_ttyWrite"), refreshKey = findMethodKey(rl, "_refreshLine");
  if (!Boolean(rl?.input?.isTTY || process.stdin.isTTY) || !Boolean(rl?.output?.isTTY || process.stdout.isTTY) || !ttyKey) return () => {};
  const origTtyWrite = rl[ttyKey].bind(rl), refreshLine = () => { if (refreshKey && typeof rl[refreshKey] === "function") rl[refreshKey](); };
  let menuShown = false, renderedRows = 0, selectedIdx = 0, lastLine = "", dismissedLine: string | null = null, lastFailedClip = "", inBracketedPaste = false, pasteBuffer = "", steerBuf = "";
  let pasteResetTimer: ReturnType<typeof setTimeout> | undefined;
  process.stdout.write("\x1b[?2004h");
  const disableBracketedPaste = () => { if (pasteResetTimer) clearTimeout(pasteResetTimer); if (process.stdout.isTTY) process.stdout.write("\x1b[?2004l"); };
  process.once("exit", disableBracketedPaste);
  const clearMenu = (cursorCols: number) => { if (menuShown) { process.stdout.write(`\r\n\x1b[J\x1b[1A\r\x1b[${cursorCols}C`); menuShown = false; renderedRows = 0; } };
  const renderMenu = () => {
    if (!isActivePrompt()) return;
    const line: string = typeof rl.line === "string" ? rl.line : "", cursor: number = typeof rl.cursor === "number" ? rl.cursor : line.length;
    const cursorCols = getPromptCols() + getPromptVisualCols(line.slice(0, cursor));
    if (line !== lastLine) { selectedIdx = 0; lastLine = line; dismissedLine = null; }
    if (dismissedLine === line) return clearMenu(cursorCols);
    const items = buildDropdownItems(line, getWorkspaceRoot(), homeBaseDir, getActiveLeafId?.(), cursor);
    if (items.length === 0) return clearMenu(cursorCols);
    selectedIdx = Math.max(0, Math.min(selectedIdx, items.length - 1));
    const { text, rows } = formatDropdownRows(items, selectedIdx, line);
    renderedRows = rows; menuShown = true;
    process.stdout.write(`${text}\x1b[J\x1b[${renderedRows}A\r\x1b[${cursorCols}C`);
  };
  const flushPasteBuffer = () => {
    const clean = encodePastedNewlines(pasteBuffer); pasteBuffer = "";
    if (!clean) return;
    if (isActivePrompt() || hooks?.isApprovalActive?.()) {
      if (isActivePrompt() && menuShown) clearMenu(getPromptCols() + getPromptVisualCols(String(rl.line ?? "").slice(0, Number(rl.cursor ?? 0))));
      insertTextAtCursor(rl, clean, refreshLine);
      if (isActivePrompt()) renderMenu();
    } else steerBuf += clean;
  };
  rl[ttyKey] = function (s: string, key?: { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean }) {
    if ((key?.ctrl && key?.name === "c") || s === "\x03") {
      inBracketedPaste = false; pasteBuffer = ""; if (pasteResetTimer) clearTimeout(pasteResetTimer);
      if (!isActivePrompt() && !hooks?.isApprovalActive?.()) hooks?.onAbortRun?.();
      return origTtyWrite(s, key);
    }
    const rawSeq = typeof s === "string" ? s : (key?.sequence ?? ""), isPasteStart = key?.name === "paste-start" || rawSeq.includes("\x1b[200~"), isPasteEnd = key?.name === "paste-end" || rawSeq.includes("\x1b[201~");
    if (inBracketedPaste || isPasteStart || isPasteEnd) {
      if (isPasteStart) inBracketedPaste = true;
      if (key?.name !== "paste-start" && key?.name !== "paste-end") pasteBuffer += rawSeq.replace(/\x1b\[20[01]~/g, "");
      if (pasteResetTimer) clearTimeout(pasteResetTimer);
      if (isPasteEnd) { inBracketedPaste = false; flushPasteBuffer(); } else pasteResetTimer = setTimeout(() => { inBracketedPaste = false; flushPasteBuffer(); }, 150);
      return;
    }
    if (!isActivePrompt()) { if (hooks?.isApprovalActive?.()) return origTtyWrite(s, key); steerBuf = handleInactiveRunKey(s, key, steerBuf, hooks); return; }
    steerBuf = "";
    const line: string = typeof rl.line === "string" ? rl.line : "", cursor: number = typeof rl.cursor === "number" ? rl.cursor : line.length;
    if (isPasteShortcutKey(s, key)) {
      const pasted = tryExpandClipboardInLine(line, cursor, getWorkspaceRoot(), true);
      if (pasted) { rl.line = pasted.line; rl.cursor = pasted.cursor; refreshLine(); renderMenu(); }
      return;
    }
    if (key?.name === "escape" && menuShown) { dismissedLine = line; return clearMenu(getPromptCols() + getPromptVisualCols(line.slice(0, cursor))); }
    const items = menuShown ? buildDropdownItems(line, getWorkspaceRoot(), homeBaseDir, getActiveLeafId?.(), cursor) : [];
    if (items.length > 0 && (key?.name === "up" || key?.name === "down")) { selectedIdx = key.name === "down" ? (selectedIdx + 1) % items.length : (selectedIdx - 1 + items.length) % items.length; return renderMenu(); }
    const isRightAtEnd = key?.name === "right" && cursor === line.length;
    if (items.length > 0 && (key?.name === "tab" || isRightAtEnd || key?.name === "return" || key?.name === "enter")) {
      if (applyChosenDropdownItem(rl, items[selectedIdx] ?? items[0]!, line, key?.name, isRightAtEnd, getWorkspaceRoot(), homeBaseDir, getActiveLeafId?.(), refreshLine, renderMenu, clearMenu, getPromptCols) === "expanded") return;
      return origTtyWrite(s, key);
    }
    if (key?.name === "return" || key?.name === "enter") { clearMenu(getPromptCols() + getPromptVisualCols(line)); return origTtyWrite(s, key); }
    origTtyWrite(s, key);
    setImmediate(() => { lastFailedClip = checkAutoClipboardExpand(rl, getWorkspaceRoot(), lastFailedClip, refreshLine); renderMenu(); });
  };
  return () => { process.off("exit", disableBracketedPaste); disableBracketedPaste(); rl[ttyKey] = origTtyWrite; };
}
