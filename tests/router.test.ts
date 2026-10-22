import { describe, expect, it } from "vitest";
import {
  parseOpenAiAssistantMessage,
  resolveRouteTier,
  toOpenAiMessages,
  zodObjectToJsonSchema,
} from "../src/adapters/router.js";
import { assembleSsePayloads, createStreamRenderer, formatMarkdownLine } from "../src/adapters/sse-stream.js";
import { z } from "zod";

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

  it("3. Zod 参数对象自动转为 JSON Schema (识别必填与可选字段)", () => {
    const schema = z.object({
      path: z.string(),
      maxLines: z.number().optional(),
    });
    expect(zodObjectToJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        path: { type: "string" },
        maxLines: { type: "number" },
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

    // 5. 验证思考流前段留屏、工具生成进度与行级 ANSI Markdown 渲染器
    const chunks: string[] = [];
    const renderer = createStreamRenderer({ write: (s) => chunks.push(s), columns: 100 });
    renderer.onEvent({ type: "reasoning_delta", text: "Let me think\nabout this" });
    renderer.onEvent({ type: "tool_call_delta", index: 0, name: "read_file", argsDelta: '{"path":"a.ts"}' });
    renderer.onEvent({ type: "content_delta", text: "## 标题\n- **重点**: `main.py`\n---\n1. 第一项\n```py\napp()\n```\n" });
    renderer.flush();
    const out = chunks.join("");
    expect(out).toContain("💭 \x1b[2m\x1b[3mLet me think about this");
    expect(out).toContain("⏳ 正在生成工具调用 read_file");
    expect(out).toContain("▍ 标题");
    expect(out).toContain("\x1b[1;97m重点\x1b[0m");
    expect(out).toContain("\x1b[36mmain.py\x1b[0m");
    expect(out).toContain("────────────────────────────────────────");
    expect(formatMarkdownLine("### 1. `.gitignore` 问题", false).text).toContain("• 1.");
  });
});
