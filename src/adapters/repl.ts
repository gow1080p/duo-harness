import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { LlmProvider, ToolCall } from "../core/contracts.js";
import { probeAgyQuota } from "./agy-bridge.js";
import { runLocalBangCommand } from "./context-mention.js";
import { padCols } from "./cost-tracker.js";
import { attachLiveSlashDropdown, getPromptVisualCols, restorePastedNewlines } from "./dropdown.js";
import { buildPlanContextPrompt, handlePlanAndSessionCmd, PLAN_DENY_REASON, PLAN_MODE_CONTEXT_PROMPT, resolveGoalTaskAndContext, savePlanArtifact, verifyGoalCompletion } from "./plan-flow.js";
import { openInDefaultApp, resolveDefaultOpenTarget } from "./platform.js";
import { createReplCompleter, formatRecentHistoryRecap, listManagedProjects, loadProjectMeta, type ManagedProjectSummary, type ProjectSessionPaths, resolveProjectSessionPaths, saveProjectMeta, SLASH_COMMANDS } from "./project-store.js";
import { executeReplReviewCommand } from "./reviewer.js";
import { ensureDefaultModelsConfigFile, listAvailableModelModes, resolveRouteTier } from "./router.js";
import { createSessionController, type SessionController } from "./session-controller.js";
import { discoverAvailableSkills, expandSkillSlashCommand } from "./skill-loader.js";
import { formatApprovalBox } from "./ui-logger.js";
import { executeVisionSlashCommand, getPasteShortcutLabel } from "./vision-capture.js";
import { killTrackedChildren } from "./write-tools.js";

export { buildPlanContextPrompt, createReplCompleter, listManagedProjects, type ManagedProjectSummary, PLAN_MODE_CONTEXT_PROMPT, type ProjectSessionPaths, resolveGoalTaskAndContext, resolveProjectSessionPaths, savePlanArtifact, verifyGoalCompletion };
function wrapOsc133Prompt(label: string): string {
  return process.stdout.isTTY ? `\x1b[?2004h\x1b]133;A\x07${label}\x1b]133;B\x07` : label;
}
function formatPrompt(ctrl: SessionController): string {
  const st = ctrl.getStatus(), short = st.projectName.length > 18 ? `${st.projectName.slice(0, 15)}...` : st.projectName;
  const label = st.isNew ? `📂 ${short} [新对话 · ${st.modelLabel}] > ` : `📂 ${short} [${st.activeTurnIndex ? `续#${st.activeTurnIndex}` : "续聊"} · ${st.modelLabel}] > `;
  return wrapOsc133Prompt(label);
}
function printReplWelcomeBanner(ctrl: SessionController): void {
  const st0 = ctrl.getStatus(), recap = formatRecentHistoryRecap(ctrl.loadEntries(), 1, ctrl.getLeafId()), diff0 = ctrl.getDiff();
  console.log(`\n🚀 Duo-Harness | 当前项目: ${st0.projectName} (${st0.workspaceRoot})\n⚡ 模型路由: ${resolveRouteTier(Date.now()).reason} (同会话自动锁定原模型防缓存失效 · 输入 /model 可手动切换)\n💡 输入 / 用 ↑/↓ 方向键选择命令 | Option(⌥)+左键点击移动光标 | 截图后按 ${getPasteShortcutLabel()} (或敲 @clipboard) 粘贴图片 (/goal 自治 | /resume 选轮次 | /diff 看修改 | /undo 撤回)`);
  if (recap) console.log(recap);
  if (diff0.totalSnapshots > 0) console.log(`📋 [检测到未撤回修改] 当前工作区有 ${diff0.files.length} 个已修改文件 (${diff0.totalSnapshots} 个版本 · 输入 /diff 查看 | /undo 撤回)`);
}

export async function handleSlashCommand(rawCmd: string, ctrl: SessionController): Promise<boolean | string> {
  if (rawCmd === "/" || rawCmd === "/help" || rawCmd === "?") {
    console.log("\n💡 [快捷指令 (输入 / 后可直接用 ↑/↓ 方向键选择并回车执行)]:");
    for (const m of SLASH_COMMANDS) console.log(`  ${padCols(m.label, 14)} - ${m.desc}`);
    return true;
  }
  const exact = !rawCmd.includes(" ") ? SLASH_COMMANDS.find((c) => c.cmd.trim() === rawCmd) : undefined;
  const unique = !rawCmd.includes(" ") ? SLASH_COMMANDS.filter((c) => c.cmd.trim().startsWith(rawCmd)) : [];
  const cmd = exact ? exact.cmd.trim() : unique.length === 1 ? unique[0]!.cmd.trim() : rawCmd;
  if (handlePlanAndSessionCmd(cmd, ctrl)) return true;
  if (cmd.startsWith("/cd ")) {
    const res = ctrl.switchWorkspace(cmd.slice("/cd ".length).trim());
    if (!res.ok) console.log(`⚠️ ${res.error}（输入 / 然后回车即可用 ↑/↓ 方向键选择项目）`);
    else if (res.alreadyInWorkspace) console.log(`💡 当前已经在 [${res.status.projectName}] 工作区中，无需重复切换。`);
    else { console.log(`✅ 已切换到 [${res.status.projectName}] (${res.status.workspaceRoot} · 历史记录 ${res.entryCount} 条)`); if (res.recapText) console.log(res.recapText); }
    return true;
  }
  if (cmd === "/model" || cmd.startsWith("/model ")) {
    const rawArg = cmd.slice("/model".length).trim(), ws = ctrl.getPaths().workspaceRoot, validModes = listAvailableModelModes(ws);
    if (rawArg.toLowerCase() === "config") {
      const cfgFile = ensureDefaultModelsConfigFile(ws), res = openInDefaultApp(cfgFile, ws);
      console.log(res.ok ? `⚙️ 已打开模型配置文件: ${cfgFile} (修改保存后下一轮立即生效)` : `⚙️ 模型配置文件已就绪: ${cfgFile}`);
      return true;
    }
    const matched = validModes.find((m) => m.toLowerCase() === rawArg.toLowerCase());
    console.log(matched ? `🤖 已切换模型策略为 [${matched}] (当前生效: ${ctrl.setModelMode(matched).activeModel})` : `💡 用法: ${validModes.map((m) => `/model ${m}`).join(" | ")} | /model config (当前: ${ctrl.getStatus().modelMode})`);
    return true;
  }
  if (cmd === "/xray" || cmd === "/tree") {
    const [{ costText, xrayText }, agyQuota] = await Promise.all([Promise.resolve(ctrl.getXrayReport()), probeAgyQuota()]);
    if (costText) console.log(costText);
    console.log(`🪐 [反重力订阅额度雷达]: ${agyQuota.summaryLabel}\n${xrayText}`);
    return true;
  }
  if (cmd.startsWith("/branch ") || cmd.startsWith("/resume ") || cmd === "/resume" || cmd === "/history") {
    const rawTarget = cmd === "/history" ? "" : cmd.replace(/^\/(?:branch|resume)\s*/, "").trim();
    if (!rawTarget) { console.log(formatRecentHistoryRecap(ctrl.loadEntries(), 12, ctrl.getLeafId()) || "ℹ️ 当前项目暂无历史对话记录。"); return true; }
    const res = ctrl.resumeTurn(rawTarget);
    console.log(res.ok ? res.recapText : `⚠️ ${res.error}`);
    return true;
  }
  if (cmd === "/diff" || cmd.startsWith("/diff ")) { console.log(ctrl.getDiff(cmd.slice("/diff".length).trim() || "turn").formattedText); return true; }
  if (cmd === "/review" || cmd.startsWith("/review ")) {
    await executeReplReviewCommand(cmd.slice("/review".length).trim(), ctrl.getPaths().workspaceRoot, ctrl.getDiff("all").files.map((f) => f.file));
    return true;
  }
  if (cmd === "/commit" || cmd.startsWith("/commit ")) {
    const note = cmd.slice("/commit".length).trim();
    return `请先调用 run_bash 查看 git status 与 git diff，结合改动生成规范中文提交信息（格式：<类型>(<模块>): <中文概述>${note ? `，备注：${note}` : ""}），执行 git add、git commit 并 git push 推送。`;
  }
  if (cmd === "/open" || cmd.startsWith("/open ")) {
    const ws = ctrl.getPaths().workspaceRoot, res = openInDefaultApp(cmd.slice("/open".length).trim() || resolveDefaultOpenTarget(ws, ctrl.getDiff("all").files.map((f) => f.file)), ws);
    console.log(res.ok ? `🌐 已调用系统默认应用打开: ${res.resolved}` : `⚠️ ${res.error}`);
    return true;
  }
  const visionRes = await executeVisionSlashCommand(cmd, ctrl.getPaths().workspaceRoot, ctrl.getDiff("all").files.map((f) => f.file));
  if (visionRes !== null) return visionRes;
  if (cmd === "/skills" || cmd === "/skill") {
    const skills = discoverAvailableSkills(ctrl.getPaths().workspaceRoot);
    console.log(skills.length > 0 ? `\n🧩 [已发现可用技能 (${skills.length} 个 · 输入 /skill <名称> <任务> 调用)]:\n` + skills.map((s) => `  • ${padCols(s.name, 18)} [${s.scope === "workspace" ? "项目" : "全局"}] ${s.description}`).join("\n") : "ℹ️ 未检测到可用 SKILL.md 技能文件。");
    return true;
  }
  if (cmd === "/undo" || cmd.startsWith("/undo ")) {
    const rb = await ctrl.undo(cmd.slice("/undo".length).trim() || "turn");
    console.log(rb.rolledBackCount > 0 ? `🔄 已撤回 ${rb.rolledBackCount} 处修改 (剩余可撤回 ${rb.remainingVersions} 步 · 可输入 /redo 恢复): ${rb.touchedPaths.join(", ")}` : "ℹ️ 当前没有可撤回的修改。");
    return true;
  }
  if (cmd === "/redo" || cmd.startsWith("/redo ")) {
    const rd = await ctrl.redo(cmd.slice("/redo".length).trim() || "turn");
    console.log(rd.redoneCount > 0 ? `↪️ 已重做恢复 ${rd.redoneCount} 处修改 (当前共 ${rd.totalVersions} 版 · 剩余可重做 ${rd.remainingRedoBatches} 步): ${rd.touchedPaths.join(", ")}` : "ℹ️ 当前没有可重做恢复的修改。");
    return true;
  }
  return false;
}

export type ApprovalInputResolution =
  | { kind: "approve"; autoApprove: boolean; trustDirectory: boolean }
  | { kind: "deny"; reason: string } | { kind: "details" } | { kind: "revise"; reason: string } | { kind: "invalid"; message: string };

export function resolveApprovalInput(rawAns: string, isEsc: boolean, hasExternalDirs: boolean): ApprovalInputResolution {
  const trimmed = rawAns.trim(), lower = trimmed.toLowerCase();
  if (lower === "d" || lower === "diff") return { kind: "details" };
  if (lower === "a" || lower === "all" || lower === "always" || lower === "t" || lower === "trust") return { kind: "approve", autoApprove: true, trustDirectory: isEsc && hasExternalDirs };
  if (lower === "y" || lower === "yes" || lower === "ok" || (!isEsc && lower === "")) return { kind: "approve", autoApprove: false, trustDirectory: false };
  if (lower === "n" || lower === "no" || (isEsc && lower === "")) {
    return { kind: "deny", reason: isEsc ? "用户拒绝了跨目录/系统级提权操作（请停止访问外部路径或执行系统级指令，直接向用户询问或汇报）" : "用户在终端拒绝了该操作（请立即停止尝试其他替代命令或启动服务，直接向用户汇报并等待指示）" };
  }
  const feedback = trimmed.match(/^(?:n|no)[:：\s]+(.+)$/i)?.[1]?.trim() ?? trimmed;
  if (/^[a-zA-Z0-9_/?-]{1,2}$/.test(feedback)) return { kind: "invalid", message: `  💡 未识别的快捷键「${trimmed}」，请输入 y(允许本次) / a(允许并后续免问) / n(拒绝)，或直接输入具体修改意见。` };
  return { kind: "revise", reason: `用户退回了本次修改并要求按以下意见重新调整：「${feedback}」（请立即按用户意见重新调用工具完成修改）` };
}

async function promptUserApproval(
  rl: readline.Interface, toolCalls: ToolCall[], workspaceRoot: string,
  st: { autoApprove: boolean; inMainPrompt: boolean; inApprovalPrompt: boolean; turnAbort: AbortController | null },
  meta?: { hasEscalated?: boolean; escalatedReasons?: string[]; externalDirs?: string[] },
): Promise<{ approved: boolean; reason?: string; trustDirectory?: boolean }> {
  const isEsc = Boolean(meta?.hasEscalated), reasons = meta?.escalatedReasons ?? [], hasExt = (meta?.externalDirs?.length ?? 0) > 0;
  if (!isEsc && st.autoApprove) { console.log(`  ⚡ [本轮免问已自动放行 ${toolCalls.length} 项工作区操作]`); return { approved: true }; }
  st.inMainPrompt = false; st.inApprovalPrompt = true;
  if (typeof (rl as any).line === "string") { (rl as any).line = ""; (rl as any).cursor = 0; }
  const initialBox = formatApprovalBox(toolCalls, workspaceRoot, false, reasons), dHint = initialBox.includes("已折叠") ? " | d=展开全部详情" : "";
  console.log(initialBox);
  try {
    while (true) {
      const aLabel = isEsc ? (hasExt ? "a=允许并信任该目录" : "a=允许并本轮免问") : "a=本轮后续免问";
      const promptStr = wrapOsc133Prompt(isEsc ? `└─ 🚨 是否授权提权执行？[y=仅允许本次${dHint} | ${aLabel} | 回车/n=拒绝] > ` : `└─ 是否允许执行？[回车/y=允许本次${dHint} | ${aLabel} | n=拒绝(或直接输入修改意见)] > `);
      const ans = await rl.question(promptStr, st.turnAbort ? { signal: st.turnAbort.signal } : {});
      if (process.stdout.isTTY) process.stdout.write("\x1b]133;C\x07");
      const res = resolveApprovalInput(restorePastedNewlines(ans), isEsc, hasExt);
      if (res.kind === "details") { console.log(formatApprovalBox(toolCalls, workspaceRoot, true, reasons)); continue; }
      if (res.kind === "invalid") { console.log(res.message); continue; }
      if (res.kind === "approve") { if (res.autoApprove) st.autoApprove = true; return { approved: true, ...(res.trustDirectory ? { trustDirectory: true } : {}) }; }
      return { approved: false, reason: res.reason };
    }
  } catch {
    process.stdout.write("\n"); st.turnAbort?.abort();
    return { approved: false, reason: "用户按 Ctrl+C 中断了本轮操作" };
  } finally { st.inApprovalPrompt = false; }
}

export async function runOneShotCli(rawArgs: string[], pipedText = "", options: { workspaceRoot?: string; homeBaseDir?: string; provider?: LlmProvider } = {}): Promise<void> {
  const autoYes = rawArgs.includes("-y") || rawArgs.includes("--yes"), ctxArg = rawArgs.find((a) => a.startsWith("--context="))?.slice("--context=".length);
  const promptArgs = rawArgs.filter((a) => a !== "-y" && a !== "--yes" && !a.startsWith("--context=")).join(" ").trim(), clip = pipedText.trim().slice(0, 64_000);
  const fullPrompt = clip ? `${promptArgs || "请分析以下标准输入内容："}\n\n<piped_stdin>\n${clip}\n</piped_stdin>` : promptArgs;
  if (!fullPrompt) return;
  const ctrl = createSessionController(options), ws = ctrl.getPaths().workspaceRoot, ac = new AbortController();
  const isPlan = /^\/plan(?:\s|$)/i.test(fullPrompt), isGoal = !isPlan && /^\/g(?:oal)?(?:\s|$)/i.test(fullPrompt);
  if (isPlan && handlePlanAndSessionCmd(fullPrompt, ctrl)) return;
  const goalRes = isGoal ? resolveGoalTaskAndContext(fullPrompt.replace(/^\/g(?:oal)?\b/i, "").trim(), ctrl) : null;
  const rawTask = isPlan ? fullPrompt.replace(/^\/plan\b/i, "").trim() : (goalRes ? goalRes.task : fullPrompt);
  const extraCtx = isPlan ? buildPlanContextPrompt(ws) : goalRes?.contextPrompt;
  const mergedCtx = [ctxArg, extraCtx].filter(Boolean).join("\n\n") || undefined;
  const onSigint = () => { ac.abort(); killTrackedChildren(); };
  for (const sig of ["SIGINT", "SIGHUP", "SIGTERM"] as const) process.once(sig, onSigint);
  try {
    const res = await ctrl.ask(expandSkillSlashCommand(rawTask, ws), {
      suppressFinalEcho: true, maxSteps: isGoal ? 50 : undefined, signal: ac.signal, contextPrompt: mergedCtx,
      onApprovalRequest: (_calls, meta) => {
        if (isPlan) {
          const extDeny = `禁止读取工作区 (${ws}) 以外的外部路径 (${meta?.externalDirs.join(", ")})，请仅基于当前工作区内已有文件完成规划，切勿再读取外部目录。`;
          return { approved: false, reason: meta?.hasWrite === false && meta?.hasEscalated ? extDeny : PLAN_DENY_REASON };
        }
        if ((autoYes || isGoal) && !meta?.hasEscalated) return { approved: true };
        console.warn(`  ⚠️ [单次模式已拦截写/提权操作] 如需允许工作区修改，请附加 -y 参数运行（例: duo -y "你的指令"）`);
        return { approved: false, reason: "非交互单次模式未传 -y 参数，默认拒绝写操作（请直接输出分析结论或代码方案）" };
      },
      verifyCompletion: isPlan ? undefined : (ans) => (isGoal || ctrl.getDiff("turn").files.some((f) => /\.[cm]?tsx?$/i.test(f.file)) ? verifyGoalCompletion(ws, ans, ac.signal, isGoal) : { ok: true, skipped: true } as any),
    });
    if (isPlan) savePlanArtifact(ctrl, res.finalAnswer, res.leafId);
  } finally {
    for (const sig of ["SIGINT", "SIGHUP", "SIGTERM"] as const) process.off(sig, onSigint);
    killTrackedChildren();
  }
}

export async function startInteractiveRepl(options: { workspaceRoot?: string; homeBaseDir?: string; provider?: LlmProvider } = {}): Promise<void> {
  const ctrl = createSessionController(options), replState = { autoApprove: false, inMainPrompt: false, inApprovalPrompt: false, turnAbort: null as AbortController | null, steerQueue: [] as string[] };
  let terminated = false;
  printReplWelcomeBanner(ctrl);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, history: [...(loadProjectMeta(ctrl.getPaths().metaFile).inputHistory ?? [])], historySize: 80, completer: createReplCompleter(() => ctrl.getPaths().workspaceRoot, () => ctrl.getPaths().sessionFile) });
  const detachDropdown = attachLiveSlashDropdown(rl, () => replState.inMainPrompt, () => getPromptVisualCols(formatPrompt(ctrl)), () => ctrl.getPaths().workspaceRoot, options.homeBaseDir, () => ctrl.getLeafId(), {
    isApprovalActive: () => replState.inApprovalPrompt, onAbortRun: () => replState.turnAbort?.abort(),
    onSteerLine: (text) => { replState.steerQueue.push(text); console.log(`\n  💬 [已加入插话队列] 当前工具执行完毕后立即注入：「${text.slice(0, 60)}」`); },
  });
  const onTerminateSignal = () => { terminated = true; replState.turnAbort?.abort(); killTrackedChildren(); rl.close(); };
  process.on("SIGHUP", onTerminateSignal); process.on("SIGTERM", onTerminateSignal);
  try {
    while (!terminated) {
      replState.inMainPrompt = true;
      let line = "";
      try { process.stdout.write("\n"); line = restorePastedNewlines(await rl.question(formatPrompt(ctrl))).trim(); if (process.stdout.isTTY) process.stdout.write("\x1b]133;C\x07"); } catch (err) {
        if (terminated || (err instanceof Error && (err.name === "AbortError" || err.message.includes("Ctrl+C") || (err as any).code === "ERR_USE_AFTER_CLOSE"))) {
          if (!terminated) process.stdout.write("\r\n\x1b[J👋 已退出 Duo-Harness。\n");
          break;
        }
        throw err;
      }
      replState.inMainPrompt = false;
      if (terminated || !line) continue;
      if (line === "exit" || line === "quit" || line === "/exit" || line === "/quit" || line === "/e") { process.stdout.write("👋 已退出 Duo-Harness。\n"); break; }
      saveProjectMeta(ctrl.getPaths().metaFile, { inputHistory: (((rl as any).history as string[]) ?? []).slice(0, 60) });
      if (line.startsWith("!")) { await runLocalBangCommand(line, ctrl.getPaths().workspaceRoot, rl); continue; }
      const slashRes = await handleSlashCommand(line, ctrl);
      if (slashRes === true) continue;
      if (typeof slashRes === "string") line = slashRes;
      const isPlan = /^\/plan(?:\s|$)/i.test(line), isGoal = !isPlan && /^\/g(?:oal)?(?:\s|$)/i.test(line);
      const goalRes = isGoal ? resolveGoalTaskAndContext(line.replace(/^\/g(?:oal)?\b/i, "").trim(), ctrl) : null;
      const rawTask = isPlan ? line.replace(/^\/plan\b/i, "").trim() : (goalRes ? goalRes.task : line);
      const turnCtx = isPlan ? buildPlanContextPrompt(ctrl.getPaths().workspaceRoot) : goalRes?.contextPrompt;
      if (isPlan) console.log("🗺️ [已开启 /plan 只读规划模式] 仅允许只读探路 · 写操作自动物理拦截 · 完成后落盘 .debug/plan.md");
      if (isGoal) console.log("🎯 [已开启 /goal 长程自治模式] 本轮自动放行工作区写与构建操作 · 步数上限 50 步 · 完成前自动校验编译状态");
      replState.autoApprove = false; replState.steerQueue = []; replState.turnAbort = new AbortController();
      const onSigint = () => replState.turnAbort?.abort();
      rl.on("SIGINT", onSigint);
      try {
        const ws = ctrl.getPaths().workspaceRoot;
        const res = await ctrl.ask(expandSkillSlashCommand(rawTask, ws), {
          suppressFinalEcho: true, maxSteps: isGoal ? 50 : undefined, signal: replState.turnAbort.signal, contextPrompt: turnCtx,
          drainSteerMessages: () => replState.steerQueue.splice(0, replState.steerQueue.length),
          onApprovalRequest: (calls, meta) => {
            if (isPlan) return meta?.hasWrite === false && meta?.hasEscalated ? promptUserApproval(rl, calls, ws, replState, meta) : { approved: false, reason: PLAN_DENY_REASON };
            return isGoal && !meta?.hasEscalated ? { approved: true } : promptUserApproval(rl, calls, ws, replState, meta);
          },
          verifyCompletion: isPlan ? undefined : (ans) => (isGoal || ctrl.getDiff("turn").files.some((f) => /\.[cm]?tsx?$/i.test(f.file)) ? verifyGoalCompletion(ws, ans, replState.turnAbort?.signal, isGoal) : { ok: true, skipped: true } as any),
        });
        if (isPlan) savePlanArtifact(ctrl, res.finalAnswer, res.leafId);
      } catch (err) { console.error(`\n❌ 本轮运行异常: ${err instanceof Error ? err.message : String(err)}`); } finally { rl.off("SIGINT", onSigint); replState.turnAbort = null; replState.steerQueue = []; }
    }
  } finally { process.off("SIGHUP", onTerminateSignal); process.off("SIGTERM", onTerminateSignal); killTrackedChildren(); detachDropdown(); rl.close(); }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2), isDirArg = args.length === 1 && !args[0]!.startsWith("-") && fs.existsSync(args[0]!) && fs.statSync(args[0]!).isDirectory();
  (async () => {
    if (process.stdin.isTTY && (args.length === 0 || isDirArg)) return startInteractiveRepl({ workspaceRoot: isDirArg ? args[0] : undefined });
    let piped = "";
    if (!process.stdin.isTTY) { for await (const chunk of process.stdin) piped += chunk.toString("utf-8"); }
    await runOneShotCli(args, piped);
  })().catch((err) => { console.error("终端运行异常:", err instanceof Error ? err.message : err); process.exit(1); });
}
