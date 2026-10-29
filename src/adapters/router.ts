import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { AssistantMessage, LlmProvider, LlmStreamEvent, Message, ToolContract } from "../core/contracts.js";
import { createAgyBridgeProvider } from "./agy-bridge.js";
import {
  ensureDefaultModelsConfigFile,
  listAvailableModelModes,
  loadApiKey,
  loadModelRegistryConfig,
  type ModelEndpointConfig,
  type ModelMode,
  type ModelRegistryConfig,
  type ResolvedModelTarget,
  type RouteDecision,
  type RouteOptions,
  type RouteTier,
  resolveActiveModelTarget,
  resolveModelsConfigPath,
  resolveRouteTier,
  saveModelRegistryConfig,
  type TimeRoutingConfig,
} from "./model-config.js";
import { createStreamRenderer, parseOpenAiAssistantMessage, readOpenAiSseStream, recordHttpWireLog } from "./sse-stream.js";

export {
  ensureDefaultModelsConfigFile,
  listAvailableModelModes,
  loadApiKey,
  loadModelRegistryConfig,
  parseOpenAiAssistantMessage,
  resolveActiveModelTarget,
  resolveModelsConfigPath,
  resolveRouteTier,
  saveModelRegistryConfig,
  type ModelEndpointConfig,
  type ModelMode,
  type ModelRegistryConfig,
  type ResolvedModelTarget,
  type RouteDecision,
  type RouteOptions,
  type RouteTier,
  type TimeRoutingConfig,
};

function zodTypeToJsonSchema(fieldSchema: z.ZodTypeAny): { schema: Record<string, unknown>; isOptional: boolean } {
  let current: z.ZodTypeAny = fieldSchema, isOptional = false, desc = fieldSchema.description;
  while (current instanceof z.ZodOptional || current instanceof z.ZodDefault || current instanceof z.ZodEffects) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodDefault) isOptional = true;
    current = current instanceof z.ZodEffects ? current._def.schema : current._def.innerType;
    desc ??= current.description;
  }
  const withDesc = (base: Record<string, unknown>) => (desc ? { ...base, description: desc } : base);
  if (current instanceof z.ZodArray) return { schema: withDesc({ type: "array", items: zodTypeToJsonSchema(current._def.type).schema }), isOptional };
  if (current instanceof z.ZodObject) return { schema: withDesc(zodObjectToJsonSchema(current)), isOptional };
  if (current instanceof z.ZodEnum) return { schema: withDesc({ type: "string", enum: current._def.values }), isOptional };
  if (current instanceof z.ZodLiteral) return { schema: withDesc({ type: typeof current._def.value, enum: [current._def.value] }), isOptional };
  const typeName = current instanceof z.ZodNumber ? "number" : current instanceof z.ZodBoolean ? "boolean" : "string";
  return { schema: withDesc({ type: typeName }), isOptional };
}

export function zodObjectToJsonSchema(schema?: z.ZodTypeAny): Record<string, unknown> {
  if (!(schema instanceof z.ZodObject)) return { type: "object", properties: {} };
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, fieldSchema] of Object.entries(shape)) {
    const { schema: propSchema, isOptional } = zodTypeToJsonSchema(fieldSchema);
    properties[key] = propSchema;
    if (!isOptional) required.push(key);
  }
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

export function toOpenAiMessages(
  messages: Message[],
  workspaceRoot = process.cwd(),
  allowImages = true,
  stripOldReasoning = false,
): Record<string, unknown>[] {
  const lastUserIdx = stripOldReasoning ? messages.map((m) => m.role).lastIndexOf("user") : -1;
  const outParams: Record<string, unknown>[] = [];
  const seenTurnImages = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === "assistant") {
      const hasTools = Boolean(msg.toolCalls && msg.toolCalls.length > 0);
      const out: Record<string, unknown> = { role: "assistant", content: msg.content || (hasTools ? null : "") };
      if ((!stripOldReasoning || i > lastUserIdx) && msg.reasoningContent !== undefined) out.reasoning_content = msg.reasoningContent;
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        out.tool_calls = msg.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }));
      }
      outParams.push(out);
      continue;
    }
    if (msg.role === "tool") {
      const imageBlocks: Record<string, unknown>[] = [];
      let j = i;
      for (; j < messages.length && messages[j]!.role === "tool"; j++) {
        const tm = messages[j] as Extract<Message, { role: "tool" }>;
        outParams.push({ role: "tool", tool_call_id: tm.toolCallId, name: tm.name, content: tm.content });
        for (const img of allowImages ? (tm.images ?? []) : []) {
          const abs = path.isAbsolute(img.path) ? img.path : path.resolve(workspaceRoot, img.path);
          if (!seenTurnImages.has(abs) && fs.existsSync(abs)) {
            seenTurnImages.add(abs);
            imageBlocks.push({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${fs.readFileSync(abs).toString("base64")}` } });
          }
        }
      }
      i = j - 1;
      if (imageBlocks.length > 0) {
        outParams.push({ role: "user", content: [{ type: "text", text: "Attached image(s) from tool result:" }, ...imageBlocks] });
      }
      continue;
    }
    if (msg.role === "user") {
      seenTurnImages.clear();
      if (msg.images && msg.images.length > 0) {
        const tags = msg.images.map((img) => `<attached_image path="${img.path}" mime="${img.mimeType}" />`).join("\n");
        if (!allowImages) { outParams.push({ role: "user", content: `${msg.content}\n${tags}`.trim() }); continue; }
        const parts: Record<string, unknown>[] = [{ type: "text", text: `${msg.content}\n${tags}`.trim() }];
        for (const img of msg.images) {
          const abs = path.isAbsolute(img.path) ? img.path : path.resolve(workspaceRoot, img.path);
          if (fs.existsSync(abs)) {
            seenTurnImages.add(abs);
            parts.push({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${fs.readFileSync(abs).toString("base64")}` } });
          }
        }
        if (parts.length > 1) { outParams.push({ role: "user", content: parts }); continue; }
      }
    }
    outParams.push({ role: msg.role, content: msg.content });
  }
  return outParams;
}

const RETRYABLE_ERR_RE = /^LLM HTTP (?:408|429|500|502|503|504)\b|fetch failed|terminated|ECONNRESET|ETIMEDOUT|socket|超时/i;

export function createRouterProvider(
  wireLogFile = ".sessions/http-wire.json",
  appendExistingWire = false,
  getModelMode?: () => ModelMode,
  customConfigPath?: string,
): LlmProvider {
  let roundCount = 0;
  let agyDelegate: LlmProvider | null = null;
  return {
    async chat(messages: Message[], tools: ToolContract<any>[] = [], options: { signal?: AbortSignal; onStreamEvent?: (event: LlmStreamEvent) => void; workspaceRoot?: string } = {}): Promise<AssistantMessage> {
      const mode = getModelMode?.() ?? "auto";
      const wsRoot = options.workspaceRoot ?? process.cwd();
      const cfg = loadModelRegistryConfig(wsRoot, customConfigPath);
      const isLockedMode = mode !== "auto" || Boolean(cfg.defaultModel && cfg.defaultModel !== "auto");
      const hasPrior = messages.some((m) => m.role === "assistant"), lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
      const turnHasImages = messages.slice(Math.max(0, lastUserIdx)).some((m) => (m.role === "user" || m.role === "tool") && Boolean(m.images && m.images.length > 0));
      const userTurnHasImages = Boolean(lastUserIdx >= 0 && (messages[lastUserIdx] as Extract<Message, { role: "user" }>)?.images?.length);
      const target = resolveActiveModelTarget(wireLogFile, hasPrior, mode, Date.now(), isLockedMode ? userTurnHasImages : turnHasImages, wsRoot, cfg);
      if (target.protocol === "agy") {
        agyDelegate ??= createAgyBridgeProvider(wireLogFile, appendExistingWire || roundCount > 0);
        roundCount += 1;
        return agyDelegate.chat(messages, tools, options);
      }
      const { apiUrl, model, apiKey, supportsVision } = target;
      if (!apiKey) throw new Error(`未检测到模型 [${model}] 密钥，请配置对应环境变量、.duo/models.json 或 ~/.duo-harness/models.json`);

      const openAiTools = tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema ?? zodObjectToJsonSchema(t.parameters) },
      }));
      const requestBody: Record<string, unknown> = {
        model,
        messages: toOpenAiMessages(messages, wsRoot, supportsVision),
        ...(openAiTools.length > 0 ? { tools: openAiTools } : {}),
        ...(model.includes("reasoner") ? {} : { temperature: 0 }),
        stream: true,
      };
      const fallbackRenderer = options.onStreamEvent ? null : createStreamRenderer(process.stdout);
      const handleEvent = options.onStreamEvent ?? ((evt: LlmStreamEvent) => fallbackRenderer?.onEvent(evt));

      for (let attempt = 0; ; attempt++) {
        let emitted = false;
        const onEvt = (evt: LlmStreamEvent) => { emitted = true; handleEvent(evt); };
        const connectCtrl = new AbortController();
        const connectTimer = setTimeout(() => connectCtrl.abort(new Error("LLM 首包连接超时 (45s)")), 45_000);
        const signal = options.signal ? AbortSignal.any([options.signal, connectCtrl.signal]) : connectCtrl.signal;
        try {
          const res = await fetch(apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify(requestBody),
            signal,
          }).finally(() => clearTimeout(connectTimer));
          if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
          const { message, rawSseLines } = await readOpenAiSseStream(res, undefined, undefined, onEvt, 45_000);
          fallbackRenderer?.flush();
          recordHttpWireLog({ roundTimestamp: new Date().toISOString(), apiUrl, requestBody, rawSseLines, assembledMessage: message }, wireLogFile, roundCount === 0 && !appendExistingWire);
          roundCount += 1;
          return message;
        } catch (err) {
          fallbackRenderer?.flush();
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt < 2 && !emitted && !options.signal?.aborted && RETRYABLE_ERR_RE.test(msg)) {
            await new Promise((r) => setTimeout(r, process.env.VITEST ? 10 : 800 * (attempt + 1)));
            continue;
          }
          recordHttpWireLog({ roundTimestamp: new Date().toISOString(), apiUrl, requestBody, rawSseLines: [`[ERROR] ${msg}`], assembledMessage: { role: "assistant", content: `[请求异常: ${msg}]` } }, wireLogFile, roundCount === 0 && !appendExistingWire);
          roundCount += 1;
          throw err;
        }
      }
    },
  };
}
