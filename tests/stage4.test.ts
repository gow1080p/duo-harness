import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentSession } from "../src/adapters/cli.js";
import { stripAttachedFiles } from "../src/adapters/context-mention.js";
import { createStdioMcpClient } from "../src/adapters/mcp-client.js";
import { createSessionController } from "../src/adapters/session-controller.js";
import { recordHttpWireLog } from "../src/adapters/sse-stream.js";
import { analyzeSessionXray, formatXrayReport } from "../src/adapters/xray.js";
import { compactMessages, estimateMessagesChars, foldSingleMessage } from "../src/core/compactor.js";
import type { AssistantMessage, LlmProvider, Message } from "../src/core/contracts.js";
import { assertSessionInvariant, buildSessionEntries } from "../src/core/session-tree.js";

describe("Stage 4: KV 前缀缓存保护压缩器 (compactor.ts) 与标准 MCP 客户端 (mcp-client.ts)", () => {
  it("1. 未超阈值时 100% 保持原样（零字节变动）；超阈值时折叠旧工具输出且不破坏 toolCallId 1:1 配对", () => {
    const longOutput = "A".repeat(2_000);
    const history: Message[] = [
      { role: "system", content: "系统指令固定头部" },
      { role: "user", content: "帮我查两个文件" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_old_1", name: "read_file", arguments: { path: "a.ts" } },
          { id: "call_old_2", name: "read_file", arguments: { path: "b.ts" } },
        ],
      },
      { role: "tool", toolCallId: "call_old_1", name: "read_file", content: longOutput, isError: false },
      { role: "tool", toolCallId: "call_old_2", name: "read_file", content: longOutput, isError: false },
      { role: "assistant", content: "我看完了 a 和 b，现在查 c", toolCalls: [{ id: "call_new_3", name: "read_file", arguments: { path: "c.ts" } }] },
      { role: "tool", toolCallId: "call_new_3", name: "read_file", content: "近期工具输出保持完整", isError: false },
    ];

    // 1) 阈值充裕时原样返回
    const untouched = compactMessages(history, { maxTotalChars: 10_000 });
    expect(untouched).toEqual(history);

    // 2) 触发第一层折叠：旧轮次 (call_old_1 / call_old_2) 输出被折叠，近期轮次 (call_new_3) 原封不动
    const folded = compactMessages(history, {
      maxTotalChars: 1_500,
      keepRecentMessages: 2,
      maxToolOutputChars: 100,
    });
    expect(estimateMessagesChars(folded)).toBeLessThan(1_500);
    expect(folded[3]?.content).toContain("[已折叠历史工具输出");
    expect(folded[4]?.content).toContain("[已折叠历史工具输出");
    expect(folded[6]?.content).toBe("近期工具输出保持完整");
    // 核心断言：折叠后依然 100% 通过发请求前的 1:1 配对检查
    expect(() => assertSessionInvariant(folded)).not.toThrow();

    // 3) 触发第二层原子块淘汰：即使极端缩减预算，也不会把 assistant(toolCalls) 与紧邻的 tool 拆出孤儿
    const heavilyCompacted = compactMessages(history, {
      maxTotalChars: 200,
      keepRecentMessages: 2,
      maxToolOutputChars: 50,
    });
    expect(heavilyCompacted[0]?.role).toBe("system");
    expect(heavilyCompacted[1]?.role).toBe("user");
    expect(() => assertSessionInvariant(heavilyCompacted)).not.toThrow();

    // 4) 无 system 消息时（首条即 user，第 2 条为带 toolCalls 的 assistant），淘汰也不会拆散配对
    const noSystemHistory = history.slice(1);
    const noSystemCompacted = compactMessages(noSystemHistory, {
      maxTotalChars: 150,
      keepRecentMessages: 2,
      maxToolOutputChars: 50,
    });
    expect(noSystemCompacted[0]?.role).toBe("user");
    expect(() => assertSessionInvariant(noSystemCompacted)).not.toThrow();

    // 5) 默认高水位阈值下：16_000 ~ 100_000 字符的中大型多文件上下文 100% 不折叠（防同轮失忆重读）
    const mediumHistory: Message[] = [
      ...history,
      { role: "user", content: "继续细读整个项目" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_cur_1", name: "read_file", arguments: { path: "d.ts" } }] },
      { role: "tool", toolCallId: "call_cur_1", name: "read_file", content: "B".repeat(20_000), isError: false },
    ];
    expect(compactMessages(mediumHistory)).toEqual(mediumHistory);

    // 6) 验证 <attached_file> 历史引用块折叠（含首轮 messages[1]）与 /compact 手动压缩 + /xray 跨轮思考链剥离免误报
    const attachedPrompt = `请参考 @a.html 修改\n\n<attached_file path="a.html" lines="1-100">\n${"X".repeat(3_000)}\n</attached_file>`;
    const foldedUser = foldSingleMessage({ role: "user", content: attachedPrompt });
    expect(foldedUser.content).toContain("[已折叠历史引用文件 @a.html");
    expect(stripAttachedFiles(foldedUser.content)).toBe("请参考 @a.html 修改");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "duo-compact-"));
    const ctrl = createSessionController({ workspaceRoot: tmpDir, homeBaseDir: tmpDir });
    const entries = buildSessionEntries([], [
      { role: "system", content: "sys" },
      { role: "user", content: attachedPrompt },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.html" } }] },
      { role: "tool", toolCallId: "c1", name: "read_file", content: "Y".repeat(2_000), isError: false },
      { role: "assistant", content: "修改完成" },
    ], 1000);
    const sideBranch = buildSessionEntries(entries, [{ role: "user", content: `<attached_file path="b.html">\n${"Z".repeat(2_000)}\n</attached_file>` }], 2000, "msg_1");
    fs.writeFileSync(ctrl.getPaths().sessionFile, `${[...entries, ...sideBranch].map((e) => JSON.stringify(e)).join("\n")}\n`, "utf-8");
    ctrl.resumeTurn("msg_5");
    const cRes = ctrl.compact();
    expect(cRes.compactedCount).toBe(2);
    expect(cRes.afterChars).toBeLessThan(cRes.beforeChars / 5);
    expect(ctrl.loadEntries().find((e) => e.id === "msg_6")?.message.content).toContain("<attached_file path=\"b.html\">");
    expect(ctrl.listTurns()).toHaveLength(2);
    expect(ctrl.listTurns()[0]?.userText).toBe("请参考 @a.html 修改");

    fs.writeFileSync(ctrl.getPaths().wireLogFile, JSON.stringify([
      { round: 1, requestBody: { model: "deepseek-reasoner", messages: [{ role: "system", content: "sys" }, { role: "user", content: "q1" }, { role: "assistant", content: null, reasoning_content: "think1" }] }, rawSseLines: [] },
      { round: 2, requestBody: { model: "deepseek-reasoner", messages: [{ role: "system", content: "sys" }, { role: "user", content: "q1" }, { role: "assistant", content: null }, { role: "user", content: "q2" }] }, rawSseLines: [] },
    ]), "utf-8");
    const xray = analyzeSessionXray(ctrl.getPaths().sessionFile, ctrl.getPaths().wireLogFile);
    expect(xray.wireRounds[1]?.statusLabel).toBe("旧消息未改动(正常)");

    // 7) 跨步前缀因果不变量断言：模拟多轮长对话与新一轮提问，水位线折叠后连续追加与跨轮追问 0 前缀突变，且自动生成 xray-cache.md
    const streamHistory: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: attachedPrompt },
    ];
    for (let step = 1; step <= 8; step++) {
      streamHistory.push({
        role: "assistant",
        content: "",
        toolCalls: [{ id: `tc_${step}`, name: "edit_file", arguments: { path: "index.html", oldText: "", newText: "H".repeat(22_000) } }],
      });
      streamHistory.push({ role: "tool", toolCallId: `tc_${step}`, name: "edit_file", content: "已写入文件: index.html", isError: false });
    }
    const atStep6 = compactMessages(streamHistory.slice(0, 14));
    expect(estimateMessagesChars(atStep6)).toBeLessThan(83_200);
    // 紧接着追加新步骤与新一轮 user 追问，已发出的前序前缀必须 100% 零字节改动（修复 #34 跌至 2% 的根因）
    const atStep7 = compactMessages(streamHistory.slice(0, 16));
    expect(atStep7.slice(0, atStep6.length)).toEqual(atStep6);
    const withFollowupUser = compactMessages([...streamHistory.slice(0, 16), { role: "user", content: "现在页面数据是 mock 的吗？" }]);
    expect(withFollowupUser.slice(0, atStep7.length)).toEqual(atStep7);

    // 验证 recordHttpWireLog 自动生成 xray-cache.md 并准确还原被截断消息的真实体积与突变取证
    recordHttpWireLog({
      roundTimestamp: "2026-10-25T12:00:00Z",
      apiUrl: "https://api.deepseek.com/chat/completions",
      requestBody: { model: "deepseek-reasoner", messages: [{ role: "system", content: "sys" }, { role: "tool", content: "T".repeat(5_000) }] },
      rawSseLines: ['data: {"usage":{"prompt_tokens":2000,"prompt_cache_hit_tokens":1900,"completion_tokens":50}}'],
      assembledMessage: { role: "assistant", content: "ok" },
    }, ctrl.getPaths().wireLogFile, true);
    recordHttpWireLog({
      roundTimestamp: "2026-10-25T12:01:00Z",
      apiUrl: "https://api.deepseek.com/chat/completions",
      requestBody: { model: "deepseek-reasoner", messages: [{ role: "system", content: "sys" }, { role: "tool", content: "[已折叠历史工具输出 (read_file，原长 5000 字符): TTTT...]" }, { role: "user", content: "q2" }] },
      rawSseLines: ['data: {"usage":{"prompt_tokens":500,"prompt_cache_hit_tokens":100,"completion_tokens":30}}'],
      assembledMessage: { role: "assistant", content: "ok2" },
    }, ctrl.getPaths().wireLogFile, false);
    const cacheMdPath = path.join(path.dirname(ctrl.getPaths().wireLogFile), "xray-cache.md");
    expect(fs.existsSync(cacheMdPath)).toBe(true);
    const cacheMd = fs.readFileSync(cacheMdPath, "utf-8");
    expect(cacheMd).toContain("4.9K(折0)");
    expect(cacheMd).toContain("[缓存前缀改写自动取证]");
    expect(formatXrayReport(analyzeSessionXray(ctrl.getPaths().sessionFile, ctrl.getPaths().wireLogFile))).toContain("msg[1]");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("2. 标准 stdio MCP 客户端支持握手、列出外部工具、处理分片 JSON-RPC 并接入 Agent Loop 执行", async () => {
    // 用内联 node 脚本模拟一个真实的外部 stdio MCP Server（故意分两次 write 模拟粘包/半包 + 杂音日志）
    const inlineMcpServerScript = `
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      console.log("[mcp-server-noise] booting up...");
      rl.on("line", (line) => {
        if (!line.trim()) return;
        const req = JSON.parse(line);
        if (req.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2024-11-05" } }) + "\\n");
        } else if (req.method === "tools/list") {
          const resp = JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: { tools: [{ name: "mcp_calc_sum", description: "计算两个数的和" }] }
          });
          process.stdout.write(resp.slice(0, 20));
          setTimeout(() => process.stdout.write(resp.slice(20) + "\\n"), 5);
        } else if (req.method === "tools/call") {
          const { a, b } = req.params.arguments || {};
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: { content: [{ type: "text", text: "MCP计算结果:" + (Number(a) + Number(b)) }] }
          }) + "\\n");
        }
      });
    `;

    const mcpClient = createStdioMcpClient(process.execPath, ["-e", inlineMcpServerScript]);
    try {
      await mcpClient.initialize();
      const mcpTools = await mcpClient.toToolContracts();
      expect(mcpTools).toHaveLength(1);
      expect(mcpTools[0]!.name).toBe("mcp_calc_sum");

      const scriptReplies: AssistantMessage[] = [
        {
          role: "assistant",
          content: "我来调用外部 MCP 工具计算",
          toolCalls: [{ id: "call_mcp_1", name: "mcp_calc_sum", arguments: { a: 19, b: 23 } }],
        },
        { role: "assistant", content: "外部 MCP 工具算出结果是 42" },
      ];
      let idx = 0;
      const mockProvider: LlmProvider = {
        async chat(): Promise<AssistantMessage> {
          return scriptReplies[idx++]!;
        },
      };

      const res = await runAgentSession("用 MCP 工具算 19+23", {
        provider: mockProvider,
        tools: mcpTools,
      });
      expect(res.finalAnswer).toBe("外部 MCP 工具算出结果是 42");
    } finally {
      await mcpClient.close();
    }

    // 验证不存在的 MCP 命令不会崩进程，而是干净地 reject
    const badClient = createStdioMcpClient("__non_existent_mcp_binary_xyz__");
    await expect(badClient.initialize()).rejects.toThrow();
    await badClient.close();
  });
});
