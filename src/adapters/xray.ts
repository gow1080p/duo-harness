import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEntry } from "../core/contracts.js";
import { extractUsageFromSseLines, padCols, truncateCols } from "./cost-tracker.js";
import type { HttpWireLogEntry } from "./sse-stream.js";
import { compactWireLogEntry, loadJsonlEntries, writeFileAtomicSync } from "./store.js";

export interface WireRoundXray {
  round: number; model: string; messageCount: number; prevMessageCount: number;
  lockedPrefixCount: number; mutatedIndices: number[]; appendedCount: number;
  preservedActiveReasoning: number; leakedOldReasoning: number;
  promptTokens: number; cachedTokens: number; totalChars: number; foldedCount: number;
  firstMutationDiff?: string; toolCallsSummary: string[]; reasoningPreview: string; statusLabel: string;
}

export interface SessionXrayReport {
  sessionFile: string; wireLogFile: string;
  treeNodes: { id: string; parentId: string | null; role: string; chars: number; summary: string }[];
  wireRounds: WireRoundXray[];
}

function realStrLen(raw: unknown): number {
  if (typeof raw !== "string") return 0;
  const m = raw.match(/\.\.\.\[len=(\d+),sha1=[0-9a-f]{10}\]$/);
  return m ? Number(m[1]) : raw.length;
}

function measureWireMsg(m: Record<string, any>): { chars: number; folded: boolean; preview: string } {
  const cStr =
    typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((p: any) => (p?.type === "text" ? String(p.text ?? "") : p?.image_url?.url ? String(p.image_url.url) : "")).join(" ")
        : "";
  const tcArr = Array.isArray(m.tool_calls) ? m.tool_calls : [];
  const tcArgs = tcArr.map((tc: any) => String(tc?.function?.arguments ?? "")).join(" ");
  const chars =
    (Array.isArray(m.content)
      ? m.content.reduce((s: number, p: any) => s + realStrLen(p?.text ?? p?.image_url?.url ?? ""), 0)
      : realStrLen(cStr)) + tcArr.reduce((acc: number, tc: any) => acc + realStrLen(tc?.function?.arguments), 0);
  const folded = cStr.includes("[已折叠历史") || tcArgs.includes("[已折叠历史");
  const rawPrev = (cStr || tcArgs).replace(/\s+/g, " ").slice(0, 48);
  return { chars, folded, preview: rawPrev };
}

function inspectSingleWireRound(
  entry: HttpWireLogEntry,
  idx: number,
  prevMsgs: Record<string, unknown>[],
): { roundXray: WireRoundXray; currentMsgs: Record<string, unknown>[] } {
  const currentMsgs = Array.isArray(entry.requestBody?.messages) ? (entry.requestBody.messages as Record<string, unknown>[]) : [];
  let lockedPrefixCount = 0;
  const mutatedIndices: number[] = [];
  const compareLen = Math.min(prevMsgs.length, currentMsgs.length);

  let prefixBroken = false;
  for (let i = 0; i < compareLen; i++) {
    const { reasoning_content: _p, ...prevClean } = prevMsgs[i] ?? {};
    const { reasoning_content: _c, ...currClean } = currentMsgs[i] ?? {};
    const same = JSON.stringify(prevClean) === JSON.stringify(currClean);
    if (same && !prefixBroken) lockedPrefixCount += 1;
    else if (!same) { prefixBroken = true; mutatedIndices.push(i); }
  }

  let firstMutationDiff: string | undefined;
  if (mutatedIndices.length > 0) {
    const mIdx = mutatedIndices[0]!;
    const pMsg = (prevMsgs[mIdx] ?? {}) as Record<string, any>, cMsg = (currentMsgs[mIdx] ?? {}) as Record<string, any>;
    const role = cMsg.role === "tool" ? `tool:${cMsg.name ?? ""}` : String(cMsg.role ?? "msg");
    firstMutationDiff = `msg[${mIdx}](${role}): "${measureWireMsg(pMsg).preview}" ➔ "${measureWireMsg(cMsg).preview}"`;
  }

  let lastUserIdx = -1;
  for (let i = currentMsgs.length - 1; i >= 0; i--) {
    if (currentMsgs[i]?.role === "user") { lastUserIdx = i; break; }
  }
  let preservedActiveReasoning = 0, leakedOldReasoning = 0, totalChars = 0, foldedCount = 0;
  for (let i = 0; i < currentMsgs.length; i++) {
    const m = currentMsgs[i]!;
    const stat = measureWireMsg(m);
    const activeReasonLen = i > lastUserIdx && m.role === "assistant" ? realStrLen(m.reasoning_content) : 0;
    totalChars += stat.chars + activeReasonLen;
    if (stat.folded) foldedCount += 1;
    if (m.role === "assistant" && typeof m.reasoning_content === "string" && m.reasoning_content.length > 0) {
      if (i > lastUserIdx) preservedActiveReasoning += 1;
      else leakedOldReasoning += 1;
    }
  }

  const usageInfo = extractUsageFromSseLines(entry.rawSseLines ?? [], String(entry.requestBody?.model ?? "unknown"));
  const calls = entry.assembledMessage?.toolCalls ?? [];
  const toolCallsSummary = calls.map((c) => {
    const argVal = String(c.arguments.pattern ?? c.arguments.path ?? c.arguments.command ?? "");
    return argVal ? `${c.name}(${argVal.slice(0, 14)})` : c.name;
  });
  const reasoning = entry.assembledMessage?.reasoningContent ?? "";
  const mutTag = mutatedIndices.length > 3 ? `${mutatedIndices.slice(0, 2).join(",")}..共${mutatedIndices.length}条` : mutatedIndices.join(",");
  const statusLabel = idx === 0 ? "第1次提问" : mutatedIndices.length === 0 && lockedPrefixCount === prevMsgs.length ? "旧消息未改动(正常)" : `警告:第[${mutTag}]条被改`;

  return {
    currentMsgs,
    roundXray: {
      round: idx + 1, model: usageInfo?.model ?? String(entry.requestBody?.model ?? "unknown"),
      messageCount: currentMsgs.length, prevMessageCount: prevMsgs.length, lockedPrefixCount, mutatedIndices,
      appendedCount: Math.max(0, currentMsgs.length - prevMsgs.length), preservedActiveReasoning, leakedOldReasoning,
      promptTokens: usageInfo?.promptTokens ?? 0, cachedTokens: usageInfo?.cacheHitTokens ?? 0,
      totalChars, foldedCount, firstMutationDiff, toolCallsSummary,
      reasoningPreview: reasoning.replace(/\n/g, " ").slice(0, 60), statusLabel,
    },
  };
}

export function analyzeSessionXray(
  sessionFile = ".sessions/play.jsonl",
  wireLogFile = ".sessions/http-wire.json",
): SessionXrayReport {
  const entries: SessionEntry[] = fs.existsSync(sessionFile) ? loadJsonlEntries(sessionFile) : [];
  const wireEntries: HttpWireLogEntry[] = fs.existsSync(wireLogFile)
    ? (JSON.parse(fs.readFileSync(wireLogFile, "utf-8")) as HttpWireLogEntry[]).map(compactWireLogEntry)
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
  const rule = "─".repeat(78);
  const lines: string[] = [
    `\n[每步消息与工具调用明细] (${report.sessionFile})`,
    rule,
    `${padCols("步骤", 5)} | ${padCols("消息组成", 9)} | ${padCols("缓存命中", 12)} | ${padCols("体积(已折)", 11)} | ${padCols("历史消息检查", 16)} | 本步动作`,
    rule,
  ];
  const mutLogs: string[] = [];

  for (const r of report.wireRounds) {
    const msgText = r.lockedPrefixCount === 0 ? `${r.appendedCount}条新消息` : `${r.lockedPrefixCount}旧+${r.appendedCount}新`;
    const pct = r.promptTokens > 0 ? `${Math.round((r.cachedTokens / r.promptTokens) * 100)}%` : "-";
    const cacheStr = r.promptTokens > 0 ? `${pct}(${(r.cachedTokens / 1000).toFixed(0)}k/${(r.promptTokens / 1000).toFixed(0)}k)` : "-";
    const volStr = `${(r.totalChars / 1024).toFixed(1)}K(折${r.foldedCount})`;
    const actRaw = r.toolCallsSummary.length > 0 ? r.toolCallsSummary.join(", ") : "输出最终回答";
    lines.push(`${padCols(`第${r.round}步`, 5)} | ${padCols(msgText, 9)} | ${padCols(cacheStr, 12)} | ${padCols(volStr, 11)} | ${padCols(truncateCols(r.statusLabel, 16), 16)} | ${truncateCols(actRaw, 10)}`);
    if (r.firstMutationDiff) {
      const idxSummary = r.mutatedIndices.length > 4 ? `${r.mutatedIndices.slice(0, 3).join(",")}..(${r.mutatedIndices.length}条)` : r.mutatedIndices.join(",");
      mutLogs.push(`  • 第${r.round}步 (${pct} · 改[${idxSummary}]): ${r.firstMutationDiff}`);
    }
  }

  lines.push(rule);
  if (mutLogs.length > 0) {
    lines.push(`[缓存前缀改写自动取证]:`, ...mutLogs, rule);
  }
  lines.push(`[硬盘保存的消息记录] (共 ${report.treeNodes.length} 条):`);
  for (const n of report.treeNodes) {
    const pTag = padCols(n.parentId ? `<-${n.parentId}` : "(起点)", 8);
    lines.push(`  ${padCols(n.id, 6)} [${padCols(n.role, 14)}] ${pTag} ${padCols(`${n.chars}字`, 6, "right")}: ${n.summary}`);
  }
  return lines.join("\n");
}

export function syncXrayCacheSnapshot(wireLogFile: string): void {
  try {
    const dir = path.dirname(wireLogFile);
    const sessionFile = fs.existsSync(path.join(dir, "chat.jsonl")) ? path.join(dir, "chat.jsonl") : path.join(dir, "play.jsonl");
    const report = analyzeSessionXray(sessionFile, wireLogFile);
    writeFileAtomicSync(path.join(dir, "xray-cache.md"), `# 🔬 实时缓存与前缀锁定透视报告\n\n\`\`\`text\n${formatXrayReport(report)}\n\`\`\`\n`);
  } catch {}
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
