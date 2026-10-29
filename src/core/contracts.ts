import { z } from "zod";

/** 1. 模型返回的工具调用请求 (ToolCall) */
export const ToolCallSchema = z.object({
  id: z.string().min(1, "toolCall.id 不能为空"),
  name: z.string().min(1, "工具函数名称不能为空"),
  arguments: z.record(z.string(), z.unknown()),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/** 2. 四种标准消息角色 (system / user / assistant / tool) */
export const SystemMessageSchema = z.object({ role: z.literal("system"), content: z.string() });
export const ImageAttachmentSchema = z.object({ path: z.string().min(1), mimeType: z.string().min(1), byteSize: z.number().int().nonnegative() });
export type ImageAttachment = z.infer<typeof ImageAttachmentSchema>;
export const UserMessageSchema = z.object({ role: z.literal("user"), content: z.string(), images: z.array(ImageAttachmentSchema).optional() });
export const AssistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.string().nullable().optional().transform((val) => val ?? ""),
  toolCalls: z.array(ToolCallSchema).optional(),
  reasoningContent: z.string().optional(),
});

export const ToolResultMessageSchema = z.object({
  role: z.literal("tool"),
  /** 必须回传对应的 ToolCall.id，用于标识这是哪次函数调用的返回值 */
  toolCallId: z.string().min(1, "toolCallId 不能为空"),
  name: z.string().min(1),
  content: z.string(),
  images: z.array(ImageAttachmentSchema).optional(),
  /** 本地函数执行报错时设为 true，把错误信息作为消息回传给模型重试 */
  isError: z.boolean().default(false),
});

export const MessageSchema = z.discriminatedUnion("role", [
  SystemMessageSchema,
  UserMessageSchema,
  AssistantMessageSchema,
  ToolResultMessageSchema,
]);

export type SystemMessage = z.infer<typeof SystemMessageSchema>;
export type UserMessage = z.infer<typeof UserMessageSchema>;
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;
export type ToolResultMessage = z.infer<typeof ToolResultMessageSchema>;
export type Message = z.infer<typeof MessageSchema>;

/**
 * 3. 纯函数状态机的 State 与输入/输出契约 (类比 React 19 useReducer)
 */
export const AgentPhaseSchema = z.enum(["idle", "thinking", "executing", "awaiting_approval", "done", "error"]);
export type AgentPhase = z.infer<typeof AgentPhaseSchema>;

export const AgentStateSchema = z.object({
  phase: AgentPhaseSchema,
  messages: z.array(MessageSchema),
  step: z.number().int().nonnegative(),
  maxSteps: z.number().int().nonnegative(),
  error: z.string().optional(),
});
export type AgentState = z.infer<typeof AgentStateSchema>;

/** 喂给纯函数大脑的输入事件 (Action) */
export type LoopEvent =
  | { type: "START"; userPrompt: string; images?: ImageAttachment[] }
  | { type: "LLM_REPLIED"; message: AssistantMessage; requiresApproval?: boolean }
  | { type: "APPROVAL_RESOLVED"; approved: boolean; reason?: string }
  | { type: "TOOLS_FINISHED"; results: ToolResultMessage[] }
  | { type: "REJECT_COMPLETION"; reason: string };

/** 纯函数大脑算出的下一步待办副作用指令 (Effect) */
export type LoopEffect =
  | { type: "REQUEST_LLM"; messages: Message[] }
  | { type: "AWAIT_APPROVAL"; toolCalls: ToolCall[] }
  | { type: "EXECUTE_TOOLS"; toolCalls: ToolCall[] }
  | { type: "COMPLETE"; finalAnswer: string }
  | { type: "ABORT"; reason: string };

export interface LoopStepResult {
  state: AgentState;
  effect: LoopEffect;
}

export type ToolExecuteOutput = string | { content: string; images?: ImageAttachment[] };

/** 4. 原子工具契约 (ToolContract) 与厂商无关大模型契约 (LlmProvider) */
export interface ToolContract<TArgs = unknown> {
  name: string;
  description: string;
  parameters?: z.ZodType<TArgs, z.ZodTypeDef, any>;
  inputSchema?: Record<string, unknown>;
  readonly: boolean;
  execute: (args: TArgs) => Promise<ToolExecuteOutput> | ToolExecuteOutput;
}

export type LlmStreamEvent =
  | { type: "reasoning_delta"; text: string }
  | { type: "content_delta"; text: string }
  | { type: "tool_call_delta"; index: number; name?: string; argsDelta: string };

export interface LlmProvider {
  chat(
    messages: Message[],
    tools?: ToolContract[],
    options?: { signal?: AbortSignal; onStreamEvent?: (event: LlmStreamEvent) => void; workspaceRoot?: string },
  ): Promise<AssistantMessage>;
}

export const SessionEntrySchema = z.object({
  id: z.string().min(1),
  parentId: z.string().nullable(),
  timestamp: z.number().int().nonnegative(),
  message: MessageSchema,
});
export type SessionEntry = z.infer<typeof SessionEntrySchema>;
