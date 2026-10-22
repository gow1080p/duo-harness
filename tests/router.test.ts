import { describe, expect, it } from "vitest";
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevDs === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prevDs;
    if (prevMimo === undefined) delete process.env.MIMO_API_KEY; else process.env.MIMO_API_KEY = prevMimo;
  });
});
