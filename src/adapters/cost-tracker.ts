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

export function truncateCols(str: string, maxCols: number): string {
  let width = 0;
  let out = "";
  for (const ch of str) {
    const w = (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
    if (width + w > maxCols) return `${out}..`;
    out += ch;
    width += w;
  }
  return out;
}

export function padCols(str: string, targetCols: number, align: "left" | "right" = "left"): string {
  let width = 0;
  for (const ch of str) width += (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
  const pad = Math.max(0, targetCols - width);
  return align === "right" ? " ".repeat(pad) + str : str + " ".repeat(pad);
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
