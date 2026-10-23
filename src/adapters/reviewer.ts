import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { LlmProvider } from "../core/contracts.js";
import { createAgyBridgeProvider, probeAgyQuota } from "./agy-bridge.js";
import { runAgentSession } from "./cli.js";
import { resolveSafePath } from "./tools.js";

export const ReviewFindingSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  severity: z.enum(["error", "warning", "info"]),
  issue: z.string().min(1),
  fix: z.string().min(1),
});

export const ReviewReportSchema = z.object({
  passed: z.boolean(),
  staticViolations: z.array(z.string()),
  findings: z.array(ReviewFindingSchema),
});

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export type ReviewReport = z.infer<typeof ReviewReportSchema>;

export interface CodeReviewOptions {
  workspaceRoot?: string;
  files: string[];
  provider?: LlmProvider;
  maxSteps?: number;
  sessionFile?: string;
}

const EXPORT_SYMBOL_REGEX =
  /^\s*export\s+(?:async\s+)?(?:function|interface|type|const|class|enum)\s+([A-Za-z0-9_]+)/;

const CORE_FORBIDDEN_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  { regex: /from\s+["']node:/, label: "禁止在 src/core/ 中导入 node:* 内置模块" },
  { regex: /\bfetch\s*\(/, label: "禁止在 src/core/ 中直接调用网络 fetch" },
  { regex: /\bprocess\.env\b/, label: "禁止在 src/core/ 中读取 process.env 环境变量" },
  { regex: /(?:from|import)\s*\(?["'][^"']*\/adapters\//, label: "禁止在 src/core/ 中反向依赖 src/adapters/" },
];

export async function buildRepoMap(
  workspaceRoot: string,
  scanDir: string = "src",
): Promise<string> {
  const realRoot = resolveSafePath(workspaceRoot, ".", "read");
  const targetDir = resolveSafePath(workspaceRoot, scanDir, "read");
  let entries: Array<{ name: string; parentPath: string; isFile: () => boolean }> = [];
  try {
    entries = await fs.readdir(targetDir, { recursive: true, withFileTypes: true });
  } catch {
    return "(未找到可扫描的源码目录)";
  }

  const tsFiles = entries
    .filter(
      (e) =>
        e.isFile() &&
        e.name.endsWith(".ts") &&
        !e.parentPath.includes("node_modules") &&
        !e.parentPath.includes(".git") &&
        !e.parentPath.includes(".sessions"),
    )
    .map((e) => path.join(e.parentPath, e.name))
    .sort();

  const sections: string[] = [];
  for (const fullPath of tsFiles) {
    const raw = await fs.readFile(fullPath, "utf-8");
    const lines = raw.split("\n");
    const relPath = path.relative(realRoot, fullPath).replace(/\\/g, "/");
    const symbols: string[] = [];
    lines.forEach((line, idx) => {
      if (EXPORT_SYMBOL_REGEX.test(line)) {
        symbols.push(`  L${idx + 1}: ${line.trim().replace(/\s*\{$/, "")}`);
      }
    });
    const header = `${relPath} (${lines.length} lines)`;
    sections.push(symbols.length > 0 ? `${header}\n${symbols.join("\n")}` : header);
  }
  return sections.join("\n");
}

export async function scanArchitectureViolations(
  workspaceRoot: string,
  files: string[],
  maxFileLines: number = 250,
): Promise<string[]> {
  const realRoot = resolveSafePath(workspaceRoot, ".", "read");
  const violations: string[] = [];
  for (const file of files) {
    const fullPath = resolveSafePath(workspaceRoot, file, "read");
    const raw = await fs.readFile(fullPath, "utf-8");
    const lines = raw.split("\n");
    const relPath = path.relative(realRoot, fullPath).replace(/\\/g, "/");

    if (lines.length > maxFileLines) {
      violations.push(
        `${relPath}:1 单文件行数超标 (${lines.length} 行 > 上限 ${maxFileLines} 行)`,
      );
    }

    const isCoreFile = relPath.startsWith("src/core/") || relPath.includes("/core/");
    if (isCoreFile) {
      lines.forEach((line, idx) => {
        for (const rule of CORE_FORBIDDEN_PATTERNS) {
          if (rule.regex.test(line)) {
            violations.push(`${relPath}:${idx + 1} ${rule.label} (${line.trim()})`);
          }
        }
      });
    }
  }
  return violations;
}

export function parseReviewReport(rawText: string): {
  ok: true;
  report: ReviewReport;
} | {
  ok: false;
  error: string;
} {
  const trimmed = rawText.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1]!.trim() : trimmed;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  const jsonSlice =
    firstBrace !== -1 && lastBrace > firstBrace
      ? candidate.slice(firstBrace, lastBrace + 1)
      : candidate;

  try {
    const parsed = JSON.parse(jsonSlice);
    const result = ReviewReportSchema.safeParse(parsed);
    if (!result.success) {
      return {
        ok: false,
        error: `JSON 字段不符合 ReviewReportSchema: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      };
    }
    return { ok: true, report: result.data };
  } catch (err) {
    return {
      ok: false,
      error: `无法解析为合法 JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function runCodeReview(
  options: CodeReviewOptions,
): Promise<{ report: ReviewReport; stepsUsed: number }> {
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const staticViolations = await scanArchitectureViolations(workspaceRoot, options.files);
  const repoMap = await buildRepoMap(workspaceRoot);

  const preloadedSnippets: string[] = [];
  for (const file of options.files) {
    const fullPath = resolveSafePath(workspaceRoot, file, "read");
    const lines = (await fs.readFile(fullPath, "utf-8")).split("\n");
    const numbered = lines.slice(0, 260).map((l, i) => `${i + 1}: ${l}`).join("\n");
    preloadedSnippets.push(`=== 待审文件: ${file} ===\n${numbered}`);
  }

  let activeProvider = options.provider;
  let useAgyOneShot = false;
  if (!activeProvider) {
    const quota = await probeAgyQuota();
    if (quota.shouldPreferAgy) {
      activeProvider = createAgyBridgeProvider();
      useAgyOneShot = true;
    }
  }
  const reviewPrompt = [
    "请对以下目标文件执行独立代码与架构审查。",
    "【全库 RepoMap 符号骨架图 (供跨文件调用定位行号)】:",
    repoMap,
    "【本地确定性静态规则扫描结果】:",
    staticViolations.length > 0 ? staticViolations.join("\n") : "0 项静态违规",
    "【待审文件带行号源码】:",
    preloadedSnippets.join("\n\n"),
    useAgyOneShot
      ? "以上已预加载完整待审源码与全库符号骨架，请直接基于现有信息完成单轮审查，切勿调用任何工具。"
      : "若待审文件调用了其他未预加载文件中的函数，请先调用 read_file 或 grep 工具核实上下游定义，禁止盲猜。",
    '审查完成后，必须只输出符合以下格式的纯 JSON：{"passed":boolean,"staticViolations":string[],"findings":[{"file":string,"line":number,"severity":"error"|"warning"|"info","issue":string,"fix":string}]}',
  ].join("\n\n");

  let verifiedReport: ReviewReport | null = null;
  const sessionResult = await runAgentSession(reviewPrompt, {
    workspaceRoot,
    provider: activeProvider,
    enableWriteTools: false,
    maxSteps: options.maxSteps ?? (useAgyOneShot ? 2 : 6),
    sessionFile: options.sessionFile,
    systemPrompt:
      "你是严谨的代码与架构审查特工。只允许使用只读工具追查跨文件引用，最终回答必须是严格的 ReviewReport JSON 对象。",
    verifyCompletion: (finalAnswer) => {
      const check = parseReviewReport(finalAnswer);
      if (!check.ok) {
        return { ok: false, errorOutput: check.error };
      }
      verifiedReport = check.report;
      return { ok: true };
    },
  });

  const baseReport: ReviewReport = verifiedReport ?? {
    passed: false,
    staticViolations,
    findings: [],
  };
  const mergedViolations = Array.from(new Set([...staticViolations, ...baseReport.staticViolations]));
  const hasErrors =
    mergedViolations.length > 0 || baseReport.findings.some((f) => f.severity === "error");

  return {
    report: {
      passed: !hasErrors && baseReport.passed,
      staticViolations: mergedViolations,
      findings: baseReport.findings,
    },
    stepsUsed: sessionResult.stepsUsed,
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const targetFiles = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const files = targetFiles.length > 0 ? targetFiles : ["src/core/loop.ts"];
  runCodeReview({ files }).then((res) => {
    console.log("\n🛡️ [代码审查报告]:\n" + JSON.stringify(res.report, null, 2));
    process.exit(res.report.passed ? 0 : 1);
  });
}
