import * as fs from "node:fs";
import * as path from "node:path";
import { AssistantMessageSchema, type AssistantMessage, type LlmStreamEvent, type ToolCall } from "../core/contracts.js";
import type { HttpWireLogEntry } from "./cost-tracker.js";
import { compactWireLogEntry, writeFileAtomicSync } from "./store.js";
import { formatMarkdownLine, getVisualCols, wrapReasoningLines } from "./ui-logger.js";
import { syncXrayCacheSnapshot } from "./xray.js";

export { formatMarkdownLine, getVisualCols, type HttpWireLogEntry, wrapReasoningLines };

export function parseOpenAiAssistantMessage(rawMsg: Record<string, any>): AssistantMessage {
  const rawToolCalls = Array.isArray(rawMsg.tool_calls) ? rawMsg.tool_calls : [];
  const toolCalls: ToolCall[] = rawToolCalls.map((tc: any, idx: number) => {
    let parsedArgs: Record<string, unknown> = {};
    const rawArgsStr = tc?.function?.arguments ?? "{}";
    try {
      const parsed = JSON.parse(rawArgsStr);
      parsedArgs = typeof parsed === "object" && parsed !== null ? parsed : { _value: parsed };
    } catch {
      parsedArgs = { _invalidJson: String(rawArgsStr) };
    }
    return { id: String(tc?.id || `call_${idx}`), name: String(tc?.function?.name || "unknown"), arguments: parsedArgs };
  });

  return AssistantMessageSchema.parse({
    role: "assistant",
    content: rawMsg.content ?? "",
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(typeof (rawMsg.reasoning_content ?? rawMsg.reasoning) === "string"
      ? { reasoningContent: rawMsg.reasoning_content ?? rawMsg.reasoning }
      : {}),
  });
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
    id: acc.id || `call_${idx}`, type: "function", function: { name: acc.name || "unknown", arguments: acc.argsRaw || "{}" },
  }));
  return parseOpenAiAssistantMessage({
    content, ...(hasReasoning ? { reasoning_content: reasoning } : {}), ...(rawToolCalls.length > 0 ? { tool_calls: rawToolCalls } : {}),
  });
}

export async function readOpenAiSseStream(
  res: Response, onDeltaText?: (text: string) => void, onReasoningDelta?: (text: string) => void, onStreamEvent?: (event: LlmStreamEvent) => void, idleTimeoutMs = 45_000,
): Promise<{ message: AssistantMessage; rawSseLines: string[] }> {
  const emitReasoning = (text: string) => { onReasoningDelta?.(text); onStreamEvent?.({ type: "reasoning_delta", text }); };
  const emitContent = (text: string) => { onDeltaText?.(text); onStreamEvent?.({ type: "content_delta", text }); };
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const { done, value } = await (idleTimeoutMs > 0
      ? Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`SSE 流空闲超时 (${idleTimeoutMs}ms 无新数据)`));
              reader.cancel().catch(() => {});
            }, idleTimeoutMs);
          }),
        ]).finally(() => clearTimeout(timer))
      : reader.read());
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

function slicePreviewText(text: string, startCols: number, maxCols: number): { out: string; nextCols: number } {
  if (startCols >= maxCols) return { out: "", nextCols: startCols };
  let out = "", cols = startCols;
  for (const ch of text) {
    const w = (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
    if (cols + w > maxCols) break;
    out += ch; cols += w;
  }
  return { out, nextCols: cols };
}

export function createStreamRenderer(stream: { write: (s: string) => unknown; columns?: number } = process.stdout) {
  let inReasoning = false, hasStartedContent = false, inCodeBlock = false;
  let currentLine = "", linePrefix = "", previewCols = 0, toolName = "", toolChars = 0, reasoningRaw = "", reasoningRows = 0;

  const clearToolProgress = () => {
    if (toolChars || toolName) { stream.write("\r\x1b[K"); toolName = ""; toolChars = 0; }
  };
  const eraseReasoningBox = () => {
    if (reasoningRows > 0) { stream.write(`${reasoningRows > 1 ? `\x1b[${reasoningRows - 1}A` : ""}\r\x1b[J`); reasoningRows = 0; }
  };
  const finishReasoning = () => {
    if (!inReasoning) return;
    const allLines = wrapReasoningLines(reasoningRaw, Math.max(20, (stream.columns ?? 80) - 6));
    if (allLines.length > 5) { eraseReasoningBox(); stream.write(`💭 \x1b[2m[已思考 ${reasoningRaw.length} 字]\x1b[0m\n`); }
    else stream.write("\x1b[0m\n");
    inReasoning = false; reasoningRaw = ""; reasoningRows = 0;
  };
  const commitCurrentLine = (withNewline: boolean) => {
    const { text: formatted, nextInCodeBlock } = formatMarkdownLine(currentLine, inCodeBlock);
    inCodeBlock = nextInCodeBlock;
    stream.write(`\r\x1b[K${linePrefix}${formatted}${withNewline ? "\n" : ""}`);
    currentLine = linePrefix = ""; previewCols = 0;
  };

  return {
    onReasoning(chunk: string) {
      clearToolProgress();
      if (!inReasoning) { stream.write("\n"); inReasoning = true; }
      reasoningRaw += chunk;
      const allLines = wrapReasoningLines(reasoningRaw, Math.max(20, (stream.columns ?? 80) - 6));
      eraseReasoningBox();
      if (allLines.length <= 5) {
        stream.write(`💭 \x1b[2m\x1b[3m${allLines.join("\n   ")}`);
        reasoningRows = allLines.length;
      } else {
        const tail = allLines.slice(-5);
        stream.write(`💭 \x1b[2m[思考中 ${reasoningRaw.length} 字 · 实时滚动]\x1b[0m\n   \x1b[2m\x1b[3m${tail.join("\n   ")}\x1b[0m`);
        reasoningRows = tail.length + 1;
      }
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
          const slice = slicePreviewText(parts[i]!, previewCols, Math.max(20, (stream.columns ?? 80) - 8));
          if (slice.out) stream.write(slice.out);
          previewCols = slice.nextCols;
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
  let existing: HttpWireLogEntry[] = [];
  if (!resetFile && fs.existsSync(wireFilePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(wireFilePath, "utf-8"));
      if (Array.isArray(parsed)) existing = parsed.map(compactWireLogEntry);
    } catch {}
  }
  existing.push(compactWireLogEntry(entry));
  writeFileAtomicSync(wireFilePath, JSON.stringify(existing, null, 2));
  syncXrayCacheSnapshot(wireFilePath);
}
