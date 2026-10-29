import type { Message, SessionEntry } from "./contracts.js";

/** 1. 将新增的 Message 数组转换为带 id 和 parentId 的树节点列表（纯函数） */
export function buildSessionEntries(
  existingEntries: readonly SessionEntry[],
  newMessages: readonly Message[],
  baseTimestamp: number,
  parentIdOverride?: string | null,
): SessionEntry[] {
  const result: SessionEntry[] = [];
  let currentParentId =
    parentIdOverride !== undefined
      ? parentIdOverride
      : (existingEntries[existingEntries.length - 1]?.id ?? null);
  let maxSeq = existingEntries.length;
  for (const entry of existingEntries) {
    const m = entry.id.match(/^msg_(\d+)$/);
    if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
  }

  for (let i = 0; i < newMessages.length; i++) {
    const id = `msg_${maxSeq + i + 1}`;
    result.push({ id, parentId: currentParentId, timestamp: baseTimestamp + i, message: newMessages[i]! });
    currentParentId = id;
  }
  return result;
}

/** 2. 顺着 parentId 从指定终点（默认最后一条）往上回溯，拼出当前分支的 Message[] 数组 */
export function projectToMessages(entries: readonly SessionEntry[], leafId?: string): Message[] {
  if (entries.length === 0) return [];
  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) {
    if (byId.has(entry.id)) throw new Error(`会话记录存在重复节点 ID: ${entry.id}`);
    byId.set(entry.id, entry);
  }
  const targetId = leafId ?? entries[entries.length - 1]!.id;
  let current = byId.get(targetId) ?? entries[entries.length - 1];
  if (!current) return [];

  const chain: Message[] = [];
  const visited = new Set<string>();
  const brokenChain = { orphan: false };
  while (current) {
    if (visited.has(current.id)) throw new Error(`会话树存在环路死循环，节点 ID: ${current.id}`);
    visited.add(current.id);
    chain.push(current.message);
    if (current.parentId === null) break;
    const parent = byId.get(current.parentId);
    if (!parent) {
      brokenChain.orphan = true;
      break;
    }
    current = parent;
  }
  const ordered = chain.reverse();
  if (brokenChain.orphan) {
    while (ordered.length > 0 && ordered[0]!.role !== "system" && ordered[0]!.role !== "user") ordered.shift();
    const sysEntry = entries.find((e) => e.message.role === "system");
    if (ordered[0]?.role !== "system" && sysEntry) ordered.unshift(sysEntry.message);
  }
  return ordered;
}

/** 3. 自动修复因终端中途关闭/Ctrl+C 遗留的未闭合 toolCalls（纯函数） */
export function repairDanglingToolCalls(messages: readonly Message[]): Message[] {
  const repaired: Message[] = [];
  const pending = new Map<string, string>();
  const flushPending = () => {
    for (const [id, name] of pending.entries()) {
      repaired.push({
        role: "tool",
        toolCallId: id,
        name,
        content: "[上次会话在等待确认或执行工具时被中断，该操作未执行]",
        isError: true,
      });
    }
    pending.clear();
  };
  for (const msg of messages) {
    if (msg.role === "tool") {
      if (pending.has(msg.toolCallId)) {
        pending.delete(msg.toolCallId);
        repaired.push(msg);
      }
      continue;
    }
    if (pending.size > 0) flushPending();
    repaired.push(msg);
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) pending.set(tc.id, tc.name);
    }
  }
  if (pending.size > 0) flushPending();
  return repaired;
}

/** 4. 发给大模型前的格式检查函数：确保每条带 toolCalls 的 assistant 消息后面紧跟一一配对的 tool 结果 */
export function assertSessionInvariant(messages: readonly Message[]): void {
  const pendingToolCallIds = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (pendingToolCallIds.size > 0 && msg.role !== "tool") {
      throw new Error(`第 ${i} 条消息违反配对规则：缺少 toolCallId [${Array.from(pendingToolCallIds).join(", ")}] 的工具返回结果`);
    }
    if (msg.role === "tool") {
      if (!pendingToolCallIds.has(msg.toolCallId)) {
        throw new Error(`第 ${i} 条消息存在未配对的孤儿 toolCallId: ${msg.toolCallId}`);
      }
      pendingToolCallIds.delete(msg.toolCallId);
      continue;
    }
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      for (const tc of msg.toolCalls) {
        if (pendingToolCallIds.has(tc.id)) throw new Error(`assistant 消息中存在重复的 toolCall.id: ${tc.id}`);
        pendingToolCallIds.add(tc.id);
      }
    }
  }
  if (pendingToolCallIds.size > 0) {
    throw new Error(`消息列表末尾缺少 toolCallId [${Array.from(pendingToolCallIds).join(", ")}] 的工具返回结果`);
  }
}
