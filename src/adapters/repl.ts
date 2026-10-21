import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { LlmProvider, ToolCall } from "../core/contracts.js";
import { runAgentSession } from "./cli.js";
import { loadAndFormatWireCost, padCols } from "./cost-tracker.js";
import { attachLiveSlashDropdown, getPromptVisualCols } from "./dropdown.js";
import {
  createReplCompleter,
  listManagedProjects,
  type ManagedProjectSummary,
  type ProjectSessionPaths,
  resolveProjectSessionPaths,
  SLASH_COMMANDS,
} from "./project-store.js";
import { createRouterProvider, resolveRouteTier } from "./router.js";
import { loadJsonlEntries } from "./store.js";
import { formatApprovalBox } from "./ui-logger.js";
import { type FileVersionSnapshot, rollbackFileSnapshots } from "./write-tools.js";
import { analyzeSessionXray, formatXrayReport } from "./xray.js";

export {
  createReplCompleter,
  listManagedProjects,
  type ManagedProjectSummary,
  type ProjectSessionPaths,
  resolveProjectSessionPaths,
  SLASH_COMMANDS,
};

interface ReplRuntimeState {
  paths: ProjectSessionPaths;
  provider: LlmProvider;
  snapshots: FileVersionSnapshot[];
  leafId: string | null;
  autoApprove: boolean;
  inMainPrompt: boolean;
  homeBaseDir?: string;
  customProvider?: LlmProvider;
}

function formatPrompt(workspaceRoot: string): string {
  const name = path.basename(workspaceRoot) || "root";
  const short = name.length > 18 ? `${name.slice(0, 15)}...` : name;
  return `\n📂 ${short} > `;
}

function resolveTargetWorkspace(targetArg: string, state: ReplRuntimeState): string | null {
  const projects = listManagedProjects(path.dirname(state.paths.projectDir));
  const idx = Number(targetArg);
  if (Number.isInteger(idx) && idx >= 1 && idx <= projects.length) {
    return projects[idx - 1]!.workspaceRoot;
  }
  const byManaged = projects.find(
    (p) => p.projectKey === targetArg || path.basename(p.workspaceRoot) === targetArg || p.projectKey.startsWith(`${targetArg}-`),
  );
  if (byManaged && fs.existsSync(byManaged.workspaceRoot)) {
    return byManaged.workspaceRoot;
  }
  const expanded = targetArg.startsWith("~/") ? path.join(os.homedir(), targetArg.slice(2)) : targetArg;
  const candidate = path.resolve(state.paths.workspaceRoot, expanded);
  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
  for (const up of ["..", "../.."]) {
    const sibling = path.resolve(state.paths.workspaceRoot, up, targetArg);
    if (fs.existsSync(sibling) && fs.statSync(sibling).isDirectory()) return sibling;
  }
  return null;
}

function switchProjectWorkspace(targetArg: string, state: ReplRuntimeState): void {
  const candidate = resolveTargetWorkspace(targetArg, state);
  if (!candidate) {
    console.log(`⚠️ 未找到项目或目录 "${targetArg}"（输入 / 然后回车即可用 ↑/↓ 方向键选择项目）`);
    return;
  }
  const realCandidate = fs.realpathSync(candidate);
  if (realCandidate === state.paths.workspaceRoot) {
    console.log(`ℹ️ 当前已经在 [${path.basename(realCandidate)}] 工作区中，无需重复切换。`);
    return;
  }
  state.paths = resolveProjectSessionPaths(realCandidate, state.homeBaseDir);
  const existing = fs.existsSync(state.paths.sessionFile) ? loadJsonlEntries(state.paths.sessionFile) : [];
  state.leafId = existing.length > 0 ? existing[existing.length - 1]!.id : null;
  state.provider = state.customProvider ?? createRouterProvider(state.paths.wireLogFile, existing.length > 0);
  state.snapshots = [];
  console.log(`✅ 已切换到 [${path.basename(realCandidate)}] (${state.paths.workspaceRoot} · 历史记录 ${existing.length} 条)`);
}

function handleSlashCommand(rawCmd: string, state: ReplRuntimeState): Promise<boolean> | boolean {
  const { paths, snapshots } = state;
  if (rawCmd === "/" || rawCmd === "/help" || rawCmd === "?") {
    console.log("\n💡 [快捷指令 (输入 / 后可直接用 ↑/↓ 方向键选择并回车执行)]:");
    for (const m of SLASH_COMMANDS) console.log(`  ${padCols(m.label, 14)} - ${m.desc}`);
    return true;
  }
  const exactOrUnique = !rawCmd.includes(" ")
    ? SLASH_COMMANDS.filter((c) => c.cmd.trim().startsWith(rawCmd))
    : [];
  const cmd = exactOrUnique.length === 1 ? exactOrUnique[0]!.cmd.trim() : rawCmd;

  if (cmd.startsWith("/cd ")) {
    switchProjectWorkspace(cmd.slice("/cd ".length).trim(), state);
    return true;
  }
  if (cmd === "/xray" || cmd === "/tree") {
    const costText = loadAndFormatWireCost(paths.wireLogFile);
    if (costText) console.log(costText);
    console.log(formatXrayReport(analyzeSessionXray(paths.sessionFile, paths.wireLogFile)));
    return true;
  }
  if (cmd.startsWith("/branch ")) {
    const targetId = cmd.slice("/branch ".length).trim();
    const entries = fs.existsSync(paths.sessionFile) ? loadJsonlEntries(paths.sessionFile) : [];
    if (!entries.some((e) => e.id === targetId)) {
      console.log(`⚠️ 未找到节点 ${targetId}，可先输入 /tree 查看现有节点 ID。`);
      return true;
    }
    state.leafId = targetId;
    console.log(`🌿 已将当前对话节点切回 ${targetId}，你的下一句提问将从该节点分叉！`);
    return true;
  }
  if (cmd === "/undo") {
    return rollbackFileSnapshots(paths.workspaceRoot, snapshots, 1).then((rb) => {
      console.log(rb.rolledBackCount > 0 ? `🔄 已撤回修改: ${rb.touchedPaths.join(", ")}` : "ℹ️ 当前没有可撤回的修改。");
      return true;
    });
  }
  if (cmd === "/projects" || cmd === "/cd") {
    const projects = listManagedProjects(path.dirname(paths.projectDir));
    console.log(`\n📁 [已管理项目列表 (共 ${projects.length} 个 · 敲 /cd 后可按 ↑/↓ 键直接选项目)]:`);
    projects.forEach((p, i) => {
      const name = path.basename(p.workspaceRoot);
      const tag = p.workspaceRoot === paths.workspaceRoot ? " ●当前项目" : "";
      console.log(`  [${i + 1}] ${padCols(name, 16)} (${p.entryCount} 条记录)${tag}  ${p.workspaceRoot}`);
    });
    return true;
  }
  if (cmd === "/clear" || cmd === "/new") {
    if (fs.existsSync(paths.sessionFile)) fs.unlinkSync(paths.sessionFile);
    if (fs.existsSync(paths.wireLogFile)) fs.unlinkSync(paths.wireLogFile);
    state.leafId = null;
    console.log("🧹 已清空当前项目对话记录，下一句将开启全新会话。");
    return true;
  }
  return false;
}

export async function startInteractiveRepl(options: {
  workspaceRoot?: string;
  homeBaseDir?: string;
  provider?: LlmProvider;
} = {}): Promise<void> {
  const paths = resolveProjectSessionPaths(options.workspaceRoot, options.homeBaseDir);
  const existing = fs.existsSync(paths.sessionFile) ? loadJsonlEntries(paths.sessionFile) : [];
  const state: ReplRuntimeState = {
    paths,
    provider: options.provider ?? createRouterProvider(paths.wireLogFile, existing.length > 0),
    snapshots: [],
    leafId: existing.length > 0 ? existing[existing.length - 1]!.id : null,
    autoApprove: false,
    inMainPrompt: false,
    homeBaseDir: options.homeBaseDir,
    customProvider: options.provider,
  };

  console.log(`\n🚀 Duo-Harness | 当前项目: ${path.basename(state.paths.workspaceRoot)} (${state.paths.workspaceRoot})`);
  console.log(`⚡ 模型路由: ${resolveRouteTier(Date.now()).reason}`);
  console.log(`💡 输入 / 用 ↑/↓ 方向键选择命令或切换项目 | 历史记录: ${existing.length} 条`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: createReplCompleter(() => state.paths.workspaceRoot, () => state.paths.sessionFile),
  });
  const detachDropdown = attachLiveSlashDropdown(
    rl,
    () => state.inMainPrompt,
    () => getPromptVisualCols(formatPrompt(state.paths.workspaceRoot)),
    () => state.paths.workspaceRoot,
    state.homeBaseDir,
  );
  const askApproval = async (toolCalls: ToolCall[]) => {
    if (state.autoApprove) return { approved: true };
    state.inMainPrompt = false;
    console.log(formatApprovalBox(toolCalls));
    const ans = (await rl.question(`└─ 是否允许执行？[直接回车/y=允许本次 | a=本轮全自动放行 | n=拒绝] > `)).trim().toLowerCase();
    if (ans === "a") state.autoApprove = true;
    return ans === "" || ans === "y" || ans === "yes" || ans === "a"
      ? { approved: true }
      : { approved: false, reason: "用户在终端拒绝了该操作" };
  };

  try {
    while (true) {
      state.inMainPrompt = true;
      let line = "";
      try {
        line = (await rl.question(formatPrompt(state.paths.workspaceRoot))).trim();
      } catch (err) {
        if (err instanceof Error && (err.name === "AbortError" || err.message.includes("Ctrl+C"))) {
          process.stdout.write("\r\n\x1b[J👋 已退出 Duo-Harness。\n");
          break;
        }
        throw err;
      }
      state.inMainPrompt = false;
      if (!line) continue;
      if (line === "/exit" || line === "/quit" || line === "/e") {
        process.stdout.write("👋 已退出 Duo-Harness。\n");
        break;
      }
      if (await handleSlashCommand(line, state)) continue;
      const res = await runAgentSession(line, {
        workspaceRoot: state.paths.workspaceRoot,
        sessionFile: state.paths.sessionFile,
        wireLogFile: state.paths.wireLogFile,
        leafId: state.leafId ?? undefined,
        provider: state.provider,
        snapshots: state.snapshots,
        enableWriteTools: true,
        showCostReport: true,
        suppressFinalEcho: true,
        onApprovalRequest: askApproval,
      });
      state.leafId = res.leafId;
    }
  } finally {
    detachDropdown();
    rl.close();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argDir = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : undefined;
  startInteractiveRepl({ workspaceRoot: argDir }).catch((err) => {
    console.error("终端运行异常:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
