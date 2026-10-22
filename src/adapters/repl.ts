import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { LlmProvider, ToolCall } from "../core/contracts.js";
import { runAgentSession } from "./cli.js";
import { loadAndFormatWireCost, padCols } from "./cost-tracker.js";
import { attachLiveSlashDropdown, getPromptVisualCols } from "./dropdown.js";
import { createReplCompleter, extractConversationTurns, formatRecentHistoryRecap, formatSnapshotsDiff, listManagedProjects, loadProjectSnapshots, type ManagedProjectSummary, type ProjectSessionPaths, resolveProjectSessionPaths, resolveTargetWorkspace, saveProjectSnapshots, SLASH_COMMANDS } from "./project-store.js";
import { createRouterProvider, resolveRouteTier } from "./router.js";
import { loadJsonlEntries } from "./store.js";
import { formatApprovalBox } from "./ui-logger.js";
import { type FileVersionSnapshot, rollbackFileSnapshots } from "./write-tools.js";
import { analyzeSessionXray, formatXrayReport } from "./xray.js";

export { createReplCompleter, listManagedProjects, type ManagedProjectSummary, type ProjectSessionPaths, resolveProjectSessionPaths, SLASH_COMMANDS };

interface ReplRuntimeState {
  paths: ProjectSessionPaths;
  provider: LlmProvider;
  snapshots: FileVersionSnapshot[];
  leafId: string | null;
  autoApprove: boolean;
  inMainPrompt: boolean;
  homeBaseDir?: string;
  customProvider?: LlmProvider;
}

function formatPrompt(state: ReplRuntimeState): string {
  const name = path.basename(state.paths.workspaceRoot) || "root";
  const short = name.length > 18 ? `${name.slice(0, 15)}...` : name;
  const entries = fs.existsSync(state.paths.sessionFile) ? loadJsonlEntries(state.paths.sessionFile) : [];
  const rootId = entries[0]?.id ?? null;
  if (!state.leafId || state.leafId === rootId || entries.length <= 1) return `📂 ${short} [新对话] > `;
  const turns = extractConversationTurns(entries, state.leafId);
  const cur = turns.find((t) => t.isCurrentLeaf) ?? turns[turns.length - 1];
  return `📂 ${short} [${cur ? `续#${cur.turnIndex}` : "续聊"}] > `;
}

function switchProjectWorkspace(targetArg: string, state: ReplRuntimeState): void {
  const candidate = resolveTargetWorkspace(targetArg, state.paths.workspaceRoot, path.dirname(state.paths.projectDir));
  if (!candidate) {
    console.log(`⚠️ 未找到项目或目录 "${targetArg}"（输入 / 然后回车即可用 ↑/↓ 方向键选择项目）`);
    return;
  }
  const realCandidate = fs.realpathSync(candidate);
  if (realCandidate === state.paths.workspaceRoot) {
    console.log(`💡 当前已经在 [${path.basename(realCandidate)}] 工作区中，无需重复切换。`);
    return;
  }
  state.paths = resolveProjectSessionPaths(realCandidate, state.homeBaseDir);
  const existing = fs.existsSync(state.paths.sessionFile) ? loadJsonlEntries(state.paths.sessionFile) : [];
  state.leafId = existing.length > 0 ? existing[existing.length - 1]!.id : null;
  state.provider = state.customProvider ?? createRouterProvider(state.paths.wireLogFile, existing.length > 0);
  state.snapshots = loadProjectSnapshots(state.paths.snapshotsFile);
  console.log(`✅ 已切换到 [${path.basename(realCandidate)}] (${state.paths.workspaceRoot} · 历史记录 ${existing.length} 条)`);
  const recap = formatRecentHistoryRecap(existing, 1, state.leafId);
  if (recap) console.log(recap);
}

function handleSlashCommand(rawCmd: string, state: ReplRuntimeState): Promise<boolean> | boolean {
  const { paths, snapshots } = state;
  if (rawCmd === "/" || rawCmd === "/help" || rawCmd === "?") {
    console.log("\n💡 [快捷指令 (输入 / 后可直接用 ↑/↓ 方向键选择并回车执行)]:");
    for (const m of SLASH_COMMANDS) console.log(`  ${padCols(m.label, 14)} - ${m.desc}`);
    return true;
  }
  const exactOrUnique = !rawCmd.includes(" ") ? SLASH_COMMANDS.filter((c) => c.cmd.trim().startsWith(rawCmd)) : [];
  const cmd = exactOrUnique.length === 1 ? exactOrUnique[0]!.cmd.trim() : rawCmd;
  const loadEntries = () => (fs.existsSync(paths.sessionFile) ? loadJsonlEntries(paths.sessionFile) : []);

  if (cmd.startsWith("/cd ")) { switchProjectWorkspace(cmd.slice("/cd ".length).trim(), state); return true; }
  if (cmd === "/xray" || cmd === "/tree") {
    const costText = loadAndFormatWireCost(paths.wireLogFile);
    if (costText) console.log(costText);
    console.log(formatXrayReport(analyzeSessionXray(paths.sessionFile, paths.wireLogFile)));
    return true;
  }
  if (cmd.startsWith("/branch ") || cmd.startsWith("/resume ") || cmd === "/resume" || cmd === "/history") {
    const rawTarget = cmd === "/history" ? "" : cmd.replace(/^\/(?:branch|resume)\s*/, "").trim();
    const entries = loadEntries();
    if (!rawTarget) {
      console.log(formatRecentHistoryRecap(entries, 12, state.leafId) || "ℹ️ 当前项目暂无历史对话记录。");
      return true;
    }
    const turns = extractConversationTurns(entries, state.leafId);
    const byTurn = turns.find((t) => `#${t.turnIndex}` === rawTarget || String(t.turnIndex) === rawTarget);
    const resolvedId = byTurn ? byTurn.leafEntryId : rawTarget;
    if (!entries.some((e) => e.id === resolvedId)) {
      console.log(`⚠️ 未找到轮次或节点 ${rawTarget}，可输入 /resume 用 ↑/↓ 方向键选择。`);
      return true;
    }
    state.leafId = resolvedId;
    console.log(formatRecentHistoryRecap(entries, 1, state.leafId));
    return true;
  }
  if (cmd === "/diff") { console.log(formatSnapshotsDiff(snapshots, paths.workspaceRoot)); return true; }
  if (cmd === "/undo" || cmd.startsWith("/undo ")) {
    const arg = cmd.slice("/undo".length).trim();
    const stepsBack = arg === "all" ? snapshots.length : Math.max(1, Number(arg) || 1);
    return rollbackFileSnapshots(paths.workspaceRoot, snapshots, stepsBack).then((rb) => {
      saveProjectSnapshots(paths.snapshotsFile, snapshots);
      console.log(rb.rolledBackCount > 0 ? `🔄 已撤回 ${rb.rolledBackCount} 步修改 (剩余可撤回 ${rb.currentVersion} 步): ${[...new Set(rb.touchedPaths)].join(", ")}` : "ℹ️ 当前没有可撤回的修改。");
      return true;
    });
  }
  if (cmd === "/projects" || cmd === "/cd") {
    const projects = listManagedProjects(path.dirname(paths.projectDir));
    console.log(`\n📁 [已管理项目列表 (共 ${projects.length} 个 · 敲 /cd 后可按 ↑/↓ 键直接选项目)]:`);
    projects.forEach((p, i) => console.log(`  [${i + 1}] ${padCols(path.basename(p.workspaceRoot), 16)} (${p.entryCount} 条记录)${p.workspaceRoot === paths.workspaceRoot ? " ●当前项目" : ""}  ${p.workspaceRoot}`));
    return true;
  }
  if (cmd === "/new") {
    state.leafId = loadEntries()[0]?.id ?? null;
    console.log("✨ 已开启全新对话（之前的历史对话已安全保留，随时可输入 /resume 用 ↑/↓ 方向键切回）。");
    return true;
  }
  if (cmd === "/clear") {
    for (const f of [paths.sessionFile, paths.wireLogFile, paths.snapshotsFile]) if (fs.existsSync(f)) fs.unlinkSync(f);
    state.leafId = null;
    state.snapshots = [];
    console.log("🧹 已彻底清空当前项目所有历史记录。");
    return true;
  }
  return false;
}

function createApprovalHandler(rl: readline.Interface, state: ReplRuntimeState) {
  return async (toolCalls: ToolCall[]) => {
    if (state.autoApprove) return { approved: true };
    state.inMainPrompt = false;
    console.log(formatApprovalBox(toolCalls, state.paths.workspaceRoot));
    try {
      const ans = (await rl.question(`└─ 是否允许执行？[直接回车/y=允许本次 | a=本轮全自动放行 | n=拒绝] > `)).trim().toLowerCase();
      if (ans === "a") state.autoApprove = true;
      return ans === "" || ans === "y" || ans === "yes" || ans === "a"
        ? { approved: true }
        : { approved: false, reason: "用户在终端拒绝了该操作" };
    } catch {
      return { approved: false, reason: "用户按 Ctrl+C 取消了该操作" };
    }
  };
}

export async function startInteractiveRepl(options: { workspaceRoot?: string; homeBaseDir?: string; provider?: LlmProvider } = {}): Promise<void> {
  const paths = resolveProjectSessionPaths(options.workspaceRoot, options.homeBaseDir);
  const existing = fs.existsSync(paths.sessionFile) ? loadJsonlEntries(paths.sessionFile) : [];
  const state: ReplRuntimeState = {
    paths,
    provider: options.provider ?? createRouterProvider(paths.wireLogFile, existing.length > 0),
    snapshots: loadProjectSnapshots(paths.snapshotsFile),
    leafId: existing.length > 0 ? existing[existing.length - 1]!.id : null,
    autoApprove: false,
    inMainPrompt: false,
    homeBaseDir: options.homeBaseDir,
    customProvider: options.provider,
  };
  console.log(`\n🚀 Duo-Harness | 当前项目: ${path.basename(paths.workspaceRoot)} (${paths.workspaceRoot})`);
  console.log(`⚡ 模型路由: ${resolveRouteTier(Date.now()).reason}`);
  console.log(`💡 输入 / 用 ↑/↓ 方向键选择命令或切换历史 (/resume 选轮次 | /new 新对话 | /diff 看修改 | /undo 撤回)`);
  const recap = formatRecentHistoryRecap(existing, 1, state.leafId);
  if (recap) console.log(recap);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: createReplCompleter(() => state.paths.workspaceRoot, () => state.paths.sessionFile),
  });
  const detachDropdown = attachLiveSlashDropdown(rl, () => state.inMainPrompt, () => getPromptVisualCols(formatPrompt(state)), () => state.paths.workspaceRoot, state.homeBaseDir, () => state.leafId);
  const askApproval = createApprovalHandler(rl, state);

  try {
    while (true) {
      state.inMainPrompt = true;
      let line = "";
      try {
        process.stdout.write("\n");
        line = (await rl.question(formatPrompt(state))).trim();
      } catch (err) {
        if (err instanceof Error && (err.name === "AbortError" || err.message.includes("Ctrl+C"))) {
          process.stdout.write("\r\n\x1b[J👋 已退出 Duo-Harness。\n");
          break;
        }
        throw err;
      }
      state.inMainPrompt = false;
      if (!line) continue;
      if (line === "exit" || line === "quit" || line === "/exit" || line === "/quit" || line === "/e") {
        process.stdout.write("👋 已退出 Duo-Harness。\n");
        break;
      }
      if (await handleSlashCommand(line, state)) continue;
      try {
        const res = await runAgentSession(line, {
          workspaceRoot: state.paths.workspaceRoot,
          sessionFile: state.paths.sessionFile,
          wireLogFile: state.paths.wireLogFile,
          leafId: state.leafId ?? undefined,
          provider: state.provider,
          snapshots: state.snapshots,
          enableWriteTools: true,
          showCostReport: false,
          suppressFinalEcho: true,
          onApprovalRequest: askApproval,
        });
        state.leafId = res.leafId;
      } catch (err) {
        console.error(`\n❌ 本轮运行异常: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        saveProjectSnapshots(state.paths.snapshotsFile, state.snapshots);
      }
    }
  } finally {
    detachDropdown();
    rl.close();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argDir = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : undefined;
  startInteractiveRepl({ workspaceRoot: argDir }).catch((err) => {
    console.error("终端运行异常:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
