import { describe, expect, it } from "vitest";
import { buildBridgePrompt, evaluateAgyQuotaSurplus, parseBridgeReply, stripAgyFooter } from "../src/adapters/agy-bridge.js";
import { summarizeWireCost } from "../src/adapters/cost-tracker.js";
import {
  parseOpenAiAssistantMessage,
  resolveActiveModelTarget,
  resolveRouteTier,
  toOpenAiMessages,
  zodObjectToJsonSchema,
} from "../src/adapters/router.js";
import { assembleSsePayloads, createStreamRenderer, formatMarkdownLine } from "../src/adapters/sse-stream.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("Step 1.4: src/adapters/router.ts 协议转换与分时路由测试", () => {
  it("1. 按北京时间 (UTC+8) 精准切换工作日白天高峰与低谷半价窗", () => {
    // 2026-10-19 (周一) 北京时间 10:30 -> Tier 1 小米 MiMo 2.6
    const monMorningUtc = Date.UTC(2026, 9, 19, 2, 30, 0);
    expect(resolveRouteTier(monMorningUtc).tier).toBe("tier1_mimo_peak");

    // 2026-10-19 (周一) 北京时间 12:30 -> Tier 2 DeepSeek 午休半价窗
    const monLunchUtc = Date.UTC(2026, 9, 19, 4, 30, 0);
    expect(resolveRouteTier(monLunchUtc).tier).toBe("tier2_deepseek_offpeak");
  });

  it("2. 内部驼峰消息与 OpenAI 下划线协议双向无损转换（含非法 JSON 容错）", () => {
    const wireMessages = toOpenAiMessages([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: "ARCH.md" } }],
      },
      {
        role: "tool",
        toolCallId: "call_1",
        name: "read_file",
        content: "# ARCH",
        isError: false,
      },
    ]);

    expect(wireMessages[0]).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"ARCH.md"}' },
        },
      ],
    });
    expect(wireMessages[1]).toMatchObject({
      role: "tool",
      tool_call_id: "call_1",
      name: "read_file",
      content: "# ARCH",
    });

    // 当大模型返回残缺 JSON 参数时，parseOpenAiAssistantMessage 不抛错崩进程
    const parsedBroken = parseOpenAiAssistantMessage({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_broken",
          type: "function",
          function: { name: "read_file", arguments: "{broken_json" },
        },
      ],
    });
    expect(parsedBroken.content).toBe("");
    expect(parsedBroken.toolCalls?.[0]?.arguments).toEqual({
      _invalidJson: "{broken_json",
    });
  });

  it("3. Zod 参数对象自动转为 JSON Schema (识别必填、可选字段及嵌套数组/对象)", () => {
    const schema = z.object({
      path: z.string(),
      maxLines: z.number().optional(),
      edits: z.array(z.object({ oldText: z.string(), newText: z.string() })).optional(),
    });
    expect(zodObjectToJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        path: { type: "string" },
        maxLines: { type: "number" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string" },
              newText: { type: "string" },
            },
            required: ["oldText", "newText"],
          },
        },
      },
      required: ["path"],
    });
  });

  it("4. 将多行 SSE 流碎片拼接成完整 AssistantMessage（含分段 tool_calls arguments）", () => {
    const sseAssembled = assembleSsePayloads([
      '{"choices":[{"index":0,"delta":{"role":"assistant","content":"我先"}}]}',
      '{"choices":[{"index":0,"delta":{"content":"读文件"}}]}',
      '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}',
      '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}',
      '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"AGENTS.md\\"}"}}]}}]}',
      "[DONE]",
    ]);
    expect(sseAssembled.content).toBe("我先读文件");
    expect(sseAssembled.toolCalls).toEqual([
      { id: "call_1", name: "read_file", arguments: { path: "AGENTS.md" } },
    ]);

    // 5. 验证思考流多行展开、工具生成进度与超宽折行表格/段落 ANSI Markdown 渲染器
    const chunks: string[] = [];
    const renderer = createStreamRenderer({ write: (s) => chunks.push(s), columns: 60 });
    renderer.onEvent({ type: "reasoning_delta", text: "Let me think\nabout this" });
    renderer.onEvent({ type: "tool_call_delta", index: 0, name: "read_file", argsDelta: '{"path":"a.ts"}' });
    renderer.onEvent({
      type: "content_delta",
      text: "## 标题\n| 文件 | 说明 |\n|---|---|\n| `main.py` | **改动最大**的超长表格行测试超越60列宽度依然完整格式化不裸露符号 |\n---\n1. 第一项\n```py\napp()\n```\n4 个**过时文件未动**（末尾无换行自动 flush 格式化）",
    });
    renderer.flush();
    const out = chunks.join("");
    expect(out).toContain("💭 \x1b[2m\x1b[3mLet me think\n   about this");
    expect(out).toContain("⏳ 正在生成工具调用 read_file");
    expect(out).toContain("▍ 标题");
    expect(out).toContain("├────────────────────────────────────────┤");
    expect(out).toContain("\x1b[1;97m改动最大\x1b[0m");
    expect(out).toContain("\x1b[1;97m过时文件未动\x1b[0m");
    expect(out).toContain("\x1b[36mmain.py\x1b[0m");
    expect(out).toContain("────────────────────────────────────────");
    expect(formatMarkdownLine("### 1. `.gitignore` 问题", false).text).toContain("▸ 1.");
  });

  it("5. 同会话模型粘性保缓存路由 (auto 续聊锁定上一轮模型，/new 或 /model 显式切换)", () => {
    const prevDs = process.env.DEEPSEEK_API_KEY;
    const prevMimo = process.env.MIMO_API_KEY;
    process.env.DEEPSEEK_API_KEY = "sk-test-ds";
    process.env.MIMO_API_KEY = "tp-test-mimo";
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "duo-sticky-"));
    const wireFile = path.join(tmpDir, "http-wire.json");
    fs.writeFileSync(wireFile, JSON.stringify([{ requestBody: { model: "deepseek-reasoner" } }]), "utf-8");

    // 续聊且 mode="auto"：即使在工作日 14:10 高峰期，也粘性保持 deepseek-reasoner 防 KV 缓存失效
    const monPeakUtc = Date.UTC(2026, 9, 19, 6, 10, 0);
    const sticky = resolveActiveModelTarget(wireFile, true, "auto", monPeakUtc);
    expect(sticky.model).toBe("deepseek-reasoner");
    expect(sticky.shortLabel).toContain("保缓存");

    // /new 新对话 (hasPriorAssistant=false)：按当前时段切换为 MiMo-2.6
    const fresh = resolveActiveModelTarget(wireFile, false, "auto", monPeakUtc);
    expect(fresh.model).toBe("mimo-v2.6-pro");

    // 显式指定 /model mimo：无视历史强制切换
    const forced = resolveActiveModelTarget(wireFile, true, "mimo", monPeakUtc);
    expect(forced.model).toBe("mimo-v2.6-pro");

    // 显式指定 /model agy：走本机 Antigravity 订阅额度桥接
    const agyTarget = resolveActiveModelTarget(wireFile, true, "agy", monPeakUtc);
    expect(agyTarget.model).toBe("gemini-4-argon-agy");
    expect(agyTarget.shortLabel).toContain("Argon");

    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevDs === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prevDs;
    if (prevMimo === undefined) delete process.env.MIMO_API_KEY; else process.env.MIMO_API_KEY = prevMimo;
  });

  it("8. Antigravity 5h 临期额度感知公式、尾注字数守恒剥离与 ¥0 订阅计费档测试", () => {
    // 周剩余 < 25% 时一律保守留存，禁止白嫖烧穿周额度
    expect(evaluateAgyQuotaSurplus(90, 15, 20)).toBe(false);
    // 周剩余充足 (41.6%) 且 5h 剩余 >= 50%、距刷新 <= 90 分钟时，优先白嫖即将刷新的 5h 额度
    expect(evaluateAgyQuotaSurplus(74.6, 8, 41.6)).toBe(true);
    // 5h 剩余 60% 但距刷新还有 180 分钟 (< 75% 且非临期) 时不主动抢跑
    expect(evaluateAgyQuotaSurplus(60, 180, 41.6)).toBe(false);

    // 剥离尾注且保护正文与 --- 分隔线
    const rawWithFooter = '这是第一段正文\n---\n这是第二段正文\n<details data-agy-footer="1"><summary>统计</summary></details>';
    expect(stripAgyFooter(rawWithFooter)).toBe("这是第一段正文\n---\n这是第二段正文");
    expect(stripAgyFooter('<details data-agy-footer="1">仅尾注时保留防空</details>')).toContain("data-agy-footer");

    // 验证 Agy 桥接提示词注入宿主工具列表（含参数签名）并能将带嵌套数组/前置文字的返回 JSON 解析为 AssistantMessage.toolCalls
    const bridgePrompt = buildBridgePrompt(
      [{ role: "user", content: "看下我代码" }],
      [{ name: "grep", description: "搜索代码", parameters: z.object({ pattern: z.string(), path: z.string().optional() }), readonly: true, execute: () => "" }],
    );
    expect(bridgePrompt).toContain("grep(pattern, path?)");
    const parsedToolReply = parseBridgeReply(
      '好的，我先修改文件：\n```json\n{"content":"我先改文件","toolCalls":[{"name":"edit_file","arguments":{"path":"a.ts","edits":[{"oldText":"a","newText":"b"}]}}]}\n```',
      "先改文件",
    );
    expect(parsedToolReply.toolCalls).toHaveLength(1);
    expect(parsedToolReply.toolCalls?.[0]?.name).toBe("edit_file");
    expect((parsedToolReply.toolCalls?.[0]?.arguments as any)?.edits).toHaveLength(1);
    expect(parsedToolReply.reasoningContent).toBe("先改文件");

    // cost-tracker 对 gemini-4-argon-agy 计为 ¥0
    const report = summarizeWireCost([
      {
        roundTimestamp: "2026-10-22T10:30:00.000Z",
        apiUrl: "agy://local-language-server",
        requestBody: { model: "gemini-4-argon-agy", messages: [{ role: "user", content: "hi" }] },
        rawSseLines: ['data: {"model":"gemini-4-argon-agy","usage":{"prompt_tokens":3000,"completion_tokens":500,"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":3000}}'],
        assembledMessage: { role: "assistant", content: "ok" },
      },
    ]);
    expect(report.totalCostCny).toBe(0);
    expect(report.periodLabel).toContain("Antigravity");
  });
});
