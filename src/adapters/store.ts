import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  SessionEntrySchema,
  type AssistantMessage,
  type LlmProvider,
  type Message,
  type SessionEntry,
} from "../core/contracts.js";
import { assertSessionInvariant, projectToMessages } from "../core/session-tree.js";
import type { HttpWireLogEntry } from "./cost-tracker.js";

export function writeFileAtomicSync(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpFile, content, "utf-8");
    fs.renameSync(tmpFile, filePath);
  } catch (err) {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
    throw err;
  }
}

/**
 * 1. 把会话节点按行追加写入硬盘上的 .jsonl 文件
 */
export function appendJsonlEntries(
  filePath: string,
  entries: readonly SessionEntry[],
  overwrite = false,
): void {
  if (entries.length === 0) return;
  const lines = entries.map((e) => JSON.stringify(SessionEntrySchema.parse(e))).join("\n") + "\n";
  if (overwrite) {
    writeFileAtomicSync(filePath, lines);
  } else {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, lines, "utf-8");
  }
}

/**
 * 2. 从硬盘上的 .jsonl 文件读取并校验所有会话节点
 */
export function loadJsonlEntries(filePath: string): SessionEntry[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`找不到会话记录文件: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, idx) => {
      try {
        return SessionEntrySchema.parse(JSON.parse(line));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`${filePath} 第 ${idx + 1} 行 JSON 格式错误: ${msg}`);
      }
    });
}

/**
 * 3. 离线录像回放器（ReplayProvider）：
 * 不发网络请求，直接从 .jsonl 记录中按顺序取出以前录制好的 assistant 回答返回
 */
export function createReplayProvider(
  entries: readonly SessionEntry[],
  leafId?: string,
): LlmProvider {
  if (entries.length === 0) {
    throw new Error("无法启动录像回放：会话记录为空（0 行），请先运行真实对话完成录制");
  }
  const branchMessages = projectToMessages(entries, leafId);
  assertSessionInvariant(branchMessages);

  const recordedReplies = branchMessages.filter(
    (m): m is AssistantMessage => m.role === "assistant",
  );
  if (recordedReplies.length === 0) {
    throw new Error("无法启动录像回放：记录中没有找到任何 assistant 回复消息");
  }
  let cursor = 0;

  return {
    async chat(messages: Message[]): Promise<AssistantMessage> {
      assertSessionInvariant(messages);
      const reply = recordedReplies[cursor];
      if (!reply) {
        throw new Error(
          `录像回放已耗尽：共录制了 ${recordedReplies.length} 条大模型回复，但尝试发起第 ${cursor + 1} 次请求`,
        );
      }
      cursor += 1;
      return reply;
    },
  };
}

function digestWireText(raw: unknown, maxLen = 160): unknown {
  if (typeof raw !== "string" || raw.length <= maxLen || /\.\.\.\[len=\d+,sha1=[0-9a-f]{10}\]$/.test(raw)) return raw;
  const sha1 = crypto.createHash("sha1").update(raw).digest("hex").slice(0, 10);
  const head = raw.includes("[已折叠历史") && !raw.slice(0, 60).includes("[已折叠历史") ? `${raw.slice(0, 42)}[已折叠历史...]` : raw.slice(0, 60);
  return `${head}...[len=${raw.length},sha1=${sha1}]`;
}

function compactWireMessage(msg: Record<string, any>): Record<string, any> {
  if (!msg || typeof msg !== "object") return msg;
  const out: Record<string, any> = { ...msg };
  if (typeof out.content === "string") out.content = digestWireText(out.content, 160);
  else if (Array.isArray(out.content)) {
    out.content = out.content.map((p: any) =>
      p?.type === "text"
        ? { ...p, text: digestWireText(p.text, 160) }
        : p?.type === "image_url" && p?.image_url?.url
          ? { ...p, image_url: { ...p.image_url, url: digestWireText(p.image_url.url, 80) } }
          : p,
    );
  }
  if (typeof out.reasoning_content === "string") out.reasoning_content = digestWireText(out.reasoning_content, 120);
  if (typeof out.reasoningContent === "string") out.reasoningContent = digestWireText(out.reasoningContent, 120);
  if (Array.isArray(out.tool_calls)) {
    out.tool_calls = out.tool_calls.map((tc: any) =>
      tc?.function ? { ...tc, function: { ...tc.function, arguments: digestWireText(tc.function.arguments, 160) } } : tc,
    );
  }
  if (Array.isArray(out.toolCalls)) {
    out.toolCalls = out.toolCalls.map((tc: any) => {
      if (!tc || typeof tc.arguments !== "object" || !tc.arguments) return tc;
      const args: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(tc.arguments)) {
        args[k] =
          k === "pattern" || k === "path" || k === "command"
            ? digestWireText(v, 160)
            : typeof v === "string"
              ? digestWireText(v, 120)
              : digestWireText(JSON.stringify(v), 120);
      }
      return { ...tc, arguments: args };
    });
  }
  return out;
}

export function compactWireLogEntry(entry: HttpWireLogEntry): HttpWireLogEntry {
  const { tools: _tools, ...restBody } = (entry.requestBody ?? {}) as Record<string, any>;
  const messages = Array.isArray(restBody.messages) ? restBody.messages.map(compactWireMessage) : restBody.messages;
  const rawLines = entry.rawSseLines ?? [];
  const usageLines = rawLines
    .filter((l) => l.includes('"prompt_tokens"'))
    .map((l) => {
      if (!l.startsWith("[非流式 JSON 响应]")) return l;
      try {
        const parsed = JSON.parse(l.replace("[非流式 JSON 响应]", "").trim());
        return `[非流式 JSON 响应] ${JSON.stringify({ model: parsed.model, usage: parsed.usage })}`;
      } catch { return l; }
    });
  const fallbackLines = rawLines.filter((l) => l.trim() && !l.includes("[DONE]")).slice(-1);
  return {
    ...entry,
    requestBody: { ...restBody, ...(messages !== undefined ? { messages } : {}) },
    rawSseLines: usageLines.length > 0 ? usageLines.slice(-2) : fallbackLines,
    assembledMessage: compactWireMessage(entry.assembledMessage as Record<string, any>) as AssistantMessage,
  };
}
