import * as fs from "node:fs";
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
import { probeAgyQuota } from "./agy-bridge.js";
import { createSessionController, type SessionController } from "./session-controller.js";
import { formatApprovalBox } from "./ui-logger.js";
import { runCommandInSandbox } from "./write-tools.js";

export { createReplCompleter, listManagedProjects, type ManagedProjectSummary, type ProjectSessionPaths, resolveProjectSessionPaths };

export async function verifyGoalCompletion(workspaceRoot: string, finalAnswer: string, signal?: AbortSignal): Promise<{ ok: boolean; errorOutput?: string }> {
  if (/(?:接下来我将|下一步我将|现在开始创建|准备开始修改)/.test(finalAnswer) && finalAnswer.length < 240) {
    return { ok: false, errorOutput: "当前处于 /goal 自治模式，请不要只汇报下一步计划，请直接调用工具完成剩余步骤后再总结。" };
  }
  const hasTsConfig = fs.existsSync(path.join(workspaceRoot, "tsconfig.json"));
  const hasLocalTsc = fs.existsSync(path.join(workspaceRoot, "node_modules", ".bin", "tsc")) || fs.existsSync(path.join(workspaceRoot, "node_modules", ".bin", "tsc.cmd"));
  if (hasTsConfig && hasLocalTsc) {
    const check = await runCommandInSandbox("./node_modules/.bin/tsc --noEmit --incremental false", workspaceRoot, 30_000, signal, false);
    if (check.exitCode !== 0) {
      return { ok: false, errorOutput: `npx tsc --noEmit 类型检查未通过 (exit ${check.exitCode}):\n${check.output.slice(0, 1500)}` };
    }
  }
  return { ok: true };
}

function formatPrompt(ctrl: SessionController): string {
  const st = ctrl.getStatus();
  const short = st.projectName.length > 18 ? `${st.projectName.slice(0, 15)}...` : st.projectName;
  if (st.isNew) return `📂 ${short} [新对话 · ${st.modelLabel}] > `;
  return `📂 ${short} [${st.activeTurnIndex ? `续#${st.activeTurnIndex}` : "续聊"} · ${st.modelLabel}] > `;
}

function printReplWelcomeBanner(ctrl: SessionController): void {
  const st0 = ctrl.getStatus();
  console.log(`\n🚀 Duo-Harness | 当前项目: ${st0.projectName} (${st0.workspaceRoot})`);
  console.log(`⚡ 模型路由: ${resolveRouteTier(Date.now()).reason} (同会话自动锁定原模型防缓存失效 · 输入 /model 可手动切换)`);
  console.log(`💡 输入 / 用 ↑/↓ 方向键选择命令 (/goal 自治任务 | /resume 选轮次 | /new 新对话 | /model 切模型 | /diff 看修改 | /undo 撤回)`);
  const recap = formatRecentHistoryRecap(ctrl.loadEntries(), 1, ctrl.getLeafId());
  if (recap) console.log(recap);
  const diff0 = ctrl.getDiff();
  if (diff0.totalSnapshots > 0) console.log(`📋 [检测到未撤回修改] 当前工作区有 ${diff0.files.length} 个已修改文件 (${diff0.totalSnapshots} 个版本 · 输入 /diff 查看 | /undo 撤回)`);
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
    if (arg === "auto" || arg === "deepseek" || arg === "mimo" || arg === "agy" || arg === "openai") {
      const st = ctrl.setModelMode(arg);
      console.log(`🤖 已切换模型策略为 [${arg}] (当前生效: ${st.activeModel})`);
    } else console.log(`💡 用法: /model auto | /model deepseek | /model mimo | /model agy (当前: ${ctrl.getStatus().modelMode})`);
    return true;
  }
  if (cmd === "/xray" || cmd === "/tree") {
    const [{ costText, xrayText }, agyQuota] = await Promise.all([Promise.resolve(ctrl.getXrayReport()), probeAgyQuota()]);
    if (costText) console.log(costText);
    console.log(`🪐 [反重力订阅额度雷达]: ${agyQuota.summaryLabel}`);
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
  if (cmd === "/diff" || cmd.startsWith("/diff ")) {
    console.log(ctrl.getDiff(cmd.slice("/diff".length).trim() || "turn").formattedText);
    return true;
  }
  if (cmd === "/undo" || cmd.startsWith("/undo ")) {
    const rb = await ctrl.undo(cmd.slice("/undo".length).trim() || "turn");
    console.log(rb.rolledBackCount > 0 ? `🔄 已撤回 ${rb.rolledBackCount} 处修改 (剩余可撤回 ${rb.remainingVersions} 步): ${rb.touchedPaths.join(", ")}` : "ℹ️ 当前没有可撤回的修改。");
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
  if (cmd === "/goal") {
    if (ctrl.getStatus().isNew) {
      console.log("💡 用法: /goal <任务目标> (例如: /goal 按照项目文档初始化项目并运行)");
      return true;
    }
    return false;
  }
  return false;
}

export async function startInteractiveRepl(options: { workspaceRoot?: string; homeBaseDir?: string; provider?: LlmProvider } = {}): Promise<void> {
  const ctrl = createSessionController(options);
  let autoApprove = false;
  let inMainPrompt = false;
  printReplWelcomeBanner(ctrl);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, completer: createReplCompleter(() => ctrl.getPaths().workspaceRoot, () => ctrl.getPaths().sessionFile) });
  const detachDropdown = attachLiveSlashDropdown(rl, () => inMainPrompt, () => getPromptVisualCols(formatPrompt(ctrl)), () => ctrl.getPaths().workspaceRoot, options.homeBaseDir, () => ctrl.getLeafId());

  let turnAbort: AbortController | null = null;
  const onTerminateSignal = () => turnAbort?.abort();
  process.on("SIGHUP", onTerminateSignal);
  process.on("SIGTERM", onTerminateSignal);
  const askApproval = async (toolCalls: ToolCall[]) => {
    if (autoApprove) return { approved: true };
    inMainPrompt = false;
    console.log(formatApprovalBox(toolCalls, ctrl.getPaths().workspaceRoot));
    try {
      const promptStr = `└─ 是否允许执行？[直接回车/y=允许本次 | a=本轮全自动放行 | n=拒绝] > `;
      const ans = (await rl.question(promptStr, turnAbort ? { signal: turnAbort.signal } : {})).trim().toLowerCase();
      if (ans === "a") autoApprove = true;
      return ans === "" || ans === "y" || ans === "yes" || ans === "a"
        ? { approved: true }
        : { approved: false, reason: "用户在终端拒绝了该操作（请立即停止尝试其他替代命令或启动服务，直接向用户汇报并等待指示）" };
    } catch {
      process.stdout.write("\n");
      turnAbort?.abort();
      return { approved: false, reason: "用户按 Ctrl+C 中断了本轮操作" };
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
      const isGoal = /^\/g(?:oal)?(?:\s|$)/.test(line);
      const askPrompt = isGoal ? (line.replace(/^\/g(?:oal)?\b/, "").trim() || "请继续推进并完成当前目标，采用分批小步落盘（每步最多写 1~3 个文件），确保所有代码落盘并通过构建/运行验证。") : line;
      if (isGoal) console.log("🎯 [已开启 /goal 长程自治模式] 本轮自动放行工作区写与构建操作 · 步数上限 50 步 · 完成前自动校验编译状态");
      turnAbort = new AbortController();
      const onSigint = () => turnAbort?.abort();
      rl.on("SIGINT", onSigint);
      try {
        await ctrl.ask(askPrompt, {
          suppressFinalEcho: true,
          maxSteps: isGoal ? 50 : undefined,
          onApprovalRequest: isGoal ? () => ({ approved: true }) : askApproval,
          verifyCompletion: isGoal ? (ans) => verifyGoalCompletion(ctrl.getPaths().workspaceRoot, ans, turnAbort?.signal) : undefined,
          signal: turnAbort.signal,
        });
      } catch (err) {
        console.error(`\n❌ 本轮运行异常: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        rl.off("SIGINT", onSigint);
        turnAbort = null;
      }
    }
  } finally {
    process.off("SIGHUP", onTerminateSignal);
    process.off("SIGTERM", onTerminateSignal);
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
