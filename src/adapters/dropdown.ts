import * as fs from "node:fs";
import * as path from "node:path";
import { padCols, truncateCols } from "./cost-tracker.js";
import { extractConversationTurns, listManagedProjects, resolveProjectSessionPaths, SLASH_COMMANDS } from "./project-store.js";
import { loadJsonlEntries } from "./store.js";

export interface DropdownItem {
  label: string;
  desc: string;
  fillText: string;
  expandOnly?: boolean;
}

export function getPromptVisualCols(promptStr: string): number {
  const lastLine = promptStr.split("\n").pop() ?? "";
  let cols = 0;
  for (const ch of lastLine) {
    cols += (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
  }
  return cols;
}

export function buildDropdownItems(
  line: string,
  currentWorkspaceRoot: string,
  homeBaseDir?: string,
  activeLeafId?: string | null,
): DropdownItem[] {
  if (line.startsWith("/model ")) {
    const filter = line.slice(7).trim().toLowerCase();
    const modes: DropdownItem[] = [
      { label: "/model auto", desc: "⚡ 智能模式 (新对话按高峰MiMo/低谷DS路由，续聊自动保持原模型防缓存失效)", fillText: "/model auto" },
      { label: "/model deepseek", desc: "🧠 锁定 DeepSeek (deepseek-reasoner · 深度中文推理)", fillText: "/model deepseek" },
      { label: "/model mimo", desc: "🚀 锁定 小米 MiMo (mimo-v2.6-pro · 高速主力模型)", fillText: "/model mimo" },
      { label: "/model agy", desc: "🪐 桥接 Antigravity (本机官方 language_server · 白嫖 5h 刷新额度)", fillText: "/model agy" },
    ];
    return modes.filter((m) => !filter || m.label.includes(filter));
  }
  if (line.startsWith("/resume ") || line.startsWith("/branch ")) {
    const filter = line.replace(/^\/(?:resume|branch)\s+/, "").trim().toLowerCase();
    const sFile = resolveProjectSessionPaths(currentWorkspaceRoot, homeBaseDir).sessionFile;
    const entries = fs.existsSync(sFile) ? loadJsonlEntries(sFile) : [];
    const turns = extractConversationTurns(entries, activeLeafId).reverse();
    const items: DropdownItem[] = turns
      .filter((t) => !filter || `#${t.turnIndex}`.includes(filter) || t.userText.toLowerCase().includes(filter) || t.leafEntryId.includes(filter))
      .slice(0, 7)
      .map((t) => ({
        label: `/resume #${t.turnIndex}`,
        desc: `${t.isCurrentLeaf ? "[●当前续接] " : `[${t.toolSteps}步] `}👤 ${t.userText.slice(0, 22)} -> 🤖 ${(t.replyText || "未完成").slice(0, 26)}`,
        fillText: `/resume #${t.turnIndex}`,
        expandOnly: false,
      }));
    items.push({
      label: "/new",
      desc: "✨ 开启全新空白对话 (保留旧对话记录，随时可 /resume 切回)",
      fillText: "/new",
      expandOnly: false,
    });
    return items;
  }
  if (line.startsWith("/cd ")) {
    const filter = line.slice(4).trim().toLowerCase();
    const projects = listManagedProjects(homeBaseDir);
    const sorted = [...projects].sort((a, b) => {
      const aIsCur = a.workspaceRoot === currentWorkspaceRoot ? 1 : 0;
      const bIsCur = b.workspaceRoot === currentWorkspaceRoot ? 1 : 0;
      return aIsCur - bIsCur || a.projectKey.localeCompare(b.projectKey);
    });
    return sorted
      .filter((p) => {
        const name = path.basename(p.workspaceRoot).toLowerCase();
        return !filter || name.includes(filter) || p.projectKey.toLowerCase().includes(filter);
      })
      .slice(0, 8)
      .map((p) => {
        const name = path.basename(p.workspaceRoot);
        const curTag = p.workspaceRoot === currentWorkspaceRoot ? "●当前项目" : `${p.entryCount}条记录`;
        return {
          label: `/cd ${name}`,
          desc: `[${curTag}] ${p.workspaceRoot}`,
          fillText: `/cd ${name}`,
          expandOnly: false,
        };
      });
  }
  if (line.startsWith("/") && !line.includes(" ")) {
    return SLASH_COMMANDS.filter((c) => c.cmd.trim().startsWith(line.trim())).map((c) => ({
      label: c.label,
      desc: c.desc,
      fillText: c.cmd === "/projects" ? "/cd " : c.cmd,
      expandOnly: c.cmd === "/cd " || c.cmd === "/resume " || c.cmd === "/branch " || c.cmd === "/model " || c.cmd === "/projects",
    }));
  }
  return [];
}

export function findMethodKey(rl: any, name: string): string | symbol | null {
  if (typeof rl?.[name] === "function") return name;
  let cur = rl;
  while (cur && cur !== Object.prototype) {
    for (const sym of Object.getOwnPropertySymbols(cur)) {
      if (sym.description === name && typeof cur[sym] === "function") return sym;
    }
    cur = Object.getPrototypeOf(cur);
  }
  return null;
}

function formatDropdownRows(items: DropdownItem[], selectedIdx: number, line: string): string {
  const maxCols = Math.max(60, (process.stdout.columns || 100) - 4);
  const labelWidth = line.startsWith("/cd ") ? 24 : line.startsWith("/resume ") ? 13 : 16;
  return items
    .map((item, idx) => {
      const active = idx === selectedIdx;
      const plain = `${active ? "❯ " : "  "}${padCols(item.label, labelWidth)} ${item.desc}`;
      const clipped = truncateCols(plain, maxCols);
      return `\r\n\x1b[2K${active ? `\x1b[36;1m${clipped}\x1b[0m` : `\x1b[90m${clipped}\x1b[0m`}`;
    })
    .join("");
}

export function attachLiveSlashDropdown(
  rl: any,
  isActivePrompt: () => boolean,
  getPromptCols: () => number,
  getWorkspaceRoot: () => string,
  homeBaseDir?: string,
  getActiveLeafId?: () => string | null,
): () => void {
  const ttyKey = findMethodKey(rl, "_ttyWrite");
  const refreshKey = findMethodKey(rl, "_refreshLine");
  if (!process.stdin.isTTY || !process.stdout.isTTY || !ttyKey) return () => {};
  const origTtyWrite = rl[ttyKey].bind(rl);
  const refreshLine = () => {
    if (refreshKey && typeof rl[refreshKey] === "function") rl[refreshKey]();
  };
  let menuShown = false, selectedIdx = 0, lastLine = "";

  const clearMenu = (cursorCols: number) => {
    if (!menuShown) return;
    process.stdout.write(`\r\n\x1b[J\x1b[1A\r\x1b[${cursorCols}C`);
    menuShown = false;
  };

  const renderMenu = () => {
    if (!isActivePrompt()) return;
    const line: string = typeof rl.line === "string" ? rl.line : "";
    const cursor: number = typeof rl.cursor === "number" ? rl.cursor : line.length;
    const cursorCols = getPromptCols() + getPromptVisualCols(line.slice(0, cursor));
    if (line !== lastLine) { selectedIdx = 0; lastLine = line; }
    const items = buildDropdownItems(line, getWorkspaceRoot(), homeBaseDir, getActiveLeafId?.());
    if (items.length === 0) return clearMenu(cursorCols);
    selectedIdx = Math.max(0, Math.min(selectedIdx, items.length - 1));
    const down = formatDropdownRows(items, selectedIdx, line);
    process.stdout.write(`${down}\x1b[J\x1b[${items.length}A\r\x1b[${cursorCols}C`);
    menuShown = true;
  };

  rl[ttyKey] = function (s: string, key?: { name?: string; ctrl?: boolean; meta?: boolean }) {
    if (!isActivePrompt()) return origTtyWrite(s, key);
    const line: string = typeof rl.line === "string" ? rl.line : "";
    const items = menuShown ? buildDropdownItems(line, getWorkspaceRoot(), homeBaseDir, getActiveLeafId?.()) : [];
    if (items.length > 0 && (key?.name === "up" || key?.name === "down")) {
      selectedIdx = key.name === "down" ? (selectedIdx + 1) % items.length : (selectedIdx - 1 + items.length) % items.length;
      return renderMenu();
    }
    if (items.length > 0 && (key?.name === "tab" || key?.name === "right" || key?.name === "return" || key?.name === "enter")) {
      const chosen = items[selectedIdx] ?? items[0]!;
      if (key.name === "tab" || key.name === "right" || chosen.expandOnly) {
        rl.line = chosen.fillText;
        rl.cursor = rl.line.length;
        refreshLine();
        return renderMenu();
      }
      rl.line = chosen.fillText.trim();
      rl.cursor = rl.line.length;
      refreshLine();
      clearMenu(getPromptCols() + getPromptVisualCols(rl.line));
      return origTtyWrite(s, key);
    }
    if (key?.name === "return" || key?.name === "enter") {
      clearMenu(getPromptCols() + getPromptVisualCols(line));
      return origTtyWrite(s, key);
    }
    origTtyWrite(s, key);
    setImmediate(renderMenu);
  };

  return () => { rl[ttyKey] = origTtyWrite; };
}
