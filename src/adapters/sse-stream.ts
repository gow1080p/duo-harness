import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage } from "../core/contracts.js";
import { parseOpenAiAssistantMessage } from "./router.js";

export interface HttpWireLogEntry {
  roundTimestamp: string;
  apiUrl: string;
  requestBody: Record<string, unknown>;
  rawSseLines: string[];
  assembledMessage: AssistantMessage;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  argsRaw: string;
}

export function assembleSsePayloads(dataPayloads: readonly string[]): AssistantMessage {
  let content = "";
  let reasoning = "";
  let hasReasoning = false;
  const toolMap = new Map<number, ToolCallAccumulator>();

  for (const payload of dataPayloads) {
    const trimmed = payload.trim();
    if (!trimmed || trimmed === "[DONE]") continue;
    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, any>;
    } catch {
      continue;
    }
    const delta = parsed.choices?.[0]?.delta;
    if (!delta) continue;
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      hasReasoning = true;
      reasoning += delta.reasoning_content;
    }
    if (typeof delta.content === "string" && delta.content.length > 0) content += delta.content;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === "number" ? tc.index : 0;
        const acc = toolMap.get(idx) ?? { id: "", name: "", argsRaw: "" };
        if (typeof tc.id === "string" && tc.id.length > 0) acc.id = tc.id;
        if (typeof tc.function?.name === "string" && tc.function.name.length > 0 && !acc.name) acc.name = tc.function.name;
        if (typeof tc.function?.arguments === "string") acc.argsRaw += tc.function.arguments;
        toolMap.set(idx, acc);
      }
    }
  }

  const rawToolCalls = Array.from(toolMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([idx, acc]) => ({
      id: acc.id || `call_${idx}`,
      type: "function",
      function: { name: acc.name || "unknown", arguments: acc.argsRaw || "{}" },
    }));

  return parseOpenAiAssistantMessage({
    content,
    ...(hasReasoning ? { reasoning_content: reasoning } : {}),
    ...(rawToolCalls.length > 0 ? { tool_calls: rawToolCalls } : {}),
  });
}

export async function readOpenAiSseStream(
  res: Response,
  onDeltaText?: (text: string) => void,
  onReasoningDelta?: (text: string) => void,
): Promise<{ message: AssistantMessage; rawSseLines: string[] }> {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream") || !res.body) {
    const data = (await res.json()) as Record<string, any>;
    const rawMsg = data.choices?.[0]?.message;
    if (!rawMsg) throw new Error("LLM 响应缺少 choices[0].message 字段");
    if (typeof rawMsg.reasoning_content === "string" && rawMsg.reasoning_content) onReasoningDelta?.(rawMsg.reasoning_content);
    if (typeof rawMsg.content === "string" && rawMsg.content) onDeltaText?.(rawMsg.content);
    return { message: parseOpenAiAssistantMessage(rawMsg), rawSseLines: [`[非流式 JSON 响应] ${JSON.stringify(data)}`] };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const rawSseLines: string[] = [];
  const dataPayloads: string[] = [];
  let buffer = "";

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    rawSseLines.push(trimmed);
    const payload = trimmed.slice(5).trim();
    dataPayloads.push(payload);
    if (!payload || payload === "[DONE]" || (!onDeltaText && !onReasoningDelta)) return;
    try {
      const delta = (JSON.parse(payload) as Record<string, any>).choices?.[0]?.delta;
      if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) onReasoningDelta?.(delta.reasoning_content);
      if (typeof delta?.content === "string" && delta.content) onDeltaText?.(delta.content);
    } catch {
      // 忽略单行非 JSON 注释或心跳
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) processLine(line);
  }
  buffer += decoder.decode();
  if (buffer.trim()) processLine(buffer);
  return { message: assembleSsePayloads(dataPayloads), rawSseLines };
}

function getVisualCols(s: string): number {
  let w = 0;
  for (const ch of s.replace(/\x1b\[[0-9;]*m/g, "")) w += (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
  return w;
}

function formatInlineMarkdown(line: string): string {
  return line.replace(/`([^`]+)`/g, "\x1b[36m$1\x1b[0m").replace(/\*\*([^*]+)\*\*/g, "\x1b[1;97m$1\x1b[0m");
}

export function formatMarkdownLine(rawLine: string, inCodeBlock: boolean): { text: string; nextInCodeBlock: boolean } {
  const fenceMatch = rawLine.match(/^\s*```(\w*)\s*$/);
  if (fenceMatch) {
    return inCodeBlock
      ? { text: "\x1b[90m  ╰────────────────────────\x1b[0m", nextInCodeBlock: false }
      : { text: `\x1b[90m  ╭── ${fenceMatch[1] || "code"} ────────────────\x1b[0m`, nextInCodeBlock: true };
  }
  if (inCodeBlock) return { text: `\x1b[90m  │ \x1b[0m\x1b[32m${rawLine}\x1b[0m`, nextInCodeBlock: true };
  const headingMatch = rawLine.match(/^(#{1,6})\s+(.*)$/);
  if (headingMatch) return { text: `\x1b[1;36m▍ ${formatInlineMarkdown(headingMatch[2]!)}\x1b[0m`, nextInCodeBlock: false };
  const bulletMatch = rawLine.match(/^(\s*)[-*]\s+(.*)$/);
  if (bulletMatch) return { text: `${bulletMatch[1]!}\x1b[36m•\x1b[0m ${formatInlineMarkdown(bulletMatch[2]!)}`, nextInCodeBlock: false };
  return { text: formatInlineMarkdown(rawLine), nextInCodeBlock: false };
}

export function createStreamRenderer(stream: { write: (s: string) => unknown; columns?: number } = process.stdout) {
  let inReasoning = false;
  let hasStartedContent = false;
  let inCodeBlock = false;
  let currentLine = "";
  let linePrefix = "";

  const commitCurrentLine = (withNewline: boolean) => {
    const { text: formatted, nextInCodeBlock } = formatMarkdownLine(currentLine, inCodeBlock);
    inCodeBlock = nextInCodeBlock;
    const totalCols = getVisualCols(linePrefix + currentLine);
    if (formatted !== currentLine && totalCols < (stream.columns ?? 80) - 4) {
      stream.write(`\r\x1b[K${linePrefix}${formatted}${withNewline ? "\n" : ""}`);
    } else if (withNewline) {
      stream.write("\n");
    }
    currentLine = "";
    linePrefix = "";
  };

  return {
    onReasoning(chunk: string) {
      if (!inReasoning) {
        stream.write("\n💭 \x1b[2m\x1b[3m");
        inReasoning = true;
      }
      stream.write(chunk.replace(/\r?\n+/g, " "));
    },
    onContent(chunk: string) {
      if (inReasoning) {
        stream.write("\x1b[0m\n");
        inReasoning = false;
      }
      if (!hasStartedContent) {
        linePrefix = "💬 ";
        stream.write(`\n${linePrefix}`);
        hasStartedContent = true;
      }
      const parts = chunk.split("\n");
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        if (part) {
          stream.write(part);
          currentLine += part;
        }
        if (i < parts.length - 1) commitCurrentLine(true);
      }
    },
    flush() {
      if (inReasoning) {
        stream.write("\x1b[0m\n");
        inReasoning = false;
      }
      if (currentLine.length > 0) commitCurrentLine(false);
      if (hasStartedContent) stream.write("\x1b[0m\n");
    },
  };
}

/**
 * 3. 将每次请求体、SSE 原始碎片流和拼接结果写入 .sessions/http-wire.json 供编辑器直观查看
 */
export function recordHttpWireLog(
  entry: HttpWireLogEntry,
  wireFilePath = ".sessions/http-wire.json",
  resetFile = false,
): void {
  fs.mkdirSync(path.dirname(wireFilePath), { recursive: true });
  let existing: HttpWireLogEntry[] = [];
  if (!resetFile && fs.existsSync(wireFilePath)) {
    try {
      existing = JSON.parse(fs.readFileSync(wireFilePath, "utf-8"));
      if (!Array.isArray(existing)) existing = [];
    } catch {
      existing = [];
    }
  }
  existing.push(entry);
  fs.writeFileSync(wireFilePath, JSON.stringify(existing, null, 2), "utf-8");
}
