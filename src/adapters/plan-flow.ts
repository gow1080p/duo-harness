import * as fs from "node:fs";
import * as path from "node:path";
import { filterAndRankFiles, listWorkspaceFiles } from "./context-mention.js";
import { padCols } from "./cost-tracker.js";
import type { DropdownItem } from "./dropdown.js";
import { runMdpCli } from "./md-preview.js";
import { editFileInExternalEditor, isPathInside, openInDefaultApp, runTerminalPager, toPosixRelative } from "./platform.js";
import { computePlanHash, listManagedProjects, loadProjectMeta, saveProjectMeta } from "./project-store.js";
import { resolveExistingRealPath } from "./sandbox-policy.js";
import type { SessionController } from "./session-controller.js";
import { writeFileAtomicSync } from "./store.js";
import { renderMarkdownDocument } from "./ui-logger.js";
import { runCommandInSandbox } from "./write-tools.js";

export const PLAN_DENY_REASON = "当前处于 /plan 只读规划模式，已物理拦截写或提权操作。请仅使用 read_file / grep / list_dir 或只读 run_bash 探明代码现状，直接输出结构化 Markdown 实施计划。";

export const PLAN_MODE_CONTEXT_PROMPT = [
  "当前处于 /plan 只读架构规划模式（严禁修改任何文件或执行有副作用的命令）：",
  "1. 先查证再规划：必须先调用 read_file、grep、list_dir 或只读 run_bash 查清当前工作区真实目录结构、关联源码与精确行号（非用户要求调研外部资料时无需发起公网请求，探索步 thinking 控制在 150 字以内，严禁凭想象盲猜文件名或接口）；",
  "2. 直接以 `# <计划标题>` 开头输出纯规划文档（严禁在开头输出“查证完毕”等寒暄导语，严禁在计划中默写整份文件的完整实现源码，全文严格 <= 120 行）：",
  "   - **改动文件清单**：列出每个待新建/修改的文件路径、函数/行号区间及职责；",
  "   - **关键数据结构与接口**：仅给出核心类型定义、函数签名或 3~15 行 JSON 示例（单个代码块严格 <= 15 行）；",
  "   - **分步实施步骤（Plan:）**：按顺序列出带编号的具体落地步骤（1. ... 2. ...），遇边界分支直接在步骤中定好合理默认行为，不要在文末附加“待确认项”章节；",
  "   - **验证方式**：给出可一行执行的构建与端到端验证命令。",
].join("\n");

export function resolveCustomMdArg(rawArg: string, ws: string): string | null {
  const trimmed = rawArg.trim().replace(/^@/, ""), isSingle = /^["'][^"']+["']$/.test(trimmed) || !/\s/.test(trimmed);
  const cleaned = trimmed.replace(/^["']|["']$/g, "");
  if (!isSingle || !cleaned || !/\.(?:md|markdown)$/i.test(cleaned)) return null;
  const realRoot = resolveExistingRealPath(ws), full = resolveExistingRealPath(path.resolve(ws, cleaned));
  return isPathInside(full, realRoot) && fs.existsSync(full) && fs.statSync(full).isFile() ? full : null;
}

export function cleanPlanArtifactText(raw: string): string {
  const headingMatch = raw.match(/(?:^|\n)(#{1,2}\s+[^\n]+[\s\S]*)$/);
  const fromHeading = headingMatch && headingMatch[1]!.length >= raw.length * 0.5 ? headingMatch[1]!.trim() : raw.trim();
  const withoutConfirm = fromHeading.replace(/\n+##+\s*(?:[0-9一二三四五六七八九十]+[.)、:：\s]*)*(?:待确认[^\n]*|确认问题[^\n]*|Open Questions[^\n]*)[\s\S]*$/i, "").trim();
  return withoutConfirm.length >= fromHeading.length * 0.5 ? withoutConfirm : fromHeading;
}
export function savePlanArtifact(ctrl: SessionController, finalAnswer: string, leafId: string | null): { saved: boolean; planPath: string } {
  const ws = ctrl.getPaths().workspaceRoot, planPath = path.join(ws, ".debug", "plan.md"), cleaned = cleanPlanArtifactText(finalAnswer);
  if (!cleaned || cleaned.startsWith("[ABORT]")) return { saved: false, planPath };
  writeFileAtomicSync(planPath, `${cleaned}\n`);
  saveProjectMeta(ctrl.getPaths().metaFile, { lastPlanLeafId: leafId, lastExecutedPlanHash: null });
  console.log(`📋 [规划方案已保存] .debug/plan.md · 直接输入 /goal 即可按计划执行 (或输入 mdp 预览 / 按 Ctrl+G 编辑)`);
  return { saved: true, planPath };
}
export function buildPlanContextPrompt(ws: string): string {
  const planPath = path.join(ws, ".debug", "plan.md");
  const cur = fs.existsSync(planPath) ? fs.readFileSync(planPath, "utf-8").trim().slice(0, 20_000) : "";
  return cur ? `${PLAN_MODE_CONTEXT_PROMPT}\n\n[若本轮需求是在现有计划基础上调整，请基于下方 <current_plan> 增量修订并输出完整的新版计划；若为全新任务请忽略旧计划]\n<current_plan>\n${cur}\n</current_plan>` : PLAN_MODE_CONTEXT_PROMPT;
}

export interface PlanStepItem { step: number; title: string; targetFiles: string[]; completed: boolean; }

export function extractPlanSteps(planMarkdown: string, touchedFiles: readonly string[] = [], isTurnCompleted = false): PlanStepItem[] {
  const touchedSet = new Set(touchedFiles.map((f) => f.replace(/^\.\//, "")));
  const isTouched = (f: string) => touchedSet.has(f) || [...touchedSet].some((t) => t.endsWith(`/${f}`));
  const noCode = planMarkdown.replace(/```[\s\S]*?```/g, "");
  const beforeVerify = noCode.split(/\n+##+\s*(?:[0-9一二三四五六七八九十]+[.)、:：\s]*)*(?:验证方式|测试验证|待确认|确认问题|Open Questions)/i)[0] ?? noCode;
  const planSecMatch = beforeVerify.match(/(?:^|\n)##+\s*(?:[^\n]*(?:Plan|实施步骤|分步实施|执行步骤|修改步骤)[^\n]*)\n([\s\S]*)$/i);
  const targetBody = planSecMatch ? planSecMatch[1]! : beforeVerify;
  const items: PlanStepItem[] = [];
  for (const m of targetBody.matchAll(/^(?:\s*(?:###?\s*)?(?:步骤|Step)\s*(\d+)\s*[:：.-]\s*|\s*(\d+)[.)]\s+)(.+)$/gim)) {
    const rawTitle = (m[3] ?? "").replace(/\*{1,2}|`/g, "").trim();
    if (rawTitle.length < 4 || /^(?:先查证|结构化|改动文件|关键数据|分步实施|验证方式)/.test(rawTitle)) continue;
    const files = [...(m[3] ?? "").matchAll(/`?([A-Za-z0-9_./-]+\.(?:json|tsx|ts|jsx|mjs|cjs|js|go|py|rs|sql|html|css|md))(?![A-Za-z0-9_])`?/g)].map((x) => x[1]!.replace(/^\.\//, ""));
    const completed = files.length > 0 && files.every(isTouched);
    items.push({ step: items.length + 1, title: rawTitle.slice(0, 48), targetFiles: [...new Set(files)], completed });
  }
  const allStepFiles = [...new Set(items.flatMap((i) => i.targetFiles))];
  if (allStepFiles.length > 0 && allStepFiles.every(isTouched)) {
    items.forEach((it, idx) => { if (it.targetFiles.length === 0 && (isTurnCompleted || idx < items.length - 1)) it.completed = true; });
  }
  return items;
}

export function formatPlanProgressBanner(planMarkdown: string, touchedFiles: readonly string[] = [], isTurnCompleted = false): string {
  const steps = extractPlanSteps(planMarkdown, touchedFiles, isTurnCompleted);
  if (steps.length === 0) return "";
  const doneCount = steps.filter((s) => s.completed).length;
  const chips = steps.slice(0, 6).map((s) => `${s.completed ? "☑" : "☐"} ${s.step}.${s.title.slice(0, 18)}`);
  return `📊 [计划步骤进度 ${doneCount}/${steps.length}]: ${chips.join(" · ")}`;
}

export function printGoalPlanProgress(ctrl: SessionController, isTurnCompleted = false): void {
  const planPath = path.join(ctrl.getPaths().workspaceRoot, ".debug", "plan.md");
  if (!fs.existsSync(planPath)) return;
  const touched = ctrl.getDiff("all").files.map((f) => f.file);
  if (touched.length === 0) return;
  const banner = formatPlanProgressBanner(cleanPlanArtifactText(fs.readFileSync(planPath, "utf-8")), touched, isTurnCompleted);
  if (banner) console.log(banner);
}

export function exportSessionToHtml(ctrl: SessionController): string {
  const paths = ctrl.getPaths(), entries = ctrl.loadEntries(), diff = ctrl.getDiff("all"), outPath = path.join(paths.workspaceRoot, ".debug", "session-export.html");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const rows = entries.map((e) => {
    const role = e.message.role, body = esc(typeof e.message.content === "string" ? e.message.content : JSON.stringify(e.message.content));
    const tools = e.message.role === "assistant" && e.message.toolCalls?.length ? `<div class="tools">${e.message.toolCalls.map((tc) => `<code>🔧 ${esc(tc.name)}(${esc(JSON.stringify(tc.arguments ?? {})).slice(0, 160)})</code>`).join("<br/>")}</div>` : "";
    return `<div class="card ${role}"><div class="meta"><b>${role.toUpperCase()}</b> · <span>#${e.id.slice(0, 8)}</span></div><pre>${body}</pre>${tools}</div>`;
  }).join("\n");
  const diffHtml = diff.files.length > 0 ? `<div class="card diff"><h3>📝 文件快照变更 (${diff.files.length} 个文件)</h3><ul>${diff.files.map((f) => `<li><b>${esc(f.file)}</b>: +${f.addedLines} / -${f.removedLines} 行 (${f.edits} 处修改)</li>`).join("")}</ul></div>` : "";
  writeFileAtomicSync(outPath, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><title>Duo-Harness Session Export</title><style>body{background:#0f141c;color:#e2e8f0;font-family:system-ui,sans-serif;max-width:960px;margin:24px auto;padding:0 16px}.card{background:#18202c;border:1px solid #2d3748;border-radius:8px;padding:12px 16px;margin-bottom:12px}.user{border-left:4px solid #38bdf8}.assistant{border-left:4px solid #a855f7}.tool{border-left:4px solid #22c55e;opacity:.9}.diff{border-left:4px solid #f59e0b}pre{white-space:pre-wrap;word-break:break-word;margin:6px 0;font-size:13px}.meta{font-size:12px;color:#94a3b8}.tools{margin-top:6px;font-size:12px;color:#cbd5e1}</style></head><body><h2>🚀 Duo-Harness 会话轨迹导出 (${esc(path.basename(paths.workspaceRoot))})</h2>${diffHtml}${rows}</body></html>`);
  return outPath;
}

export function resolveGoalTaskAndContext(rawGoalArg: string, ctrl: SessionController): { task: string; contextPrompt?: string } {
  const paths = ctrl.getPaths(), planPath = path.join(paths.workspaceRoot, ".debug", "plan.md");
  const trimmedArg = rawGoalArg.trim(), isExplicitPlan = trimmedArg.toLowerCase() === "plan";
  const customMd = trimmedArg && !isExplicitPlan ? resolveCustomMdArg(trimmedArg, paths.workspaceRoot) : null;
  if (trimmedArg && !isExplicitPlan && !customMd) return { task: trimmedArg };
  if (customMd && path.resolve(customMd) !== path.resolve(planPath)) {
    writeFileAtomicSync(planPath, `${cleanPlanArtifactText(fs.readFileSync(customMd, "utf-8"))}\n`);
  }
  const diskPlan = fs.existsSync(planPath) ? cleanPlanArtifactText(fs.readFileSync(planPath, "utf-8")) : "";
  const conciseHint = "（每步最多写 1~3 个文件，thinking 严格控制在 150 字以内，严禁在 thinking 中预先默写代码草稿）";
  if (diskPlan) {
    const planHash = computePlanHash(diskPlan), meta = loadProjectMeta(paths.metaFile);
    const leafId = ctrl.getLeafId(), entries = ctrl.loadEntries(), isNew = ctrl.getStatus().isNew;
    const byId = new Map(entries.map((e) => [e.id, e])), branch: typeof entries = [];
    for (let cur = leafId ? byId.get(leafId) : undefined; cur && branch.length <= entries.length; cur = cur.parentId ? byId.get(cur.parentId) : undefined) branch.unshift(cur);
    const planIdx = meta.lastPlanLeafId ? branch.findIndex((e) => e.id === meta.lastPlanLeafId) : -1;
    const userCount = branch.filter((e) => e.message.role === "user").length;
    const touched = ctrl.getDiff("all").files.map((f) => f.file);
    const progressBanner = formatPlanProgressBanner(diskPlan, touched);
    if (!isExplicitPlan && !customMd && !isNew && planIdx === branch.length - 1 && userCount === 1 && diskPlan === cleanPlanArtifactText(String(branch[planIdx]!.message.content))) {
      saveProjectMeta(paths.metaFile, { lastExecutedPlanHash: planHash, lastPlanLeafId: null });
      if (progressBanner) console.log(progressBanner);
      return { task: `请严格按照你上一轮输出的规划方案逐步完成所有代码修改${conciseHint}，全部落盘后运行计划中的验证命令确认通过。` };
    }
    if (isExplicitPlan || Boolean(customMd) || isNew || meta.lastExecutedPlanHash !== planHash) {
      ctrl.newSession();
      saveProjectMeta(paths.metaFile, { lastExecutedPlanHash: planHash, lastPlanLeafId: null });
      const label = isExplicitPlan || customMd ? "<approved_plan>" : "最新 <approved_plan>";
      const modNote = touched.length > 0 ? `\n<workspace_modified_files>\n当前工作区在前序轮次已修改过的文件（必要时请先用 read_file 核对最新内容）：${touched.join(", ")}\n</workspace_modified_files>` : "";
      console.log(`📋 [已挂载执行计划] ${customMd ? toPosixRelative(paths.workspaceRoot, customMd) : ".debug/plan.md"} (#${planHash.slice(0, 8)}) · 已从根节点开启干净执行分支`);
      if (progressBanner) console.log(progressBanner);
      return { task: `请严格按照 ${label} 中的实施计划逐步完成所有代码修改${conciseHint}，全部落盘后运行计划中的验证命令确认通过。`, contextPrompt: `<approved_plan>\n${diskPlan}\n</approved_plan>${modNote}` };
    }
    const isPlanBranch = planIdx >= 0 || branch.some((e) => typeof e.message.content === "string" && (e.message.content.includes("<approved_plan>") || e.message.content.includes(PLAN_MODE_CONTEXT_PROMPT)));
    if (isPlanBranch) {
      if (progressBanner) console.log(progressBanner);
      return { task: `请继续推进并完成 <approved_plan> 中的剩余步骤，采用分批小步落盘${conciseHint}，确保所有代码落盘并通过构建/运行验证。`, contextPrompt: `<approved_plan>\n${diskPlan}\n</approved_plan>` };
    }
  }
  return { task: `请继续推进并完成当前目标，采用分批小步落盘${conciseHint}，确保所有代码落盘并通过构建/运行验证。` };
}

export function buildPlanOrGoalDropdown(line: string, currentWorkspaceRoot: string): DropdownItem[] {
  const isGoal = /^\/goal(?:\s|$)/i.test(line), filter = line.replace(/^\/(?:plan|goal)\b\s*/i, "").trim(), lowerFilter = filter.toLowerCase();
  const subMatch = !isGoal ? filter.match(/^(view|full|-f|--full|edit|-e|--edit|open)\s+(.*)$/i) : null;
  if (subMatch) {
    const verb = subMatch[1]!.toLowerCase(), q = subMatch[2]!.trim().replace(/^@/, "");
    return filterAndRankFiles(listWorkspaceFiles(currentWorkspaceRoot).filter((f) => /\.(?:md|markdown)$/i.test(f)), q, 6).map((f) => ({ label: `/plan ${verb} ${f}`, desc: `📄 指定工作区 Markdown 方案 (${f})`, fillText: `/plan ${verb} ${f}` }));
  }
  if (!fs.existsSync(path.join(currentWorkspaceRoot, ".debug", "plan.md"))) {
    if (!/\s$/.test(line) && !filter) return [];
    const mdItems = isGoal ? filterAndRankFiles(listWorkspaceFiles(currentWorkspaceRoot).filter((f) => /\.(?:md|markdown)$/i.test(f)), filter.replace(/^@/, ""), 5).map((f) => ({ label: `/goal ${f}`, desc: `📋 按工作区自定义方案执行 (${f})`, fillText: `/goal ${f}` })) : [];
    return filter !== "" ? mdItems : [isGoal ? { label: "/goal <任务目标>", desc: "💡 当前工作区尚无 .debug/plan.md · 请直接输入任务目标并回车", fillText: "/goal " } : { label: "/plan <任务需求>", desc: "💡 当前工作区尚无 .debug/plan.md · 请直接输入规划需求并回车", fillText: "/plan " }, ...mdItems];
  }
  const candidates: Array<{ item: DropdownItem; keywords: string[] }> = isGoal
    ? [
        { item: { label: "/goal", desc: "🚀 按当前 .debug/plan.md 规划方案自动执行 (优先复用热缓存/续接剩余步骤)", fillText: "/goal" }, keywords: ["goal", "run"] },
        { item: { label: "/goal plan", desc: "🌱 从根节点开启全新干净分支重头执行 .debug/plan.md", fillText: "/goal plan" }, keywords: ["plan", "new", "clean"] },
      ]
    : [
        { item: { label: "/plan <新规划需求>", desc: "🗺️ 输入新需求生成/更新 .debug/plan.md (或按 ↓ 选择查看已有计划)", fillText: "/plan ", expandOnly: true }, keywords: [] },
        { item: { label: "/plan view", desc: "📝 终端高亮预览当前规划方案 (.debug/plan.md)", fillText: "/plan view" }, keywords: ["view", ".debug/plan.md"] },
        { item: { label: "/plan full", desc: "📖 终端全屏展开完整规划方案 (不折叠代码块，分页浏览)", fillText: "/plan full" }, keywords: ["full", "-f", "--full"] },
        { item: { label: "/plan edit", desc: "✏️ 调用外部编辑器 (Cursor/VS Code/Vim) 修改 .debug/plan.md (同 Ctrl+G)", fillText: "/plan edit" }, keywords: ["edit", "-e", "--edit", "open"] },
        { item: { label: "/plan open --web", desc: "🌐 拉起独立浏览器预览窗查看/编辑 .debug/plan.md", fillText: "/plan open --web" }, keywords: ["open --web", "open -w", "--web", "-w", "web"] },
        { item: { label: "/goal plan", desc: "🚀 按当前 .debug/plan.md 规划方案开启干净分支自动执行 (回车确认)", fillText: "/goal plan", expandOnly: true }, keywords: ["goal"] },
      ];
  return candidates.filter((c) => !lowerFilter || c.keywords.some((kw) => kw.startsWith(lowerFilter))).map((c) => c.item);
}
export function handlePlanAndSessionCmd(cmd: string, ctrl: SessionController): boolean {
  const norm = cmd.trim().replace(/\s+/g, " ").toLowerCase();
  const paths = ctrl.getPaths(), ws = paths.workspaceRoot, planPath = path.join(ws, ".debug", "plan.md");
  if (/^\/?mdp(?:\s|$)/i.test(cmd.trim())) {
    const restArg = cmd.trim().replace(/^\/?mdp\b/i, "").trim(), res = runMdpCli(restArg ? [restArg] : [], ws);
    if (!res.ok) console.log(`⚠️ ${res.error}`);
    else if (res.mode === "md-preview") console.log(`📝 已拉起 Markdown 浏览器预览窗: ${res.resolved} (按 E 编辑 · Ctrl+S/自动保存 · Esc 关闭)`);
    else if (res.mode === "editor") console.log(`📝 [${res.edited ? "已保存修改" : "未做修改"} (${res.editor ?? "editor"})]: ${res.resolved}`);
    else console.log(`\n💡 终端预览: ${res.resolved} (加 -f 展开全部代码 | 加 -e 用编辑器修改 | 加 --web 用浏览器预览)`);
    return true;
  }
  if (norm === "/export") {
    const outPath = exportSessionToHtml(ctrl);
    console.log(`📄 [会话已导出为独立 HTML]: ${outPath} (可输入 /open .debug/session-export.html 在浏览器打开)`);
    return true;
  }
  const planSub = cmd.trim().match(/^\/plan(?:\s+(view|full|-f|--full|edit|-e|--edit|open|-w|--web))?(?:\s+([^\s]+))?(?:\s+(--web|-w))?$/i);
  const subVerb = planSub?.[1]?.toLowerCase(), arg1 = planSub?.[2], arg2 = planSub?.[3]?.toLowerCase();
  const isPlanAction = Boolean(planSub && (!arg1 || /\.(?:md|markdown)$/i.test(arg1.replace(/^@/, "")) || /^(?:--web|-w)$/i.test(arg1)));
  if (isPlanAction) {
    const isWebFlag = subVerb === "-w" || subVerb === "--web" || Boolean(arg1 && /^(?:--web|-w)$/i.test(arg1)) || Boolean(arg2);
    const rawMdArg = arg1 && !/^(?:--web|-w)$/i.test(arg1) ? arg1 : undefined;
    const targetPath = rawMdArg ? resolveCustomMdArg(rawMdArg, ws) : planPath;
    if (!targetPath || !fs.existsSync(targetPath)) {
      console.log(rawMdArg ? `⚠️ 未找到指定的规划文档: ${rawMdArg}` : "💡 用法: /plan <任务需求> (只读探路并生成 .debug/plan.md 实施计划，确认后输入 /goal 一键执行)");
      return true;
    }
    const relLabel = toPosixRelative(ws, targetPath), isEditOrWeb = Boolean(subVerb && /^(?:edit|-e|--edit|open|-w|--web)$/.test(subVerb)) || isWebFlag;
    if (!isEditOrWeb) {
      const isFull = Boolean(subVerb && /^(?:full|-f|--full)$/.test(subVerb));
      const rendered = `\n📋 [当前规划方案 (${relLabel})${isFull ? " · 已展开完整源码" : ""}]:\n${renderMarkdownDocument(fs.readFileSync(targetPath, "utf-8").trim(), { expandCodeBlocks: isFull })}\n\n💡 直接输入 /goal 即可执行 | 按 Ctrl+G (或输入 /plan edit) 在编辑器修改 | 输入 /plan full 全屏浏览 | 输入 /plan open --web 浏览器预览`;
      if (isFull && runTerminalPager(rendered, { forcePager: true })) return true;
      console.log(rendered);
      return true;
    }
    if (isWebFlag) {
      const res = openInDefaultApp(`${relLabel} --web`, ws);
      console.log(res.ok ? `📝 已拉起规划方案浏览器预览窗: ${res.resolved} (按 E 编辑 · Esc 关闭)` : `⚠️ ${res.error}`);
      return true;
    }
    const ed = editFileInExternalEditor(targetPath);
    console.log(ed.ok ? `📝 [${ed.edited ? "已更新规划方案 (检测到手工修订)" : "已查看规划方案 (未做修改)"} (${ed.editor ?? "editor"})]: ${targetPath} · 直接输入 /goal 即可按计划执行` : `⚠️ ${ed.error}`);
    return true;
  }
  if (cmd === "/compact") {
    const c = ctrl.compact(), savedPct = c.beforeChars > 0 ? Math.round(((c.beforeChars - c.afterChars) / c.beforeChars) * 100) : 0;
    console.log(c.compactedCount > 0 ? `🗜️ 已折叠 ${c.compactedCount} 条历史大文件输出与 @引用块 (${(c.beforeChars / 1024).toFixed(1)} KB → ${(c.afterChars / 1024).toFixed(1)} KB，节省 ${savedPct}% 上下文体积，下轮起锁定精简缓存前缀)。` : "ℹ️ 当前对话上下文已经处于精简状态，无需折叠。");
    return true;
  }
  if (cmd === "/projects" || cmd === "/cd") {
    const projects = listManagedProjects(path.dirname(paths.projectDir));
    console.log(`\n📁 [已管理项目列表 (共 ${projects.length} 个 · 敲 /cd 后可按 ↑/↓ 键直接选项目)]:`);
    projects.forEach((p, i) => console.log(`  [${i + 1}] ${padCols(path.basename(p.workspaceRoot), 16)} (${p.entryCount} 条记录)${p.workspaceRoot === ws ? " ●当前项目" : ""}  ${p.workspaceRoot}`));
    return true;
  }
  if (cmd === "/new") { ctrl.newSession(); console.log("✨ 已开启全新对话（之前的历史对话已安全保留，随时可输入 /resume 用 ↑/↓ 方向键切回）。"); return true; }
  if (cmd === "/clear") { ctrl.clearHistory(); console.log("🧹 已彻底清空当前项目所有历史记录。"); return true; }
  if (cmd === "/goal" && ctrl.getStatus().isNew && !fs.existsSync(planPath)) { console.log("💡 用法: /goal <任务目标> (例如: /goal 按照项目文档初始化项目并运行)"); return true; }
  return false;
}

export async function verifyGoalCompletion(workspaceRoot: string, finalAnswer: string, signal?: AbortSignal, isGoal = true): Promise<{ ok: boolean; errorOutput?: string }> {
  if (isGoal && /(?:接下来我将|下一步我将|现在开始创建|准备开始修改)/.test(finalAnswer) && finalAnswer.length < 240) {
    return { ok: false, errorOutput: "当前处于 /goal 自治模式，请不要只汇报下一步计划，请直接调用工具完成剩余步骤后再总结。" };
  }
  if (fs.existsSync(path.join(workspaceRoot, "tsconfig.json")) && (fs.existsSync(path.join(workspaceRoot, "node_modules", ".bin", "tsc")) || fs.existsSync(path.join(workspaceRoot, "node_modules", ".bin", "tsc.cmd")))) {
    const check = await runCommandInSandbox("./node_modules/.bin/tsc --noEmit --incremental false", workspaceRoot, 30_000, signal, false);
    if (check.exitCode !== 0) return { ok: false, errorOutput: `npx tsc --noEmit 类型检查未通过 (exit ${check.exitCode}):\n${check.output.slice(0, 1500)}` };
  }
  return { ok: true };
}
