import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AssistantMessageSchema, type AssistantMessage, type LlmProvider, type LlmStreamEvent, type Message, type ToolContract } from "../core/contracts.js";
import { discoverOsLsProcess, querySqliteFirstValue, resolveAntigravityLsBin } from "./platform.js";
import { zodObjectToJsonSchema } from "./router.js";
import { createStreamRenderer, recordHttpWireLog } from "./sse-stream.js";

const execFileAsync = promisify(execFile);

export interface AgyQuotaSnapshot {
  online: boolean; userTier: string; remaining5hPct: number; resetInMinutes: number | null; remainingWeeklyPct: number; shouldPreferAgy: boolean; summaryLabel: string;
}

export function evaluateAgyQuotaSurplus(rem5hPct: number, resetInMinutes: number | null, remWeeklyPct: number): boolean {
  if (remWeeklyPct < 25) return false;
  return (rem5hPct >= 50 && resetInMinutes !== null && resetInMinutes >= 0 && resetInMinutes <= 90) || rem5hPct >= 75;
}

export function stripAgyFooter(rawText: string): string {
  const marker = '<details data-agy-footer="1">';
  if (!rawText.includes(marker)) return rawText;
  const head = rawText.slice(0, rawText.lastIndexOf(marker)).trimEnd();
  return head.length > 0 ? head : rawText;
}

function callLocalLsRpc(port: number, token: string, rpcName: string, body: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve) => {
    const req = https.request(
      { hostname: "127.0.0.1", port, path: `/exa.language_server_pb.LanguageServerService/${rpcName}`, method: "POST", rejectUnauthorized: false, headers: { "Content-Type": "application/json", "x-codeium-csrf-token": token }, timeout: 2000 },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { try { resolve(res.statusCode === 200 && raw ? JSON.parse(raw) : null); } catch { resolve(null); } });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function discoverLocalLs(): Promise<{ port: number; grpcPort: number; token: string; projectId: string } | null> {
  try {
    const { token, ports } = discoverOsLsProcess();
    if (!token || ports.length === 0) return null;
    const dbPath = path.join(os.homedir(), ".gemini", "antigravity", "conversation_summaries.db");
    const projectId =
      process.env.ANTIGRAVITY_PROJECT_ID?.trim() ||
      querySqliteFirstValue(dbPath, "SELECT project_id FROM conversation_summaries WHERE project_id IS NOT NULL AND project_id != '' ORDER BY last_modified_time DESC LIMIT 1;");
    for (const port of ports) {
      const status = await callLocalLsRpc(port, token, "GetUserStatus", {});
      if (status?.userStatus) {
        return { port, grpcPort: ports.includes(port + 1) ? port + 1 : (ports.find((p) => p !== port) ?? port + 1), token, projectId };
      }
    }
  } catch {}
  return null;
}

export async function probeAgyQuota(): Promise<AgyQuotaSnapshot> {
  const conn = await discoverLocalLs();
  if (!conn) return { online: false, userTier: "Offline", remaining5hPct: 0, resetInMinutes: null, remainingWeeklyPct: 0, shouldPreferAgy: false, summaryLabel: "本机 Antigravity 未运行" };
  const [statusData, summaryData] = await Promise.all([callLocalLsRpc(conn.port, conn.token, "GetUserStatus", {}), callLocalLsRpc(conn.port, conn.token, "RetrieveUserQuotaSummary", {})]);
  const configs: any[] = statusData?.userStatus?.cascadeModelConfigData?.clientModelConfigs ?? [];
  const argonCfg = configs.find((c) => /Argon|Gemini 4|Flash/i.test(String(c?.label ?? "")));
  const groups: any[] = summaryData?.response?.groups ?? summaryData?.groups ?? [];
  const buckets: any[] = groups.find((g) => /gemini/i.test(String(g?.displayName ?? "")))?.buckets ?? [];
  const b5h = buckets.find((b) => b?.window === "5h" || String(b?.bucketId ?? "").endsWith("-5h")) ?? argonCfg?.quotaInfo;
  const bWeekly = buckets.find((b) => b?.window === "weekly" || String(b?.bucketId ?? "").endsWith("-weekly")) ?? b5h;
  const rem5hPct = Math.round(Number(b5h?.remainingFraction ?? 0) * 1000) / 10;
  const remWeeklyPct = Math.round(Number(bWeekly?.remainingFraction ?? rem5hPct / 100) * 1000) / 10;
  const resetTs = b5h?.resetTime ? Date.parse(String(b5h.resetTime)) : NaN;
  const resetInMinutes = Number.isFinite(resetTs) ? Math.max(0, Math.round((resetTs - Date.now()) / 60_000)) : null;
  const shouldPreferAgy = evaluateAgyQuotaSurplus(rem5hPct, resetInMinutes, remWeeklyPct);
  const resetTag = resetInMinutes !== null ? ` (${resetInMinutes}m后刷新)` : "";
  return { online: true, userTier: String(statusData?.userStatus?.userTier?.name ?? "Pro"), remaining5hPct: rem5hPct, resetInMinutes, remainingWeeklyPct: remWeeklyPct, shouldPreferAgy, summaryLabel: `5h余 ${rem5hPct}%${resetTag} · 周余 ${remWeeklyPct}% (${shouldPreferAgy ? "🟢 推荐白嫖" : "🟡 保守留存"})` };
}

export function buildBridgePrompt(messages: Message[], tools: ToolContract<any>[] = []): string {
  const parts = ["【档位：Argon-Med】请保持思考链精炼高效（thinking <= 150 字，使用简明中文），直奔结论。"];
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls?.length) {
      parts.push(`[ASSISTANT]\n${m.content ? `${m.content}\n` : ""}${JSON.stringify({ toolCalls: m.toolCalls })}`);
    } else if (m.role === "tool") {
      parts.push(`[TOOL_RESULT (${m.name} · id=${m.toolCallId})]\n${m.content}`);
    } else {
      parts.push(`[${m.role.toUpperCase()}]\n${m.content}`);
    }
  }
  if (tools.length > 0) {
    const toolDesc = tools.map((t) => {
      const schema = (t.inputSchema ?? zodObjectToJsonSchema(t.parameters)) as { properties?: Record<string, unknown>; required?: string[] };
      const reqSet = new Set(schema.required ?? []);
      const keys = Object.keys(schema.properties ?? {}).map((k) => (reqSet.has(k) ? k : `${k}?`)).join(", ");
      return `- ${t.name}(${keys}): ${t.description}`;
    }).join("\n");
    parts.push(`【Duo-Harness 桥接协议：严禁直接调用 Antigravity IDE 自身内置工具（严禁调 IDE 的 view_file/read_file/run_command/get-metrics.mjs 或拉起子代理）！若需查看目录、读取文件或执行命令，请从以下 Duo-Harness 宿主工具中选择，并直接输出且仅输出一行纯 JSON（不要加 markdown 代码块包裹）：\n{"content":"","toolCalls":[{"name":"工具名","arguments":{"参数名":"..."}}]}\n可用宿主工具列表：\n${toolDesc}\n若当前上下文已足够回答用户问题，请直接输出最终中文 Markdown 回答】`);
  } else {
    parts.push("【纯文本/JSON 桥接守卫：以上已包含全部所需上下文。严禁调用任何工具(read_file/run_command等)、严禁运行 get-metrics.mjs 或拉起子代理，请直接输出最终回答】");
  }
  return parts.join("\n\n");
}

export function parseBridgeReply(cleanedText: string, thinking?: string): AssistantMessage {
  const trimmed = cleanedText.replace(/```(?:json)?\s*/gi, "").replace(/\s*```/g, "").trim();
  const startMatch = trimmed.match(/\{\s*"(?:content|toolCalls)"\s*:/);
  const endIdx = trimmed.lastIndexOf("}");
  const jsonCandidate = startMatch?.index !== undefined && endIdx > startMatch.index ? trimmed.slice(startMatch.index, endIdx + 1) : null;
  if (jsonCandidate) {
    try {
      const parsed = JSON.parse(jsonCandidate) as { content?: string; toolCalls?: { id?: string; name?: string; arguments?: Record<string, unknown> }[] };
      if (Array.isArray(parsed.toolCalls) && parsed.toolCalls.length > 0 && parsed.toolCalls.every((c) => typeof c?.name === "string")) {
        const toolCalls = parsed.toolCalls.map((c, idx) => ({ id: c.id || `agy_call_${Date.now()}_${idx}`, name: String(c.name), arguments: (c.arguments ?? {}) as Record<string, unknown> }));
        return AssistantMessageSchema.parse({ role: "assistant", content: String(parsed.content ?? ""), toolCalls, ...(thinking ? { reasoningContent: thinking } : {}) });
      }
    } catch {}
  }
  return AssistantMessageSchema.parse({ role: "assistant", content: cleanedText, ...(thinking ? { reasoningContent: thinking } : {}) });
}

interface LiveStepSnapshot {
  thinking: string;
  content: string;
  done: boolean;
  isIdle: boolean;
  usage: { cacheHit: number; cacheMiss: number; outTok: number; thinkTok: number } | null;
}

async function pollLivePlannerStep(convId: string, port: number, token: string): Promise<LiveStepSnapshot> {
  const [trajRes, allTraj] = await Promise.all([
    callLocalLsRpc(port, token, "GetCascadeTrajectory", { cascadeId: convId, trajectoryVerbosity: 3 }),
    callLocalLsRpc(port, token, "GetAllCascadeTrajectories", {}),
  ]);
  const st = allTraj?.trajectorySummaries?.[convId];
  const isIdle = Boolean(st && !st.notFullyIdle && (st.status === "CASCADE_RUN_STATUS_IDLE" || !st.status));
  const gens: any[] = trajRes?.trajectory?.generatorMetadata ?? [];
  const lastUsage = [...gens].reverse().find((g) => g?.chatModel?.usage)?.chatModel?.usage;
  const usage = lastUsage
    ? {
        cacheHit: Number(lastUsage.cacheReadTokens ?? 0),
        cacheMiss: Number(lastUsage.inputTokens ?? 0),
        outTok: Number(lastUsage.outputTokens ?? 0),
        thinkTok: Number(lastUsage.thinkingOutputTokens ?? 0),
      }
    : null;
  const steps: any[] = trajRes?.trajectory?.steps ?? [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const pr = steps[i]?.plannerResponse;
    if (pr) {
      const thinking = String(pr.thinking ?? "");
      const content = String(pr.modifiedResponse ?? pr.response ?? "");
      return { thinking, content, done: steps[i]?.status === "CORTEX_STEP_STATUS_DONE", isIdle, usage };
    }
  }
  return { thinking: "", content: "", done: false, isIdle, usage };
}

export function createAgyBridgeProvider(wireLogFile = ".sessions/http-wire.json", appendExistingWire = false): LlmProvider {
  let roundCount = 0;
  return {
    async chat(messages: Message[], tools: ToolContract<any>[] = [], options: { signal?: AbortSignal; onStreamEvent?: (event: LlmStreamEvent) => void } = {}): Promise<AssistantMessage> {
      const lsBin = resolveAntigravityLsBin();
      const conn = await discoverLocalLs();
      if (!fs.existsSync(lsBin) || !conn) throw new Error("未检测到本机运行中的 Antigravity language_server，无法使用 agy 桥接模式");
      const cleanEnv: NodeJS.ProcessEnv = { ...process.env, ANTIGRAVITY_LS_ADDRESS: process.env.ANTIGRAVITY_LS_ADDRESS || `localhost:${conn.grpcPort}`, ANTIGRAVITY_CSRF_TOKEN: process.env.ANTIGRAVITY_CSRF_TOKEN || conn.token, ...(conn.projectId ? { ANTIGRAVITY_PROJECT_ID: conn.projectId } : {}) };
      delete cleanEnv.ANTIGRAVITY_SOURCE_METADATA;
      delete cleanEnv.ANTIGRAVITY_SIDECAR_UI_TOKEN;
      delete cleanEnv.ANTIGRAVITY_SIDECAR_WEB_PORT;

      const prompt = buildBridgePrompt(messages, tools);
      let stdout = "";
      try {
        ({ stdout } = await execFileAsync(lsBin, ["agentapi", "new-conversation", "--model=pro", "--title=🪐 [Duo-Bridge] 临时工单", prompt], { env: cleanEnv, timeout: 25_000 }));
      } catch (err: any) {
        const detail = String(err?.stdout || err?.stderr || err?.code || "连接失败").trim().slice(0, 200);
        throw new Error(`Antigravity 桥接启动失败: ${detail}`);
      }
      const newId = String(JSON.parse(stdout.trim())?.response?.newConversation?.conversationId ?? "");
      if (!newId) throw new Error("Antigravity agentapi 未返回有效 conversationId");

      const fallback = options.onStreamEvent ? null : createStreamRenderer();
      const emit = options.onStreamEvent ?? ((evt: LlmStreamEvent) => fallback?.onEvent(evt));
      let sentThinkLen = 0, sentTextLen = 0;
      let finalSnap: LiveStepSnapshot = { thinking: "", content: "", done: false, isIdle: false, usage: null };
      const deadline = Date.now() + 90_000;

      try {
        while (Date.now() < deadline) {
          if (options.signal?.aborted) throw new Error("Agy 桥接请求已取消");
          await new Promise((r) => setTimeout(r, 350));
          finalSnap = await pollLivePlannerStep(newId, conn.port, conn.token);
          const cleanContent = stripAgyFooter(finalSnap.content);
          if (finalSnap.thinking.length < sentThinkLen) sentThinkLen = 0;
          if (cleanContent.length < sentTextLen) sentTextLen = 0;
          if (finalSnap.thinking.length > sentThinkLen) {
            emit({ type: "reasoning_delta", text: finalSnap.thinking.slice(sentThinkLen) });
            sentThinkLen = finalSnap.thinking.length;
          }
          if (cleanContent.length > sentTextLen) {
            const delta = cleanContent.slice(sentTextLen);
            const isToolJson = /^```(?:json)?\s*\{|^\s*\{\s*"(?:content|toolCalls)"/.test(cleanContent);
            emit(isToolJson ? { type: "tool_call_delta", index: 0, name: "toolCalls", argsDelta: delta } : { type: "content_delta", text: delta });
            sentTextLen = cleanContent.length;
          }
          if (finalSnap.isIdle && (cleanContent.length > 0 || finalSnap.done)) break;
        }
      } finally {
        fallback?.flush();
        const metricsScript = path.join(os.homedir(), ".gemini", "config", "plugins", "antigravity-cost-monitor", "get-metrics.mjs");
        if (fs.existsSync(metricsScript)) await execFileAsync(process.execPath, [metricsScript, newId], { timeout: 3500 }).catch(() => {});
        await callLocalLsRpc(conn.port, conn.token, "CancelCascadeInvocation", { cascadeId: newId });
        await callLocalLsRpc(conn.port, conn.token, "DeleteCascadeTrajectory", { cascadeId: newId });
        try { fs.rmSync(path.join(os.homedir(), ".gemini", "antigravity", "brain", newId), { recursive: true, force: true }); } catch {}
      }

      const cleanedText = stripAgyFooter(finalSnap.content).trim();
      if (!cleanedText) throw new Error("Antigravity 桥接响应超时或未返回有效内容");
      const message = parseBridgeReply(cleanedText, finalSnap.thinking || undefined);
      const u = finalSnap.usage ?? { cacheHit: 0, cacheMiss: Math.ceil(prompt.length / 3), outTok: Math.ceil((cleanedText.length + finalSnap.thinking.length) / 3), thinkTok: Math.ceil(finalSnap.thinking.length / 3) };
      const synthSse = `data: ${JSON.stringify({ model: "gemini-4-argon-agy", usage: { prompt_tokens: u.cacheHit + u.cacheMiss, completion_tokens: u.outTok, prompt_cache_hit_tokens: u.cacheHit, prompt_cache_miss_tokens: u.cacheMiss, completion_tokens_details: { reasoning_tokens: u.thinkTok } } })}`;
      recordHttpWireLog({ roundTimestamp: new Date().toISOString(), apiUrl: "agy://local-language-server", requestBody: { model: "gemini-4-argon-agy", messages }, rawSseLines: [synthSse], assembledMessage: message }, wireLogFile, roundCount === 0 && !appendExistingWire);
      roundCount += 1;
      return message;
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  probeAgyQuota().then((q) => { console.log("🪐 [Antigravity 实时配额雷达]:", JSON.stringify(q, null, 2)); process.exit(0); });
}
