import { fileURLToPath } from "node:url";
import { compactMessages, type CompactorOptions } from "../core/compactor.js";
import type { ImageAttachment, LlmProvider, LlmStreamEvent, LoopStepResult, SessionEntry, ToolCall, ToolContract, ToolResultMessage } from "../core/contracts.js";
import { createInitialState, stepAgentLoop } from "../core/loop.js";
import { assertSessionInvariant, buildSessionEntries, projectToMessages, repairDanglingToolCalls } from "../core/session-tree.js";
import { stripAttachedFiles } from "./context-mention.js";
import { loadAndFormatWireCost } from "./cost-tracker.js";
import { createRouterProvider, type ModelMode, resolveRouteTier } from "./router.js";
import { createSandboxGrants, evaluateBatchCallsRisk, grantApprovedCalls, type SandboxGrants } from "./sandbox-policy.js";
import { appendJsonlEntries, createReplayProvider, loadJsonlEntries, withSessionLock } from "./store.js";
import { type AdapterToolContract, type AdapterToolResultMessage, createBuiltinTools, executeToolCalls } from "./tools.js";
import { buildDefaultSystemPrompt, formatCompactTurnFooter, formatStepToolCalls, formatToolResultLine, isReadonlyBashCommand } from "./ui-logger.js";
import { createWriteTools, type FileVersionSnapshot, rollbackFileSnapshots } from "./write-tools.js";

export { buildDefaultSystemPrompt, isReadonlyBashCommand };
export interface ApprovalRequestMeta { hasEscalated: boolean; hasWrite?: boolean; escalatedReasons: string[]; externalDirs: string[]; }
export interface AfterToolCallDecision { terminate?: boolean; finalAnswer?: string; details?: unknown; }
export interface ApprovalDecision { approved: boolean; reason?: string; trustDirectory?: boolean; updatedCalls?: ToolCall[]; }
export interface RunSessionOptions {
  provider?: LlmProvider; model?: ModelMode; modelsConfigPath?: string;
  tools?: (ToolContract<any> | AdapterToolContract<any>)[]; extraTools?: (ToolContract<any> | AdapterToolContract<any>)[];
  includeBuiltinTools?: boolean; enableWriteTools?: boolean; quiet?: boolean; signal?: AbortSignal;
  workspaceRoot?: string; snapshots?: FileVersionSnapshot[]; redoBatches?: FileVersionSnapshot[][]; sandboxGrants?: SandboxGrants; compactor?: CompactorOptions;
  maxSteps?: number; systemPrompt?: string; contextPrompt?: string; sessionFile?: string; replayFromFile?: string; wireLogFile?: string;
  showCostReport?: boolean; suppressFinalEcho?: boolean; leafId?: string; userImages?: ImageAttachment[];
  onApprovalRequest?: (toolCalls: ToolCall[], meta?: ApprovalRequestMeta) => Promise<ApprovalDecision> | ApprovalDecision;
  onAfterToolCall?: (call: ToolCall, result: AdapterToolResultMessage) => Promise<AfterToolCallDecision | void> | AfterToolCallDecision | void;
  verifyCompletion?: (finalAnswer: string) => Promise<{ ok: boolean; errorOutput?: string }> | { ok: boolean; errorOutput?: string };
  onStepEvent?: (event: { phase: string; step: number; detail?: string; toolCalls?: ToolCall[]; toolResults?: AdapterToolResultMessage[] }) => void;
  onStreamEvent?: (event: LlmStreamEvent) => void; onSnapshotChange?: () => void; drainSteerMessages?: () => string[];
}

interface SessionCursor { persistedCount: number; leafId: string | null; lastErrSig?: string; errStreak?: number; toolDetails: Record<string, unknown>; }

function syncNewMessagesToDisk(sessionFile: string | undefined, recordedEntries: SessionEntry[], allMessages: readonly any[], cursor: SessionCursor, isFirstWrite: boolean): void {
  const unsavedMessages = allMessages.slice(cursor.persistedCount);
  if (unsavedMessages.length === 0) return;
  const newEntries = buildSessionEntries(recordedEntries, unsavedMessages, Date.now(), cursor.leafId);
  recordedEntries.push(...newEntries); cursor.persistedCount = allMessages.length; cursor.leafId = newEntries[newEntries.length - 1]!.id;
  if (sessionFile) appendJsonlEntries(sessionFile, newEntries, isFirstWrite);
}
function printCostIfEnabled(options: RunSessionOptions, wireLogFile: string, isReplay: boolean): void {
  if (!options.showCostReport || options.quiet) return;
  const report = loadAndFormatWireCost(wireLogFile, { isReplay });
  if (report) console.log(report);
}

async function executeToolBatchStep(
  state: LoopStepResult["state"], toolCalls: ToolCall[], cursor: SessionCursor,
  tools: ToolContract<any>[], options: RunSessionOptions, grants: SandboxGrants, log: (...args: any[]) => void,
): Promise<LoopStepResult> {
  try {
    const rawResults = await executeToolCalls(toolCalls, tools);
    let hookFinalAnswer: string | undefined;
    for (let i = 0; i < rawResults.length; i++) {
      const r = rawResults[i]!, call = toolCalls[i]!;
      if (r.isError) {
        const sig = `${r.name}:${r.content.slice(0, 48)}`;
        cursor.errStreak = cursor.lastErrSig === sig ? (cursor.errStreak ?? 1) + 1 : 1; cursor.lastErrSig = sig;
        if (r.content.includes("[沙箱安全拦截]")) log(`  🛡️ ${r.content.replace(/^执行异常：/, "")}`);
        if (cursor.errStreak >= 2) r.content += `\n[系统防卡死提示：该操作已连续 ${cursor.errStreak} 次出现相同报错，严禁使用相同参数重复尝试，请先核实状态或直接向用户询问]`;
      } else { cursor.lastErrSig = undefined; cursor.errStreak = 0; }
      log(formatToolResultLine(r));
      const hookRes = options.onAfterToolCall ? await options.onAfterToolCall(call, r) : undefined;
      if (hookRes?.details !== undefined) r.details = hookRes.details;
      if (hookRes?.terminate !== undefined) r.terminate = hookRes.terminate;
      if (hookRes?.finalAnswer !== undefined) hookFinalAnswer = hookRes.finalAnswer;
      if (r.details !== undefined) cursor.toolDetails[r.toolCallId] = r.details;
    }
    options.onStepEvent?.({ phase: "executing", step: state.step, detail: "tool_results", toolResults: rawResults });
    const cleanResults: ToolResultMessage[] = rawResults.map(({ details: _d, terminate: _t, ...rest }) => rest);
    const lastMsg = state.messages[state.messages.length - 1], rLen = lastMsg?.role === "assistant" ? (lastMsg.reasoningContent?.length ?? 0) : 0;
    if (rLen > 2_500 && cleanResults.length > 0 && !rawResults.some((r) => r.terminate)) {
      cleanResults[cleanResults.length - 1]!.content += `\n[系统提示：检测到上一步 thinking 思考过程长达 ${rLen} 字符，后续步骤请将思考控制在 150 字以内，严禁在 thinking 中预先默写完整代码草稿，请直接调用工具落盘]`;
    }
    const next = stepAgentLoop(state, { type: "TOOLS_FINISHED", results: cleanResults });
    if (rawResults.some((r) => !r.isError && r.terminate)) {
      const fallbackText = lastMsg?.role === "assistant" && lastMsg.content.trim() ? lastMsg.content : cleanResults.map((r) => r.content).join("\n");
      return { state: { ...next.state, phase: "done" }, effect: { type: "COMPLETE", finalAnswer: hookFinalAnswer ?? fallbackText } };
    }
    const steers = options.drainSteerMessages?.() ?? [];
    if (steers.length > 0 && next.effect.type === "REQUEST_LLM") {
      log(`  💬 [实时插话已生效] 已向模型注入 ${steers.length} 条补充指令`);
      return { state: { ...next.state, messages: [...next.state.messages, ...steers.map((s) => ({ role: "user" as const, content: `[用户运行中补充指令] ${s}` }))] }, effect: next.effect };
    }
    return next;
  } finally { grants.onceAllowedPaths.clear(); }
}

async function runSingleEffectStep(
  current: LoopStepResult, recordedEntries: SessionEntry[], cursor: SessionCursor, provider: LlmProvider,
  tools: ToolContract<any>[], readonlyMap: Map<string, boolean>, options: RunSessionOptions, grants: SandboxGrants,
): Promise<LoopStepResult> {
  const { state, effect } = current, wsRoot = options.workspaceRoot ?? process.cwd(), log = (...args: any[]) => { if (!options.quiet) console.log(...args); };
  if (effect.type === "REQUEST_LLM") {
    const messagesToSend = compactMessages(repairDanglingToolCalls(projectToMessages(recordedEntries, cursor.leafId ?? undefined)), options.compactor);
    if (state.step >= state.maxSteps - 1 && messagesToSend.length > 0) {
      const last = messagesToSend[messagesToSend.length - 1]!;
      messagesToSend[messagesToSend.length - 1] = { ...last, content: `${last.content}\n[系统提示：当前已执行 ${state.step}/${state.maxSteps} 步，请勿再发起只读探索，请立即完成修改或直接输出总结回答。]` };
    }
    assertSessionInvariant(messagesToSend);
    let reply;
    try { reply = await provider.chat(messagesToSend, tools, { signal: options.signal, onStreamEvent: options.onStreamEvent ?? (options.quiet ? () => {} : undefined), workspaceRoot: wsRoot }); }
    catch (err) { if (options.signal?.aborted) return { state: { ...state, phase: "error", error: "收到外部取消信号 (AbortSignal)" }, effect: { type: "ABORT", reason: "收到外部取消信号 (AbortSignal)" } }; throw err; }
    const calls = reply.toolCalls ?? [], risk = evaluateBatchCallsRisk(calls, wsRoot, readonlyMap, grants);
    const requiresApproval = risk.hasDenied || risk.hasEscalated || (risk.callsNeedingApproval.length > 0 && Boolean(options.onApprovalRequest));
    const next = stepAgentLoop(state, { type: "LLM_REPLIED", message: reply, requiresApproval });
    if (calls.length > 0 && next.effect.type !== "ABORT") { log(formatStepToolCalls(state.step + 1, calls, readonlyMap, wsRoot)); options.onStepEvent?.({ phase: next.state.phase, step: state.step + 1, detail: "tool_calls", toolCalls: calls }); }
    return next;
  }
  if (effect.type === "AWAIT_APPROVAL") {
    const risk = evaluateBatchCallsRisk(effect.toolCalls, wsRoot, readonlyMap, grants);
    if (risk.hasDenied) {
      const denyText = `[沙箱安全拦截] ${risk.deniedReasons.join("；")}。若缺少外部配置或 API Key，请立即停止探测并直接向用户询问。`;
      log(`  🛡️ ${denyText}`);
      return stepAgentLoop(state, { type: "APPROVAL_RESOLVED", approved: false, reason: denyText });
    }
    const targetCalls = risk.callsNeedingApproval.length > 0 ? risk.callsNeedingApproval : effect.toolCalls;
    const decision: ApprovalDecision = options.onApprovalRequest
      ? await options.onApprovalRequest(targetCalls, { hasEscalated: risk.hasEscalated, hasWrite: risk.hasWrite, escalatedReasons: risk.escalatedReasons, externalDirs: risk.externalDirs })
      : { approved: false, reason: "未配置审批回调，默认拒绝写或跨界操作" };
    let effectiveCalls = effect.toolCalls;
    if (decision.approved && decision.updatedCalls?.length) {
      const patchById = new Map(decision.updatedCalls.map((c) => [c.id, c]));
      effectiveCalls = effect.toolCalls.map((c) => patchById.get(c.id) ?? c);
      const recheck = evaluateBatchCallsRisk(effectiveCalls, wsRoot, readonlyMap, grants);
      if (recheck.hasDenied) return stepAgentLoop(state, { type: "APPROVAL_RESOLVED", approved: false, reason: `[沙箱安全拦截] 审批改参触发安全红线: ${recheck.deniedReasons.join("；")}` });
    }
    const trustedDirs = decision.approved ? grantApprovedCalls(effectiveCalls, wsRoot, readonlyMap, grants, Boolean(decision.trustDirectory)) : [];
    log(decision.approved ? (trustedDirs.length > 0 ? `  🟢 已授权并信任外部目录: ${trustedDirs.join(", ")}` : `  🟢 已确认允许执行`) : `  🔴 已拒绝执行: ${decision.reason}`);
    let resolved = stepAgentLoop(state, { type: "APPROVAL_RESOLVED", approved: decision.approved, reason: decision.reason });
    if (decision.approved && effectiveCalls !== effect.toolCalls && resolved.effect.type === "EXECUTE_TOOLS") {
      const msgs = [...resolved.state.messages], lastIdx = msgs.length - 1, last = msgs[lastIdx];
      if (last?.role === "assistant") msgs[lastIdx] = { ...last, toolCalls: effectiveCalls };
      resolved = { state: { ...resolved.state, messages: msgs }, effect: { ...resolved.effect, toolCalls: effectiveCalls } };
    }
    if (options.signal?.aborted) {
      const abortReason = decision.reason ?? "用户按 Ctrl+C 中断了本轮操作";
      return { state: { ...resolved.state, phase: "error", error: abortReason }, effect: { type: "ABORT", reason: abortReason } };
    }
    return resolved;
  }
  return effect.type === "EXECUTE_TOOLS" ? executeToolBatchStep(state, effect.toolCalls, cursor, tools, options, grants, log) : current;
}

function initSessionContext(userPrompt: string, workspaceRoot: string, options: RunSessionOptions) {
  let existingEntries: SessionEntry[] = [];
  if (options.leafId && options.sessionFile) { try { existingEntries = loadJsonlEntries(options.sessionFile); } catch {} }
  const resolvedLeafId = options.leafId === "latest" ? existingEntries.at(-1)?.id : options.leafId;
  const rawPrior = existingEntries.length > 0 && resolvedLeafId ? projectToMessages(existingEntries, resolvedLeafId) : [];
  const systemPrompt = options.systemPrompt ?? (rawPrior.length > 1 && rawPrior[0]?.role === "system" ? rawPrior[0].content : undefined) ?? buildDefaultSystemPrompt(workspaceRoot);
  if ((rawPrior.length === 1 || Boolean(options.systemPrompt)) && rawPrior[0]?.role === "system" && rawPrior[0].content !== systemPrompt && existingEntries[0]?.message.role === "system") {
    rawPrior[0] = { role: "system", content: systemPrompt }; existingEntries[0] = { ...existingEntries[0], message: rawPrior[0] };
    if (options.sessionFile) appendJsonlEntries(options.sessionFile, existingEntries, true);
  }
  const baseState = createInitialState({ systemPrompt, maxSteps: options.maxSteps ?? 20 }), byId = new Map(existingEntries.map((e) => [e.id, e]));
  let trace = resolvedLeafId ? byId.get(resolvedLeafId) : undefined;
  while (trace?.parentId && byId.has(trace.parentId)) trace = byId.get(trace.parentId);
  const hasBrokenChain = existingEntries.length > 0 && (!existingEntries[0] || existingEntries[0].parentId !== null || existingEntries[0].message.role !== "system" || (Boolean(resolvedLeafId) && (!trace || trace.parentId !== null)));
  const priorMessages = repairDanglingToolCalls(rawPrior.length > 0 && rawPrior[0]?.role === "system" ? rawPrior : (rawPrior.length > 0 ? [{ role: "system", content: systemPrompt }, ...rawPrior] : baseState.messages));
  while (priorMessages.length > 0 && priorMessages[priorMessages.length - 1]!.role === "user") priorMessages.pop();
  const wasHealed = hasBrokenChain || (rawPrior.length > 0 && existingEntries.length > 0 && (priorMessages.length !== rawPrior.length || priorMessages.some((m, i) => m !== rawPrior[i])));
  const recordedEntries: SessionEntry[] = wasHealed ? (!hasBrokenChain && existingEntries.length > rawPrior.length ? [...existingEntries, ...buildSessionEntries(existingEntries, priorMessages.slice(1), Date.now(), existingEntries[0]!.id)] : buildSessionEntries([], priorMessages, Date.now(), null)) : existingEntries;
  if (wasHealed && options.sessionFile) appendJsonlEntries(options.sessionFile, recordedEntries, true);
  const cursor: SessionCursor = { persistedCount: existingEntries.length > 0 && resolvedLeafId ? priorMessages.length : 0, leafId: wasHealed ? (recordedEntries[recordedEntries.length - 1]?.id ?? null) : (resolvedLeafId ?? null), toolDetails: {} };
  const fullPrompt = options.contextPrompt?.trim() ? `${userPrompt}\n<context_state>\n[当前外部上下文状态（仅最后一条用户消息代表当前最新状态）]\n${options.contextPrompt.trim()}\n</context_state>` : userPrompt;
  const stepRes = stepAgentLoop({ ...baseState, messages: priorMessages }, { type: "START", userPrompt: fullPrompt, images: options.userImages });
  syncNewMessagesToDisk(options.sessionFile, recordedEntries, stepRes.state.messages, cursor, existingEntries.length === 0 && !wasHealed);
  return { stepRes, recordedEntries, cursor };
}

async function runAgentSessionUnlocked(
  userPrompt: string, options: RunSessionOptions = {},
): Promise<{ finalAnswer: string; stepsUsed: number; entries: SessionEntry[]; leafId: string | null; toolDetails?: Record<string, unknown> }> {
  const isReplay = Boolean(options.replayFromFile), turnStartMs = Date.now(), workspaceRoot = options.workspaceRoot ?? process.cwd();
  const snapshots = options.snapshots ?? [], grants = options.sandboxGrants ?? createSandboxGrants(), snapStartIdx = snapshots.length, wireLogFile = options.wireLogFile ?? ".sessions/http-wire.json";
  const provider = isReplay ? createReplayProvider(loadJsonlEntries(options.replayFromFile!)) : (options.provider ?? createRouterProvider(wireLogFile, false, options.model ? () => options.model! : undefined, options.modelsConfigPath));
  const builtinCtx = { provider, model: options.model, modelsConfigPath: options.modelsConfigPath, wireLogFile, signal: options.signal };
  const builtins = options.includeBuiltinTools === false ? [] : [...createBuiltinTools(workspaceRoot, grants, builtinCtx), ...(options.enableWriteTools ? createWriteTools(workspaceRoot, snapshots, options.signal, options.onSnapshotChange, grants) : [])];
  const mergedMap = new Map<string, ToolContract<any>>();
  for (const t of [...builtins, ...(options.extraTools ?? [])]) mergedMap.set(t.name, t as ToolContract<any>);
  const tools = (options.tools as ToolContract<any>[] | undefined) ?? [...mergedMap.values()], readonlyMap = new Map(tools.map((t) => [t.name, t.readonly]));
  if (!options.suppressFinalEcho && !options.quiet) console.log(`\n⚡ [路由决策] ${resolveRouteTier(Date.now(), { isReplay }).reason}\n👤 [用户提问] ${stripAttachedFiles(userPrompt)}\n`);
  let { stepRes, recordedEntries, cursor } = initSessionContext(userPrompt, workspaceRoot, options);
  while (true) {
    if (options.signal?.aborted && stepRes.effect.type !== "ABORT") stepRes = { state: { ...stepRes.state, phase: "error", error: "收到外部取消信号 (AbortSignal)" }, effect: { type: "ABORT", reason: "收到外部取消信号 (AbortSignal)" } };
    if (stepRes.effect.type === "ABORT") {
      syncNewMessagesToDisk(options.sessionFile, recordedEntries, repairDanglingToolCalls(stepRes.state.messages), cursor, false);
      const turnSnapCount = snapshots.length - snapStartIdx;
      if (turnSnapCount > 0 && !options.signal?.aborted) {
        const rb = await rollbackFileSnapshots(workspaceRoot, snapshots, turnSnapCount, options.onSnapshotChange, options.redoBatches);
        if (!options.quiet) console.warn(`🔄 [任务熔断自动回滚] 已自动还原 ${rb.rolledBackCount} 个版本修改 (${rb.touchedPaths.join(", ")}) · 可输入 /redo 恢复`);
      } else if (turnSnapCount > 0 && !options.quiet) {
        console.warn(`⚠️ [已中断] 本轮中断前已修改 ${turnSnapCount} 处文件（输入 /diff 查看，或输入 /undo 一键撤回）`);
        if (options.suppressFinalEcho) console.log(formatCompactTurnFooter(wireLogFile, stepRes.state.step, isReplay, snapshots.slice(snapStartIdx), workspaceRoot, Date.now() - turnStartMs));
      }
      printCostIfEnabled(options, wireLogFile, isReplay);
      if (!options.quiet) console.error(`\n❌ [循环熔断终止] ${stepRes.effect.reason}`);
      return { finalAnswer: `[ABORT] ${stepRes.effect.reason}`, stepsUsed: stepRes.state.step, entries: recordedEntries, leafId: cursor.leafId, toolDetails: cursor.toolDetails };
    }
    if (stepRes.effect.type === "COMPLETE") {
      const steers = stepRes.state.step < stepRes.state.maxSteps ? (options.drainSteerMessages?.() ?? []) : [];
      if (steers.length > 0) {
        if (!options.quiet) console.log(`  💬 [实时插话已生效] 已向模型注入 ${steers.length} 条补充指令`);
        const nextMsgs = [...stepRes.state.messages, ...steers.map((s) => ({ role: "user" as const, content: `[用户运行中补充指令] ${s}` }))];
        stepRes = { state: { ...stepRes.state, phase: "thinking", step: stepRes.state.step + 1, messages: nextMsgs }, effect: { type: "REQUEST_LLM", messages: nextMsgs } };
        syncNewMessagesToDisk(options.sessionFile, recordedEntries, stepRes.state.messages, cursor, false); continue;
      }
      if (options.verifyCompletion) {
        const check = await options.verifyCompletion(stepRes.effect.finalAnswer);
        if (!check.ok) {
          if (!options.quiet) console.log(`🔄 [自动验证未通过，打回重修]: ${check.errorOutput}`);
          stepRes = stepAgentLoop(stepRes.state, { type: "REJECT_COMPLETION", reason: check.errorOutput ?? "验证未通过" });
          syncNewMessagesToDisk(options.sessionFile, recordedEntries, stepRes.state.messages, cursor, false); continue;
        }
        if (!(check as { skipped?: boolean }).skipped && !options.quiet) console.log(`✅ [完成前自动验证通过]`);
      }
      options.onStepEvent?.({ phase: "done", step: stepRes.state.step, detail: stepRes.effect.finalAnswer }); break;
    }
    options.onStepEvent?.({ phase: stepRes.state.phase, step: stepRes.state.step, detail: stepRes.effect.type });
    stepRes = await runSingleEffectStep(stepRes, recordedEntries, cursor, provider, tools, readonlyMap, { ...options, workspaceRoot }, grants);
    if (stepRes.state.phase !== "awaiting_approval" && stepRes.state.phase !== "executing") syncNewMessagesToDisk(options.sessionFile, recordedEntries, stepRes.state.messages, cursor, false);
  }
  if (!options.quiet) {
    if (!options.suppressFinalEcho) {
      if (options.sessionFile) console.log(`💾 [已保存会话记录] ${options.sessionFile} (共 ${recordedEntries.length} 行 JSON)`);
      printCostIfEnabled(options, wireLogFile, isReplay);
      console.log(`\n✅ [最终回答 (共执行 ${stepRes.state.step} 步)]:\n${stepRes.effect.finalAnswer}`);
    } else console.log(formatCompactTurnFooter(wireLogFile, stepRes.state.step, isReplay, snapshots.slice(snapStartIdx), workspaceRoot, Date.now() - turnStartMs));
  }
  return { finalAnswer: stepRes.effect.finalAnswer, stepsUsed: stepRes.state.step, entries: recordedEntries, leafId: cursor.leafId, toolDetails: cursor.toolDetails };
}

export async function runAgentSession(
  userPrompt: string, options: RunSessionOptions = {},
): Promise<{ finalAnswer: string; stepsUsed: number; entries: SessionEntry[]; leafId: string | null; toolDetails?: Record<string, unknown> }> {
  return options.sessionFile && !options.replayFromFile ? withSessionLock(options.sessionFile, () => runAgentSessionUnlocked(userPrompt, options), options.signal) : runAgentSessionUnlocked(userPrompt, options);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rawArgs = process.argv.slice(2), useLatest = rawArgs.includes("--continue") || rawArgs.includes("-c");
  const ctxArg = rawArgs.find((a) => a.startsWith("--context="))?.slice("--context=".length);
  const prompt = rawArgs.filter((a) => a !== "--continue" && a !== "-c" && !a.startsWith("--context=")).join(" ").trim() || "请先用 list_dir 查看当前目录有哪些文件，再读取 package.json 告诉我这个项目的名称和 dependencies。";
  runAgentSession(prompt, { sessionFile: ".sessions/ask-latest.jsonl", leafId: useLatest ? "latest" : undefined, contextPrompt: ctxArg, enableWriteTools: true, showCostReport: true }).catch((err) => { console.error("运行出错:", err instanceof Error ? err.message : err); process.exit(1); });
}
