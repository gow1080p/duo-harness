import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEntry } from "../core/contracts.js";
import { extractUsageFromSseLines, padCols, truncateCols } from "./cost-tracker.js";
import type { HttpWireLogEntry } from "./sse-stream.js";
import { loadJsonlEntries } from "./store.js";

export interface WireRoundXray {
  round: number;
  model: string;
  messageCount: number;
  prevMessageCount: number;
  lockedPrefixCount: number;
  mutatedIndices: number[];
  appendedCount: number;
  preservedActiveReasoning: number;
  leakedOldReasoning: number;
  promptTokens: number;
  cachedTokens: number;
  toolCallsSummary: string[];
  reasoningPreview: string;
  statusLabel: string;
}

export interface SessionXrayReport {
  sessionFile: string;
  wireLogFile: string;
  treeNodes: {
    id: string;
    parentId: string | null;
    role: string;
    chars: number;
    summary: string;
  }[];
  wireRounds: WireRoundXray[];
}

function inspectSingleWireRound(
  entry: HttpWireLogEntry,
  idx: number,
  prevMsgs: Record<string, unknown>[],
): { roundXray: WireRoundXray; currentMsgs: Record<string, unknown>[] } {
  const currentMsgs = Array.isArray(entry.requestBody?.messages)
    ? (entry.requestBody.messages as Record<string, unknown>[])
    : [];
  let lockedPrefixCount = 0;
  const mutatedIndices: number[] = [];
  const compareLen = Math.min(prevMsgs.length, currentMsgs.length);

  let prefixBroken = false;
  for (let i = 0; i < compareLen; i++) {
    const same = JSON.stringify(prevMsgs[i]) === JSON.stringify(currentMsgs[i]);
    if (same && !prefixBroken) {
      lockedPrefixCount += 1;
    } else if (!same) {
      prefixBroken = true;
      mutatedIndices.push(i);
    }
  }

  let lastUserIdx = -1;
  for (let i = currentMsgs.length - 1; i >= 0; i--) {
    if (currentMsgs[i]?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  let preservedActiveReasoning = 0;
  let leakedOldReasoning = 0;
  for (let i = 0; i < currentMsgs.length; i++) {
    const m = currentMsgs[i]!;
    if (m.role === "assistant" && typeof m.reasoning_content === "string" && m.reasoning_content.length > 0) {
      if (i > lastUserIdx) preservedActiveReasoning += 1;
      else leakedOldReasoning += 1;
    }
  }

  const usageInfo = extractUsageFromSseLines(
    entry.rawSseLines ?? [],
    String(entry.requestBody?.model ?? "unknown"),
  );
  const calls = entry.assembledMessage?.toolCalls ?? [];
  const toolCallsSummary = calls.map((c) => {
    const argVal = String(c.arguments.pattern ?? c.arguments.path ?? c.arguments.command ?? "");
    return argVal ? `${c.name}(${argVal.slice(0, 14)})` : c.name;
  });
  const reasoning = entry.assembledMessage?.reasoningContent ?? "";

  let statusLabel = "第1次提问";
  if (idx > 0) {
    statusLabel =
      mutatedIndices.length === 0 && lockedPrefixCount === prevMsgs.length
        ? "旧消息未改动(正常)"
        : `警告:第[${mutatedIndices.join(",")}]条被改`;
  }

  return {
    currentMsgs,
    roundXray: {
      round: idx + 1,
      model: usageInfo?.model ?? String(entry.requestBody?.model ?? "unknown"),
      messageCount: currentMsgs.length,
      prevMessageCount: prevMsgs.length,
      lockedPrefixCount,
      mutatedIndices,
      appendedCount: Math.max(0, currentMsgs.length - prevMsgs.length),
      preservedActiveReasoning,
      leakedOldReasoning,
      promptTokens: usageInfo?.promptTokens ?? 0,
      cachedTokens: usageInfo?.cacheHitTokens ?? 0,
      toolCallsSummary,
      reasoningPreview: reasoning.replace(/\n/g, " ").slice(0, 60),
      statusLabel,
    },
  };
}

export function analyzeSessionXray(
  sessionFile = ".sessions/play.jsonl",
  wireLogFile = ".sessions/http-wire.json",
): SessionXrayReport {
  const entries: SessionEntry[] = fs.existsSync(sessionFile) ? loadJsonlEntries(sessionFile) : [];
  const wireEntries: HttpWireLogEntry[] = fs.existsSync(wireLogFile)
    ? (JSON.parse(fs.readFileSync(wireLogFile, "utf-8")) as HttpWireLogEntry[])
    : [];

  const treeNodes = entries.map((e) => {
    const m = e.message;
    const calls = m.role === "assistant" && m.toolCalls ? ` -> [${m.toolCalls.map((c) => c.name).join(",")}]` : "";
    const rawText = `${m.content.replace(/\n/g, " ")}${calls}`;
    return {
      id: e.id,
      parentId: e.parentId,
      role: m.role === "tool" ? `tool:${m.name}` : m.role,
      chars: m.content.length,
      summary: truncateCols(rawText, 28),
    };
  });

  const wireRounds: WireRoundXray[] = [];
  let prevMsgs: Record<string, unknown>[] = [];
  for (let i = 0; i < wireEntries.length; i++) {
    const { roundXray, currentMsgs } = inspectSingleWireRound(wireEntries[i]!, i, prevMsgs);
    wireRounds.push(roundXray);
    prevMsgs = currentMsgs;
  }

  return { sessionFile, wireLogFile, treeNodes, wireRounds };
}

export function formatXrayReport(report: SessionXrayReport): string {
  const rule = "─".repeat(66);
  const lines: string[] = [
    `\n[每步消息与工具调用明细] (${report.sessionFile})`,
    rule,
    `${padCols("步骤", 5)} | ${padCols("发出的消息", 10)} | ${padCols("历史消息检查", 18)} | 本步执行的动作`,
    rule,
  ];

  for (const r of report.wireRounds) {
    const msgText =
      r.lockedPrefixCount === 0
        ? `${r.appendedCount}条新消息`
        : `${r.lockedPrefixCount}旧 + ${r.appendedCount}新`;
    const msgCol = padCols(msgText, 10);
    const statusCol = padCols(r.statusLabel, 18);
    const actRaw = r.toolCallsSummary.length > 0 ? r.toolCallsSummary.join(", ") : "输出最终回答";
    lines.push(`${padCols(`第${r.round}步`, 5)} | ${msgCol} | ${statusCol} | ${truncateCols(actRaw, 24)}`);
  }

  lines.push(rule);
  lines.push(`[硬盘保存的消息记录] (共 ${report.treeNodes.length} 条):`);
  for (const n of report.treeNodes) {
    const pTag = padCols(n.parentId ? `<-${n.parentId}` : "(起点)", 8);
    lines.push(`  ${padCols(n.id, 6)} [${padCols(n.role, 14)}] ${pTag} ${padCols(`${n.chars}字`, 6, "right")}: ${n.summary}`);
  }
  return lines.join("\n");
}

export function writeXrayMarkdownReport(
  report: SessionXrayReport,
  outFile = ".sessions/xray-report.md",
): string {
  const mermaidLines = [
    "# 🔬 每步消息与工具调用明细报告",
    "",
    "```mermaid",
    "sequenceDiagram",
    "  participant U as Agent 循环",
    "  participant R as 网络请求 (Router)",
    "  participant M as 云端模型",
    "  participant T as 本地工具",
  ];
  for (const r of report.wireRounds) {
    mermaidLines.push(`  U->>R: 第${r.round}步 (共${r.messageCount}条消息, 其中${r.lockedPrefixCount}条旧消息未改动)`);
    mermaidLines.push(`  R->>M: 发送请求 (总输入=${r.promptTokens}词, 缓存命中=${r.cachedTokens}词)`);
    if (r.toolCallsSummary.length > 0) {
      mermaidLines.push(`  M-->>T: 调用 ${r.toolCallsSummary.join(", ").replace(/["{}]/g, "")}`);
      mermaidLines.push(`  T-->>U: 返回工具执行结果`);
    } else {
      mermaidLines.push(`  M-->>U: 返回最终回答`);
    }
  }
  mermaidLines.push("```", "", "```text", formatXrayReport(report), "```");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, mermaidLines.join("\n"), "utf-8");
  return outFile;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const sessionFile = process.argv[2] || ".sessions/play.jsonl";
  const wireLogFile = process.argv[3] || ".sessions/http-wire.json";
  const report = analyzeSessionXray(sessionFile, wireLogFile);
  console.log(formatXrayReport(report));
  const mdFile = writeXrayMarkdownReport(report);
  console.log(`\n📄 [已生成可视化时序图与明细报告]: ${mdFile}`);
}
