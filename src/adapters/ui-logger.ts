import * as fs from "node:fs";
import type { ToolResultMessage } from "../core/contracts.js";
import { summarizeWireCost } from "./cost-tracker.js";
import { type FileDiffSummaryItem, formatApprovalBox, formatStepToolCalls, normalizeEditsArray, summarizeSnapshotsDiff } from "./diff-presenter.js";
import { formatMarkdownLine, getVisualCols, type HttpWireLogEntry } from "./sse-stream.js";

export { type FileDiffSummaryItem, formatApprovalBox, formatMarkdownLine, formatStepToolCalls, getVisualCols, normalizeEditsArray, summarizeSnapshotsDiff };

const SAFE_READONLY_VERBS_RE =
  /^(?:ls|cat|head|tail|wc|grep|egrep|fgrep|rg|ag|find|stat|file|du|df|pwd|realpath|dirname|basename|which|whereis|type|echo|printf|tr|cut|sort|uniq|diff|comm|cmp|md5|shasum|sha256sum|xxd|hexdump|strings|tree|uname|whoami|id|hostname|date|uptime|printenv|ps|lsof|pgrep|sed|curl|test|true|false)(?:\s|$)/;

const GIT_READONLY_SUBCMD_RE =
  /^git\s+(?:(?:--no-pager|-C\s+(?:"__STR__"|\S+))\s+)*(?:(?:status|diff|log|show|rev-parse|ls-files|ls-tree|cat-file|describe|shortlog|blame|var)(?:\s|$)|reflog(?:\s+show)?\s*$|branch(?:\s+(?:-(?:a|r|v|vv)|--(?:all|remotes|list|show-current|contains|merged|no-merged)))*\s*$|remote(?:\s+(?:-v|--verbose))*\s*$|tag(?:\s+(?:-l|--list)(?:\s+\S+)*)?\s*$|config\s+(?:--(?:get|get-all|list)|-l)(?:\s|$)|(?:-v|--version)\s*$)/;

const RUNTIME_VERSION_RE =
  /^(?:(?:node|python3?|pip3?|npm|pnpm|yarn|bun|tsc|cargo|rustc|uvicorn|vite)\s+(?:-v|--version|-V)|go\s+version|(?:(?:npx|pnpm|yarn|bunx?)\s+)?tsc(?:\s+(?:--noEmit|--pretty(?:\s+(?:true|false))?|--skipLibCheck|--strict|-p\s+(?:"__STR__"|\S+)|--project\s+(?:"__STR__"|\S+)))*\s+--noEmit(?:\s+(?:--pretty(?:\s+(?:true|false))?|--skipLibCheck|--strict|-p\s+(?:"__STR__"|\S+)|--project\s+(?:"__STR__"|\S+)))*)\s*$/;

export function shortenWorkspaceText(raw: string, workspaceRoot?: string): string {
  if (!raw) return raw;
  let res = raw;
  if (workspaceRoot) {
    const cleanRoot = workspaceRoot.replace(/\/$/, "");
    if (cleanRoot) res = res.split(`${cleanRoot}/`).join("").split(cleanRoot).join(".");
  }
  return res.replace(/^\s*cd\s+(?:"\."|'\.'|\.)\s*(?:&&|;)\s*/, "");
}

export function cleanDisplayBash(rawCmd: string, workspaceRoot?: string): string[] {
  const short = shortenWorkspaceText(rawCmd.trim(), workspaceRoot);
  const rawParts = short.match(/(?:\s*&&\s*echo\s+(?!(?:['"]?(?:===+|---+)))(?:[^;&'"]|'[^']*'|"(?:[^"\\]|\\.)*")+|'[^']*'|"(?:[^"\\]|\\.)*"|\b(?:for|while|until)\b(?:[^'"]|'[^']*'|"(?:[^"\\]|\\.)*")+?\bdone\b|\bif\b(?:[^'"]|'[^']*'|"(?:[^"\\]|\\.)*")+?\bfi\b|[^;&'"]+|(?<!&)&(?!&))+/g) ?? [short];
  const parts = rawParts
    .map((s) => s.trim().replace(/\s+2>&1(?=\s*$|\s*\|)/g, ""))
    .filter((s) => s && !/^echo(?:\s+(?:'(?:===+|---+)(?:.*(?:===+|---+))?'|"(?:===+|---+)(?:.*(?:===+|---+))?"|---+|===+))?$/.test(s))
    .filter((s, _, arr) => !(arr.length > 1 && /^echo\s+['"]?[^'"]*(?:exit|\$\?)[^'"]*['"]?$/i.test(s)));
  return parts.length > 0 ? parts : [short];
}

export function buildDefaultSystemPrompt(workspaceRoot: string): string {
  return [
    `你是运行在 Duo-Harness 宿主环境中的本地编程智能体（全程必须使用简明中文思考与回答，第 1 步起 reasoning 严禁输出英文 Let me...；严禁自称 Claude 或 Anthropic 模型，当用户询问模型身份时请如实回答底层模型如 DeepSeek 或小米 MiMo）。`,
    `- 当前工作区根目录 (workspaceRoot): ${workspaceRoot} (操作系统: ${process.platform})`,
    `- 工具使用纪律（必须严格遵守）：`,
    `  1. 查看目录与文件行数必须直接调用 list_dir（已自带 2 层目录树、代码文件行数及顶层/二级 [已过滤忽略目录] 如 venv/、web-ui/node_modules/），读文件调 read_file（1000 行内直接一次读完，多个文件同轮并发读取），搜索代码调 grep；严禁调用 run_bash 执行 cat/find/grep/ls/wc，也严禁用 ls node_modules 或 python -c "import ..." 试探依赖。`,
    `  2. 调用工具时 path 参数请直接传相对于工作区根目录的简短相对路径（如 "."、"README.md"、"src/index.ts"），不要重复拼接长绝对路径。`,
    `  3. run_bash 默认已在工作区根目录 (${workspaceRoot}) 下启动，严禁在命令开头拼接 cd "${workspaceRoot}" &&；前端/TS 类型检查请统一用只读命令 npx tsc --noEmit（自动免确认放行，勿用会写缓存的 tsc -b）；只读环境检查严禁与写操作或 python -c 混写在同一条 run_bash 中；启动常驻服务（如 uvicorn/vite/npm run dev）必须用后台方式（nohup ... > /tmp/xxx.log 2>&1 </dev/null &）并在同条命令内 sleep 1~2 后检查端口或日志，严禁前台裸跑常驻进程。`,
    `  4. 修改同一个文件的多处内容时，请使用 edit_file 的 edits 批量数组在单次调用中完成（或同一步并发调用多个 edit_file）；严禁通过 run_bash 调用 sed -i 或脚本改写源码文件。`,
    `  5. 思考过程（reasoning）必须全程使用简明中文，调工具取证阶段思考控制在 100 字以内，聚焦下一步动作；当用户要求“拉起/启动项目”时，第 1~2 步用 list_dir 与 read_file 读齐入口配置（如 README.md、main.py、package.json、vite.config.ts）后立即在下一步直接启动服务，禁止超过 2 步纯探索。`,
  ].join("\n");
}

export function isReadonlyBashCommand(cmd: string, explicitReadonly?: boolean): boolean {
  if (explicitReadonly === false) return false;
  const raw = cmd.trim();
  if (!raw || /`|\$\(|\$'|\$\{|[\n\r]/.test(raw)) return false;
  const unquoted = raw.replace(/['"]/g, "").replace(/(?:^|\s)(?:-o\s*|--output(?:=|\s+))\/dev\/null(?=\s|$|;|\||&)/g, " ");
  if (
    /(?:^|\s)(?:-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)\b|--(?:output|output-dir|in-place|file|ext-diff|textconv|pre|pre-glob|compress-program|data\S*|form\S*|upload-file|request|remote-name\S*|json|url\S*|next|config|dump-header|trace\S*)\b)/.test(unquoted) ||
    /(?:^|[;&|]\s*)(?:(?:\w+=\S+|env|command|do|then|elif|else|if|while|until)\s+)*(?:(?:sort|tree|git|rg|xxd)\b[^;&|]*\s-[a-zA-Z]*o|curl\b[^;&|]*\s-[a-zA-Z0-9#]*[oOdDFTPXK]|file\b[^;&|]*\s-[a-zA-Z]*C|sed\b[^;&|]*\s-[a-zA-Z]*[if])/.test(unquoted)
  ) {
    return false;
  }
  const maskedQuotes = raw.replace(/(?:'[^']*'|"(?:[^"\\]|\\.)*")/g, (m) => {
    const inner = m.slice(1, -1);
    if (/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/[^'"]*)?$/.test(inner)) return '"__LOCAL_URL__"';
    const body = inner.replace(/\bs([^\w\s])(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1/g, "/").replace(/\/(?:\\.|[^/])*\//g, "/");
    return /\/[gIimMp0-9]*[ewW]|(?:^|[;{}!\s$0-9])[ewW](?:\s|$)/.test(body) ? '"__SED_UNSAFE__"' : '"__STR__"';
  });
  if (/['"]/.test(maskedQuotes.replace(/"__(?:STR|LOCAL_URL|SED_UNSAFE)__"/g, ""))) return false;
  const cleaned = maskedQuotes.replace(/(?:^|\s)(?:[12]?>\s*\/dev\/null|<\s*\/dev\/null|(?:-o\s*|--output(?:=|\s+))\/dev\/null|2>&1|1>&2)(?=\s|$|;|\||&)/g, " ").trim();
  if (!cleaned || /[><]|(?:^|[^&])&(?:[^&]|$)/.test(cleaned)) return false;
  const segments = cleaned.split(/\s*(?:\|\||&&|;|\|)\s*/);
  let hasReadVerb = false;
  return (
    segments.every((seg) => {
      const core = seg.trim().replace(/^(?:(?:LC_ALL|LANG|TZ|TERM|COLORTERM)=(?:"__STR__"|\S+)\s+|(?:env|command|do|if|then|elif|else)\s+)*/, "");
      if (!core) return false;
      if (/^(?:cd(?:\s+(?:"__STR__"|\S+))?|sleep\s+\d+(?:\.\d+)?|for\s+[a-zA-Z_]\w*\s+in(?:\s+(?:"__STR__"|\S+))+|done|fi)$/.test(core)) return true;
      if (/^(?:\[\s+.+\s+\]|\[\[\s+.+\s+\]\])$/.test(core)) {
        hasReadVerb = true;
        return true;
      }
      const tokens = core.split(/\s+/);
      const first = tokens[0] ?? "";
      if (!first || first.includes("/") || first === '"__STR__"' || first === '"__LOCAL_URL__"' || first === '"__SED_UNSAFE__"') return false;
      if (first === "sed" && (core.includes('"__SED_UNSAFE__"') || tokens.find((t, i) => i > 0 && !t.startsWith("-")) !== '"__STR__"')) return false;
      if (first === "curl") {
        const curlPos = core.slice(4).replace(/\s+(?:-(?:w|H|A|e|m)|--(?:write-out|header|user-agent|referer|max-time|connect-timeout|retry))\s+(?:"__(?:STR|LOCAL_URL)__"|\S+)/g, "").trim().split(/\s+/).filter((t) => t && !t.startsWith("-"));
        if (curlPos.length === 0 || curlPos.some((t) => !/^(?:"__LOCAL_URL__"|https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/.*)?)$/.test(t))) return false;
      }
      if ((first === "uniq" || first === "xxd") && tokens.slice(1).filter((t) => !t.startsWith("-")).length > 1) return false;
      if (/^env$/.test(core) || SAFE_READONLY_VERBS_RE.test(core) || GIT_READONLY_SUBCMD_RE.test(core) || RUNTIME_VERSION_RE.test(core)) {
        hasReadVerb = true;
        return true;
      }
      return false;
    }) && hasReadVerb
  );
}

export function formatToolResultLine(result: ToolResultMessage): string {
  if (result.isError) {
    const errPreview = result.content.replace(/\s+/g, " ").slice(0, 72);
    return `     ⚠️ 执行出错 (${result.name}): ${errPreview}${result.content.length > 72 ? "..." : ""}`;
  }
  if ((result.name === "edit_file" || result.name === "rollback_version") && result.content) {
    return `     ↳ ✏️  ${result.content.replace(/\s+/g, " ").trim()}`;
  }
  const lineCount = result.content ? result.content.split("\n").length : 0;
  return `     ↳ 完成 (${result.name} · 共 ${lineCount} 行)`;
}

export interface TurnMetricsSummary {
  activeModel: string; turnCostCny: number; sessionCostCny: number; totalCostCny: number; cacheHitRatePct: number;
}

export function computeTurnMetrics(wireLogFile: string, stepsUsed: number, isReplay = false): TurnMetricsSummary | null {
  try {
    if (!fs.existsSync(wireLogFile)) return null;
    const entries = JSON.parse(fs.readFileSync(wireLogFile, "utf-8")) as HttpWireLogEntry[];
    const s = Array.isArray(entries) && entries.length > 0 ? summarizeWireCost(entries, { isReplay }) : null;
    if (!s || s.rounds.length === 0) return null;
    let startIdx = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const msgs = (entries[i]?.requestBody as { messages?: { role?: string }[] } | undefined)?.messages;
      if (Array.isArray(msgs) && !msgs.some((m) => m.role === "assistant")) { startIdx = i; break; }
    }
    const sSession = startIdx > 0 ? summarizeWireCost(entries.slice(startIdx), { isReplay }) : s;
    const sessionRounds = sSession.rounds.length > 0 ? sSession.rounds : s.rounds;
    const turnRounds = sessionRounds.slice(-Math.max(1, (stepsUsed ?? 0) + 1));
    const turnIn = turnRounds.reduce((acc, r) => acc + r.promptTokens, 0), turnHit = turnRounds.reduce((acc, r) => acc + r.cacheHitTokens, 0);
    return { activeModel: turnRounds[turnRounds.length - 1]?.model || "unknown", turnCostCny: turnRounds.reduce((a, r) => a + r.costCny, 0), sessionCostCny: sessionRounds.reduce((a, r) => a + r.costCny, 0), totalCostCny: s.totalCostCny, cacheHitRatePct: turnIn > 0 ? (turnHit / turnIn) * 100 : s.overallCacheRatePct };
  } catch { return null; }
}

export function formatCompactTurnFooter(wireLogFile: string, stepsUsed: number, isReplay = false, turnSnapshots: readonly { path: string; beforeContent: string | null; afterContent: string; hunkCount?: number }[] = [], workspaceRoot?: string): string {
  const diffs = summarizeSnapshotsDiff(turnSnapshots, workspaceRoot);
  const totalAdd = diffs.reduce((a, d) => a + d.addedLines, 0), totalRem = diffs.reduce((a, d) => a + d.removedLines, 0);
  const modLines = diffs.length > 0 ? [`\n📋 [本轮共修改 ${diffs.length} 个文件 (\x1b[32m+${totalAdd}\x1b[0m / \x1b[31m-${totalRem}\x1b[0m 行) · 输入 /diff 查看代码对比 | 输入 /undo 撤回修改]:`, ...diffs.map((d) => `  ✏️  ${d.file} (${d.isNew ? `新建 \x1b[32m+${d.newLines}\x1b[0m 行` : `\x1b[32m+${d.addedLines}\x1b[0m / \x1b[31m-${d.removedLines}\x1b[0m 行 · ${d.edits} 处修改 (${d.oldLines} -> ${d.newLines} 行)`})`)] : [];
  const modPrefix = modLines.length > 0 ? `${modLines.join("\n")}\n` : "\n";
  const m = computeTurnMetrics(wireLogFile, stepsUsed, isReplay);
  const costStr = m ? (m.totalCostCny > m.sessionCostCny + 0.00005 ? `本轮 ¥${m.turnCostCny.toFixed(4)} / 当前对话 ¥${m.sessionCostCny.toFixed(4)} (项目总计 ¥${m.totalCostCny.toFixed(4)})` : `本轮 ¥${m.turnCostCny.toFixed(4)} / 当前对话 ¥${m.sessionCostCny.toFixed(4)}`) : "";
  return m ? `${modPrefix}✅ 本轮完成 (🤖 ${m.activeModel} · 共 ${stepsUsed} 步 · 💰 ${costStr} · 缓存命中 ${m.cacheHitRatePct.toFixed(0)}% · 输入 /xray 查账单)` : `${modPrefix}✅ 本轮完成 (共 ${stepsUsed} 步)`;
}
