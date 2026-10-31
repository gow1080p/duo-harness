import * as fs from "node:fs";
import * as path from "node:path";
import { buildPsDropdownItems } from "./bg-process.js";
import { buildAtMentionDropdown, filterAndRankFiles, listWorkspaceFiles } from "./context-mention.js";
import { summarizeSnapshotsDiff } from "./diff-presenter.js";
import { loadModelRegistryConfig } from "./model-config.js";
import { buildPlanOrGoalDropdown } from "./plan-flow.js";
import { getVisualCols, padCols, truncateCols } from "./platform.js";
import { extractConversationTurns, listManagedProjects, loadProjectSnapshots, resolveProjectSessionPaths, SLASH_COMMANDS } from "./project-store.js";
import { buildSkillDropdownItems, discoverAvailableSkills } from "./skill-loader.js";
import { loadJsonlEntries } from "./store.js";
import { captureClipboardImage, checkAutoClipboardExpand, consumeTerminalFocusSeq, isPasteShortcutKey, setMacClipboardPromptActive, startMacClipboardImageBridge, tryExpandClipboardInLine, tryPasteClipboardToRl } from "./vision-capture.js";

export interface DropdownItem { label: string; desc: string; fillText: string; expandOnly?: boolean; cursorAfter?: number; }
export interface LiveDropdownRuntimeHooks { isApprovalActive?: () => boolean; onAbortRun?: () => void; onSteerLine?: (text: string) => void; onExternalEditor?: () => void; }
const MAX_MENU_ROWS = 8, PASTED_NEWLINE_TOKEN = "\u200b↵\u200b";

export function encodePastedNewlines(raw: string): string { return raw.replace(/\r\n|\r|\n/g, PASTED_NEWLINE_TOKEN); }
export function restorePastedNewlines(line: string): string { return line.split(PASTED_NEWLINE_TOKEN).join("\n"); }
export function getPromptVisualCols(promptStr: string): number { return getVisualCols(promptStr.split("\n").pop() ?? ""); }

function buildDiffOrOpenDropdown(line: string, currentWorkspaceRoot: string, homeBaseDir?: string): DropdownItem[] {
  const isDiff = line.startsWith("/diff "), isMdp = /^\/?mdp\s+/i.test(line), cmdPrefix = line.startsWith("/shot ") ? "/shot" : isMdp ? "/mdp" : "/open";
  const filter = line.replace(/^\/?(?:diff|open|shot|mdp)\s+/i, "").trim().toLowerCase();
  const snaps = loadProjectSnapshots(resolveProjectSessionPaths(currentWorkspaceRoot, homeBaseDir, { readonly: true }).snapshotsFile);
  const top = snaps[snaps.length - 1], files = summarizeSnapshotsDiff(top?.turnId ? snaps.filter((s) => s.turnId === top.turnId) : snaps, currentWorkspaceRoot, false);
  if (isDiff) {
    const items: DropdownItem[] = [...files.map((d, i) => ({ label: `/diff ${d.file}`, desc: `[#${i + 1}] ${d.isNew ? `新建 +${d.newLines} 行` : `+${d.addedLines} / -${d.removedLines} 行 (${d.edits}处修改)`}`, fillText: `/diff ${d.file}` })), { label: "/diff full", desc: "🔍 展开本轮全部修改代码行（不折叠长片段）", fillText: "/diff full" }, { label: "/diff all", desc: `📚 查看从第 1 版以来的累计对比 (共 ${snaps.length} 版)`, fillText: "/diff all" }];
    return items.filter((m) => !filter || m.label.toLowerCase().includes(filter) || m.desc.toLowerCase().includes(filter));
  }
  const seen = new Set<string>(), allWsFiles = listWorkspaceFiles(currentWorkspaceRoot);
  const items: DropdownItem[] = isMdp ? [{ label: "/mdp -f", desc: "📖 终端展开完整源码 (不折叠长代码块，进入 less 分页浏览)", fillText: "/mdp -f" }, { label: "/mdp -e", desc: "✏️ 调用外部编辑器 (Cursor/VS Code/Vim) 打开修改 (同 Ctrl+G)", fillText: "/mdp -e" }, { label: "/mdp --web", desc: "🌐 拉起独立浏览器 Markdown 预览窗 (支持目录大纲与按 E 编辑)", fillText: "/mdp --web" }] : [];
  if (cmdPrefix !== "/shot" && (allWsFiles.includes(".debug/plan.md") || fs.existsSync(path.join(currentWorkspaceRoot, ".debug", "plan.md")))) {
    seen.add(".debug/plan.md"); items.push({ label: `${cmdPrefix} .debug/plan.md`, desc: "📝 终端高亮预览当前规划方案 (.debug/plan.md)", fillText: `${cmdPrefix} .debug/plan.md` });
  }
  for (const d of files) {
    if (!seen.has(d.file) && (!isMdp || /\.(?:md|markdown)$/i.test(d.file))) {
      seen.add(d.file); items.push({ label: `${cmdPrefix} ${d.file}`, desc: cmdPrefix === "/shot" ? `🌐 无头截图预览 (${d.file})` : isMdp ? `📝 终端高亮预览本轮修改 Markdown (${d.file})` : `🌐 打开本轮修改文件 (${d.file})`, fillText: `${cmdPrefix} ${d.file}` });
    }
  }
  for (const rel of filterAndRankFiles(allWsFiles.filter((f) => !seen.has(f) && (!isMdp || /\.(?:md|markdown)$/i.test(f))), filter, 8)) {
    const descPrefix = isMdp ? "📝 终端高亮预览 Markdown" : /\.(?:md|markdown)$/i.test(rel) && cmdPrefix === "/open" ? "📝 预览与编辑 Markdown" : cmdPrefix === "/shot" ? "📄 截取网页/文件预览图" : "📄 用系统默认应用打开";
    items.push({ label: `${cmdPrefix} ${rel}`, desc: `${descPrefix} ${rel}`, fillText: `${cmdPrefix} ${rel}` });
  }
  if (cmdPrefix === "/open") items.push({ label: "/open .", desc: `📂 在系统文件管理器中打开当前工作区 (${currentWorkspaceRoot})`, fillText: "/open ." });
  return items.filter((m) => !filter || m.label.toLowerCase().includes(filter) || m.desc.toLowerCase().includes(filter)).slice(0, 8);
}

export function buildDropdownItems(line: string, currentWorkspaceRoot: string, homeBaseDir?: string, activeLeafId?: string | null, cursor: number = line.length): DropdownItem[] {
  if (line.startsWith("/model ")) {
    const filter = line.slice(7).trim().toLowerCase(), cfg = loadModelRegistryConfig(currentWorkspaceRoot);
    const baseItems: DropdownItem[] = [{ label: "/model auto", desc: "⚡ 智能模式 (新对话按高峰MiMo/低谷DS路由，续聊自动保持原模型防缓存失效)", fillText: "/model auto" }, { label: "/model deepseek", desc: "🧠 锁定 DeepSeek (deepseek-reasoner · 深度中文推理)", fillText: "/model deepseek" }, { label: "/model mimo", desc: "🚀 锁定 小米 MiMo (mimo-v2.6-pro · 高速主力模型)", fillText: "/model mimo" }, { label: "/model agy", desc: "🪐 锁定 Argon·反重力 (gemini-4-argon-high · 车位订阅 OpenAI 网关 · 实付 ¥0)", fillText: "/model agy" }];
    for (const [k, v] of Object.entries(cfg.models)) if (!["deepseek", "mimo", "agy", "openai"].includes(k)) baseItems.push({ label: `/model ${k}`, desc: `🔌 自定义模型 (${v.label ?? k} · ${v.model})`, fillText: `/model ${k}` });
    baseItems.push({ label: "/model config", desc: "⚙️ 打开模型配置文件 (~/.duo-harness/models.json · 添加/修改 API 与自定义模型)", fillText: "/model config" });
    return baseItems.filter((m) => !filter || m.label.toLowerCase().includes(filter) || m.desc.toLowerCase().includes(filter));
  }
  if (line.startsWith("/resume ") || line.startsWith("/branch ")) {
    const filter = line.replace(/^\/(?:resume|branch)\s+/, "").trim().toLowerCase(), sFile = resolveProjectSessionPaths(currentWorkspaceRoot, homeBaseDir, { readonly: true }).sessionFile;
    const turns = extractConversationTurns(fs.existsSync(sFile) ? loadJsonlEntries(sFile) : [], activeLeafId).reverse();
    const items: DropdownItem[] = turns.filter((t) => !filter || `#${t.turnIndex}`.includes(filter) || t.userText.toLowerCase().includes(filter) || t.leafEntryId.includes(filter)).slice(0, 7)
      .map((t) => ({ label: `/resume #${t.turnIndex}`, desc: `${t.isCurrentLeaf ? "[●当前续接] " : `[${t.toolSteps}步] `}👤 ${t.userText.slice(0, 22)} -> 🤖 ${(t.replyText || "未完成").slice(0, 26)}`, fillText: `/resume #${t.turnIndex}`, expandOnly: false }));
    items.push({ label: "/new", desc: "✨ 开启全新空白对话 (保留旧对话记录，随时可 /resume 切回)", fillText: "/new", expandOnly: false });
    return items;
  }
  if (line.startsWith("/diff ") || line.startsWith("/open ") || line.startsWith("/shot ") || /^\/?mdp\s+/i.test(line)) return buildDiffOrOpenDropdown(line, currentWorkspaceRoot, homeBaseDir);
  if (/^\/ps\s+/i.test(line)) return buildPsDropdownItems(line, currentWorkspaceRoot);
  if (/^\/verify\s+/i.test(line)) {
    const q = line.replace(/^\/verify\s+/i, "").trim().toLowerCase();
    return [{ label: "/verify", desc: "🔍 查看当前完成前验证策略 (默认按语言自动检测)", fillText: "/verify" }, { label: "/verify auto", desc: "⚡ 恢复默认多语言自动验证 (TS/Python/Go/Rust)", fillText: "/verify auto" }, { label: "/verify off", desc: "⏸️ 关闭完成前自动编译检查", fillText: "/verify off" }, { label: "/verify pnpm test", desc: "🧪 自定义完成前运行 pnpm test 验证命令", fillText: "/verify pnpm test" }].filter((m) => !q || m.label.toLowerCase().includes(q) || m.desc.toLowerCase().includes(q));
  }
  if (/^\/(?:plan|goal)(?:\s|$)/i.test(line)) { const planItems = buildPlanOrGoalDropdown(line, currentWorkspaceRoot); if (planItems.length > 0) return planItems; }
  if (line.startsWith("/skill ") || line === "/skills") return buildSkillDropdownItems(line, currentWorkspaceRoot);
  if (line.startsWith("/cd ")) {
    const filter = line.slice(4).trim().toLowerCase();
    return [...listManagedProjects(homeBaseDir)].sort((a, b) => (a.workspaceRoot === currentWorkspaceRoot ? 1 : 0) - (b.workspaceRoot === currentWorkspaceRoot ? 1 : 0) || a.projectKey.localeCompare(b.projectKey))
      .filter((p) => !filter || path.basename(p.workspaceRoot).toLowerCase().includes(filter) || p.projectKey.toLowerCase().includes(filter)).slice(0, 8)
      .map((p) => ({ label: `/cd ${path.basename(p.workspaceRoot)}`, desc: `[${p.workspaceRoot === currentWorkspaceRoot ? "●当前项目" : `${p.entryCount}条记录`}] ${p.workspaceRoot}`, fillText: `/cd ${path.basename(p.workspaceRoot)}`, expandOnly: false }));
  }
  if ((line.startsWith("/") && !line.includes(" ")) || /^mdp$/i.test(line.trim())) {
    const q = line.startsWith("/") ? line.trim().toLowerCase() : `/${line.trim().toLowerCase()}`;
    const base = SLASH_COMMANDS.filter((c) => c.cmd.trim().startsWith(q)).map((c) => ({ label: c.label, desc: c.desc, fillText: c.cmd === "/projects" ? "/cd " : c.cmd, expandOnly: c.cmd.endsWith(" ") || c.cmd === "/projects" }));
    const custom = discoverAvailableSkills(currentWorkspaceRoot, homeBaseDir).filter((s) => s.kind === "command" && `/${s.name.toLowerCase()}`.startsWith(q) && !SLASH_COMMANDS.some((c) => c.cmd.trim() === `/${s.name.toLowerCase()}`)).map((s) => ({ label: `/${s.name}${s.argumentHint ? ` ${s.argumentHint}` : ""}`, desc: `⚡ [${s.scope === "workspace" ? "项目" : "全局"}命令] ${s.description}`, fillText: `/${s.name} `, expandOnly: Boolean(s.argumentHint) }));
    return [...base, ...custom];
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
  const isWide = items[0]?.label.startsWith("@") || line.startsWith("/cd ") || line.startsWith("/diff ") || line.startsWith("/open ") || line.startsWith("/shot ") || /^\/?mdp\s+/i.test(line) || /^\/(?:plan|goal|ps)(?:\s|$)/i.test(line) || line.startsWith("/skill");
  const labelWidth = isWide ? 26 : line.startsWith("/resume ") ? 13 : 16;
  const winStart = items.length > MAX_MENU_ROWS ? Math.max(0, Math.min(selectedIdx - 3, items.length - MAX_MENU_ROWS)) : 0, visible = items.slice(winStart, winStart + MAX_MENU_ROWS);
  const text = visible.map((item, i) => {
    const active = winStart + i === selectedIdx, clipped = truncateCols(`${active ? "❯ " : "  "}${padCols(item.label, labelWidth)} ${item.desc}`, maxCols);
    return `\r\n\x1b[2K${active ? `\x1b[36;1m${clipped}\x1b[0m` : `\x1b[90m${clipped}\x1b[0m`}`;
  }).join("");
  return { text, rows: visible.length };
}

function handleInactiveRunKey(s: string, key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined, curBuf: string, hooks?: LiveDropdownRuntimeHooks): string {
  if (key?.name === "escape" || s === "\x1b") return "";
  if (key?.name === "return" || key?.name === "enter") { const msg = restorePastedNewlines(curBuf).trim(); if (msg) hooks?.onSteerLine?.(msg); return ""; }
  if (key?.name === "backspace") return Array.from(curBuf).slice(0, -1).join("");
  return typeof s === "string" && !key?.ctrl && !key?.meta && s >= " " ? curBuf + s : curBuf;
}

function insertTextAtCursor(rl: any, text: string, refreshLine: () => void): void {
  const curLine: string = typeof rl.line === "string" ? rl.line : "", curCursor: number = typeof rl.cursor === "number" ? rl.cursor : curLine.length;
  const normCurCmd = curLine.trim().startsWith("/") ? curLine.trim().toLowerCase() : `/${curLine.trim().toLowerCase()}`;
  if (curCursor === curLine.length && /^\/?[a-z]+\s*$/i.test(curLine) && text.trimStart().toLowerCase().startsWith(`${normCurCmd} `)) {
    rl.line = text.trimStart(); rl.cursor = rl.line.length; refreshLine(); return;
  }
  rl.line = curLine.slice(0, curCursor) + text + curLine.slice(curCursor); rl.cursor = curCursor + text.length; refreshLine();
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
    refreshLine(); renderMenu(); return "expanded";
  }
  rl.line = chosen.fillText.trim(); rl.cursor = rl.line.length; refreshLine(); clearMenu(getPromptCols() + getPromptVisualCols(rl.line)); return "submit";
}

function handlePromptInterruptKey(
  rl: any, s: string, key: { name?: string; ctrl?: boolean } | undefined, isActivePrompt: () => boolean,
  getPromptCols: () => number, clearMenu: (cols: number) => void, refreshLine: () => void,
  origTtyWrite: (s: string, key?: any) => any, hooks: LiveDropdownRuntimeHooks | undefined,
  state: { lastCtrlCTime: number; lastLine: string; dismissedLine: string | null; inBracketedPaste: boolean; pasteBuffer: string; pasteResetTimer?: ReturnType<typeof setTimeout> },
  out: { write: (str: string) => any },
): boolean {
  const curLine = typeof rl.line === "string" ? rl.line : "";
  const isCtrlC = (key?.ctrl && key?.name === "c") || s === "\x03", isEmptyCtrlD = ((key?.ctrl && key?.name === "d") || s === "\x04") && curLine.length === 0;
  if (!isCtrlC && !(isActivePrompt() && isEmptyCtrlD)) {
    if (state.lastCtrlCTime > 0) { state.lastCtrlCTime = 0; if (isActivePrompt()) out.write("\x1b[K"); }
    return false;
  }
  state.inBracketedPaste = false; state.pasteBuffer = ""; if (state.pasteResetTimer) clearTimeout(state.pasteResetTimer);
  if (!isActivePrompt()) { if (!hooks?.isApprovalActive?.()) hooks?.onAbortRun?.(); origTtyWrite(s, key); return true; }
  clearMenu(getPromptCols() + getPromptVisualCols(curLine.slice(0, Number(rl.cursor ?? curLine.length))));
  if (curLine.length > 0) { rl.line = ""; rl.cursor = 0; state.lastLine = ""; state.dismissedLine = null; state.lastCtrlCTime = 0; refreshLine(); return true; }
  const now = Date.now();
  if (now - state.lastCtrlCTime < 1500) { state.lastCtrlCTime = 0; out.write("\x1b[K"); origTtyWrite(s, key); return true; }
  state.lastCtrlCTime = now; refreshLine(); out.write(`\x1b[90m(再按一次 Ctrl+C 退出)\x1b[0m\x1b[K\r\x1b[${getPromptCols()}C`); return true;
}

function flushBracketedPaste(
  rl: any, rawPaste: string, isActivePrompt: () => boolean, getPromptCols: () => number,
  getWorkspaceRoot: () => string, menuShown: boolean, clearMenu: (cols: number) => void,
  refreshLine: () => void, renderMenu: () => void, hooks: LiveDropdownRuntimeHooks | undefined, steerBuf: string,
): string {
  const clean = encodePastedNewlines(rawPaste);
  const clearCurMenu = () => { if (isActivePrompt() && menuShown) clearMenu(getPromptCols() + getPromptVisualCols(String(rl.line ?? "").slice(0, Number(rl.cursor ?? 0)))); };
  if (!clean || clean.trim() === "@clipboard") {
    if (hooks?.isApprovalActive?.()) return steerBuf;
    if (isActivePrompt()) {
      if (tryPasteClipboardToRl(rl, getWorkspaceRoot(), refreshLine, renderMenu, clearCurMenu)) return steerBuf;
      if (!clean || rawPaste === "@clipboard ") return steerBuf;
    } else {
      const clip = captureClipboardImage(getWorkspaceRoot());
      return clip.ok ? `${steerBuf}${steerBuf && !/\s$/.test(steerBuf) ? " " : ""}@${clip.immutableRelPath} ` : steerBuf;
    }
  }
  if (isActivePrompt() || hooks?.isApprovalActive?.()) { clearCurMenu(); insertTextAtCursor(rl, clean, refreshLine); if (isActivePrompt()) renderMenu(); return steerBuf; }
  return steerBuf + clean;
}

export function attachLiveSlashDropdown(
  rl: any, isActivePrompt: () => boolean, getPromptCols: () => number, getWorkspaceRoot: () => string,
  homeBaseDir?: string, getActiveLeafId?: () => string | null, hooks?: LiveDropdownRuntimeHooks,
): () => void {
  const ttyKey = findMethodKey(rl, "_ttyWrite"), refreshKey = findMethodKey(rl, "_refreshLine");
  if (!Boolean(rl?.input?.isTTY || process.stdin.isTTY) || !Boolean(rl?.output?.isTTY || process.stdout.isTTY) || !ttyKey) return () => {};
  const origTtyWrite = rl[ttyKey].bind(rl), out = rl?.output && typeof rl.output.write === "function" ? rl.output : process.stdout;
  const refreshLine = () => { if (refreshKey && typeof rl[refreshKey] === "function") rl[refreshKey](); };
  const st = { lastCtrlCTime: 0, lastLine: "", lastCursor: -1, items: [] as DropdownItem[], dismissedLine: null as string | null, inBracketedPaste: false, pasteBuffer: "", pasteResetTimer: undefined as ReturnType<typeof setTimeout> | undefined };
  let menuShown = false, renderedRows = 0, selectedIdx = 0, lastFailedClip = "", steerBuf = "";
  const stopClipBridge = startMacClipboardImageBridge();
  setImmediate(() => { listWorkspaceFiles(getWorkspaceRoot()); discoverAvailableSkills(getWorkspaceRoot(), homeBaseDir); });
  process.stdout.write(process.platform === "darwin" ? "\x1b[?2004h\x1b[?1004h" : "\x1b[?2004h");
  const disableBracketedPaste = () => {
    stopClipBridge(); if (st.pasteResetTimer) clearTimeout(st.pasteResetTimer);
    if (process.stdout.isTTY) process.stdout.write(process.platform === "darwin" ? "\x1b[?1004l\x1b[?2004l" : "\x1b[?2004l");
  };
  process.once("exit", disableBracketedPaste);
  const clearMenu = (cursorCols: number) => { if (menuShown) { process.stdout.write(`\r\n\x1b[J\x1b[1A\r\x1b[${cursorCols}C`); menuShown = false; renderedRows = 0; st.items = []; } };
  const renderMenu = () => {
    if (!isActivePrompt()) return;
    const line: string = typeof rl.line === "string" ? rl.line : "", cursor: number = typeof rl.cursor === "number" ? rl.cursor : line.length;
    const cursorCols = getPromptCols() + getPromptVisualCols(line.slice(0, cursor));
    if (line !== st.lastLine) { selectedIdx = 0; st.lastLine = line; st.dismissedLine = null; st.items = []; }
    if (st.dismissedLine === line) return clearMenu(cursorCols);
    if (!menuShown || cursor !== st.lastCursor || st.items.length === 0) { st.lastCursor = cursor; st.items = buildDropdownItems(line, getWorkspaceRoot(), homeBaseDir, getActiveLeafId?.(), cursor); }
    if (st.items.length === 0) return clearMenu(cursorCols);
    selectedIdx = Math.max(0, Math.min(selectedIdx, st.items.length - 1));
    const { text, rows } = formatDropdownRows(st.items, selectedIdx, line);
    renderedRows = rows; menuShown = true; process.stdout.write(`${text}\x1b[J\x1b[${renderedRows}A\r\x1b[${cursorCols}C`);
  };
  const flushPasteBuffer = () => {
    const raw = st.pasteBuffer; st.pasteBuffer = "";
    steerBuf = flushBracketedPaste(rl, raw, isActivePrompt, getPromptCols, getWorkspaceRoot, menuShown, clearMenu, refreshLine, renderMenu, hooks, steerBuf);
  };
  rl[ttyKey] = function (s: string, key?: { name?: string; sequence?: string; code?: string; ctrl?: boolean; meta?: boolean }) {
    if (handlePromptInterruptKey(rl, s, key, isActivePrompt, getPromptCols, clearMenu, refreshLine, origTtyWrite, hooks, st, out)) return;
    const rawSeq = typeof s === "string" ? s : (key?.sequence ?? "");
    if (consumeTerminalFocusSeq(rawSeq, key?.code, isActivePrompt())) return;
    const isPasteStart = key?.name === "paste-start" || rawSeq.includes("\x1b[200~"), isPasteEnd = key?.name === "paste-end" || rawSeq.includes("\x1b[201~");
    if (st.inBracketedPaste || isPasteStart || isPasteEnd) {
      if (isPasteStart) st.inBracketedPaste = true;
      if (key?.name !== "paste-start" && key?.name !== "paste-end") st.pasteBuffer += rawSeq.replace(/\x1b\[(?:20[01]~|[IO])/g, "");
      if (st.pasteResetTimer) clearTimeout(st.pasteResetTimer);
      if (isPasteEnd) { st.inBracketedPaste = false; flushPasteBuffer(); }
      else st.pasteResetTimer = setTimeout(() => { st.inBracketedPaste = false; flushPasteBuffer(); }, 150);
      return;
    }
    if (!isActivePrompt()) { setMacClipboardPromptActive(false); if (hooks?.isApprovalActive?.()) return origTtyWrite(s, key); steerBuf = handleInactiveRunKey(s, key, steerBuf, hooks); return; }
    steerBuf = "";
    const line: string = typeof rl.line === "string" ? rl.line : "", cursor: number = typeof rl.cursor === "number" ? rl.cursor : line.length;
    const clearCur = () => clearMenu(getPromptCols() + getPromptVisualCols(line.slice(0, cursor)));
    if (isPasteShortcutKey(s, key)) { tryPasteClipboardToRl(rl, getWorkspaceRoot(), refreshLine, renderMenu, clearCur); return; }
    if ((key?.ctrl && key?.name === "g") || s === "\x07") { clearCur(); hooks?.onExternalEditor?.(); return; }
    if (key?.name === "escape" && menuShown) { st.dismissedLine = line; return clearCur(); }
    const items = menuShown ? (line === st.lastLine && cursor === st.lastCursor ? st.items : buildDropdownItems(line, getWorkspaceRoot(), homeBaseDir, getActiveLeafId?.(), cursor)) : [];
    if (items.length > 0 && (key?.name === "up" || key?.name === "down")) { selectedIdx = key.name === "down" ? (selectedIdx + 1) % items.length : (selectedIdx - 1 + items.length) % items.length; return renderMenu(); }
    const isRightAtEnd = key?.name === "right" && cursor === line.length;
    if (items.length > 0 && (key?.name === "tab" || isRightAtEnd || key?.name === "return" || key?.name === "enter")) {
      if (applyChosenDropdownItem(rl, items[selectedIdx] ?? items[0]!, line, key?.name, isRightAtEnd, getWorkspaceRoot(), homeBaseDir, getActiveLeafId?.(), refreshLine, renderMenu, clearMenu, getPromptCols) === "expanded") return;
      setMacClipboardPromptActive(false); return origTtyWrite(s, key);
    }
    if (key?.name === "return" || key?.name === "enter") { setMacClipboardPromptActive(false); clearMenu(getPromptCols() + getPromptVisualCols(line)); return origTtyWrite(s, key); }
    origTtyWrite(s, key);
    setImmediate(() => { lastFailedClip = checkAutoClipboardExpand(rl, getWorkspaceRoot(), lastFailedClip, refreshLine, clearCur); renderMenu(); });
  };
  return () => { process.off("exit", disableBracketedPaste); disableBracketedPaste(); rl[ttyKey] = origTtyWrite; };
}
