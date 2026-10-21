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

/**
 * 1. 把会话节点按行追加写入硬盘上的 .jsonl 文件
 */
export function appendJsonlEntries(
  filePath: string,
  entries: readonly SessionEntry[],
  overwrite = false,
): void {
  if (entries.length === 0) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = entries.map((e) => JSON.stringify(SessionEntrySchema.parse(e))).join("\n") + "\n";
  if (overwrite) {
    fs.writeFileSync(filePath, lines, "utf-8");
  } else {
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
