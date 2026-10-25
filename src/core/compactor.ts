import type { Message } from "./contracts.js";

export interface CompactorOptions { maxTotalChars?: number; keepRecentMessages?: number; maxToolOutputChars?: number }

function estimateBaseChars(messages: readonly Message[]): number {
  let total = 0;
  for (const m of messages) {
    const imgChars = m.role === "user" && m.images ? m.images.reduce((s, img) => s + Math.min(8_000, Math.max(2_000, Math.ceil(img.byteSize / 16))), 0) : 0;
    total += m.content.length + imgChars + (m.role === "assistant" && m.toolCalls ? JSON.stringify(m.toolCalls).length : 0);
  }
  return total;
}

export function estimateMessagesChars(messages: readonly Message[]): number {
  let lastUserIdx = -1, activeReason = 0;
  for (let i = 0; i < messages.length; i++) if (messages[i]!.role === "user") lastUserIdx = i;
  for (let i = Math.max(0, lastUserIdx + 1); i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.reasoningContent) activeReason += m.reasoningContent.length;
  }
  return estimateBaseChars(messages) + activeReason;
}

interface IndexedUnit { msgs: Message[]; startIdx: number; endIdx: number; reasonChars?: number }

function groupIntoAtomicUnits(messages: readonly Message[], startOffset = 0): IndexedUnit[] {
  const units: IndexedUnit[] = [];
  for (let i = 0; i < messages.length; ) {
    const startIdx = startOffset + i, current = messages[i]!;
    if (current.role === "assistant" && current.toolCalls?.length) {
      const group: Message[] = [current];
      for (i += 1; i < messages.length && messages[i]!.role === "tool"; ) group.push(messages[i++]!);
      units.push({ msgs: group, startIdx, endIdx: startOffset + i - 1 });
    } else units.push({ msgs: [current], startIdx, endIdx: startIdx + (i++, 0) });
  }
  return units;
}

const foldCodeArg = (s: unknown, limit: number): unknown => (typeof s === "string" && s.length > limit && !s.startsWith("[已折叠历史") ? `[已折叠历史代码片段 (原长 ${s.length} 字符)]` : s);
const normRelPath = (p: unknown): string => (typeof p === "string" ? p.replace(/\\/g, "/").replace(/^\.\//, "") : "");

export function foldSingleMessage(msg: Message, maxToolChars = 200): Message {
  if (msg.role === "tool" && msg.content.length > maxToolChars && !msg.content.startsWith("[已折叠历史工具输出 (")) {
    const next = `[已折叠历史工具输出 (${msg.name}，原长 ${msg.content.length} 字符): ${msg.content.slice(0, 60).replace(/\n/g, " ")}...]`;
    return next.length < msg.content.length ? { ...msg, content: next } : msg;
  }
  if (msg.role === "user" && (msg.content.includes("<attached_file ") || (msg.images && msg.images.length > 0))) {
    let next = msg.content.replace(/<attached_file path="([^"]+)"[^>]*>[\s\S]*?<\/attached_file>/g, (full, p) => `[已折叠历史引用文件 @${p} (原长 ${full.length} 字符)]`);
    if (msg.images?.length) next = `${next}\n${msg.images.map((img) => `[已折叠历史图片 @${img.path} (${Math.max(1, Math.round(img.byteSize / 1024))} KB)]`).join(" ")}`.trim();
    const { images: _imgs, ...rest } = msg;
    return next !== msg.content || msg.images?.length ? { ...rest, content: next } : msg;
  }
  if (msg.role === "assistant" && msg.toolCalls?.length) {
    const limit = Math.max(maxToolChars * 4, 800);
    let anyChanged = false;
    const toolCalls = msg.toolCalls.map((tc) => {
      if (tc.name !== "edit_file" || !tc.arguments) return tc;
      let tcChanged = false;
      const args: Record<string, unknown> = { ...tc.arguments };
      for (const k of ["oldText", "newText"] as const) {
        const f = foldCodeArg(args[k], limit);
        if (f !== args[k]) { args[k] = f; tcChanged = true; }
      }
      if (Array.isArray(args.edits)) {
        args.edits = args.edits.map((ed: any) => {
          if (!ed || typeof ed !== "object") return ed;
          const no = foldCodeArg(ed.oldText, limit), nn = foldCodeArg(ed.newText, limit);
          if (no !== ed.oldText || nn !== ed.newText) { tcChanged = true; return { ...ed, oldText: no, newText: nn }; }
          return ed;
        });
      }
      if (tcChanged) anyChanged = true;
      return tcChanged ? { ...tc, arguments: args } : tc;
    });
    return anyChanged ? { ...msg, toolCalls } : msg;
  }
  return msg;
}

function collectProtectedReadPaths(units: readonly IndexedUnit[], minStartIdx: number): Set<string> {
  const paths = new Set<string>();
  for (const u of units) {
    if (u.startIdx < minStartIdx || u.msgs[0]?.role !== "assistant" || !u.msgs[0].toolCalls) continue;
    const errIds = new Set(u.msgs.filter((m) => m.role === "tool" && m.isError).map((m) => (m as any).toolCallId));
    for (const tc of u.msgs[0].toolCalls) {
      const p = tc.name === "edit_file" && !errIds.has(tc.id) ? normRelPath(tc.arguments?.path) : "";
      if (p) paths.add(p);
    }
  }
  return paths;
}

function isProtectedToolMsg(unit: IndexedUnit, msg: Message, protectedPaths?: ReadonlySet<string>): boolean {
  if (!protectedPaths?.size || msg.role !== "tool" || msg.name !== "read_file" || unit.msgs[0]?.role !== "assistant") return false;
  const p = normRelPath(unit.msgs[0].toolCalls?.find((c) => c.id === msg.toolCallId)?.arguments?.path);
  return Boolean(p && protectedPaths.has(p));
}

function foldUnitToolsUpTo(head: Message[], units: IndexedUnit[], limitIdx: number, maxToolChars: number, chars: number, target: number, protectedPaths?: ReadonlySet<string>): number {
  for (let i = 0; i < head.length && i < limitIdx && chars > target; i++) {
    const m = head[i]!, folded = foldSingleMessage(m, maxToolChars);
    if (folded !== m) { chars -= estimateBaseChars([m]) - estimateBaseChars([folded]); head[i] = folded; }
  }
  for (const pass of ["args", "tools"] as const) {
    for (const unit of units) {
      for (let j = 0; j < unit.msgs.length && chars > target; j++) {
        if (unit.startIdx + j >= limitIdx) break;
        const msg = unit.msgs[j]!;
        if (pass === "args" ? msg.role === "tool" : msg.role !== "tool" || isProtectedToolMsg(unit, msg, protectedPaths)) continue;
        const folded = foldSingleMessage(msg, maxToolChars);
        if (folded !== msg) { chars -= estimateBaseChars([msg]) - estimateBaseChars([folded]); unit.msgs[j] = folded; }
      }
    }
  }
  return chars;
}

/** KV 缓存友好型裁剪纯函数：纯前缀因果扫描 0..i（含跨轮峰值），超水位时优先折叠历史 edit_file 参数与无关输出，100% 锁死前序缓存 */
export function compactMessages(messages: readonly Message[], options: CompactorOptions = {}): Message[] {
  const maxTotalChars = options.maxTotalChars ?? 128_000, keepRecentMessages = options.keepRecentMessages ?? 16, maxToolOutputChars = options.maxToolOutputChars ?? 200;
  const headCount = messages[0]?.role === "system" && messages[1]?.role === "user" ? 2 : 1;
  if (messages.length <= headCount + 1) return [...messages];
  const lowWaterMark = Math.floor(maxTotalChars * 0.65), headPrefix = messages.slice(0, headCount), activeUnits: IndexedUnit[] = [];
  let runningChars = estimateBaseChars(headPrefix);
  for (const unit of groupIntoAtomicUnits(messages.slice(headCount), headCount)) {
    if (unit.msgs[0]?.role === "user") for (const u of activeUnits) { runningChars -= u.reasonChars ?? 0; u.reasonChars = 0; }
    const reasonChars = unit.msgs.reduce((s, m) => s + (m.role === "assistant" && m.reasoningContent ? m.reasoningContent.length : 0), 0);
    activeUnits.push({ ...unit, msgs: [...unit.msgs], reasonChars });
    runningChars += estimateBaseChars(unit.msgs) + reasonChars;
    if (runningChars <= maxTotalChars) continue;
    const recentIdx = Math.max(headCount, unit.endIdx + 1 - keepRecentMessages), nearIdx = Math.max(headCount, unit.startIdx);
    const protectedPaths = collectProtectedReadPaths(activeUnits, recentIdx);
    runningChars = foldUnitToolsUpTo(headPrefix, activeUnits, recentIdx, maxToolOutputChars, runningChars, lowWaterMark, protectedPaths);
    if (runningChars > maxTotalChars) runningChars = foldUnitToolsUpTo(headPrefix, activeUnits, nearIdx, maxToolOutputChars, runningChars, lowWaterMark, protectedPaths);
    if (runningChars > maxTotalChars) runningChars = foldUnitToolsUpTo(headPrefix, activeUnits, nearIdx, maxToolOutputChars, runningChars, lowWaterMark);
    if (runningChars > maxTotalChars) while (activeUnits.length > 1 && runningChars > lowWaterMark) { const ev = activeUnits.shift()!; runningChars -= estimateBaseChars(ev.msgs) + (ev.reasonChars ?? 0); }
  }
  return [...headPrefix, ...activeUnits.flatMap((u) => u.msgs)];
}
