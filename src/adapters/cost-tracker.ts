import * as fs from "node:fs";
import type { HttpWireLogEntry } from "./sse-stream.js";

export interface RoundCostMetric {
  round: number;
  model: string;
  messageCount: number;
  promptTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  expectedPrefixTokens: number;
  billCacheRatePct: number;
  prefixRetentionPct: number | null;
  diagnosis: string;
  costCny: number;
  savedCny: number;
}

export interface SessionCostSummary {
  isReplay: boolean;
  periodLabel: string;
  rounds: RoundCostMetric[];
  totalPromptTokens: number;
  totalCacheHitTokens: number;
  totalCompletionTokens: number;
  totalReasoningTokens: number;
  overallCacheRatePct: number;
  totalCostCny: number;
  totalSavedCny: number;
}

interface UnitRates {
  inMissPerM: number;
  cacheHitPerM: number;
  outPerM: number;
  minCacheTokens: number;
  periodLabel: string;
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
      return {
        model: String(parsed.model || fallbackModel),
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
  if (/mimo/i.test(model)) {
    return {
      inMissPerM: 2.0,
      cacheHitPerM: 0.2,
      outPerM: 6.0,
      minCacheTokens: 1024,
      periodLabel: "小米 MiMo 2.6 计费档 (满 1024 tok 起缓)",
    };
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
  let diagnosis = "⚪ 首轮建库";

  if (prev) {
    const prevContext = prev.promptTokens + (prev.completionTokens - prev.reasoningTokens);
    if (prevContext < rates.minCacheTokens || usage.promptTokens < rates.minCacheTokens) {
      diagnosis = `⚪ 未达起缓线 (<${rates.minCacheTokens})`;
    } else {
      expectedPrefixTokens = Math.min(Math.floor(prevContext / 64) * 64, Math.floor(usage.promptTokens / 64) * 64);
      if (expectedPrefixTokens > 0) {
        prefixRetentionPct = Math.min(100, (Math.min(usage.cacheHitTokens, expectedPrefixTokens) / expectedPrefixTokens) * 100);
        diagnosis = prefixRetentionPct >= 85 ? `🟢 前缀复用 ${prefixRetentionPct.toFixed(1)}%` : `🟡 前缀复用 ${prefixRetentionPct.toFixed(1)}%`;
      } else {
        diagnosis = `⚪ 未达起缓线 (<${rates.minCacheTokens})`;
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
    const msgCount = Array.isArray(entry.requestBody?.messages) ? entry.requestBody.messages.length : 0;
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

export function formatCostReport(summary: SessionCostSummary): string {
  if (summary.rounds.length === 0) return "";
  const lines: string[] = [
    `\n📊 [成本与 KV 缓存账单] ${summary.periodLabel}`,
    "----------------------------------------------------------------------------------------",
    "轮次 | 消息 | 总输入(tok) | 命中缓存(账单占比) | 历史前缀诊断         | 输出(含思考) | 实付(¥) / 缓存省(¥)",
    "----------------------------------------------------------------------------------------",
  ];
  for (const r of summary.rounds) {
    const hitStr = `${String(r.cacheHitTokens).padStart(6)} (${r.billCacheRatePct.toFixed(1).padStart(5)}%)`;
    const outStr = `${String(r.completionTokens).padStart(4)} (思${String(r.reasoningTokens).padStart(3)})`;
    lines.push(
      ` #${String(r.round).padEnd(2)} | ${String(r.messageCount).padStart(4)} | ${String(r.promptTokens).padStart(11)} | ${hitStr.padEnd(18)} | ${r.diagnosis.padEnd(18)} | ${outStr.padEnd(12)} | ¥${r.costCny.toFixed(4)} / 省¥${r.savedCny.toFixed(4)}`,
    );
  }
  lines.push("----------------------------------------------------------------------------------------");
  lines.push(
    ` 合计 (${summary.rounds.length}轮) | 输入 ${summary.totalPromptTokens} tok (命中 ${summary.totalCacheHitTokens} tok · 总缓 ${summary.overallCacheRatePct.toFixed(1)}%) | 输出 ${summary.totalCompletionTokens} tok | 💰实付 ¥${summary.totalCostCny.toFixed(4)} (净省 ¥${summary.totalSavedCny.toFixed(4)})`,
  );
  return lines.join("\n");
}

export function loadAndFormatWireCost(
  wireLogFile = ".sessions/http-wire.json",
  options: { isReplay?: boolean } = {},
): string {
  try {
    if (!fs.existsSync(wireLogFile)) return "";
    const entries = JSON.parse(fs.readFileSync(wireLogFile, "utf-8")) as HttpWireLogEntry[];
    return Array.isArray(entries) && entries.length > 0 ? formatCostReport(summarizeWireCost(entries, options)) : "";
  } catch {
    return "";
  }
}
