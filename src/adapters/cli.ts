import { fileURLToPath } from "node:url";
import { compactMessages, type CompactorOptions } from "../core/compactor.js";
import type { LlmProvider, LoopStepResult, SessionEntry, ToolCall, ToolContract } from "../core/contracts.js";
import { createInitialState, stepAgentLoop } from "../core/loop.js";
import { assertSessionInvariant, buildSessionEntries, projectToMessages } from "../core/session-tree.js";
import { createRouterProvider, resolveRouteTier } from "./router.js";
import { loadAndFormatWireCost } from "./cost-tracker.js";
import { appendJsonlEntries, createReplayProvider, loadJsonlEntries } from "./store.js";
import { createBuiltinTools, executeToolCalls } from "./tools.js";
import { createWriteTools, type FileVersionSnapshot, rollbackFileSnapshots } from "./write-tools.js";

export interface RunSessionOptions {
  provider?: LlmProvider;
  tools?: ToolContract<any>[];
  enableWriteTools?: boolean;
  signal?: AbortSignal;
  workspaceRoot?: string;
  snapshots?: FileVersionSnapshot[];
  compactor?: CompactorOptions;
  maxSteps?: number;
  systemPrompt?: string;
  sessionFile?: string;
  replayFromFile?: string;
  wireLogFile?: string;
  showCostReport?: boolean;
  suppressFinalEcho?: boolean;
  leafId?: string;
  onApprovalRequest?: (
    toolCalls: ToolCall[],
  ) => Promise<{ approved: boolean; reason?: string }> | { approved: boolean; reason?: string };
  verifyCompletion?: (
    finalAnswer: string,
  ) => Promise<{ ok: boolean; errorOutput?: string }> | { ok: boolean; errorOutput?: string };
  onStepEvent?: (event: { phase: string; step: number; detail?: string }) => void;
}

interface SessionCursor {
  persistedCount: number;
  leafId: string | null;
}

function syncNewMessagesToDisk(
  sessionFile: string | undefined,
  recordedEntries: SessionEntry[],
  allMessages: readonly any[],
  cursor: SessionCursor,
  isFirstWrite: boolean,
): void {
  const unsavedMessages = allMessages.slice(cursor.persistedCount);
  if (unsavedMessages.length === 0) return;
  const newEntries = buildSessionEntries(recordedEntries, unsavedMessages, Date.now(), cursor.leafId);
  recordedEntries.push(...newEntries);
  cursor.persistedCount = allMessages.length;
  cursor.leafId = newEntries[newEntries.length - 1]!.id;
  if (sessionFile) appendJsonlEntries(sessionFile, newEntries, isFirstWrite);
}

export function isReadonlyBashCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed || /[><`;\n\r]|\$\(|(?:^|\s)-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)\b/.test(trimmed)) {
    return false;
  }
  const segments = trimmed.split(/\s*(?:\|\||&&|\|)\s*/);
  const safePrefix = /^(ls|find|wc|head|tail|cat|pwd|which|stat|file|grep|rg|git\s+(status|diff|log|show|rev-parse))\b/;
  return segments.every((seg) => safePrefix.test(seg.trim()) && !/(^|\s)&(\s|$)/.test(seg));
}

function filterCallsNeedingApproval(calls: readonly ToolCall[], readonlyMap: Map<string, boolean>): ToolCall[] {
  return calls.filter((c) => {
    if (readonlyMap.get(c.name) !== false) return false;
    if (c.name === "run_bash" && isReadonlyBashCommand(String(c.arguments?.command ?? ""))) return false;
    return true;
  });
}

async function runSingleEffectStep(
  current: LoopStepResult,
  recordedEntries: SessionEntry[],
  cursor: SessionCursor,
  provider: LlmProvider,
  tools: ToolContract<any>[],
  readonlyMap: Map<string, boolean>,
  options: RunSessionOptions,
): Promise<LoopStepResult> {
  const { state, effect } = current;
  if (effect.type === "REQUEST_LLM") {
    const rawMessages = projectToMessages(recordedEntries, cursor.leafId ?? undefined);
    const messagesToSend = compactMessages(rawMessages, options.compactor);
    assertSessionInvariant(messagesToSend);
    console.log(`🤖 [请求大模型] 正在发送 ${messagesToSend.length} 条上下文消息...`);
    let reply;
    try {
      reply = await provider.chat(messagesToSend, tools, { signal: options.signal });
    } catch (err) {
      if (options.signal?.aborted) {
        return {
          state: { ...state, phase: "error", error: "收到外部取消信号 (AbortSignal)" },
          effect: { type: "ABORT", reason: "收到外部取消信号 (AbortSignal)" },
        };
      }
      throw err;
    }

    const calls = reply.toolCalls ?? [];
    if (calls.length > 0) {
      const summary = calls.map((c) => `${c.name}(${JSON.stringify(c.arguments)})`).join(", ");
      console.log(`-> [大模型调用工具] ${summary}`);
    }
    const writeCalls = filterCallsNeedingApproval(calls, readonlyMap);
    const requiresApproval = writeCalls.length > 0 && Boolean(options.onApprovalRequest);
    return stepAgentLoop(state, { type: "LLM_REPLIED", message: reply, requiresApproval });
  }

  if (effect.type === "AWAIT_APPROVAL") {
    const writeCalls = filterCallsNeedingApproval(effect.toolCalls, readonlyMap);
    const decision = options.onApprovalRequest
      ? await options.onApprovalRequest(writeCalls.length > 0 ? writeCalls : effect.toolCalls)
      : { approved: false, reason: "未配置审批回调，默认拒绝写操作" };
    console.log(decision.approved ? `🟢 [已允许执行]` : `🔴 [已拒绝执行]: ${decision.reason}`);
    return stepAgentLoop(state, { type: "APPROVAL_RESOLVED", approved: decision.approved, reason: decision.reason });
  }

  if (effect.type === "EXECUTE_TOOLS") {
    const results = await executeToolCalls(effect.toolCalls, tools);
    for (const r of results) {
      const preview = r.content.replace(/\n/g, " ").slice(0, 80);
      console.log(`   ↳ [本地工具结果] ${r.name} (isError=${r.isError}): ${preview}${r.content.length > 80 ? "..." : ""}`);
    }
    return stepAgentLoop(state, { type: "TOOLS_FINISHED", results });
  }

  return current;
}

function printCostIfEnabled(options: RunSessionOptions, wireLogFile: string, isReplay: boolean): void {
  if (!options.showCostReport) return;
  const report = loadAndFormatWireCost(wireLogFile, { isReplay });
  if (report) console.log(report);
}

function initSessionContext(userPrompt: string, options: RunSessionOptions) {
  const systemPrompt =
    options.systemPrompt ??
    "你是一个运行在本地代码库中的智能体。请调用工具读取或修改真实文件后再回答，回答请简明扼要。";
  let existingEntries: SessionEntry[] = [];
  if (options.leafId && options.sessionFile) {
    try {
      existingEntries = loadJsonlEntries(options.sessionFile);
    } catch {
      existingEntries = [];
    }
  }
  const baseState = createInitialState({ systemPrompt, maxSteps: options.maxSteps ?? 8 });
  const priorMessages =
    existingEntries.length > 0 && options.leafId
      ? projectToMessages(existingEntries, options.leafId)
      : baseState.messages;
  const recordedEntries: SessionEntry[] = [...existingEntries];
  const cursor: SessionCursor = {
    persistedCount: existingEntries.length > 0 && options.leafId ? priorMessages.length : 0,
    leafId: options.leafId ?? null,
  };
  const stepRes = stepAgentLoop({ ...baseState, messages: priorMessages }, { type: "START", userPrompt });
  syncNewMessagesToDisk(options.sessionFile, recordedEntries, stepRes.state.messages, cursor, existingEntries.length === 0);
  return { stepRes, recordedEntries, cursor };
}

export async function runAgentSession(
  userPrompt: string,
  options: RunSessionOptions = {},
): Promise<{ finalAnswer: string; stepsUsed: number; entries: SessionEntry[]; leafId: string | null }> {
  const isReplay = Boolean(options.replayFromFile);
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const snapshots = options.snapshots ?? [];
  const wireLogFile = options.wireLogFile ?? ".sessions/http-wire.json";
  const provider = isReplay
    ? createReplayProvider(loadJsonlEntries(options.replayFromFile!))
    : (options.provider ?? createRouterProvider(wireLogFile));
  const defaultTools = [
    ...createBuiltinTools(workspaceRoot),
    ...(options.enableWriteTools ? createWriteTools(workspaceRoot, snapshots, options.signal) : []),
  ];
  const tools = options.tools ?? defaultTools;
  const readonlyMap = new Map(tools.map((t) => [t.name, t.readonly]));
  console.log(`\n⚡ [路由决策] ${resolveRouteTier(Date.now(), { isReplay }).reason}`);
  console.log(`👤 [用户提问] ${userPrompt}\n`);

  let { stepRes, recordedEntries, cursor } = initSessionContext(userPrompt, options);

  while (true) {
    if (options.signal?.aborted) {
      stepRes = {
        state: { ...stepRes.state, phase: "error", error: "收到外部取消信号 (AbortSignal)" },
        effect: { type: "ABORT", reason: "收到外部取消信号 (AbortSignal)" },
      };
    }
    if (stepRes.effect.type === "ABORT") {
      if (snapshots.length > 0) {
        const rb = await rollbackFileSnapshots(workspaceRoot, snapshots, snapshots.length);
        console.warn(`🔄 [任务熔断自动回滚] 已自动还原 ${rb.rolledBackCount} 个版本修改 (${rb.touchedPaths.join(", ")})`);
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
          syncNewMessagesToDisk(options.sessionFile, recordedEntries, stepRes.state.messages, cursor, false);
          continue;
        }
        console.log(`✅ [完成前自动验证通过]`);
      }
      options.onStepEvent?.({ phase: "done", step: stepRes.state.step, detail: stepRes.effect.finalAnswer });
      break;
    }
    options.onStepEvent?.({ phase: stepRes.state.phase, step: stepRes.state.step, detail: stepRes.effect.type });
    stepRes = await runSingleEffectStep(stepRes, recordedEntries, cursor, provider, tools, readonlyMap, options);
    syncNewMessagesToDisk(options.sessionFile, recordedEntries, stepRes.state.messages, cursor, false);
  }

  if (options.sessionFile) console.log(`💾 [已保存会话记录] ${options.sessionFile} (共 ${recordedEntries.length} 行 JSON)`);
  printCostIfEnabled(options, wireLogFile, isReplay);
  if (!options.suppressFinalEcho) {
    console.log(`\n✅ [最终回答 (共执行 ${stepRes.state.step} 步)]:\n${stepRes.effect.finalAnswer}`);
  } else {
    console.log(`\n✅ [本轮完成 (共调用工具 ${stepRes.state.step} 步)]`);
  }
  return { finalAnswer: stepRes.effect.finalAnswer, stepsUsed: stepRes.state.step, entries: recordedEntries, leafId: cursor.leafId };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const prompt =
    process.argv.slice(2).join(" ").trim() ||
    "请先用 list_dir 查看当前目录有哪些文件，再读取 package.json 告诉我这个项目的名称和 dependencies。";
  runAgentSession(prompt, {
    sessionFile: ".sessions/ask-latest.jsonl",
    enableWriteTools: true,
    showCostReport: true,
  }).catch((err) => {
    console.error("运行出错:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
