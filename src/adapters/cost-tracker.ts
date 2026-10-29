import * as fs from "node:fs";
import type { AssistantMessage } from "../core/contracts.js";
import { padCols, truncateCols } from "./platform.js";

export { padCols, truncateCols };

export interface HttpWireLogEntry {
  roundTimestamp: string;
  apiUrl: string;
  requestBody: Record<string, unknown>;
  rawSseLines: string[];
  assembledMessage?: AssistantMessage;
}

export interface RoundCostMetric {
  round: number; model: string; messageCount: number; promptTokens: number; cacheHitTokens: number;
  cacheMissTokens: number; completionTokens: number; reasoningTokens: number; expectedPrefixTokens: number;
  billCacheRatePct: number; prefixRetentionPct: number | null; diagnosis: string; costCny: number; savedCny: number;
}

export interface SessionCostSummary {
  isReplay: boolean; periodLabel: string; rounds: RoundCostMetric[]; totalPromptTokens: number;
  totalCacheHitTokens: number; totalCompletionTokens: number; totalReasoningTokens: number;
  overallCacheRatePct: number; totalCostCny: number; totalSavedCny: number;
}

interface UnitRates {
  inMissPerM: number; cacheHitPerM: number; outPerM: number; minCacheTokens: number; periodLabel: string;
}

export function extractUsageFromSseLines(
  rawSseLines: readonly string[],
  fallbackModel = "unknown",
) {
  for (let i = rawSseLines.length - 1; i >= 0; i--) {
    const line = rawSseLines[i]!.trim();
    const jsonStr = line.startsWith("data:")
      ? line.slice(5).trim()
      : line.startsWith("[非流式 JSON 响应]")
        ? line.replace("[非流式 JSON 响应]", "").trim()
        : "";
    if (!jsonStr || jsonStr === "[DONE]") continue;
    try {
      const parsed = JSON.parse(jsonStr) as Record<string, any>;
      const u = parsed.usage;
      if (!u || typeof u.prompt_tokens !== "number") continue;
      const promptTokens = Math.max(0, Number(u.prompt_tokens));
      const rawHit = Number(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0);
      const cacheHitTokens = Math.min(promptTokens, Math.max(0, rawHit));
      const completionTokens = Math.max(0, Number(u.completion_tokens ?? 0));
      const rawReasoning = Number(u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens ?? 0);
      const respModel = String(parsed.model || fallbackModel);
      const displayModel =
        fallbackModel && fallbackModel !== "unknown" && respModel !== fallbackModel
          ? `${fallbackModel} (${respModel})`
          : respModel;
      return {
        model: displayModel,
        promptTokens,
        cacheHitTokens,
        cacheMissTokens: Math.max(0, promptTokens - cacheHitTokens),
        completionTokens,
        reasoningTokens: Math.min(completionTokens, Math.max(0, rawReasoning)),
      };
    } catch {
      continue;
    }
  }
  return null;
}

function resolveUnitRates(model: string, isoTimestamp: string): UnitRates {
  if (/agy|antigravity|argon|gemini/i.test(model)) {
    return { inMissPerM: 0, cacheHitPerM: 0, outPerM: 0, minCacheTokens: 0, periodLabel: "Antigravity 订阅额度桥接 (实付 ¥0)" };
  }
  if (/mimo/i.test(model)) {
    return { inMissPerM: 2.0, cacheHitPerM: 0.2, outPerM: 6.0, minCacheTokens: 1024, periodLabel: "小米 MiMo 2.6 计费档 (满 1024 tok 起缓)" };
  }
  const ts = Date.parse(isoTimestamp);
  const bj = new Date((Number.isFinite(ts) ? ts : Date.now()) + 8 * 3600_000);
  const day = bj.getUTCDay();
  const hour = bj.getUTCHours();
  const isPeak = day >= 1 && day <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
  return isPeak
    ? { inMissPerM: 2.0, cacheHitPerM: 0.2, outPerM: 8.0, minCacheTokens: 64, periodLabel: "DeepSeek 工作日标准价 (64 tok 块级缓存)" }
    : { inMissPerM: 1.0, cacheHitPerM: 0.1, outPerM: 4.0, minCacheTokens: 64, periodLabel: "DeepSeek 低谷半价窗 50% OFF (64 tok 块级缓存)" };
}

function computeRoundMetric(
  round: number,
  msgCount: number,
  usage: NonNullable<ReturnType<typeof extractUsageFromSseLines>>,
  rates: UnitRates,
  prev: RoundCostMetric | undefined,
  isReplay: boolean,
): RoundCostMetric {
  // completion_tokens 已含 reasoning_tokens，严禁重复相加计费
  const rawCost =
    (usage.cacheHitTokens * rates.cacheHitPerM +
      usage.cacheMissTokens * rates.inMissPerM +
      usage.completionTokens * rates.outPerM) /
    1_000_000;
  const noCacheCost = (usage.promptTokens * rates.inMissPerM + usage.completionTokens * rates.outPerM) / 1_000_000;
  const billCacheRatePct = usage.promptTokens > 0 ? (usage.cacheHitTokens / usage.promptTokens) * 100 : 0;

  let expectedPrefixTokens = 0;
  let prefixRetentionPct: number | null = null;
  let diagnosis = "第1次发请求";

  if (prev) {
    const prevContext = prev.promptTokens + (prev.completionTokens - prev.reasoningTokens);
    if (prevContext < rates.minCacheTokens || usage.promptTokens < rates.minCacheTokens) {
      diagnosis = `未满${rates.minCacheTokens}词不缓存`;
    } else {
      expectedPrefixTokens = Math.min(Math.floor(prevContext / 64) * 64, Math.floor(usage.promptTokens / 64) * 64);
      if (expectedPrefixTokens > 0) {
        prefixRetentionPct = Math.min(100, (Math.min(usage.cacheHitTokens, expectedPrefixTokens) / expectedPrefixTokens) * 100);
        diagnosis =
          prefixRetentionPct >= 99.5
            ? "旧内容100%命中"
            : `旧内容命中 ${prefixRetentionPct.toFixed(0)}%`;
      } else {
        diagnosis = `未满${rates.minCacheTokens}词不缓存`;
      }
    }
  }

  return {
    round,
    messageCount: msgCount,
    ...usage,
    expectedPrefixTokens,
    billCacheRatePct,
    prefixRetentionPct,
    diagnosis,
    costCny: isReplay ? 0 : rawCost,
    savedCny: isReplay ? noCacheCost : Math.max(0, noCacheCost - rawCost),
  };
}

export function summarizeWireCost(
  entries: readonly HttpWireLogEntry[],
  options: { isReplay?: boolean } = {},
): SessionCostSummary {
  const isReplay = Boolean(options.isReplay);
  const rounds: RoundCostMetric[] = [];
  let periodLabel = isReplay ? "📼 离线回放模式 (零网络请求 · 实付 ¥0)" : "未知计费档";

  entries.forEach((entry) => {
    const reqModel = String(entry.requestBody?.model ?? "unknown");
    const usage = extractUsageFromSseLines(entry.rawSseLines ?? [], reqModel);
    if (!usage) return;
    const rates = resolveUnitRates(usage.model, entry.roundTimestamp);
    if (!isReplay) periodLabel = rates.periodLabel;
    const msgCount = Array.isArray(entry.requestBody?.messages)
      ? entry.requestBody.messages.length
      : Number(entry.requestBody?.messageCount ?? 0);
    rounds.push(computeRoundMetric(rounds.length + 1, msgCount, usage, rates, rounds[rounds.length - 1], isReplay));
  });

  const totalPromptTokens = rounds.reduce((s, r) => s + r.promptTokens, 0);
  const totalCacheHitTokens = rounds.reduce((s, r) => s + r.cacheHitTokens, 0);
  const totalCompletionTokens = rounds.reduce((s, r) => s + r.completionTokens, 0);
  const totalReasoningTokens = rounds.reduce((s, r) => s + r.reasoningTokens, 0);

  return {
    isReplay,
    periodLabel,
    rounds,
    totalPromptTokens,
    totalCacheHitTokens,
    totalCompletionTokens,
    totalReasoningTokens,
    overallCacheRatePct: totalPromptTokens > 0 ? (totalCacheHitTokens / totalPromptTokens) * 100 : 0,
    totalCostCny: rounds.reduce((s, r) => s + r.costCny, 0),
    totalSavedCny: rounds.reduce((s, r) => s + r.savedCny, 0),
  };
}

export interface TurnMetricsSummary {
  activeModel: string; turnCostCny: number; turnSavedCny: number; sessionCostCny: number; totalCostCny: number;
  cacheHitRatePct: number; sessionCacheHitRatePct: number; lastStepCacheHitRatePct: number;
  contextTokens: number; stepCacheTrajectory: string;
}

export function computeTurnMetrics(wireLogFile: string, stepsUsed: number, isReplay = false): TurnMetricsSummary | null {
  try {
    if (!fs.existsSync(wireLogFile)) return null;
    const entries = JSON.parse(fs.readFileSync(wireLogFile, "utf-8")) as HttpWireLogEntry[];
    const s = Array.isArray(entries) && entries.length > 0 ? summarizeWireCost(entries, { isReplay }) : null;
    if (!s || s.rounds.length === 0) return null;
    let startIdx = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const reqBody = entries[i]?.requestBody as { messages?: { role?: string }[]; isSessionStart?: boolean } | undefined;
      const msgs = reqBody?.messages;
      if (reqBody?.isSessionStart || (Array.isArray(msgs) && !msgs.some((m) => m.role === "assistant"))) { startIdx = i; break; }
    }
    const sSession = startIdx > 0 ? summarizeWireCost(entries.slice(startIdx), { isReplay }) : s;
    const sessionRounds = sSession.rounds.length > 0 ? sSession.rounds : s.rounds;
    const turnRounds = sessionRounds.slice(-Math.max(1, (stepsUsed ?? 0) + 1));
    const turnIn = turnRounds.reduce((acc, r) => acc + r.promptTokens, 0);
    const turnHit = turnRounds.reduce((acc, r) => acc + r.cacheHitTokens, 0);
    const lastRound = turnRounds[turnRounds.length - 1];
    const stepCacheTrajectory = turnRounds.map((r) => `#${r.round}(${r.billCacheRatePct.toFixed(0)}%)`).join("→");
    const turnRate = turnIn > 0 ? (turnHit / turnIn) * 100 : sSession.overallCacheRatePct;
    return {
      activeModel: lastRound?.model || "unknown",
      turnCostCny: turnRounds.reduce((a, r) => a + r.costCny, 0),
      turnSavedCny: turnRounds.reduce((a, r) => a + r.savedCny, 0),
      sessionCostCny: sessionRounds.reduce((a, r) => a + r.costCny, 0),
      totalCostCny: s.totalCostCny,
      cacheHitRatePct: turnRate,
      sessionCacheHitRatePct: sSession.overallCacheRatePct,
      lastStepCacheHitRatePct: lastRound?.billCacheRatePct ?? turnRate,
      contextTokens: lastRound?.promptTokens ?? 0,
      stepCacheTrajectory,
    };
  } catch { return null; }
}

export function formatCostReport(summary: SessionCostSummary): string {
  if (summary.rounds.length === 0) return "";
  const rule = "─".repeat(66);
  const lines: string[] = [
    `\n[每步 Token 消耗与缓存账单] ${summary.periodLabel}`,
    rule,
    `${padCols("步骤", 6)} | ${padCols("命中缓存 / 总输入", 18)} | ${padCols("缓存状态", 16)} | ${padCols("输出", 6)} | 本步费用`,
    rule,
  ];
  for (const r of summary.rounds) {
    const inCol = padCols(`命中${r.cacheHitTokens}/共${r.promptTokens}`, 18, "right");
    const diagCol = padCols(r.diagnosis, 16);
    const outCol = padCols(`${r.completionTokens}词`, 6, "right");
    lines.push(
      `${padCols(`第${r.round}步`, 6)} | ${inCol} | ${diagCol} | ${outCol} | ¥${r.costCny.toFixed(4)} (省¥${r.savedCny.toFixed(4)})`,
    );
  }
  lines.push(rule);
  lines.push(
    `总计 ${summary.rounds.length} 步: 共输入 ${summary.totalPromptTokens} 词 (缓存命中 ${summary.totalCacheHitTokens} 词, 占 ${summary.overallCacheRatePct.toFixed(1)}%) | 实付 ¥${summary.totalCostCny.toFixed(4)}`,
  );
  return lines.join("\n");
}

export function loadAndFormatWireCost(wireLogFile = ".sessions/http-wire.json", options: { isReplay?: boolean } = {}): string {
  try {
    if (!fs.existsSync(wireLogFile)) return "";
    const entries = JSON.parse(fs.readFileSync(wireLogFile, "utf-8")) as HttpWireLogEntry[];
    return Array.isArray(entries) && entries.length > 0 ? formatCostReport(summarizeWireCost(entries, options)) : "";
  } catch { return ""; }
}
