import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { compactMessages } from "../src/core/compactor.js";
import type { AssistantMessage, LlmProvider, Message } from "../src/core/contracts.js";
import { runAgentSession } from "../src/adapters/cli.js";
import { createBuiltinTools, executeToolCalls, type AdapterToolContract } from "../src/adapters/tools.js";
import {
  buildRepoMap,
  runCodeReview,
  scanArchitectureViolations,
} from "../src/adapters/reviewer.js";
import { createHarnessRpcServer } from "../src/adapters/rpc-server.js";
import { formatCostReport, summarizeWireCost } from "../src/adapters/cost-tracker.js";
import { ensureDefaultModelsConfigFile, listAvailableModelModes, loadModelRegistryConfig, resolveActiveModelTarget, saveModelRegistryConfig, toOpenAiMessages } from "../src/adapters/router.js";
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

    const nextHistory: Message[] = [
      ...baseHistory,
      { role: "user", content: "继续追问" },
      { role: "assistant", content: "Z".repeat(450) },
    ];
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

  it("3. 轻量 HTTP/SSE 接口服务 (rpc-server.ts)：支持 /health、/api/status、/api/command 双端状态同步与 SSE 实时事件流", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "duo-rpc-home-"));
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
      homeBaseDir: tmpHome,
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

      // 验证双端共享控制接口：切换模型与开启新会话并持久化至 meta.json
      const cmdModel = await fetch(`${baseUrl}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "model", arg: "mimo" }),
      });
      expect(((await cmdModel.json()) as any).status.modelMode).toBe("mimo");

      const statusResp = await fetch(`${baseUrl}/api/status`);
      const statusJson = (await statusResp.json()) as any;
      expect(statusJson.ok).toBe(true);
      expect(statusJson.status.isNew).toBe(false);
      expect(statusJson.turns.length).toBe(1);

      const cmdNew = await fetch(`${baseUrl}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "new" }),
      });
      expect(((await cmdNew.json()) as any).status.isNew).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tmpHome, { recursive: true, force: true });
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
    expect(summary.rounds[0]!.diagnosis).toContain("第1次发请求");
    expect(summary.rounds[1]!.diagnosis).toContain("未满1024词不缓存");
    expect(summary.rounds[2]!.prefixRetentionPct).toBeCloseTo((3840 / 3968) * 100, 1);
    expect(summary.rounds[2]!.diagnosis).toContain("旧内容命中");

    const replaySummary = summarizeWireCost(mockWireEntries, { isReplay: true });
    expect(replaySummary.totalCostCny).toBe(0);
    expect(formatCostReport(replaySummary)).toContain("离线回放模式");

    // 5. 默认跨回合保留 reasoning_content 锁死多轮 KV 前缀（亦支持显式 stripOldReasoning）+ X-Ray 零黑盒透视校验
    const multiTurnMsgs: Message[] = [
      { role: "user", content: "第1轮问题" },
      { role: "assistant", content: "第1轮回答", reasoningContent: "旧回合思考保留以锁死MiMo多轮KV缓存前缀" },
      { role: "user", content: "第2轮问题" },
      { role: "assistant", content: "", reasoningContent: "当前回合工具步思考应保留", toolCalls: [{ id: "t1", name: "list_dir", arguments: {} }] },
      { role: "tool", toolCallId: "t1", name: "list_dir", content: "src", isError: false },
    ];
    const openAiPayload = toOpenAiMessages(multiTurnMsgs);
    expect(openAiPayload[1]!.reasoning_content).toBe("旧回合思考保留以锁死MiMo多轮KV缓存前缀");
    expect(openAiPayload[3]!.reasoning_content).toBe("当前回合工具步思考应保留");
    const strippedPayload = toOpenAiMessages(multiTurnMsgs, process.cwd(), true, true);
    expect(strippedPayload[1]!.reasoning_content).toBeUndefined();
    expect(strippedPayload[3]!.reasoning_content).toBe("当前回合工具步思考应保留");

    // 6. 因果前缀压缩：当首条 user 含图片且后续工具输出超水位时，优先折叠工具输出而不改写 head[1]，且追加新回合保持 100% 前缀不变
    const causalBase: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "带图首问", images: [{ path: ".debug/a.png", mimeType: "image/png", byteSize: 64_000 }] },
      { role: "assistant", content: "", toolCalls: [{ id: "r1", name: "read_file", arguments: { path: "big.ts" } }] },
      { role: "tool", toolCallId: "r1", name: "read_file", content: "X".repeat(25_000), isError: false },
      { role: "assistant", content: "首轮完成" },
      { role: "user", content: "第2轮追问" },
      { role: "assistant", content: "", toolCalls: [{ id: "r2", name: "read_file", arguments: { path: "cur.ts" } }] },
      { role: "tool", toolCallId: "r2", name: "read_file", content: "Y".repeat(5_000), isError: false },
    ];
    const compTurn2 = compactMessages(causalBase, { maxTotalChars: 30_000, keepRecentMessages: 3 });
    expect((compTurn2[1] as Extract<Message, { role: "user" }>).images?.length).toBe(1);
    expect(compTurn2[3]!.content).toContain("[已折叠历史工具输出");
    const compTurn3 = compactMessages([...causalBase, { role: "assistant", content: "第2轮完成" }, { role: "user", content: "第3轮追问" }], {
      maxTotalChars: 30_000,
      keepRecentMessages: 3,
    });
    expect(compTurn3.slice(0, compTurn2.length)).toEqual(compTurn2);

    const xray = analyzeSessionXray(".sessions/play.jsonl", ".sessions/http-wire.json");
    expect(formatXrayReport(xray)).toContain("每步消息与工具调用明细");
  });

  it("5. 外部 models.json 用户配置化与业务系统 SDK 扩展钩子 (includeBuiltinTools:false / quiet / details / terminate:true 秒停)", async () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "duo-ext-sdk-"));
    try {
      // 1) 验证 .duo/models.json 自定义内网/本地模型加载与路由解析
      fs.mkdirSync(path.join(tmpWs, ".duo"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpWs, ".duo", "models.json"),
        JSON.stringify({
          defaultModel: "qwen-intranet",
          timeRouting: { peakModel: "qwen-intranet", offPeakModel: "deepseek", visionModel: "unconfigured-vlm" },
          models: {
            deepseek: {
              model: "deepseek-chat",
            },
            "corp-ds": {
              protocol: "openai",
              baseUrl: "https://llm.corp.internal/v1",
              model: "deepseek-chat",
              apiKey: "sk-corp",
            },
            "qwen-intranet": {
              protocol: "openai",
              baseUrl: "http://192.168.50.251:8000/v1",
              model: "qwen3.8-27b",
              label: "Qwen内网",
              supportsVision: false,
            },
          },
        }),
        "utf-8",
      );

      const cfg = loadModelRegistryConfig(tmpWs);
      expect(cfg.defaultModel).toBe("qwen-intranet");
      // 验证单字段增量覆写生效（无需重复填 baseUrl）
      expect(cfg.models.deepseek?.model).toBe("deepseek-chat");
      expect(cfg.models.deepseek?.baseUrl).toBe("https://api.deepseek.com");
      expect(listAvailableModelModes(tmpWs)).toContain("qwen-intranet");

      const targetAuto = resolveActiveModelTarget(undefined, false, "auto", Date.now(), false, tmpWs);
      expect(targetAuto.apiUrl).toBe("http://192.168.50.251:8000/v1/chat/completions");
      expect(targetAuto.model).toBe("qwen3.8-27b");
      expect(targetAuto.apiKey).toBe("EMPTY");
      expect(targetAuto.shortLabel).toContain("Qwen内网");

      // 验证多轮粘性路由按 apiUrl + model 精确匹配，防止同 model 名称的企业代理被内置 deepseek 劫持
      const wireFile = path.join(tmpWs, ".duo", "wire.json");
      fs.writeFileSync(wireFile, JSON.stringify([{ apiUrl: "https://llm.corp.internal/v1/chat/completions", requestBody: { model: "deepseek-chat" } }]), "utf-8");
      const stickyCorp = resolveActiveModelTarget(wireFile, true, "auto", Date.now(), false, tmpWs, { ...cfg, defaultModel: "auto" });
      expect(stickyCorp.apiUrl).toBe("https://llm.corp.internal/v1/chat/completions");
      expect(stickyCorp.shortLabel).toContain("保缓存");

      // 按模型实际名称 "qwen3.8-27b" 也能反查命中配置
      const targetByModelName = resolveActiveModelTarget(undefined, false, "qwen3.8-27b", Date.now(), false, tmpWs);
      expect(targetByModelName.apiUrl).toBe("http://192.168.50.251:8000/v1/chat/completions");

      // 验证 ensureDefaultModelsConfigFile 与 saveModelRegistryConfig 持久化保存
      const ensuredPath = ensureDefaultModelsConfigFile(tmpWs, true);
      expect(ensuredPath).toBe(path.join(tmpWs, ".duo", "models.json"));
      saveModelRegistryConfig({ defaultModel: "mimo", models: { mimo: { baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.6-pro", label: "MiMo-2.6" } } }, tmpWs, true);
      expect(loadModelRegistryConfig(tmpWs).defaultModel).toBe("mimo");

      // 2) 验证外部业务系统接入：includeBuiltinTools: false + extraTools + details 双通道 + terminate: true 省掉二次 LLM 请求
      const genuiTool: AdapterToolContract<{ title: string }> = {
        name: "genui_surface",
        description: "生成前端图表组件树",
        parameters: z.object({ title: z.string() }),
        readonly: true,
        execute: async ({ title }) => ({
          content: `已生成图表：${title}`,
          details: { surfaceId: "s_revenue", chartType: "bar", title, rows: 25 },
          terminate: true,
        }),
      };

      let llmCallCount = 0;
      let exposedToolNames: string[] = [];
      const mockProvider: LlmProvider = {
        async chat(_messages, tools = []) {
          llmCallCount += 1;
          exposedToolNames = tools.map((t) => t.name);
          return {
            role: "assistant",
            content: "为您展示今年各区域营收对比柱状图：",
            toolCalls: [{ id: "call_genui_1", name: "genui_surface", arguments: { title: "区域营收对比" } }],
          };
        },
      };

      const sessionFile = path.join(tmpWs, ".duo", "bi-session.jsonl");
      let capturedHookDetails: unknown;
      const res1 = await runAgentSession("画各区域营收柱状图", {
        workspaceRoot: tmpWs,
        sessionFile,
        provider: mockProvider,
        includeBuiltinTools: false,
        extraTools: [genuiTool],
        quiet: true,
        onAfterToolCall: (_call, result) => {
          capturedHookDetails = result.details;
        },
      });

      // 只暴露了业务工具，不包含 read_file/edit_file/run_bash
      expect(exposedToolNames).toEqual(["genui_surface"]);
      // terminate: true 生效：工具跑完当场结束，只调了 1 次 LLM（没有发第 2 次请求）
      expect(llmCallCount).toBe(1);
      expect(res1.finalAnswer).toBe("为您展示今年各区域营收对比柱状图：");
      expect(capturedHookDetails).toEqual({ surfaceId: "s_revenue", chartType: "bar", title: "区域营收对比", rows: 25 });
      expect(res1.toolDetails?.call_genui_1).toEqual({ surfaceId: "s_revenue", chartType: "bar", title: "区域营收对比", rows: 25 });

      // 3) 验证落盘的 .jsonl 不含 details/terminate 大字段，且第 2 轮续聊 100% 通过会话树配对检查
      const rawJsonl = fs.readFileSync(sessionFile, "utf-8");
      expect(rawJsonl).not.toContain("surfaceId");
      const res2 = await runAgentSession("再切到华东区看明细", {
        workspaceRoot: tmpWs,
        sessionFile,
        leafId: res1.leafId ?? undefined,
        provider: {
          async chat(messages) {
            llmCallCount += 1;
            expect(messages.some((m) => m.role === "tool" && m.content === "已生成图表：区域营收对比")).toBe(true);
            return { role: "assistant", content: "华东区明细已为您更新。" };
          },
        },
        includeBuiltinTools: false,
        extraTools: [genuiTool],
        quiet: true,
      });
      expect(llmCallCount).toBe(2);
      expect(res2.finalAnswer).toBe("华东区明细已为您更新。");
    } finally {
      fs.rmSync(tmpWs, { recursive: true, force: true });
    }
  });
});
