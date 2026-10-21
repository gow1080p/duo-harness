import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEntry } from "../core/contracts.js";
import { extractUsageFromSseLines } from "./cost-tracker.js";
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
  const toolCallsSummary = calls.map((c) => `${c.name}(${JSON.stringify(c.arguments).slice(0, 40)})`);
  const reasoning = entry.assembledMessage?.reasoningContent ?? "";

  let statusLabel = "🔵 首轮建库";
  if (idx > 0) {
    statusLabel =
      mutatedIndices.length === 0 && lockedPrefixCount === prevMsgs.length
        ? `🟢 前缀100%锁死 (${lockedPrefixCount}/${prevMsgs.length}条恒等)`
        : `🟡 改写历史第[${mutatedIndices.join(",")}]条 (锁前${lockedPrefixCount}条)`;
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
    const calls = m.role === "assistant" && m.toolCalls ? ` -> 🛠️ ${m.toolCalls.map((c) => c.name).join(",")}` : "";
    const preview = m.content.replace(/\n/g, " ").slice(0, 42);
    return {
      id: e.id,
      parentId: e.parentId,
      role: m.role === "tool" ? `tool:${m.name}` : m.role,
      chars: m.content.length,
      summary: `${preview}${m.content.length > 42 ? "..." : ""}${calls}`,
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
  const lines: string[] = [
    `\n🔬 [Duo-Harness X-Ray 零黑盒物理透视台] (会话: ${report.sessionFile} | 抓包: ${report.wireLogFile})`,
    "─".repeat(104),
    "轮次 | 消息数(锁/增) | 物理前缀字节比对诊断                 | 同轮思考链 | 云端缓存(hit/in) | 本轮动作与思考切片",
    "─".repeat(104),
  ];

  for (const r of report.wireRounds) {
    const msgStat = `${String(r.messageCount).padStart(2)} (${r.lockedPrefixCount}/${r.appendedCount})`.padEnd(13);
    const thinkStat = r.leakedOldReasoning > 0 ? `🔴漏${r.leakedOldReasoning}` : `🟢留${r.preservedActiveReasoning}`;
    const cacheStat = `${r.cachedTokens}/${r.promptTokens}`.padStart(14);
    const action = r.toolCallsSummary.length > 0 ? `🛠️ ${r.toolCallsSummary.join(", ")}` : "✅ 最终回复";
    lines.push(
      ` #${r.round}  | ${msgStat} | ${r.statusLabel.padEnd(32)} | ${thinkStat.padEnd(8)} | ${cacheStat}   | ${action}`,
    );
  }

  lines.push("─".repeat(104));
  lines.push(`🌳 [.jsonl 会话树节点拓扑] (共 ${report.treeNodes.length} 个不可变节点):`);
  for (const n of report.treeNodes) {
    const parentTag = n.parentId ? `<- ${n.parentId}` : "(root)";
    lines.push(`  • ${n.id.padEnd(6)} [${n.role.padEnd(14)}] ${parentTag.padEnd(9)} (${String(n.chars).padStart(4)}字): ${n.summary}`);
  }
  return lines.join("\n");
}

export function writeXrayMarkdownReport(
  report: SessionXrayReport,
  outFile = ".sessions/xray-report.md",
): string {
  const mermaidLines = [
    "# 🔬 Duo-Harness 零黑盒全链路透视报告 (X-Ray)",
    "",
    "```mermaid",
    "sequenceDiagram",
    "  participant U as User / Loop",
    "  participant R as Router (Wire)",
    "  participant M as Cloud LLM",
    "  participant T as Sandbox Tools",
  ];
  for (const r of report.wireRounds) {
    mermaidLines.push(`  U->>R: Round #${r.round} (${r.messageCount} msgs, locked=${r.lockedPrefixCount})`);
    mermaidLines.push(`  R->>M: POST /chat/completions (in=${r.promptTokens}, hit=${r.cachedTokens})`);
    if (r.toolCallsSummary.length > 0) {
      mermaidLines.push(`  M-->>T: ${r.toolCallsSummary.join(", ").replace(/["{}]/g, "")}`);
      mermaidLines.push(`  T-->>U: ToolResultMessage`);
    } else {
      mermaidLines.push(`  M-->>U: Final Answer`);
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
  console.log(`\n📄 [已生成可视化 Mermaid 时序与透视报告]: ${mdFile}`);
}
