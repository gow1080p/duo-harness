import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { LlmProvider, ToolCall } from "../core/contracts.js";
import { runAgentSession } from "./cli.js";
import { loadAndFormatWireCost } from "./cost-tracker.js";
import { createRouterProvider } from "./router.js";
import { loadJsonlEntries } from "./store.js";
import { type FileVersionSnapshot, rollbackFileSnapshots } from "./write-tools.js";
import { analyzeSessionXray, formatXrayReport } from "./xray.js";

export interface ProjectSessionPaths {
  projectKey: string;
  workspaceRoot: string;
  projectDir: string;
  sessionFile: string;
  wireLogFile: string;
  metaFile: string;
}

export interface ManagedProjectSummary {
  projectKey: string;
  workspaceRoot: string;
  updatedAt: string;
  entryCount: number;
  lastLeafId: string | null;
}

export function resolveProjectSessionPaths(
  workspaceRoot = process.cwd(),
  homeBaseDir = path.join(os.homedir(), ".duo-harness", "projects"),
): ProjectSessionPaths {
  const resolved = path.resolve(workspaceRoot);
  const realRoot = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
  const baseName = path.basename(realRoot).replace(/[^a-zA-Z0-9_-]/g, "_") || "root";
  const hash8 = crypto.createHash("sha256").update(realRoot).digest("hex").slice(0, 8);
  const projectKey = `${baseName}-${hash8}`;
  const projectDir = path.join(homeBaseDir, projectKey);
  fs.mkdirSync(projectDir, { recursive: true });
  const metaFile = path.join(projectDir, "meta.json");
  fs.writeFileSync(
    metaFile,
    JSON.stringify({ projectKey, workspaceRoot: realRoot, updatedAt: new Date().toISOString() }, null, 2),
    "utf-8",
  );
  return {
    projectKey,
    workspaceRoot: realRoot,
    projectDir,
    sessionFile: path.join(projectDir, "chat.jsonl"),
    wireLogFile: path.join(projectDir, "http-wire.json"),
    metaFile,
  };
}

export function listManagedProjects(
  homeBaseDir = path.join(os.homedir(), ".duo-harness", "projects"),
): ManagedProjectSummary[] {
  if (!fs.existsSync(homeBaseDir)) return [];
  const dirs = fs.readdirSync(homeBaseDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  const list: ManagedProjectSummary[] = [];
  for (const d of dirs) {
    try {
      const pDir = path.join(homeBaseDir, d.name);
      const meta = JSON.parse(fs.readFileSync(path.join(pDir, "meta.json"), "utf-8"));
      const sFile = path.join(pDir, "chat.jsonl");
      const entries = fs.existsSync(sFile) ? loadJsonlEntries(sFile) : [];
      list.push({
        projectKey: String(meta.projectKey ?? d.name),
        workspaceRoot: String(meta.workspaceRoot ?? ""),
        updatedAt: String(meta.updatedAt ?? ""),
        entryCount: entries.length,
        lastLeafId: entries.length > 0 ? entries[entries.length - 1]!.id : null,
      });
    } catch {
      continue;
    }
  }
  return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function handleSlashCommand(
  cmd: string,
  paths: ProjectSessionPaths,
  snapshots: FileVersionSnapshot[],
  state: { leafId: string | null },
): Promise<boolean> | boolean {
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
      console.log(
        rb.rolledBackCount > 0
          ? `🔄 已撤回最近 1 次修改: ${rb.touchedPaths.join(", ")}`
          : "ℹ️ 当前没有可撤回的文件修改。",
      );
      return true;
    });
  }
  if (cmd === "/projects") {
    const projects = listManagedProjects(path.dirname(paths.projectDir));
    console.log(`\n📁 [本机已管理的项目列表 (共 ${projects.length} 个)]:`);
    for (const p of projects) {
      const activeTag = p.projectKey === paths.projectKey ? " (当前项目)" : "";
      console.log(`  - ${p.projectKey}${activeTag}: ${p.entryCount} 条记录 | 路径: ${p.workspaceRoot}`);
    }
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
  const snapshots: FileVersionSnapshot[] = [];
  const existing = fs.existsSync(paths.sessionFile) ? loadJsonlEntries(paths.sessionFile) : [];
  const provider = options.provider ?? createRouterProvider(paths.wireLogFile, existing.length > 0);
  const state = { leafId: existing.length > 0 ? existing[existing.length - 1]!.id : null, autoApprove: false };

  console.log(`\n🚀 [Duo-Harness 交互终端] 当前工作区: ${paths.workspaceRoot}`);
  console.log(`🗂️  [会话存档位置 (零污染项目 Git)]: ${paths.sessionFile}`);
  if (state.leafId) {
    console.log(`🔗 [已自动接续上次对话]: 共 ${existing.length} 条记录，当前节点 ${state.leafId}`);
  }
  console.log(`💡 快捷命令: /xray (看账单与明细) | /tree (看节点) | /branch <id> (分叉) | /undo (撤回修改) | /projects (多项目列表) | /clear (清空重开) | /exit (退出)\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const askApproval = async (toolCalls: ToolCall[]) => {
    if (state.autoApprove) return { approved: true };
    console.log(`\n┌─ ⚠️  需要你确认以下修改操作 ──────────────────────────────────`);
    for (const c of toolCalls) {
      if (c.name === "run_bash") {
        console.log(`│ 💻 执行命令: ${String(c.arguments?.command ?? "")}`);
      } else if (c.name === "edit_file") {
        console.log(`│ 📝 修改文件: ${String(c.arguments?.path ?? "")}`);
      } else {
        console.log(`│ 🔧 调用工具: ${c.name} ${JSON.stringify(c.arguments)}`);
      }
    }
    const ans = (
      await rl.question(`└─ 是否允许执行？[直接回车/y=允许本次 | a=本轮全自动放行 | n=拒绝] > `)
    )
      .trim()
      .toLowerCase();
    if (ans === "a") {
      state.autoApprove = true;
      return { approved: true };
    }
    return ans === "" || ans === "y" || ans === "yes"
      ? { approved: true }
      : { approved: false, reason: "用户在终端拒绝了该操作" };
  };

  try {
    while (true) {
      const line = (await rl.question("\n👤 你 > ")).trim();
      if (!line) continue;
      if (line === "/exit" || line === "/quit") break;
      if (await handleSlashCommand(line, paths, snapshots, state)) continue;

      const res = await runAgentSession(line, {
        workspaceRoot: paths.workspaceRoot,
        sessionFile: paths.sessionFile,
        wireLogFile: paths.wireLogFile,
        leafId: state.leafId ?? undefined,
        provider,
        snapshots,
        enableWriteTools: true,
        showCostReport: true,
        suppressFinalEcho: true,
        onApprovalRequest: askApproval,
      });
      state.leafId = res.leafId;
    }
  } finally {
    rl.close();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  startInteractiveRepl().catch((err) => {
    console.error("终端运行异常:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
