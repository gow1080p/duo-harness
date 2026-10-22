import * as path from "node:path";
import { padCols, truncateCols } from "./cost-tracker.js";
import { listManagedProjects, SLASH_COMMANDS } from "./project-store.js";

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
): DropdownItem[] {
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
      expandOnly: c.cmd === "/cd " || c.cmd === "/projects",
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

export function attachLiveSlashDropdown(
  rl: any,
  isActivePrompt: () => boolean,
  getPromptCols: () => number,
  getWorkspaceRoot: () => string,
  homeBaseDir?: string,
): () => void {
  const ttyKey = findMethodKey(rl, "_ttyWrite");
  const refreshKey = findMethodKey(rl, "_refreshLine");
  if (!process.stdin.isTTY || !process.stdout.isTTY || !ttyKey) {
    return () => {};
  }
  const origTtyWrite = rl[ttyKey].bind(rl);
  const refreshLine = () => {
    if (refreshKey && typeof rl[refreshKey] === "function") rl[refreshKey]();
  };
  let menuShown = false;
  let selectedIdx = 0;
  let lastLine = "";

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
    if (line !== lastLine) {
      selectedIdx = 0;
      lastLine = line;
    }
    const items = buildDropdownItems(line, getWorkspaceRoot(), homeBaseDir);
    if (items.length === 0) {
      clearMenu(cursorCols);
      return;
    }
    selectedIdx = Math.max(0, Math.min(selectedIdx, items.length - 1));
    const maxCols = Math.max(60, (process.stdout.columns || 100) - 4);
    const labelWidth = line.startsWith("/cd ") ? 24 : 16;
    const rows = items.map((item, idx) => {
      const active = idx === selectedIdx;
      const prefix = active ? "❯ " : "  ";
      const plain = `${prefix}${padCols(item.label, labelWidth)} ${item.desc}`;
      const clipped = truncateCols(plain, maxCols);
      return active ? `\x1b[36;1m${clipped}\x1b[0m` : `\x1b[90m${clipped}\x1b[0m`;
    });
    const down = rows.map((r) => `\r\n\x1b[2K${r}`).join("");
    process.stdout.write(`${down}\x1b[J\x1b[${rows.length}A\r\x1b[${cursorCols}C`);
    menuShown = true;
  };

  rl[ttyKey] = function (s: string, key?: { name?: string; ctrl?: boolean; meta?: boolean }) {
    if (!isActivePrompt()) return origTtyWrite(s, key);
    const line: string = typeof rl.line === "string" ? rl.line : "";
    const items = menuShown ? buildDropdownItems(line, getWorkspaceRoot(), homeBaseDir) : [];

    if (items.length > 0 && (key?.name === "up" || key?.name === "down")) {
      selectedIdx = key.name === "down" ? (selectedIdx + 1) % items.length : (selectedIdx - 1 + items.length) % items.length;
      renderMenu();
      return;
    }
    if (items.length > 0 && (key?.name === "tab" || key?.name === "right" || key?.name === "return" || key?.name === "enter")) {
      const chosen = items[selectedIdx] ?? items[0]!;
      if (key.name === "tab" || key.name === "right" || chosen.expandOnly) {
        rl.line = chosen.fillText;
        rl.cursor = rl.line.length;
        refreshLine();
        renderMenu();
        return;
      }
      rl.line = chosen.fillText.trim();
      rl.cursor = rl.line.length;
      refreshLine();
      process.stdout.write(`\r\n\x1b[J\x1b[1A\r\x1b[${getPromptCols() + getPromptVisualCols(rl.line)}C`);
      menuShown = false;
      return origTtyWrite(s, key);
    }
    if (key?.name === "return" || key?.name === "enter") {
      if (menuShown) {
        process.stdout.write(`\r\n\x1b[J\x1b[1A\r\x1b[${getPromptCols() + getPromptVisualCols(line)}C`);
        menuShown = false;
      }
      return origTtyWrite(s, key);
    }
    origTtyWrite(s, key);
    setImmediate(renderMenu);
  };

  return () => {
    rl[ttyKey] = origTtyWrite;
  };
}
