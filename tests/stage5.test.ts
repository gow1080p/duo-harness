import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { compactMessages } from "../src/core/compactor.js";
import type { AssistantMessage, LlmProvider, Message } from "../src/core/contracts.js";
import { createBuiltinTools, executeToolCalls } from "../src/adapters/tools.js";
import {
  buildRepoMap,
  runCodeReview,
  scanArchitectureViolations,
} from "../src/adapters/reviewer.js";
import { createHarnessRpcServer } from "../src/adapters/rpc-server.js";
import { formatCostReport, summarizeWireCost } from "../src/adapters/cost-tracker.js";
import { toOpenAiMessages } from "../src/adapters/router.js";
import { analyzeSessionXray, formatXrayReport } from "../src/adapters/xray.js";
import type { HttpWireLogEntry } from "../src/adapters/sse-stream.js";

describe("Stage 5: 自主探路代码审查特工 (reviewer.ts)、RepoMap 与轻量 RPC/SSE 接口 (rpc-server.ts)", () => {
  it("1. 增量前缀缓存稳定性与带行号工具：折叠最旧超长输出后，后续轮次追加消息不会破坏中间轮次前缀缓存", async () => {
    const baseHistory: Message[] = [
      { role: "system", content: "系统指令" },
      { role: "user", content: "查文件" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.ts" } }] },
      { role: "tool", toolCallId: "c1", name: "read_file", content: "X".repeat(2_000), isError: false },
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "read_file", arguments: { path: "b.ts" } }] },
      { role: "tool", toolCallId: "c2", name: "read_file", content: "Y".repeat(400), isError: false },
      { role: "assistant", content: "第一阶段结论" },
    ];
    const opts = { maxTotalChars: 1_500, keepRecentMessages: 2, maxToolOutputChars: 100 };
    const round1 = compactMessages(baseHistory, opts);
    expect(round1[3]?.content).toContain("[已折叠历史工具输出");
    expect(round1[5]?.content).toBe("Y".repeat(400));

    const nextHistory: Message[] = [...baseHistory, { role: "user", content: "继续追问" }, { role: "assistant", content: "补充回答" }];
    const round2 = compactMessages(nextHistory, opts);
    expect(round2.slice(0, 7)).toEqual(round1.slice(0, 7));

    // 验证 read_file 带 1-based 行号输出 & grep 支持 contextLines
    const tools = createBuiltinTools(process.cwd());
    const res = await executeToolCalls(
      [
        { id: "r1", name: "read_file", arguments: { path: "package.json", startLine: 1, endLine: 3 } },
        { id: "g1", name: "grep", arguments: { pattern: "stepAgentLoop", path: "src/core/loop.ts", contextLines: 1 } },
      ],
      tools,
    );
    expect(res[0]?.content).toMatch(/^1: \{/m);
    expect(res[0]?.content).toMatch(/^2: /m);
    expect(res[1]?.content).toContain("src/core/loop.ts:");
    expect(res[1]?.content).toContain("|");
  });

  it("2. 自主探路审查闭环：生成 RepoMap + 拦截 core 违规导入 + 模型跨文件追查 + 非法 JSON 自动打回重修", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "duo-stage5-review-"));
    try {
      fs.mkdirSync(path.join(tmpDir, "src/core"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "src/adapters"), { recursive: true });

      fs.writeFileSync(
        path.join(tmpDir, "src/core/bad-core.ts"),
        [
          'import * as fs from "node:fs";',
          "export function computeScore(x: number): number {",
          "  return x + 1;",
          "}",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(tmpDir, "src/adapters/caller.ts"),
        [
          'import { computeScore } from "../core/bad-core.js";',
          "export function runCaller(): number {",
          "  return computeScore(41);",
          "}",
        ].join("\n"),
      );

      const repoMap = await buildRepoMap(tmpDir, "src");
      expect(repoMap).toContain("src/core/bad-core.ts (4 lines)");
      expect(repoMap).toContain("L2: export function computeScore");

      const violations = await scanArchitectureViolations(tmpDir, ["src/core/bad-core.ts"]);
      expect(violations.some((v) => v.includes("node:*"))).toBe(true);

      // 模拟大模型：第 1 步调 read_file 追查上游 caller.ts -> 第 2 步故意返回非 JSON 被 verifyCompletion 打回 -> 第 3 步返回标准 JSON
      const replies: AssistantMessage[] = [
        {
          role: "assistant",
          content: "我先追查一下 caller.ts 的跨文件调用",
          toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: "src/adapters/caller.ts" } }],
        },
        {
          role: "assistant",
          content: "我认为这段代码有问题，但这里我故意忘了输出 JSON 格式",
        },
        {
          role: "assistant",
          content: JSON.stringify({
            passed: false,
            staticViolations: [],
            findings: [
              {
                file: "src/core/bad-core.ts",
                line: 1,
                severity: "error",
                issue: "core 层违规导入 node:fs",
                fix: "移除 node:fs 导入，将文件读写移至 adapters 层",
              },
            ],
          }),
        },
      ];
      let callIdx = 0;
      const mockProvider: LlmProvider = {
        async chat() {
          return replies[callIdx++]!;
        },
      };

      const reviewRes = await runCodeReview({
        workspaceRoot: tmpDir,
        files: ["src/core/bad-core.ts"],
        provider: mockProvider,
        maxSteps: 5,
      });

      expect(reviewRes.stepsUsed).toBe(2);
      expect(reviewRes.report.passed).toBe(false);
      expect(reviewRes.report.staticViolations.length).toBeGreaterThan(0);
      expect(reviewRes.report.findings[0]?.file).toBe("src/core/bad-core.ts");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("3. 轻量 HTTP/SSE 接口服务 (rpc-server.ts)：支持 /health、JSON 问答/审查与 SSE 实时事件流推送", async () => {
    const mockProvider: LlmProvider = {
      async chat() {
        return {
          role: "assistant",
          content: JSON.stringify({
            passed: true,
            staticViolations: [],
            findings: [],
          }),
        };
      },
    };

    const server = createHarnessRpcServer({
      workspaceRoot: process.cwd(),
      provider: mockProvider,
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const healthResp = await fetch(`${baseUrl}/health`);
      expect(healthResp.status).toBe(200);
      expect(await healthResp.json()).toEqual({ ok: true, status: "healthy" });

      const reviewResp = await fetch(`${baseUrl}/api/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "review", files: ["src/core/contracts.ts"] }),
      });
      const reviewJson = (await reviewResp.json()) as any;
      expect(reviewResp.status).toBe(200);
      expect(reviewJson.ok).toBe(true);
      expect(reviewJson.report.passed).toBe(true);

      const sseResp = await fetch(`${baseUrl}/api/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ prompt: "测试 SSE 流", stream: true }),
      });
      expect(sseResp.status).toBe(200);
      expect(sseResp.headers.get("content-type")).toContain("text/event-stream");
      const sseText = await sseResp.text();
      expect(sseText).toContain("event: step");
      expect(sseText).toContain("event: done");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("4. 零 Bug 成本与缓存统计器 (cost-tracker.ts)：支持末尾无 delta 的 usage 提取、防 reasoning 双重计费与前缀复用率诊断", () => {
    const mockWireEntries: HttpWireLogEntry[] = [
      {
        roundTimestamp: "2026-10-21T02:10:00.000Z", // 北京时间 10:10 (工作日高峰)
        apiUrl: "https://api.xiaomimimo.com/v1/chat/completions",
        requestBody: { model: "mimo-v2.6-pro", messages: [{}, {}] },
        rawSseLines: [
          'data: {"choices":[{"delta":{"content":"step1"}}]}',
          'data: {"choices":[],"model":"mimo-v2.6-pro","usage":{"prompt_tokens":500,"completion_tokens":60,"completion_tokens_details":{"reasoning_tokens":10},"prompt_tokens_details":{"cached_tokens":0}}}',
        ],
        assembledMessage: { role: "assistant", content: "step1" },
      },
      {
        roundTimestamp: "2026-10-21T02:10:05.000Z",
        apiUrl: "https://api.xiaomimimo.com/v1/chat/completions",
        requestBody: { model: "mimo-v2.6-pro", messages: [{}, {}, {}, {}, {}] },
        rawSseLines: [
          'data: {"choices":[],"model":"mimo-v2.6-pro","usage":{"prompt_tokens":3900,"completion_tokens":150,"completion_tokens_details":{"reasoning_tokens":20},"prompt_tokens_details":{"cached_tokens":0}}}',
        ],
        assembledMessage: { role: "assistant", content: "step2" },
      },
      {
        roundTimestamp: "2026-10-21T02:10:10.000Z",
        apiUrl: "https://api.xiaomimimo.com/v1/chat/completions",
        requestBody: { model: "mimo-v2.6-pro", messages: Array.from({ length: 8 }, () => ({})) },
        rawSseLines: [
          'data: {"choices":[],"model":"mimo-v2.6-pro","usage":{"prompt_tokens":6400,"completion_tokens":100,"completion_tokens_details":{"reasoning_tokens":10},"prompt_tokens_details":{"cached_tokens":3840}}}',
        ],
        assembledMessage: { role: "assistant", content: "step3" },
      },
    ];

    const summary = summarizeWireCost(mockWireEntries);
    expect(summary.rounds).toHaveLength(3);
    expect(summary.rounds[0]!.costCny).toBeCloseTo(0.00136, 6);
    expect(summary.rounds[0]!.diagnosis).toContain("首轮建库");
    expect(summary.rounds[1]!.diagnosis).toContain("未达起缓线 (<1024)");
    expect(summary.rounds[2]!.prefixRetentionPct).toBeCloseTo((3840 / 3968) * 100, 1);
    expect(summary.rounds[2]!.diagnosis).toContain("🟢 前缀复用");

    const replaySummary = summarizeWireCost(mockWireEntries, { isReplay: true });
    expect(replaySummary.totalCostCny).toBe(0);
    expect(formatCostReport(replaySummary)).toContain("离线回放模式");

    // 5. 同回合保留 reasoning_content、跨旧回合自动剥离 + X-Ray 零黑盒透视校验
    const openAiPayload = toOpenAiMessages([
      { role: "user", content: "第1轮问题" },
      { role: "assistant", content: "第1轮回答", reasoningContent: "旧回合思考应被剥离" },
      { role: "user", content: "第2轮问题" },
      { role: "assistant", content: "", reasoningContent: "当前回合工具步思考应保留", toolCalls: [{ id: "t1", name: "list_dir", arguments: {} }] },
      { role: "tool", toolCallId: "t1", name: "list_dir", content: "src", isError: false },
    ]);
    expect(openAiPayload[1]!.reasoning_content).toBeUndefined();
    expect(openAiPayload[3]!.reasoning_content).toBe("当前回合工具步思考应保留");

    const xray = analyzeSessionXray(".sessions/play.jsonl", ".sessions/http-wire.json");
    expect(formatXrayReport(xray)).toContain("Duo-Harness X-Ray 零黑盒物理透视台");
  });
});
