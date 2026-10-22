import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage, LlmStreamEvent } from "../core/contracts.js";
import { parseOpenAiAssistantMessage } from "./router.js";

export function getVisualCols(s: string): number {
  let w = 0;
  for (const ch of s.replace(/\x1b\[[0-9;]*m/g, "")) w += (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
  return w;
}

function formatInlineMarkdown(line: string): string {
  return line.replace(/`([^`]+)`/g, "\x1b[36m$1\x1b[0m").replace(/\*\*([^*]+)\*\*/g, "\x1b[1;97m$1\x1b[0m").replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1\x1b[3m$2\x1b[0m");
}

export function formatMarkdownLine(rawLine: string, inCodeBlock: boolean): { text: string; nextInCodeBlock: boolean } {
  const fenceMatch = rawLine.match(/^\s*```(\w*)\s*$/);
  if (fenceMatch) {
    return inCodeBlock ? { text: "\x1b[90m  ╰────────────────────────\x1b[0m", nextInCodeBlock: false } : { text: `\x1b[90m  ╭── ${fenceMatch[1] || "code"} ────────────────\x1b[0m`, nextInCodeBlock: true };
  }
  if (inCodeBlock) return { text: `\x1b[90m  │ \x1b[0m\x1b[32m${rawLine}\x1b[0m`, nextInCodeBlock: true };
  if (/^\s*(?:---+|\*\*\*+)\s*$/.test(rawLine)) return { text: "\x1b[90m  ────────────────────────────────────────\x1b[0m", nextInCodeBlock: false };
  if (/^\s*\|[\s:|-]+\|\s*$/.test(rawLine)) return { text: "\x1b[90m  ├────────────────────────────────────────┤\x1b[0m", nextInCodeBlock: false };
  if (/^\s*\|.*\|\s*$/.test(rawLine)) {
    const cells = rawLine.trim().replace(/^\||\|$/g, "").split("|").map((c) => formatInlineMarkdown(c.trim()));
    return { text: `  \x1b[90m│\x1b[0m ${cells.join(" \x1b[90m│\x1b[0m ")} \x1b[90m│\x1b[0m`, nextInCodeBlock: false };
  }
  const headingMatch = rawLine.match(/^(#{1,6})\s+(.*)$/);
  if (headingMatch) {
    const body = formatInlineMarkdown(headingMatch[2]!);
    return { text: headingMatch[1]!.length <= 2 ? `\x1b[1;36m▍ ${body}\x1b[0m` : `\x1b[1;33m▸ ${body}\x1b[0m`, nextInCodeBlock: false };
  }
  const quoteMatch = rawLine.match(/^(\s*)>\s?(.*)$/);
  if (quoteMatch) return { text: `${quoteMatch[1]!}\x1b[90m▎\x1b[0m \x1b[3m${formatInlineMarkdown(quoteMatch[2]!)}\x1b[0m`, nextInCodeBlock: false };
  const bulletMatch = rawLine.match(/^(\s*)[-*]\s+(.*)$/);
  if (bulletMatch) return { text: `${bulletMatch[1]!}\x1b[36m•\x1b[0m ${formatInlineMarkdown(bulletMatch[2]!)}`, nextInCodeBlock: false };
  const numMatch = rawLine.match(/^(\s*)(\d+\.)\s+(.*)$/);
  if (numMatch) return { text: `${numMatch[1]!}\x1b[36m${numMatch[2]!}\x1b[0m ${formatInlineMarkdown(numMatch[3]!)}`, nextInCodeBlock: false };
  return { text: formatInlineMarkdown(rawLine), nextInCodeBlock: false };
}

export interface HttpWireLogEntry {
  roundTimestamp: string;
  apiUrl: string;
  requestBody: Record<string, unknown>;
  rawSseLines: string[];
  assembledMessage: AssistantMessage;
}

export function assembleSsePayloads(dataPayloads: readonly string[]): AssistantMessage {
  let content = "", reasoning = "", hasReasoning = false;
  const toolMap = new Map<number, { id: string; name: string; argsRaw: string }>();

  for (const payload of dataPayloads) {
    const trimmed = payload.trim();
    if (!trimmed || trimmed === "[DONE]") continue;
    let parsed: Record<string, any>;
    try { parsed = JSON.parse(trimmed) as Record<string, any>; } catch { continue; }
    const delta = parsed.choices?.[0]?.delta;
    if (!delta) continue;
    const rChunk = typeof delta.reasoning_content === "string" ? delta.reasoning_content : delta.reasoning;
    if (typeof rChunk === "string" && rChunk.length > 0) { hasReasoning = true; reasoning += rChunk; }
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
  const rawToolCalls = Array.from(toolMap.entries()).sort(([a], [b]) => a - b).map(([idx, acc]) => ({
    id: acc.id || `call_${idx}`,
    type: "function",
    function: { name: acc.name || "unknown", arguments: acc.argsRaw || "{}" },
  }));
  return parseOpenAiAssistantMessage({ content, ...(hasReasoning ? { reasoning_content: reasoning } : {}), ...(rawToolCalls.length > 0 ? { tool_calls: rawToolCalls } : {}) });
}

export async function readOpenAiSseStream(
  res: Response,
  onDeltaText?: (text: string) => void,
  onReasoningDelta?: (text: string) => void,
  onStreamEvent?: (event: LlmStreamEvent) => void,
): Promise<{ message: AssistantMessage; rawSseLines: string[] }> {
  const emitReasoning = (text: string) => {
    onReasoningDelta?.(text);
    onStreamEvent?.({ type: "reasoning_delta", text });
  };
  const emitContent = (text: string) => {
    onDeltaText?.(text);
    onStreamEvent?.({ type: "content_delta", text });
  };
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream") || !res.body) {
    const data = (await res.json()) as Record<string, any>;
    const rawMsg = data.choices?.[0]?.message;
    if (!rawMsg) throw new Error("LLM 响应缺少 choices[0].message 字段");
    if (typeof rawMsg.reasoning_content === "string" && rawMsg.reasoning_content) emitReasoning(rawMsg.reasoning_content);
    if (typeof rawMsg.content === "string" && rawMsg.content) emitContent(rawMsg.content);
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
    if (!payload || payload === "[DONE]" || (!onDeltaText && !onReasoningDelta && !onStreamEvent)) return;
    try {
      const delta = (JSON.parse(payload) as Record<string, any>).choices?.[0]?.delta;
      const rText = typeof delta?.reasoning_content === "string" ? delta.reasoning_content : delta?.reasoning;
      if (typeof rText === "string" && rText) emitReasoning(rText);
      if (typeof delta?.content === "string" && delta.content) emitContent(delta.content);
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          onStreamEvent?.({
            type: "tool_call_delta",
            index: typeof tc.index === "number" ? tc.index : 0,
            name: typeof tc.function?.name === "string" ? tc.function.name : undefined,
            argsDelta: typeof tc.function?.arguments === "string" ? tc.function.arguments : "",
          });
        }
      }
    } catch {}
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

export function createStreamRenderer(stream: { write: (s: string) => unknown; columns?: number } = process.stdout) {
  let inReasoning = false, hasStartedContent = false, inCodeBlock = false;
  let currentLine = "", linePrefix = "", previewCols = 0, toolName = "", toolChars = 0;

  const clearToolProgress = () => {
    if (!toolChars && !toolName) return;
    stream.write("\r\x1b[K");
    toolName = "";
    toolChars = 0;
  };
  const finishReasoning = () => {
    if (!inReasoning) return;
    stream.write("\x1b[0m\n");
    inReasoning = false;
  };
  const writePreviewSlice = (text: string) => {
    const maxCols = Math.max(20, (stream.columns ?? 80) - 8);
    if (previewCols >= maxCols) return;
    let out = "";
    for (const ch of text) {
      const w = (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
      if (previewCols + w > maxCols) break;
      out += ch;
      previewCols += w;
    }
    if (out) stream.write(out);
  };
  const commitCurrentLine = (withNewline: boolean) => {
    const { text: formatted, nextInCodeBlock } = formatMarkdownLine(currentLine, inCodeBlock);
    inCodeBlock = nextInCodeBlock;
    stream.write(`\r\x1b[K${linePrefix}${formatted}${withNewline ? "\n" : ""}`);
    currentLine = linePrefix = "";
    previewCols = 0;
  };

  return {
    onReasoning(chunk: string) {
      clearToolProgress();
      if (!inReasoning) { stream.write("\n💭 \x1b[2m\x1b[3m"); inReasoning = true; }
      stream.write(chunk.replace(/\r?\n/g, "\n   "));
    },
    onToolCall(name?: string, argsDelta = "") {
      finishReasoning();
      if (name) toolName = name;
      toolChars += argsDelta.length;
      stream.write(`\r\x1b[K\x1b[2m⏳ 正在生成工具调用 ${toolName || "..."} (${toolChars} 字符)...\x1b[0m`);
    },
    onContent(chunk: string) {
      finishReasoning();
      clearToolProgress();
      if (!hasStartedContent) {
        linePrefix = "💬 ";
        previewCols = getVisualCols(linePrefix);
        stream.write(`\n${linePrefix}`);
        hasStartedContent = true;
      }
      const parts = chunk.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (parts[i]) {
          writePreviewSlice(parts[i]!);
          currentLine += parts[i]!;
        }
        if (i < parts.length - 1) commitCurrentLine(true);
      }
    },
    onEvent(evt: LlmStreamEvent) {
      if (evt.type === "reasoning_delta") this.onReasoning(evt.text);
      else if (evt.type === "content_delta") this.onContent(evt.text);
      else if (evt.type === "tool_call_delta") this.onToolCall(evt.name, evt.argsDelta);
    },
    flush() {
      finishReasoning();
      clearToolProgress();
      if (currentLine.length > 0) commitCurrentLine(false);
      if (hasStartedContent) stream.write("\x1b[0m\n");
    },
  };
}

export function recordHttpWireLog(entry: HttpWireLogEntry, wireFilePath = ".sessions/http-wire.json", resetFile = false): void {
  fs.mkdirSync(path.dirname(wireFilePath), { recursive: true });
  let existing: HttpWireLogEntry[] = [];
  if (!resetFile && fs.existsSync(wireFilePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(wireFilePath, "utf-8"));
      if (Array.isArray(parsed)) existing = parsed;
    } catch {}
  }
  existing.push(entry);
  fs.writeFileSync(wireFilePath, JSON.stringify(existing, null, 2), "utf-8");
}
