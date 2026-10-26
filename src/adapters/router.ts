import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AssistantMessage, LlmProvider, LlmStreamEvent, Message, ToolContract } from "../core/contracts.js";
import { createAgyBridgeProvider } from "./agy-bridge.js";
import { createStreamRenderer, parseOpenAiAssistantMessage, readOpenAiSseStream, recordHttpWireLog } from "./sse-stream.js";

export { parseOpenAiAssistantMessage };

export type RouteTier = "tier0_replay" | "tier1_mimo_peak" | "tier2_deepseek_offpeak" | "tier3_gemini_cli";

export interface RouteOptions { isReplay?: boolean; forceGeminiCli?: boolean; }
export interface RouteDecision { tier: RouteTier; beijingHour: number; isWorkday: boolean; reason: string; }

export function resolveRouteTier(utcTimestampMs: number, options: RouteOptions = {}): RouteDecision {
  const beijingDate = new Date(utcTimestampMs + 8 * 3600_000);
  const day = beijingDate.getUTCDay();
  const beijingHour = beijingDate.getUTCHours();
  const isWorkday = day >= 1 && day <= 5;
  if (options.isReplay) return { tier: "tier0_replay", beijingHour, isWorkday, reason: "离线录像回放模式 (¥0)" };
  if (options.forceGeminiCli) return { tier: "tier3_gemini_cli", beijingHour, isWorkday, reason: "显式指定 Gemini CLI 桥接兜底 (¥0)" };
  const isPeakHour = isWorkday && ((beijingHour >= 9 && beijingHour < 12) || (beijingHour >= 14 && beijingHour < 18));
  if (isPeakHour) return { tier: "tier1_mimo_peak", beijingHour, isWorkday, reason: `工作日高峰时段 (${beijingHour}:00 · 自动路由高速主力模型)` };
  return { tier: "tier2_deepseek_offpeak", beijingHour, isWorkday, reason: `低谷优惠时段 (${isWorkday ? "工作日午休/夜间" : "周末"} ${beijingHour}:00 · 自动路由 DeepSeek)` };
}

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

export function zodObjectToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
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

export function toOpenAiMessages(messages: Message[], workspaceRoot = process.cwd(), allowImages = true): Record<string, unknown>[] {
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  const outParams: Record<string, unknown>[] = [];
  const seenTurnImages = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === "assistant") {
      const hasTools = Boolean(msg.toolCalls && msg.toolCalls.length > 0);
      const out: Record<string, unknown> = { role: "assistant", content: msg.content || (hasTools ? null : "") };
      if (i > lastUserIdx && msg.reasoningContent !== undefined) out.reasoning_content = msg.reasoningContent;
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

function readKeyFromFile(filePath: string, envName: string, allowBareFirstLine = true): string {
  if (!fs.existsSync(filePath)) return "";
  const raw = fs.readFileSync(filePath, "utf-8").trim();
  const match = raw.match(new RegExp(`^(?:export\\s+)?${envName}\\s*=\\s*(.+)$`, "m"));
  if (match?.[1]) return match[1].trim().replace(/^['"]|['"]$/g, "");
  if (!allowBareFirstLine) return "";
  const firstLine = raw.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "";
  return firstLine.includes("=") ? "" : firstLine.replace(/^['"]|['"]$/g, "");
}

function loadApiKey(envName: string, dotFileName: string): string {
  if (process.env[envName]?.trim()) return process.env[envName]!.trim();
  const cwdEnv = readKeyFromFile(path.resolve(process.cwd(), ".env.local"), envName, false);
  if (cwdEnv) return cwdEnv;
  const harnessRootEnv = readKeyFromFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env.local"), envName, false);
  return harnessRootEnv || readKeyFromFile(path.join(os.homedir(), ".gemini", "antigravity", dotFileName), envName, true);
}

export type ModelMode = "auto" | "deepseek" | "mimo" | "agy" | "openai";

export function resolveActiveModelTarget(
  wireLogFile?: string,
  hasPriorAssistant = false,
  mode: ModelMode = "auto",
  nowUtcMs = Date.now(),
  hasImages = false,
): { apiUrl: string; model: string; apiKey: string; shortLabel: string } {
  if (mode === "agy") return { apiUrl: "agy://local-language-server", model: "gemini-4-argon-agy", apiKey: "local-agy", shortLabel: "Argon·反重力" };
  const openaiKey = loadApiKey("OPENAI_API_KEY", ".openai_key");
  const mimoKey = loadApiKey("MIMO_API_KEY", ".mimo_key");
  const deepseekKey = loadApiKey("DEEPSEEK_API_KEY", ".deepseek_key");
  let stickyProvider: "mimo" | "deepseek" | null = null;
  if (mode === "auto" && hasPriorAssistant && wireLogFile && fs.existsSync(wireLogFile)) {
    try {
      const arr = JSON.parse(fs.readFileSync(wireLogFile, "utf-8"));
      const lastModel = String(arr[arr.length - 1]?.requestBody?.model ?? arr[arr.length - 1]?.model ?? "");
      if (lastModel.startsWith("deepseek") && deepseekKey) stickyProvider = "deepseek";
      else if (lastModel.startsWith("mimo") && mimoKey) stickyProvider = "mimo";
    } catch {}
  }
  const decision = resolveRouteTier(nowUtcMs);
  const useOpenAi = mode === "openai" || (mode === "auto" && openaiKey.length > 0 && ((!mimoKey && !deepseekKey) || process.env.LLM_PROVIDER === "openai"));
  const useMimo = !useOpenAi && (mode === "mimo" || (mode === "auto" && ((hasImages && mimoKey.length > 0) || (stickyProvider ? stickyProvider === "mimo" : decision.tier === "tier1_mimo_peak" && mimoKey.length > 0))));
  if (hasImages && !useOpenAi && !useMimo) {
    throw new Error("当前会话包含未折叠的图片附件，但 DeepSeek 官方接口不支持视觉输入 (image_url)；请配置 MIMO_API_KEY / 执行 /model mimo 切换到支持视觉的模型，或执行 /compact 折叠历史图片后再试。");
  }
  const isTokenPlan = mimoKey.startsWith("tp-") || mimoKey.startsWith("ttp-");
  const openaiBaseUrl = (process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/$/, "");
  const mimoBaseUrl = process.env.MIMO_BASE_URL?.trim() || (isTokenPlan ? "https://token-plan-cn.xiaomimimo.com/v1" : "https://api.xiaomimimo.com/v1");
  const apiUrl = useOpenAi ? `${openaiBaseUrl}/chat/completions` : useMimo ? `${mimoBaseUrl.replace(/\/$/, "")}/chat/completions` : "https://api.deepseek.com/chat/completions";
  const model = useOpenAi ? process.env.OPENAI_MODEL?.trim() || "gpt-5-codex" : useMimo ? process.env.MIMO_MODEL?.trim() || "mimo-v2.6-pro" : process.env.DEEPSEEK_MODEL?.trim() || "deepseek-reasoner";
  const apiKey = useOpenAi ? openaiKey : useMimo ? mimoKey : deepseekKey;
  const baseTag = useOpenAi ? "OpenAI" : useMimo ? "MiMo-2.6" : "DeepSeek";
  const shortLabel = mode !== "auto" ? `${baseTag}·锁` : hasImages && useMimo ? `${baseTag}·视觉` : stickyProvider ? `${baseTag}·保缓存` : baseTag;
  return { apiUrl, model, apiKey, shortLabel };
}

const RETRYABLE_ERR_RE = /^LLM HTTP (?:408|429|500|502|503|504)\b|fetch failed|terminated|ECONNRESET|ETIMEDOUT|socket|超时/i;

export function createRouterProvider(wireLogFile = ".sessions/http-wire.json", appendExistingWire = false, getModelMode?: () => ModelMode): LlmProvider {
  let roundCount = 0;
  let agyDelegate: LlmProvider | null = null;
  return {
    async chat(messages: Message[], tools: ToolContract<any>[] = [], options: { signal?: AbortSignal; onStreamEvent?: (event: LlmStreamEvent) => void; workspaceRoot?: string } = {}): Promise<AssistantMessage> {
      const mode = getModelMode?.() ?? "auto";
      if (mode === "agy") {
        agyDelegate ??= createAgyBridgeProvider(wireLogFile, appendExistingWire || roundCount > 0);
        roundCount += 1;
        return agyDelegate.chat(messages, tools, options);
      }
      const hasPrior = messages.some((m) => m.role === "assistant"), lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
      const turnHasImages = messages.slice(Math.max(0, lastUserIdx)).some((m) => (m.role === "user" || m.role === "tool") && Boolean(m.images && m.images.length > 0));
      const userTurnHasImages = Boolean(lastUserIdx >= 0 && (messages[lastUserIdx] as Extract<Message, { role: "user" }>)?.images?.length);
      const { apiUrl, model, apiKey } = resolveActiveModelTarget(wireLogFile, hasPrior, mode, Date.now(), mode === "deepseek" ? userTurnHasImages : turnHasImages);
      if (!apiKey) throw new Error(`未检测到模型密钥，请配置 DEEPSEEK_API_KEY / MIMO_API_KEY 或 ~/.gemini/antigravity/.deepseek_key`);

      const openAiTools = tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema ?? zodObjectToJsonSchema(t.parameters) },
      }));
      const requestBody: Record<string, unknown> = {
        model,
        messages: toOpenAiMessages(messages, options.workspaceRoot, !model.startsWith("deepseek")),
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
