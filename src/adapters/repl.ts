import * as path from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { LlmProvider, ToolCall } from "../core/contracts.js";
import { padCols } from "./cost-tracker.js";
import { attachLiveSlashDropdown, getPromptVisualCols } from "./dropdown.js";
import {
  createReplCompleter,
  formatRecentHistoryRecap,
  listManagedProjects,
  type ManagedProjectSummary,
  type ProjectSessionPaths,
  resolveProjectSessionPaths,
  SLASH_COMMANDS,
} from "./project-store.js";
import { resolveRouteTier } from "./router.js";
import { createSessionController, type SessionController } from "./session-controller.js";
import { formatApprovalBox } from "./ui-logger.js";

export { createReplCompleter, listManagedProjects, type ManagedProjectSummary, type ProjectSessionPaths, resolveProjectSessionPaths };

function formatPrompt(ctrl: SessionController): string {
  const st = ctrl.getStatus();
  const short = st.projectName.length > 18 ? `${st.projectName.slice(0, 15)}...` : st.projectName;
  if (st.isNew) return `📂 ${short} [新对话 · ${st.modelLabel}] > `;
  return `📂 ${short} [${st.activeTurnIndex ? `续#${st.activeTurnIndex}` : "续聊"} · ${st.modelLabel}] > `;
}

async function handleSlashCommand(rawCmd: string, ctrl: SessionController): Promise<boolean> {
  if (rawCmd === "/" || rawCmd === "/help" || rawCmd === "?") {
    console.log("\n💡 [快捷指令 (输入 / 后可直接用 ↑/↓ 方向键选择并回车执行)]:");
    for (const m of SLASH_COMMANDS) console.log(`  ${padCols(m.label, 14)} - ${m.desc}`);
    return true;
  }
  const exactOrUnique = !rawCmd.includes(" ") ? SLASH_COMMANDS.filter((c) => c.cmd.trim().startsWith(rawCmd)) : [];
  const cmd = exactOrUnique.length === 1 ? exactOrUnique[0]!.cmd.trim() : rawCmd;

  if (cmd.startsWith("/cd ")) {
    const res = ctrl.switchWorkspace(cmd.slice("/cd ".length).trim());
    if (!res.ok) console.log(`⚠️ ${res.error}（输入 / 然后回车即可用 ↑/↓ 方向键选择项目）`);
    else if (res.alreadyInWorkspace) console.log(`💡 当前已经在 [${res.status.projectName}] 工作区中，无需重复切换。`);
    else {
      console.log(`✅ 已切换到 [${res.status.projectName}] (${res.status.workspaceRoot} · 历史记录 ${res.entryCount} 条)`);
      if (res.recapText) console.log(res.recapText);
    }
    return true;
  }
  if (cmd === "/model" || cmd.startsWith("/model ")) {
    const arg = cmd.slice("/model".length).trim().toLowerCase();
    if (arg === "auto" || arg === "deepseek" || arg === "mimo" || arg === "openai") {
      const st = ctrl.setModelMode(arg);
      console.log(`🤖 已切换模型策略为 [${arg}] (当前生效: ${st.activeModel})`);
    } else console.log(`💡 用法: /model auto | /model deepseek | /model mimo (当前: ${ctrl.getStatus().modelMode})`);
    return true;
  }
  if (cmd === "/xray" || cmd === "/tree") {
    const { costText, xrayText } = ctrl.getXrayReport();
    if (costText) console.log(costText);
    console.log(xrayText);
    return true;
  }
  if (cmd.startsWith("/branch ") || cmd.startsWith("/resume ") || cmd === "/resume" || cmd === "/history") {
    const rawTarget = cmd === "/history" ? "" : cmd.replace(/^\/(?:branch|resume)\s*/, "").trim();
    if (!rawTarget) {
      console.log(formatRecentHistoryRecap(ctrl.loadEntries(), 12, ctrl.getLeafId()) || "ℹ️ 当前项目暂无历史对话记录。");
      return true;
    }
    const res = ctrl.resumeTurn(rawTarget);
    console.log(res.ok ? res.recapText : `⚠️ ${res.error}`);
    return true;
  }
  if (cmd === "/diff") {
    console.log(ctrl.getDiff().formattedText);
    return true;
  }
  if (cmd === "/undo" || cmd.startsWith("/undo ")) {
    const rb = await ctrl.undo(cmd.slice("/undo".length).trim() || "1");
    console.log(rb.rolledBackCount > 0 ? `🔄 已撤回 ${rb.rolledBackCount} 步修改 (剩余可撤回 ${rb.remainingVersions} 步): ${rb.touchedPaths.join(", ")}` : "ℹ️ 当前没有可撤回的修改。");
    return true;
  }
  if (cmd === "/projects" || cmd === "/cd") {
    const paths = ctrl.getPaths();
    const projects = listManagedProjects(path.dirname(paths.projectDir));
    console.log(`\n📁 [已管理项目列表 (共 ${projects.length} 个 · 敲 /cd 后可按 ↑/↓ 键直接选项目)]:`);
    projects.forEach((p, i) => console.log(`  [${i + 1}] ${padCols(path.basename(p.workspaceRoot), 16)} (${p.entryCount} 条记录)${p.workspaceRoot === paths.workspaceRoot ? " ●当前项目" : ""}  ${p.workspaceRoot}`));
    return true;
  }
  if (cmd === "/new") {
    ctrl.newSession();
    console.log("✨ 已开启全新对话（之前的历史对话已安全保留，随时可输入 /resume 用 ↑/↓ 方向键切回）。");
    return true;
  }
  if (cmd === "/clear") {
    ctrl.clearHistory();
    console.log("🧹 已彻底清空当前项目所有历史记录。");
    return true;
  }
  return false;
}

export async function startInteractiveRepl(options: { workspaceRoot?: string; homeBaseDir?: string; provider?: LlmProvider } = {}): Promise<void> {
  const ctrl = createSessionController(options);
  let autoApprove = false;
  let inMainPrompt = false;
  const st0 = ctrl.getStatus();
  console.log(`\n🚀 Duo-Harness | 当前项目: ${st0.projectName} (${st0.workspaceRoot})`);
  console.log(`⚡ 模型路由: ${resolveRouteTier(Date.now()).reason} (同会话自动锁定原模型防缓存失效 · 输入 /model 可手动切换)`);
  console.log(`💡 输入 / 用 ↑/↓ 方向键选择命令或切换历史 (/resume 选轮次 | /new 新对话 | /model 切模型 | /diff 看修改 | /undo 撤回)`);
  const recap = formatRecentHistoryRecap(ctrl.loadEntries(), 1, ctrl.getLeafId());
  if (recap) console.log(recap);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: createReplCompleter(() => ctrl.getPaths().workspaceRoot, () => ctrl.getPaths().sessionFile),
  });
  const detachDropdown = attachLiveSlashDropdown(rl, () => inMainPrompt, () => getPromptVisualCols(formatPrompt(ctrl)), () => ctrl.getPaths().workspaceRoot, options.homeBaseDir, () => ctrl.getLeafId());

  const askApproval = async (toolCalls: ToolCall[]) => {
    if (autoApprove) return { approved: true };
    inMainPrompt = false;
    console.log(formatApprovalBox(toolCalls, ctrl.getPaths().workspaceRoot));
    try {
      const ans = (await rl.question(`└─ 是否允许执行？[直接回车/y=允许本次 | a=本轮全自动放行 | n=拒绝] > `)).trim().toLowerCase();
      if (ans === "a") autoApprove = true;
      return ans === "" || ans === "y" || ans === "yes" || ans === "a" ? { approved: true } : { approved: false, reason: "用户在终端拒绝了该操作" };
    } catch {
      return { approved: false, reason: "用户按 Ctrl+C 取消了该操作" };
    }
  };

  try {
    while (true) {
      inMainPrompt = true;
      let line = "";
      try {
        process.stdout.write("\n");
        line = (await rl.question(formatPrompt(ctrl))).trim();
      } catch (err) {
        if (err instanceof Error && (err.name === "AbortError" || err.message.includes("Ctrl+C"))) {
          process.stdout.write("\r\n\x1b[J👋 已退出 Duo-Harness。\n");
          break;
        }
        throw err;
      }
      inMainPrompt = false;
      if (!line) continue;
      if (line === "exit" || line === "quit" || line === "/exit" || line === "/quit" || line === "/e") {
        process.stdout.write("👋 已退出 Duo-Harness。\n");
        break;
      }
      if (await handleSlashCommand(line, ctrl)) continue;
      try {
        await ctrl.ask(line, { suppressFinalEcho: true, onApprovalRequest: askApproval });
      } catch (err) {
        console.error(`\n❌ 本轮运行异常: ${err instanceof Error ? err.message : String(err)}`);
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
