import { AgentStateSchema, type AgentState, type AssistantMessage, type LoopEvent, type LoopStepResult, type Message, type ToolResultMessage } from "./contracts.js";

export interface InitialStateConfig { systemPrompt?: string; maxSteps?: number }

export function createInitialState(config: InitialStateConfig = {}): AgentState {
  const messages: Message[] = config.systemPrompt ? [{ role: "system", content: config.systemPrompt }] : [];
  return AgentStateSchema.parse({ phase: "idle", messages, step: 0, maxSteps: config.maxSteps ?? 20 });
}

function abortLoop(state: AgentState, reason: string, messages = state.messages): LoopStepResult {
  return { state: { ...state, phase: "error", messages, error: reason }, effect: { type: "ABORT", reason } };
}

function handleLlmReplied(state: AgentState, message: AssistantMessage, requiresApproval = false): LoopStepResult {
  const nextMessages: Message[] = [...state.messages, message];
  const toolCalls = message.toolCalls ?? [];

  if (toolCalls.length === 0) {
    return {
      state: { ...state, phase: "done", messages: nextMessages },
      effect: { type: "COMPLETE", finalAnswer: message.content },
    };
  }

  if (state.step >= state.maxSteps) {
    return abortLoop(state, `超过最大循环步数限制 (maxSteps=${state.maxSteps})`, nextMessages);
  }

  if (requiresApproval) {
    return {
      state: { ...state, phase: "awaiting_approval", messages: nextMessages },
      effect: { type: "AWAIT_APPROVAL", toolCalls },
    };
  }

  return {
    state: { ...state, phase: "executing", step: state.step + 1, messages: nextMessages },
    effect: { type: "EXECUTE_TOOLS", toolCalls },
  };
}

function handleApprovalResolved(
  state: AgentState,
  approved: boolean,
  reason?: string,
): LoopStepResult {
  if (state.phase !== "awaiting_approval") {
    return abortLoop(state, `仅允许在 awaiting_approval 状态处理审批结果 (当前: ${state.phase})`);
  }
  const lastMsg = state.messages[state.messages.length - 1];
  const pendingCalls = lastMsg?.role === "assistant" ? (lastMsg.toolCalls ?? []) : [];
  if (pendingCalls.length === 0) {
    return abortLoop(state, "未找到待审批的 toolCalls");
  }

  if (approved) {
    return {
      state: { ...state, phase: "executing", step: state.step + 1 },
      effect: { type: "EXECUTE_TOOLS", toolCalls: pendingCalls },
    };
  }

  const rejectText = reason ?? "用户拒绝执行该写操作";
  const rejectedResults: ToolResultMessage[] = pendingCalls.map((tc) => ({
    role: "tool",
    toolCallId: tc.id,
    name: tc.name,
    content: `执行被拦截：${rejectText}`,
    isError: true,
  }));
  const nextMessages: Message[] = [...state.messages, ...rejectedResults];
  return {
    state: { ...state, phase: "thinking", step: state.step + 1, messages: nextMessages },
    effect: { type: "REQUEST_LLM", messages: nextMessages },
  };
}

function handleRejectCompletion(state: AgentState, reason: string): LoopStepResult {
  if (state.phase !== "done") {
    return abortLoop(state, `仅允许在 done 状态触发验证打回 (当前: ${state.phase})`);
  }
  if (state.step >= state.maxSteps) {
    return abortLoop(state, `自动验证未通过且已达最大步数限制 (maxSteps=${state.maxSteps})`);
  }
  const feedbackMsg: Message = {
    role: "user",
    content: `[自动验证未通过] 请继续修复以下错误：\n${reason}`,
  };
  const nextMessages: Message[] = [...state.messages, feedbackMsg];
  return {
    state: { ...state, phase: "thinking", step: state.step + 1, messages: nextMessages },
    effect: { type: "REQUEST_LLM", messages: nextMessages },
  };
}

export function stepAgentLoop(state: AgentState, event: LoopEvent): LoopStepResult {
  if (state.phase === "error" || (state.phase === "done" && event.type !== "REJECT_COMPLETION")) {
    return abortLoop(state, state.error ?? `状态机已处于终态 (${state.phase})，拒绝继续步进`);
  }
  if (state.phase === "awaiting_approval" && event.type !== "APPROVAL_RESOLVED") {
    return abortLoop(state, "当前正等待人工审批，禁止跳过审批注入其他事件");
  }

  switch (event.type) {
    case "START": {
      const userMsg: Message = {
        role: "user",
        content: event.userPrompt,
        ...(event.images && event.images.length > 0 ? { images: event.images } : {}),
      };
      const nextMessages: Message[] = [...state.messages, userMsg];
      return {
        state: { ...state, phase: "thinking", messages: nextMessages },
        effect: { type: "REQUEST_LLM", messages: nextMessages },
      };
    }
    case "LLM_REPLIED":
      return handleLlmReplied(state, event.message, event.requiresApproval);
    case "APPROVAL_RESOLVED":
      return handleApprovalResolved(state, event.approved, event.reason);
    case "TOOLS_FINISHED": {
      if (event.results.length === 0) {
        return abortLoop(state, "工具执行结果列表不能为空");
      }
      const nextMessages: Message[] = [...state.messages, ...event.results];
      return {
        state: { ...state, phase: "thinking", messages: nextMessages },
        effect: { type: "REQUEST_LLM", messages: nextMessages },
      };
    }
    case "REJECT_COMPLETION":
      return handleRejectCompletion(state, event.reason);
  }
}
