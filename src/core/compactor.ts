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

interface IndexedUnit {
  msgs: Message[];
  startIdx: number;
  endIdx: number;
}

function groupIntoAtomicUnits(messages: readonly Message[], startOffset = 0): IndexedUnit[] {
  const units: IndexedUnit[] = [];
  for (let i = 0; i < messages.length; ) {
    const startIdx = startOffset + i;
    const current = messages[i]!;
    if (current.role === "assistant" && current.toolCalls?.length) {
      const group: Message[] = [current];
      i += 1;
      while (i < messages.length && messages[i]!.role === "tool") group.push(messages[i++]!);
      units.push({ msgs: group, startIdx, endIdx: startOffset + i - 1 });
    } else {
      units.push({ msgs: [current], startIdx, endIdx: startIdx });
      i += 1;
    }
  }
  return units;
}

function foldUnitToolsUpTo(units: IndexedUnit[], limitIdx: number, maxToolChars: number, chars: number, target: number): number {
  for (const unit of units) {
    for (let j = 0; j < unit.msgs.length && chars > target; j++) {
      if (unit.startIdx + j >= limitIdx) break;
      const msg = unit.msgs[j]!;
      if (msg.role === "tool" && msg.content.length > maxToolChars && !msg.content.startsWith("[已折叠历史工具输出 (")) {
        const preview = msg.content.slice(0, 60).replace(/\n/g, " ");
        const next = `[已折叠历史工具输出 (${msg.name}，原长 ${msg.content.length} 字符): ${preview}...]`;
        if (next.length < msg.content.length) {
          chars -= msg.content.length - next.length;
          unit.msgs[j] = { ...msg, content: next };
        }
      }
    }
  }
  return chars;
}

/** KV 缓存友好型裁剪纯函数：正向扫描前缀 0..i，超水位时批量折叠/淘汰至 65% 低水位，锁死前序缓存 */
export function compactMessages(messages: readonly Message[], options: CompactorOptions = {}): Message[] {
  const maxTotalChars = options.maxTotalChars ?? 128_000;
  const keepRecentMessages = options.keepRecentMessages ?? 16;
  const maxToolOutputChars = options.maxToolOutputChars ?? 200;
  if (estimateMessagesChars(messages) <= maxTotalChars) return [...messages];

  const headCount = messages[0]?.role === "system" && messages[1]?.role === "user" ? 2 : 1;
  if (messages.length <= headCount + 1) return [...messages];

  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  const baseCutoff = Math.max(headCount, messages.length - keepRecentMessages);
  const globalCutoffIndex = options.maxTotalChars === undefined && lastUserIdx > headCount ? Math.min(baseCutoff, lastUserIdx) : baseCutoff;

  const lowWaterMark = Math.floor(maxTotalChars * 0.65);
  const headPrefix = messages.slice(0, headCount);
  const activeUnits: IndexedUnit[] = [];
  let runningChars = estimateMessagesChars(headPrefix);

  for (const unit of groupIntoAtomicUnits(messages.slice(headCount), headCount)) {
    activeUnits.push({ ...unit, msgs: [...unit.msgs] });
    runningChars += estimateMessagesChars(unit.msgs);
    if (runningChars <= maxTotalChars) continue;

    const prefixCutoff = Math.min(globalCutoffIndex, Math.max(headCount, unit.endIdx + 1 - keepRecentMessages));
    runningChars = foldUnitToolsUpTo(activeUnits, prefixCutoff, maxToolOutputChars, runningChars, lowWaterMark);
    if (runningChars > maxTotalChars) {
      runningChars = foldUnitToolsUpTo(activeUnits, Math.min(globalCutoffIndex, unit.endIdx + 1), maxToolOutputChars, runningChars, lowWaterMark);
    }
    if (runningChars > maxTotalChars) {
      while (activeUnits.length > 1 && runningChars > lowWaterMark) {
        runningChars -= estimateMessagesChars(activeUnits.shift()!.msgs);
      }
    }
  }

  return [...headPrefix, ...activeUnits.flatMap((u) => u.msgs)];
}
