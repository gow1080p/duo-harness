import { describe, expect, it } from "vitest";
import { buildBridgePrompt, evaluateAgyQuotaSurplus, parseBridgeReply, stripAgyFooter } from "../src/adapters/agy-bridge.js";
import { checkFileSyntax } from "../src/adapters/bash-policy.js";
import { buildAtMentionDropdown, expandAtMentions, runLocalBangCommand, stripAttachedFiles } from "../src/adapters/context-mention.js";
import { summarizeWireCost } from "../src/adapters/cost-tracker.js";
import { buildDropdownItems, encodePastedNewlines, restorePastedNewlines } from "../src/adapters/dropdown.js";
import { getVisualCols } from "../src/adapters/platform.js";
import { extractConversationTurns, loadProjectMeta, resolveProjectSessionPaths, saveProjectMeta } from "../src/adapters/project-store.js";
import { handleSlashCommand, runOneShotCli } from "../src/adapters/repl.js";
import { createSessionController } from "../src/adapters/session-controller.js";
import {
  parseOpenAiAssistantMessage,
  resolveActiveModelTarget,
  resolveRouteTier,
  toOpenAiMessages,
  zodObjectToJsonSchema,
} from "../src/adapters/router.js";
import { assembleSsePayloads, createStreamRenderer, formatMarkdownLine, readOpenAiSseStream } from "../src/adapters/sse-stream.js";
import { compactWireLogEntry } from "../src/adapters/store.js";
import { formatIntraLineDiffPair, highlightCodeLine } from "../src/adapters/diff-presenter.js";
import { formatApprovalBox, renderMarkdownDocument } from "../src/adapters/ui-logger.js";
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
    expect(out).toContain("┌─");
    expect(out).toContain("─┼─");
    expect(out).toContain("└─");
    expect(out).toContain("\x1b[1;97m改动最大\x1b[0m");
    expect(out).toContain("\x1b[1;97m过时文件未动\x1b[0m");
    expect(out).toContain("\x1b[36mmain.py\x1b[0m");
    expect(out).toContain("────────────────────────────────────────");
    expect(formatMarkdownLine("### 1. `.gitignore` 问题", false).text).toContain("▸ 1.");
    const multiCodeGlob = formatMarkdownLine("检查 `src/*.ts` 和 `test/*.ts`", false).text;
    expect(multiCodeGlob).toContain("src/*.ts");
    expect(multiCodeGlob).toContain("test/*.ts");
    const absPkg = path.resolve(process.cwd(), "package.json");
    const mdInline = formatMarkdownLine(`页面是根目录下的 package.json（完整路径 ${absPkg}），或点 \`package.json\``, false).text;
    expect(mdInline).not.toContain("\x1b]8;;");
    expect(mdInline).toContain(absPkg);
    const mdCode = formatMarkdownLine(absPkg, true).text;
    expect(mdCode).not.toContain("\x1b]8;;");
    expect(mdCode).toContain(absPkg);

    // 验证表格最末行无尾随换行紧接 tool_call_delta 时不被腰斩拆成两个表格
    const tblToolChunks: string[] = [];
    const rTbl = createStreamRenderer({ write: (s) => tblToolChunks.push(s), columns: 80 });
    rTbl.onEvent({ type: "content_delta", text: "| 模块 | 状态 |\n| --- | --- |\n| repl | 正常 |" });
    rTbl.onEvent({ type: "tool_call_delta", index: 0, name: "list_dir", argsDelta: "{}" });
    rTbl.flush();
    const tblToolOut = tblToolChunks.join("");
    expect((tblToolOut.match(/┌─/g) ?? []).length).toBe(1);
    expect(tblToolOut).toContain("repl");

    // 验证长思考 (>5行) 原地 5 行滚动预览 + 结束时自动收拢为 [已思考 N 字] 摘要
    const longReasonChunks: string[] = [];
    const r2 = createStreamRenderer({ write: (s) => longReasonChunks.push(s), columns: 60 });
    r2.onEvent({ type: "reasoning_delta", text: "第1行思考\n第2行思考\n第3行思考\n第4行思考\n第5行思考\n第6行思考\n第7行思考" });
    r2.onEvent({ type: "content_delta", text: "最终回答\n" });
    r2.flush();
    const longOut = longReasonChunks.join("");
    expect(longOut).toContain("[思考中");
    expect(longOut).toContain("[已思考");

    // 验证静态 Markdown 渲染器（/plan view 代码块智能折叠 + AST 符号骨架 + 行内 Diff 高亮胶囊）
    const samplePlan = [
      "# Stage 1 实施计划",
      "> 1. 所有外部环境均已预置就绪，**零 Python 依赖**。",
      "```go",
      "package main",
      "import (",
      '  "database/sql"',
      '  "fmt"',
      '  "net/http"',
      '  "os"',
      '  "strings"',
      ")",
      "type Store struct { db *sql.DB }",
      "func NewStore(path string) (*Store, error) {",
      "  return nil, nil",
      "}",
      "func (s *Store) GetDoc(id string) error {",
      "  return nil",
      "}",
      "func main() {",
      '  fmt.Println("ok")',
      "}",
      "```",
    ].join("\n");
    const foldedMd = renderMarkdownDocument(samplePlan, { expandCodeBlocks: false, maxCols: 76 });
    expect(foldedMd).toContain("🔎 核心符号骨架");
    expect(foldedMd).toContain("type Store · func NewStore");
    expect(foldedMd).toContain("/plan full");
    const fullMd = renderMarkdownDocument(samplePlan, { expandCodeBlocks: true, maxCols: 76 });
    expect(fullMd).not.toContain("🔎 核心符号骨架");
    expect(fullMd).toContain("main() {");

    const intraPair = formatIntraLineDiffPair("  return count + 1;", "  return count + 2;", 70);
    expect(intraPair).not.toBeNull();
    expect(intraPair.remFormatted).toContain("-   return count + 1;");
    expect(intraPair.addFormatted).toContain("+   return count + 2;");
    expect(intraPair.remFormatted).toContain("-1");
    expect(intraPair.addFormatted).toContain("+2");

    // 验证超长行 (>66列) 行尾修改仍能精准提取 Diff 胶囊且总视觉宽度严格受控
    const tailOld = "const res = await client.request(workspaceRoot, { timeout: 3000, retry: false });";
    const tailNew = "const res = await client.request(workspaceRoot, { timeout: 3000, retry: true });";
    const tailDiff = formatIntraLineDiffPair(tailOld, tailNew, 66);
    expect(tailDiff.remFormatted).toContain("-false");
    expect(tailDiff.addFormatted).toContain("+true");
    expect(getVisualCols(tailDiff.remFormatted.replace(/\x1b\[[0-9;]*m/g, ""))).toBeLessThanOrEqual(68);

    // 验证字符串字面量内的 SQL/Go 关键字不会被二次正则染色冲掉外层绿色
    const sqlLine = highlightCodeLine('const q = "SELECT * FROM users";');
    expect(sqlLine).toContain('\x1b[32m"SELECT * FROM users"\x1b[0m');
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

  it("9. SSE 流式 chunk 空闲看门狗 (readOpenAiSseStream)：连续吐字超时上限不误杀，半途真卡死立即触发空闲超时", async () => {
    const encoder = new TextEncoder();
    // Case A: 总耗时 ~90ms (> idleTimeoutMs=50ms)，但每 25ms 持续吐 chunk -> 100% 正常读完不误杀
    const continuousStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const word of ["第一段", "第二段", "第三段"]) {
          await new Promise((r) => setTimeout(r, 25));
          controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"${word}"}}]}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const okRes = new Response(continuousStream, { headers: { "content-type": "text/event-stream" } });
    const parsed = await readOpenAiSseStream(okRes, undefined, undefined, undefined, 50);
    expect(parsed.message.content).toBe("第一段第二段第三段");

    // Case B: 吐出第 1 个 chunk 后挂死 90ms (> idleTimeoutMs=35ms) -> 触发 SSE 流空闲超时
    const stalledStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"开头"}}]}\n\n'));
        await new Promise((r) => setTimeout(r, 90));
        controller.close();
      },
    });
    const stalledRes = new Response(stalledStream, { headers: { "content-type": "text/event-stream" } });
    await expect(readOpenAiSseStream(stalledRes, undefined, undefined, undefined, 35)).rejects.toThrow("SSE 流空闲超时");
  });

  it("10. @文件 句中实时补全、行区间内联注入、历史摘要剥离与 !命令 直跑测试", async () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "duo-at-mention-"));
    fs.mkdirSync(path.join(tmpWs, "src", "adapters"), { recursive: true });
    fs.mkdirSync(path.join(tmpWs, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(tmpWs, "src", "adapters", "cli.ts"), "line1\nline2\nline3\nline4\nline5\n", "utf-8");
    fs.writeFileSync(path.join(tmpWs, "node_modules", "pkg", "cli.ts"), "ignored\n", "utf-8");

    // 1) 句中光标位置 (cursor=8) 触发 @cli 补全，自动忽略 node_modules，补尾随空格并返回精准 cursorAfter 防回车死锁
    const midLine = "请对比 @cli 的实现";
    const items = buildDropdownItems(midLine, tmpWs, undefined, null, 8);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]?.label).toBe("@src/adapters/cli.ts");
    expect(items[0]?.fillText).toBe("请对比 @src/adapters/cli.ts 的实现");
    expect(items[0]?.cursorAfter).toBe("请对比 @src/adapters/cli.ts ".length);
    expect(items[0]?.expandOnly).toBe(true);
    // 补全后光标位于尾随空格之后，再次渲染菜单不会重复匹配导致回车死锁
    expect(buildAtMentionDropdown(items[0]!.fillText, items[0]!.cursorAfter!, tmpWs)).toHaveLength(0);

    // 2) expandAtMentions 支持 @path:2-4 行区间切片且忽略邮箱 dev@example.com
    const { expandedPrompt, attachedPaths } = expandAtMentions("发邮件给 dev@example.com 并检查 @src/adapters/cli.ts:2-4", tmpWs);
    expect(attachedPaths).toEqual(["src/adapters/cli.ts"]);
    expect(expandedPrompt).toContain('<attached_file path="src/adapters/cli.ts" lines="2-4">');
    expect(expandedPrompt).toContain("2: line2\n3: line3\n4: line4");
    expect(expandedPrompt).not.toContain("1: line1");

    // 3) stripAttachedFiles 与 extractConversationTurns 剥除 <attached_file> 防历史摘要污染，且纯 @引用 有非空兜底
    expect(stripAttachedFiles(expandedPrompt)).toBe("发邮件给 dev@example.com 并检查 @src/adapters/cli.ts:2-4");
    expect(stripAttachedFiles('<attached_file path="src/adapters/cli.ts" lines="1-2">\n1: a\n</attached_file>')).toBe("[引用文件: @src/adapters/cli.ts]");
    const turns = extractConversationTurns([
      { id: "u1", parentId: null, timestamp: 1, message: { role: "user", content: expandedPrompt } },
      { id: "a1", parentId: "u1", timestamp: 2, message: { role: "assistant", content: "已检查完毕" } },
    ]);
    expect(turns[0]?.userText).toBe("发邮件给 dev@example.com 并检查 @src/adapters/cli.ts:2-4");

    // 4) !命令 空输入守卫与正常命令直跑
    await runLocalBangCommand("!", tmpWs);
    await runLocalBangCommand("!node -v", tmpWs);

    fs.rmSync(tmpWs, { recursive: true, force: true });
  });

  it("11. Aider 式写后 0ms 语法自检 (checkFileSyntax) 与 Claude Code 式审批框按 d 展开测试", async () => {
    // 1) HTML 内联 <script> 精准抓出第 5 行多余 ); 语法错误，且行号完全对齐
    const brokenHtml = ["<!doctype html>", "<html>", "<body>", "<script>", "  halo.addColorStop(1, 'rgba(255,170,90,0)'););", "</script>", "</body></html>"].join("\n");
    const htmlErr = checkFileSyntax("van-gogh-pelican.html", brokenHtml);
    expect(htmlErr).toContain("van-gogh-pelican.html:5");
    expect(htmlErr).toContain("Unexpected token ')'");

    // 2) 合法 ES Module (<script type="module">)、WebGL Shader 与带注释 tsconfig.json 零假阳性误报
    const validEsmAndShader = [
      '<script type="x-shader/x-vertex">attribute vec3 aPos; void main() { gl_Position = vec4(aPos, 1.0); }</script>',
      '<script type="module">',
      'import * as THREE from "three";',
      "export const scene = new THREE.Scene();",
      "</script>",
    ].join("\n");
    expect(checkFileSyntax("index.html", validEsmAndShader)).toBeNull();
    expect(checkFileSyntax("tsconfig.json", '{\n  // 允许 JSONC 注释\n  "compilerOptions": {}\n}')).toBeNull();
    expect(checkFileSyntax("dyn.mjs", 'import os from "node:os";\nexport function run() {\n  import("./heavy.js").then((m) => m.go());\n}')).toBeNull();
    expect(checkFileSyntax("App.js", 'import React from "react";\nexport default function App() { return <h1>Hi</h1>; }')).toBeNull();

    // 3) ES Module 内部若存在真实语法错误，掩码二次校验依然能精准捕获行号
    const brokenEsm = ['import fs from "node:fs";', "export function test() {", "  const a = (1 + 2));", "}"].join("\n");
    const esmErr = checkFileSyntax("app.mjs", brokenEsm);
    expect(esmErr).toContain("app.mjs:3");

    // 4) formatApprovalBox 汇总文件数/修改处数，且 expandAll=true 解开 4 处与 66 列折叠限制
    const edits = Array.from({ length: 6 }, (_, i) => ({
      oldText: `const line${i + 1} = "old_value_${i + 1}";`,
      newText: `const line${i + 1} = "new_value_${i + 1}_with_a_very_long_tail_exceeding_66_columns_for_sure_1234567890";`,
    }));
    const calls = [{ id: "c1", name: "edit_file", arguments: { path: "demo.js", edits } }];
    const foldedBox = formatApprovalBox(calls, process.cwd(), false);
    expect(foldedBox).toContain("[待确认：本次申请修改文件 1 个 (共 6 处)]");
    expect(foldedBox).toContain("其余 2 处修改已折叠，输入 d 展开全部 6 处详情");
    expect(foldedBox).not.toContain("@@ 修改点 #6");

    const expandedBox = formatApprovalBox(calls, process.cwd(), true);
    expect(expandedBox).toContain("已展开全部明细");
    expect(expandedBox).toContain("@@ 修改点 #6");
    expect(expandedBox).toContain("exceeding_66_columns_for_sure_1234567890");

    // 5) compactWireLogEntry 严格幂等且只保留含 prompt_tokens 的 usage 行，大幅压缩超长消息与 tool_calls 参数
    const hugeCode = "x".repeat(5000);
    const rawWire = {
      roundTimestamp: "2026-10-25T02:00:00.000Z",
      apiUrl: "https://api.deepseek.com/chat/completions",
      requestBody: {
        model: "deepseek-reasoner",
        tools: [{ type: "function", function: { name: "edit_file" } }],
        messages: [
          { role: "user", content: hugeCode },
          { role: "assistant", content: "ok", tool_calls: [{ id: "tc1", function: { name: "edit_file", arguments: hugeCode } }] },
        ],
      },
      rawSseLines: [
        'data: {"choices":[{"delta":{"content":"this line mentions usage word"}}]}',
        'data: {"model":"deepseek-reasoner","usage":{"prompt_tokens":1200,"prompt_cache_hit_tokens":1000,"completion_tokens":80}}',
        "data: [DONE]",
      ],
      assembledMessage: {
        role: "assistant" as const,
        content: hugeCode,
        reasoningContent: hugeCode,
        toolCalls: [{ id: "tc1", name: "edit_file", arguments: { path: "index.html", edits: hugeCode } }],
      },
    };
    const once = compactWireLogEntry(rawWire);
    const twice = compactWireLogEntry(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    expect(once.rawSseLines).toHaveLength(1);
    expect(once.requestBody.tools).toBeUndefined();
    expect(JSON.stringify(once).length).toBeLessThan(1200);
    expect(summarizeWireCost([once]).totalPromptTokens).toBe(1200);

    // 验证 zodObjectToJsonSchema 保留外层 .optional().describe() 与 z.enum
    const testSchema = z.object({
      mode: z.enum(["read", "write"]).default("read").describe("读写模式"),
      startLine: z.number().int().optional().describe("起始行"),
    });
    const jsonSchema = zodObjectToJsonSchema(testSchema) as any;
    expect(jsonSchema.properties.mode).toEqual({ type: "string", enum: ["read", "write"], description: "读写模式" });
    expect(jsonSchema.properties.startLine).toEqual({ type: "number", description: "起始行" });

    // 验证单宽制表符/箭头/圆点宽度为 1 列、CJK 为 2 列，且多行粘贴编解码无损
    expect(getVisualCols("❯ ─│•→")).toBe(6);
    expect(getVisualCols("中文")).toBe(4);
    const multi = "line1\r\nline2\nline3";
    const encoded = encodePastedNewlines(multi);
    expect(encoded.includes("\n")).toBe(false);
    expect(restorePastedNewlines(encoded)).toBe("line1\nline2\nline3");

    // 验证 inputHistory 逆序持久化、/commit 展开及 runOneShotCli 管道输入 + -y 写操作落盘
    const tmpOneShot = fs.mkdtempSync(path.join(os.tmpdir(), "duo-oneshot-"));
    try {
      const paths = resolveProjectSessionPaths(tmpOneShot, tmpOneShot);
      saveProjectMeta(paths.metaFile, { inputHistory: ["最新命令", "上一条命令"] });
      expect(loadProjectMeta(paths.metaFile).inputHistory).toEqual(["最新命令", "上一条命令"]);

      const ctrl = createSessionController({ workspaceRoot: tmpOneShot, homeBaseDir: tmpOneShot });
      const commitExpanded = await handleSlashCommand("/commit 修复管道输入", ctrl);
      expect(typeof commitExpanded).toBe("string");
      expect(String(commitExpanded)).toContain("git commit");

      let step = 0;
      const seenOneShotMsgs: any[][] = [];
      const mockReplies: any[] = [
        { role: "assistant", content: "", toolCalls: [{ id: "e1", name: "edit_file", arguments: { path: "note.txt", oldText: "", newText: "fixed" } }] },
        { role: "assistant", content: "已根据管道报错修好 note.txt" },
      ];
      await runOneShotCli(["-y", "修一下"], "Error: missing note.txt", {
        workspaceRoot: tmpOneShot,
        homeBaseDir: tmpOneShot,
        provider: { async chat(msgs) { seenOneShotMsgs.push(msgs); return mockReplies[step++]!; } },
      });
      expect(seenOneShotMsgs[0]?.some((m) => m.role === "user" && m.content.includes("<piped_stdin>"))).toBe(true);
      expect(fs.readFileSync(path.join(tmpOneShot, "note.txt"), "utf-8")).toBe("fixed");
    } finally {
      fs.rmSync(tmpOneShot, { recursive: true, force: true });
    }
  });
});
