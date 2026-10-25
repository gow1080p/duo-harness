import { fileURLToPath } from "node:url";
import { compactMessages, type CompactorOptions } from "../core/compactor.js";
import type { ImageAttachment, LlmProvider, LlmStreamEvent, LoopStepResult, SessionEntry, ToolCall, ToolContract } from "../core/contracts.js";
import { createInitialState, stepAgentLoop } from "../core/loop.js";
import { assertSessionInvariant, buildSessionEntries, projectToMessages, repairDanglingToolCalls } from "../core/session-tree.js";
import { createRouterProvider, resolveRouteTier } from "./router.js";
import { loadAndFormatWireCost } from "./cost-tracker.js";
import { appendJsonlEntries, createReplayProvider, loadJsonlEntries } from "./store.js";
import { createBuiltinTools, executeToolCalls } from "./tools.js";
import { createWriteTools, type FileVersionSnapshot, rollbackFileSnapshots } from "./write-tools.js";
import { createSandboxGrants, evaluateBatchCallsRisk, grantApprovedCalls, type SandboxGrants } from "./sandbox-policy.js";
import { buildDefaultSystemPrompt, formatCompactTurnFooter, formatStepToolCalls, formatToolResultLine, isReadonlyBashCommand } from "./ui-logger.js";
import { stripAttachedFiles } from "./context-mention.js";
import { syncXrayCacheSnapshot } from "./xray.js";

export { buildDefaultSystemPrompt, isReadonlyBashCommand };

export interface ApprovalRequestMeta {
  hasEscalated: boolean; escalatedReasons: string[]; externalDirs: string[];
}

export interface RunSessionOptions {
  provider?: LlmProvider; tools?: ToolContract<any>[]; enableWriteTools?: boolean; signal?: AbortSignal;
  workspaceRoot?: string; snapshots?: FileVersionSnapshot[]; sandboxGrants?: SandboxGrants; compactor?: CompactorOptions;
  maxSteps?: number; systemPrompt?: string; sessionFile?: string; replayFromFile?: string; wireLogFile?: string;
  showCostReport?: boolean; suppressFinalEcho?: boolean; leafId?: string; userImages?: ImageAttachment[];
  onApprovalRequest?: (toolCalls: ToolCall[], meta?: ApprovalRequestMeta) => Promise<{ approved: boolean; reason?: string; trustDirectory?: boolean }> | { approved: boolean; reason?: string; trustDirectory?: boolean };
  verifyCompletion?: (finalAnswer: string) => Promise<{ ok: boolean; errorOutput?: string }> | { ok: boolean; errorOutput?: string };
  onStepEvent?: (event: { phase: string; step: number; detail?: string; toolCalls?: ToolCall[]; toolResults?: { toolCallId: string; name: string; content: string; isError?: boolean }[] }) => void;
  onStreamEvent?: (event: LlmStreamEvent) => void;
  onSnapshotChange?: () => void;
}

interface SessionCursor {
  persistedCount: number; leafId: string | null;
}

function syncNewMessagesToDisk(sessionFile: string | undefined, recordedEntries: SessionEntry[], allMessages: readonly any[], cursor: SessionCursor, isFirstWrite: boolean, wireLogFile?: string): void {
  const unsavedMessages = allMessages.slice(cursor.persistedCount);
  if (unsavedMessages.length === 0) return;
  const newEntries = buildSessionEntries(recordedEntries, unsavedMessages, Date.now(), cursor.leafId);
  recordedEntries.push(...newEntries);
  cursor.persistedCount = allMessages.length;
  cursor.leafId = newEntries[newEntries.length - 1]!.id;
  if (sessionFile) {
    appendJsonlEntries(sessionFile, newEntries, isFirstWrite);
    if (wireLogFile) syncXrayCacheSnapshot(wireLogFile);
  }
}

async function runSingleEffectStep(
  current: LoopStepResult, recordedEntries: SessionEntry[], cursor: SessionCursor, provider: LlmProvider,
  tools: ToolContract<any>[], readonlyMap: Map<string, boolean>, options: RunSessionOptions, grants: SandboxGrants,
): Promise<LoopStepResult> {
  const { state, effect } = current, wsRoot = options.workspaceRoot ?? process.cwd();
  if (effect.type === "REQUEST_LLM") {
    const rawMessages = repairDanglingToolCalls(projectToMessages(recordedEntries, cursor.leafId ?? undefined));
    const messagesToSend = compactMessages(rawMessages, options.compactor);
    if (state.step >= state.maxSteps - 1 && messagesToSend.length > 0) {
      const last = messagesToSend[messagesToSend.length - 1]!;
      messagesToSend[messagesToSend.length - 1] = { ...last, content: `${last.content}\n[系统提示：当前已执行 ${state.step}/${state.maxSteps} 步，请勿再发起只读探索，请立即完成修改或直接输出总结回答。]` };
    }
    assertSessionInvariant(messagesToSend);
    let reply;
    try {
      reply = await provider.chat(messagesToSend, tools, { signal: options.signal, onStreamEvent: options.onStreamEvent, workspaceRoot: wsRoot });
    } catch (err) {
      if (options.signal?.aborted) return { state: { ...state, phase: "error", error: "收到外部取消信号 (AbortSignal)" }, effect: { type: "ABORT", reason: "收到外部取消信号 (AbortSignal)" } };
      throw err;
    }

    const calls = reply.toolCalls ?? [];
    const risk = evaluateBatchCallsRisk(calls, wsRoot, readonlyMap, grants);
    const requiresApproval = risk.callsNeedingApproval.length > 0 && (risk.hasDenied || Boolean(options.onApprovalRequest));
    const next = stepAgentLoop(state, { type: "LLM_REPLIED", message: reply, requiresApproval });
    if (calls.length > 0 && next.effect.type !== "ABORT") {
      console.log(formatStepToolCalls(state.step + 1, calls, readonlyMap, wsRoot));
      options.onStepEvent?.({ phase: next.state.phase, step: state.step + 1, detail: "tool_calls", toolCalls: calls });
    }
    return next;
  }

  if (effect.type === "AWAIT_APPROVAL") {
    const risk = evaluateBatchCallsRisk(effect.toolCalls, wsRoot, readonlyMap, grants);
    if (risk.hasDenied) {
      const denyText = `[沙箱安全拦截] ${risk.deniedReasons.join("；")}。若缺少外部配置或 API Key，请立即停止探测并直接向用户询问。`;
      console.log(`  🛡️ ${denyText}`);
      return stepAgentLoop(state, { type: "APPROVAL_RESOLVED", approved: false, reason: denyText });
    }
    const targetCalls = risk.callsNeedingApproval.length > 0 ? risk.callsNeedingApproval : effect.toolCalls;
    const decision = options.onApprovalRequest
      ? await options.onApprovalRequest(targetCalls, { hasEscalated: risk.hasEscalated, escalatedReasons: risk.escalatedReasons, externalDirs: risk.externalDirs })
      : { approved: false, reason: "未配置审批回调，默认拒绝写或跨界操作" };
    if (decision.approved) {
      const trustedDirs = grantApprovedCalls(effect.toolCalls, wsRoot, readonlyMap, grants, Boolean(decision.trustDirectory));
      console.log(trustedDirs.length > 0 ? `  🟢 已授权并信任外部目录: ${trustedDirs.join(", ")}` : `  🟢 已确认允许执行`);
    } else {
      console.log(`  🔴 已拒绝执行: ${decision.reason}`);
    }
    const resolved = stepAgentLoop(state, { type: "APPROVAL_RESOLVED", approved: decision.approved, reason: decision.reason });
    if (options.signal?.aborted) {
      const abortReason = decision.reason ?? "用户按 Ctrl+C 中断了本轮操作";
      return { state: { ...resolved.state, phase: "error", error: abortReason }, effect: { type: "ABORT", reason: abortReason } };
    }
    return resolved;
  }

  if (effect.type === "EXECUTE_TOOLS") {
    try {
      const results = await executeToolCalls(effect.toolCalls, tools);
      for (const r of results) {
        if (r.isError && r.content.includes("[沙箱安全拦截]")) console.log(`  🛡️ ${r.content.replace(/^执行异常：/, "")}`);
        console.log(formatToolResultLine(r));
      }
      options.onStepEvent?.({ phase: "executing", step: state.step, detail: "tool_results", toolResults: results });
      return stepAgentLoop(state, { type: "TOOLS_FINISHED", results });
    } finally {
      grants.onceAllowedPaths.clear();
    }
  }

  return current;
}

function printCostIfEnabled(options: RunSessionOptions, wireLogFile: string, isReplay: boolean): void {
  if (!options.showCostReport) return;
  const report = loadAndFormatWireCost(wireLogFile, { isReplay });
  if (report) console.log(report);
}

function initSessionContext(userPrompt: string, workspaceRoot: string, options: RunSessionOptions) {
  let existingEntries: SessionEntry[] = [];
  if (options.leafId && options.sessionFile) {
    try { existingEntries = loadJsonlEntries(options.sessionFile); } catch {}
  }
  const rawPrior = existingEntries.length > 0 && options.leafId ? projectToMessages(existingEntries, options.leafId) : [];
  const existingSystem = rawPrior.length > 1 && rawPrior[0]?.role === "system" ? rawPrior[0].content : undefined;
  const systemPrompt = options.systemPrompt ?? existingSystem ?? buildDefaultSystemPrompt(workspaceRoot);
  if (rawPrior.length === 1 && rawPrior[0]?.role === "system" && rawPrior[0].content !== systemPrompt && existingEntries[0]?.message.role === "system") {
    rawPrior[0] = { role: "system", content: systemPrompt };
    existingEntries[0] = { ...existingEntries[0], message: rawPrior[0] };
    if (options.sessionFile) appendJsonlEntries(options.sessionFile, existingEntries, true);
  }
  const baseState = createInitialState({ systemPrompt, maxSteps: options.maxSteps ?? 20 });
  const priorMessages = repairDanglingToolCalls(rawPrior.length > 0 ? rawPrior : baseState.messages);
  while (priorMessages.length > 0 && priorMessages[priorMessages.length - 1]!.role === "user") priorMessages.pop();
  if (options.systemPrompt && priorMessages[0]?.role === "system" && priorMessages[0].content !== systemPrompt) {
    priorMessages[0] = { role: "system", content: systemPrompt };
  }
  const wasHealed = existingEntries.length > 0 && (priorMessages.length !== rawPrior.length || priorMessages.some((m, i) => m !== rawPrior[i]));
  const recordedEntries: SessionEntry[] = wasHealed ? buildSessionEntries([], priorMessages, Date.now(), null) : existingEntries;
  if (wasHealed && options.sessionFile) appendJsonlEntries(options.sessionFile, recordedEntries, true);
  const cursor: SessionCursor = {
    persistedCount: existingEntries.length > 0 && options.leafId ? priorMessages.length : 0,
    leafId: wasHealed ? (recordedEntries[recordedEntries.length - 1]?.id ?? null) : (options.leafId ?? null),
  };
  const stepRes = stepAgentLoop({ ...baseState, messages: priorMessages }, { type: "START", userPrompt, images: options.userImages });
  syncNewMessagesToDisk(options.sessionFile, recordedEntries, stepRes.state.messages, cursor, existingEntries.length === 0 && !wasHealed, options.wireLogFile);
  return { stepRes, recordedEntries, cursor };
}

export async function runAgentSession(
  userPrompt: string,
  options: RunSessionOptions = {},
): Promise<{ finalAnswer: string; stepsUsed: number; entries: SessionEntry[]; leafId: string | null }> {
  const isReplay = Boolean(options.replayFromFile), turnStartMs = Date.now();
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const snapshots = options.snapshots ?? [];
  const grants = options.sandboxGrants ?? createSandboxGrants();
  const snapStartIdx = snapshots.length;
  const wireLogFile = options.wireLogFile ?? ".sessions/http-wire.json";
  const provider = isReplay ? createReplayProvider(loadJsonlEntries(options.replayFromFile!)) : (options.provider ?? createRouterProvider(wireLogFile));
  const defaultTools = [
    ...createBuiltinTools(workspaceRoot, grants),
    ...(options.enableWriteTools ? createWriteTools(workspaceRoot, snapshots, options.signal, options.onSnapshotChange, grants) : []),
  ];
  const tools = options.tools ?? defaultTools;
  const readonlyMap = new Map(tools.map((t) => [t.name, t.readonly]));
  if (!options.suppressFinalEcho) {
    console.log(`\n⚡ [路由决策] ${resolveRouteTier(Date.now(), { isReplay }).reason}`);
    console.log(`👤 [用户提问] ${stripAttachedFiles(userPrompt)}\n`);
  }

  let { stepRes, recordedEntries, cursor } = initSessionContext(userPrompt, workspaceRoot, options);

  while (true) {
    if (options.signal?.aborted && stepRes.effect.type !== "ABORT") {
      stepRes = {
        state: { ...stepRes.state, phase: "error", error: "收到外部取消信号 (AbortSignal)" },
        effect: { type: "ABORT", reason: "收到外部取消信号 (AbortSignal)" },
      };
    }
    if (stepRes.effect.type === "ABORT") {
      syncNewMessagesToDisk(options.sessionFile, recordedEntries, repairDanglingToolCalls(stepRes.state.messages), cursor, false, wireLogFile);
      const turnSnapCount = snapshots.length - snapStartIdx;
      if (turnSnapCount > 0 && !options.signal?.aborted) {
        const rb = await rollbackFileSnapshots(workspaceRoot, snapshots, turnSnapCount, options.onSnapshotChange);
        console.warn(`🔄 [任务熔断自动回滚] 已自动还原 ${rb.rolledBackCount} 个版本修改 (${rb.touchedPaths.join(", ")})`);
      } else if (turnSnapCount > 0 && options.suppressFinalEcho) {
        console.log(formatCompactTurnFooter(wireLogFile, stepRes.state.step, isReplay, snapshots.slice(snapStartIdx), workspaceRoot, Date.now() - turnStartMs));
      }
      printCostIfEnabled(options, wireLogFile, isReplay);
      console.error(`\n❌ [循环熔断终止] ${stepRes.effect.reason}`);
      return { finalAnswer: `[ABORT] ${stepRes.effect.reason}`, stepsUsed: stepRes.state.step, entries: recordedEntries, leafId: cursor.leafId };
    }
    if (stepRes.effect.type === "COMPLETE") {
      if (options.verifyCompletion) {
        const check = await options.verifyCompletion(stepRes.effect.finalAnswer);
        if (!check.ok) {
          console.log(`🔄 [自动验证未通过，打回重修]: ${check.errorOutput}`);
          stepRes = stepAgentLoop(stepRes.state, { type: "REJECT_COMPLETION", reason: check.errorOutput ?? "验证未通过" });
          syncNewMessagesToDisk(options.sessionFile, recordedEntries, stepRes.state.messages, cursor, false, wireLogFile);
          continue;
        }
        console.log(`✅ [完成前自动验证通过]`);
      }
      options.onStepEvent?.({ phase: "done", step: stepRes.state.step, detail: stepRes.effect.finalAnswer });
      break;
    }
    options.onStepEvent?.({ phase: stepRes.state.phase, step: stepRes.state.step, detail: stepRes.effect.type });
    stepRes = await runSingleEffectStep(stepRes, recordedEntries, cursor, provider, tools, readonlyMap, { ...options, workspaceRoot }, grants);
    if (stepRes.state.phase !== "awaiting_approval" && stepRes.state.phase !== "executing") {
      syncNewMessagesToDisk(options.sessionFile, recordedEntries, stepRes.state.messages, cursor, false, wireLogFile);
    }
  }

  if (!options.suppressFinalEcho) {
    if (options.sessionFile) console.log(`💾 [已保存会话记录] ${options.sessionFile} (共 ${recordedEntries.length} 行 JSON)`);
    printCostIfEnabled(options, wireLogFile, isReplay);
    console.log(`\n✅ [最终回答 (共执行 ${stepRes.state.step} 步)]:\n${stepRes.effect.finalAnswer}`);
  } else {
    console.log(formatCompactTurnFooter(wireLogFile, stepRes.state.step, isReplay, snapshots.slice(snapStartIdx), workspaceRoot, Date.now() - turnStartMs));
  }
  return { finalAnswer: stepRes.effect.finalAnswer, stepsUsed: stepRes.state.step, entries: recordedEntries, leafId: cursor.leafId };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const prompt = process.argv.slice(2).join(" ").trim() || "请先用 list_dir 查看当前目录有哪些文件，再读取 package.json 告诉我这个项目的名称和 dependencies。";
  runAgentSession(prompt, { sessionFile: ".sessions/ask-latest.jsonl", enableWriteTools: true, showCostReport: true }).catch((err) => {
    console.error("运行出错:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
