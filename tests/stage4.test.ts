import { describe, expect, it } from "vitest";
import { runAgentSession } from "../src/adapters/cli.js";
import { createStdioMcpClient } from "../src/adapters/mcp-client.js";
import { compactMessages, estimateMessagesChars } from "../src/core/compactor.js";
import type { AssistantMessage, LlmProvider, Message } from "../src/core/contracts.js";
import { assertSessionInvariant } from "../src/core/session-tree.js";

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
