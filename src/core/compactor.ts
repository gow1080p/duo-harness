import type { Message } from "./contracts.js";

export interface CompactorOptions {
  maxTotalChars?: number;
  keepRecentMessages?: number;
  maxToolOutputChars?: number;
}

export function estimateMessagesChars(messages: readonly Message[]): number {
  let total = 0;
  for (const m of messages) {
    total += m.content.length;
    if (m.role === "assistant" && m.toolCalls) {
      total += JSON.stringify(m.toolCalls).length;
    }
  }
  return total;
}

function groupIntoAtomicUnits(messages: readonly Message[]): Message[][] {
  const units: Message[][] = [];
  let i = 0;
  while (i < messages.length) {
    const current = messages[i]!;
    if (current.role === "assistant" && current.toolCalls && current.toolCalls.length > 0) {
      const group: Message[] = [current];
      i += 1;
      while (i < messages.length && messages[i]!.role === "tool") {
        group.push(messages[i]!);
        i += 1;
      }
      units.push(group);
    } else {
      units.push([current]);
      i += 1;
    }
  }
  return units;
}

/**
 * KV 缓存友好型上下文裁剪纯函数：
 * 1. 未超 maxTotalChars 水位线时原样返回（0 字节变动，100% 保护前缀缓存）；
 * 2. 超出时优先原地折叠旧轮次的超长 tool 输出（保留 toolCallId 1:1 配对）；
 * 3. 若仍超长，按 [assistant(toolCalls) + 紧邻 tool 结果] 原子块淘汰最旧中间轮次，锁死头部 system + 首条 user。
 */
export function compactMessages(
  messages: readonly Message[],
  options: CompactorOptions = {},
): Message[] {
  const maxTotalChars = options.maxTotalChars ?? 128_000;
  const keepRecentMessages = options.keepRecentMessages ?? 16;
  const maxToolOutputChars = options.maxToolOutputChars ?? 200;

  if (estimateMessagesChars(messages) <= maxTotalChars) {
    return [...messages];
  }

  const headCount = messages[0]?.role === "system" && messages[1]?.role === "user" ? 2 : 1;
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  const baseCutoff = Math.max(headCount, messages.length - keepRecentMessages);
  const cutoffIndex =
    options.maxTotalChars === undefined && lastUserIdx > headCount
      ? Math.min(baseCutoff, lastUserIdx)
      : baseCutoff;
  const folded: Message[] = [...messages];
  let currentChars = estimateMessagesChars(folded);

  for (let idx = headCount; idx < cutoffIndex && currentChars > maxTotalChars; idx++) {
    const msg = folded[idx]!;
    if (msg.role === "tool" && msg.content.length > maxToolOutputChars) {
      const preview = msg.content.slice(0, 60).replace(/\n/g, " ");
      const nextContent = `[已折叠历史工具输出 (${msg.name}，原长 ${msg.content.length} 字符): ${preview}...]`;
      if (nextContent.length < msg.content.length) {
        currentChars -= msg.content.length - nextContent.length;
        folded[idx] = { ...msg, content: nextContent };
      }
    }
  }

  if (currentChars <= maxTotalChars || folded.length <= headCount + 1) {
    return folded;
  }

  const headPrefix = folded.slice(0, headCount);
  const units = groupIntoAtomicUnits(folded.slice(headCount));

  while (units.length > 1 && estimateMessagesChars([...headPrefix, ...units.flat()]) > maxTotalChars) {
    units.shift();
  }

  return [...headPrefix, ...units.flat()];
}
