import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import type { LlmProvider, ToolContract } from "../core/contracts.js";
import type { ModelMode } from "./model-config.js";
import type { SandboxGrants } from "./sandbox-policy.js";

export interface SubagentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  source: "builtin" | "workspace" | "user";
  maxSteps?: number;
  filePath?: string;
}

export interface SubagentRuntimeContext {
  provider?: LlmProvider;
  model?: ModelMode;
  modelsConfigPath?: string;
  wireLogFile?: string;
  signal?: AbortSignal;
}

const DEFAULT_EXPLORE_PROMPT = [
  "你是运行在独立只读沙箱中的代码库极速探路子代理（Explore Subagent）。",
  "1. 你只能使用只读工具（list_dir、read_file、grep、fetch_url），尽可能在同一步并发发起多个工具调用以缩短耗时；",
  "2. 取证步 thinking 严格控制在 100 字以内，不要在思考中复述大段代码；",
  "3. 探路完成后直接输出结构化结论：明确列出关键文件的相对路径、精确行号区间（Lxx-Lyy）与核心调用逻辑，严禁寒暄。",
].join("\n");

function parseAgentMarkdownFile(filePath: string, source: "workspace" | "user"): SubagentConfig | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
    const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    const fmText = m ? m[1]! : "";
    const body = (m ? m[2]! : raw).trim();
    if (!body) return null;
    const baseName = path.basename(filePath, path.extname(filePath));
    const nameMatch = fmText.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m);
    const descMatch = fmText.match(/^description:\s*["']?([^"'\n]+)["']?\s*$/m);
    const stepsMatch = fmText.match(/^maxSteps:\s*(\d+)\s*$/m);
    const maxSteps = stepsMatch ? Math.max(2, Math.min(15, Number(stepsMatch[1]))) : undefined;
    const name = (nameMatch?.[1]?.trim() || baseName).toLowerCase();
    const description = descMatch?.[1]?.trim() || `自定义只读子代理 (${name})`;
    return { name, description, systemPrompt: `${DEFAULT_EXPLORE_PROMPT}\n\n${body}`, source, maxSteps, filePath };
  } catch {
    return null;
  }
}

export function discoverSubagents(workspaceRoot: string, homeDir = os.homedir()): SubagentConfig[] {
  const byName = new Map<string, SubagentConfig>();
  byName.set("explore", {
    name: "explore",
    description: "内置极速代码库探路特工（跨目录搜索符号、梳理调用链并返回精确行号）",
    systemPrompt: DEFAULT_EXPLORE_PROMPT,
    source: "builtin",
  });
  const userDirs = [
    path.join(homeDir, ".duo-harness", "agents"),
    path.join(homeDir, ".claude", "agents"),
    path.join(homeDir, ".pi", "agent", "agents"),
  ];
  const wsDirs = [
    path.join(workspaceRoot, ".duo-harness", "agents"),
    path.join(workspaceRoot, ".claude", "agents"),
    path.join(workspaceRoot, ".pi", "agents"),
  ];
  const scanDir = (dir: string, source: "workspace" | "user") => {
    if (!fs.existsSync(dir)) return;
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if ((e.isFile() || e.isSymbolicLink()) && e.name.endsWith(".md")) {
          const parsed = parseAgentMarkdownFile(path.join(dir, e.name), source);
          if (parsed) byName.set(parsed.name, parsed);
        }
      }
    } catch {}
  };
  for (const d of userDirs) scanDir(d, "user");
  for (const d of wsDirs) scanDir(d, "workspace");
  return [...byName.values()];
}
export const discoverCustomAgents = discoverSubagents;

async function mapWithConcurrency<TIn, TOut>(items: readonly TIn[], concurrency: number, fn: (item: TIn, idx: number) => Promise<TOut>): Promise<TOut[]> {
  const results = new Array<TOut>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx]!, idx);
    }
  });
  await Promise.all(workers);
  return results;
}

export const DelegateResearchArgsSchema = z.object({
  task: z.string().optional().describe("单个探路任务描述（与 tasks 二选一）"),
  agent: z.string().optional().describe("要调用的子代理名称（默认 explore，亦支持 .claude/agents/*.md 自定义名称）"),
  tasks: z
    .array(
      z.object({
        task: z.string().min(1).describe("并行子代理的具体探路任务"),
        agent: z.string().optional().describe("子代理角色名称（默认 explore）"),
      }),
    )
    .max(6)
    .optional()
    .describe("并行派发多个独立模块探路任务（最多 6 个，最大并发 3）"),
});

export function createSubagentTool(
  workspaceRoot: string,
  baseReadonlyTools: readonly ToolContract<any>[],
  grants?: SandboxGrants,
  runtimeCtx?: SubagentRuntimeContext,
): ToolContract<z.infer<typeof DelegateResearchArgsSchema>> {
  return {
    name: "delegate_research",
    description:
      "将跨目录代码搜索、多文件阅读或架构探路任务委派给独立上下文的只读子代理（支持单任务 task 或并行 tasks 数组，结果提纯后返回，零污染主会话上下文）",
    parameters: DelegateResearchArgsSchema,
    readonly: true,
    execute: async (args) => {
      const taskList =
        args.tasks && args.tasks.length > 0
          ? args.tasks
          : args.task?.trim()
            ? [{ task: args.task.trim(), agent: args.agent }]
            : [];
      if (taskList.length === 0) {
        throw new Error("请提供 task（单任务字符串）或 tasks（并行任务数组）参数");
      }
      const agents = discoverSubagents(workspaceRoot);
      const safeTools = baseReadonlyTools.filter(
        (t) => t.readonly === true && t.name !== "delegate_research" && t.name !== "edit_file" && t.name !== "run_bash",
      );
      const { runAgentSession } = await import("./cli.js");
      const outputs = await mapWithConcurrency(taskList, 3, async (item, idx) => {
        const targetName = (item.agent?.trim() || "explore").toLowerCase();
        const cfg = agents.find((a) => a.name === targetName) ?? agents[0]!;
        const res = await runAgentSession(item.task, {
          workspaceRoot,
          provider: runtimeCtx?.provider,
          model: runtimeCtx?.model,
          modelsConfigPath: runtimeCtx?.modelsConfigPath,
          wireLogFile: runtimeCtx?.wireLogFile,
          signal: runtimeCtx?.signal,
          sandboxGrants: grants,
          includeBuiltinTools: false,
          enableWriteTools: false,
          tools: safeTools,
          systemPrompt: cfg.systemPrompt,
          maxSteps: cfg.maxSteps ?? 6,
          quiet: true,
          snapshots: [],
        });
        const cleanAns = res.finalAnswer.length > 12_000 ? `${res.finalAnswer.slice(0, 12_000)}\n... [子代理输出已截断]` : res.finalAnswer;
        return taskList.length === 1
          ? `[子代理 ${cfg.name} · 共 ${res.stepsUsed} 步]\n${cleanAns}`
          : `=== 子代理 #${idx + 1} (${cfg.name} · ${res.stepsUsed} 步): ${item.task.slice(0, 60)} ===\n${cleanAns}`;
      });
      return outputs.join("\n\n");
    },
  };
}
