import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import {
  AssistantMessageSchema,
  type AssistantMessage,
  type LlmProvider,
  type Message,
  type ToolCall,
  type ToolContract,
} from "../core/contracts.js";
import { readOpenAiSseStream, recordHttpWireLog } from "./sse-stream.js";

export type RouteTier = "tier0_replay" | "tier1_mimo_peak" | "tier2_deepseek_offpeak" | "tier3_gemini_cli";

export interface RouteOptions {
  isReplay?: boolean;
  forceGeminiCli?: boolean;
}

export interface RouteDecision {
  tier: RouteTier;
  beijingHour: number;
  isWorkday: boolean;
  reason: string;
}

export function resolveRouteTier(utcTimestampMs: number, options: RouteOptions = {}): RouteDecision {
  const beijingDate = new Date(utcTimestampMs + 8 * 3600_000);
  const day = beijingDate.getUTCDay();
  const beijingHour = beijingDate.getUTCHours();
  const isWorkday = day >= 1 && day <= 5;

  if (options.isReplay) {
    return { tier: "tier0_replay", beijingHour, isWorkday, reason: "离线录像回放模式 (¥0)" };
  }
  if (options.forceGeminiCli) {
    return { tier: "tier3_gemini_cli", beijingHour, isWorkday, reason: "显式指定 Gemini CLI 桥接" };
  }

  const isPeakHour = (beijingHour >= 9 && beijingHour < 12) || (beijingHour >= 14 && beijingHour < 18);
  if (isWorkday && isPeakHour) {
    return {
      tier: "tier1_mimo_peak",
      beijingHour,
      isWorkday,
      reason: `工作日白天高峰 (${beijingHour}:00) 优先走小米 MiMo 2.6 赠金档`,
    };
  }

  return {
    tier: "tier2_deepseek_offpeak",
    beijingHour,
    isWorkday,
    reason: `低谷半价窗 (${isWorkday ? "工作日午休/夜间" : "周末"} ${beijingHour}:00) 走 DeepSeek`,
  };
}

export function zodObjectToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (!(schema instanceof z.ZodObject)) {
    return { type: "object", properties: {} };
  }
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, fieldSchema] of Object.entries(shape)) {
    let current: z.ZodTypeAny = fieldSchema;
    let isOptional = false;
    while (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
      isOptional = true;
      current = current._def.innerType;
    }
    const typeName =
      current instanceof z.ZodNumber ? "number" : current instanceof z.ZodBoolean ? "boolean" : "string";
    properties[key] = { type: typeName };
    if (!isOptional) required.push(key);
  }

  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

export function toOpenAiMessages(messages: Message[]): Record<string, unknown>[] {
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  return messages.map((msg, idx) => {
    if (msg.role === "assistant") {
      const hasTools = Boolean(msg.toolCalls && msg.toolCalls.length > 0);
      const out: Record<string, unknown> = {
        role: "assistant",
        content: msg.content || (hasTools ? null : ""),
      };
      if (idx > lastUserIdx && msg.reasoningContent !== undefined) {
        out.reasoning_content = msg.reasoningContent;
      }
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        out.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
      }
      return out;
    }
    if (msg.role === "tool") {
      return { role: "tool", tool_call_id: msg.toolCallId, name: msg.name, content: msg.content };
    }
    return { role: msg.role, content: msg.content };
  });
}

export function parseOpenAiAssistantMessage(rawMsg: Record<string, any>): AssistantMessage {
  const rawToolCalls = Array.isArray(rawMsg.tool_calls) ? rawMsg.tool_calls : [];
  const toolCalls: ToolCall[] = rawToolCalls.map((tc: any, idx: number) => {
    let parsedArgs: Record<string, unknown> = {};
    const rawArgsStr = tc?.function?.arguments ?? "{}";
    try {
      const parsed = JSON.parse(rawArgsStr);
      parsedArgs = typeof parsed === "object" && parsed !== null ? parsed : { _value: parsed };
    } catch {
      parsedArgs = { _invalidJson: String(rawArgsStr) };
    }
    return {
      id: String(tc?.id || `call_${idx}`),
      name: String(tc?.function?.name || "unknown"),
      arguments: parsedArgs,
    };
  });

  return AssistantMessageSchema.parse({
    role: "assistant",
    content: rawMsg.content ?? "",
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(typeof rawMsg.reasoning_content === "string"
      ? { reasoningContent: rawMsg.reasoning_content }
      : {}),
  });
}

function readKeyFromFile(filePath: string, envName: string, allowBareFirstLine = true): string {
  if (!fs.existsSync(filePath)) return "";
  const raw = fs.readFileSync(filePath, "utf-8").trim();
  const regex = new RegExp(`^(?:export\\s+)?${envName}\\s*=\\s*(.+)$`, "m");
  const match = raw.match(regex);
  if (match?.[1]) {
    return match[1].trim().replace(/^['"]|['"]$/g, "");
  }
  if (!allowBareFirstLine) return "";
  const firstLine = raw.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "";
  return firstLine.includes("=") ? "" : firstLine.replace(/^['"]|['"]$/g, "");
}

function loadApiKey(envName: string, dotFileName: string): string {
  if (process.env[envName]?.trim()) {
    return process.env[envName]!.trim();
  }
  const localEnvKey = readKeyFromFile(path.resolve(process.cwd(), ".env.local"), envName, false);
  if (localEnvKey) return localEnvKey;
  return readKeyFromFile(path.join(os.homedir(), ".gemini", "antigravity", dotFileName), envName, true);
}

/** 5. 创建真实 HTTP 大模型调用器（支持按时段路由小米 MiMo 2.6 / DeepSeek） */
export function createRouterProvider(wireLogFile = ".sessions/http-wire.json"): LlmProvider {
  let roundCount = 0;
  return {
    async chat(
      messages: Message[],
      tools: ToolContract<any>[] = [],
      options: { signal?: AbortSignal } = {},
    ): Promise<AssistantMessage> {
      const decision = resolveRouteTier(Date.now());
      const mimoKey = loadApiKey("MIMO_API_KEY", ".mimo_key");
      const deepseekKey = loadApiKey("DEEPSEEK_API_KEY", ".deepseek_key");

      const useMimo = decision.tier === "tier1_mimo_peak" && mimoKey.length > 0;
      const isTokenPlan = mimoKey.startsWith("tp-") || mimoKey.startsWith("ttp-");
      const mimoBaseUrl =
        process.env.MIMO_BASE_URL?.trim() ||
        (isTokenPlan ? "https://token-plan-cn.xiaomimimo.com/v1" : "https://api.xiaomimimo.com/v1");

      const apiUrl = useMimo
        ? `${mimoBaseUrl.replace(/\/$/, "")}/chat/completions`
        : "https://api.deepseek.com/chat/completions";
      const model = useMimo ? process.env.MIMO_MODEL?.trim() || "mimo-v2.6-pro" : "deepseek-chat";
      const apiKey = useMimo ? mimoKey : deepseekKey;
      if (!apiKey) {
        throw new Error("未检测到 MIMO_API_KEY (.mimo_key) 或 DEEPSEEK_API_KEY (.deepseek_key)");
      }

      const openAiTools = tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema ?? zodObjectToJsonSchema(t.parameters),
        },
      }));
      const requestBody: Record<string, unknown> = {
        model,
        messages: toOpenAiMessages(messages),
        ...(openAiTools.length > 0 ? { tools: openAiTools } : {}),
        temperature: 0,
        stream: true,
      };
      const timeoutSig = AbortSignal.timeout(60_000);
      const signal = options.signal ? AbortSignal.any([options.signal, timeoutSig]) : timeoutSig;

      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(requestBody),
        signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`LLM HTTP ${res.status}: ${errText.slice(0, 300)}`);
      }

      let printedHeader = false;
      const { message, rawSseLines } = await readOpenAiSseStream(res, (chunk) => {
        if (!printedHeader) {
          process.stdout.write("   🌊 [实时流输出]: ");
          printedHeader = true;
        }
        process.stdout.write(chunk);
      });
      if (printedHeader) process.stdout.write("\n");

      recordHttpWireLog(
        {
          roundTimestamp: new Date().toISOString(),
          apiUrl,
          requestBody,
          rawSseLines,
          assembledMessage: message,
        },
        wireLogFile,
        roundCount === 0,
      );
      roundCount += 1;
      return message;
    },
  };
}
