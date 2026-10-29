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

  it("3. 通用 Runtime 底座能力：子路径导出、无 Zod 工具与 _invalidJson 拦截、maxSeq 防撞号、外部工具大参数与 <context_state> 折叠、leafId='latest' 续接与跨界默认拦截", async () => {
    // 1) 子路径导出完整性检查
    const coreMod = await import("../src/core/index.js");
    const runtimeMod = await import("../src/runtime.js");
    const codingMod = await import("../src/coding.js");
    expect(typeof coreMod.stepAgentLoop).toBe("function");
    expect(typeof runtimeMod.runAgentSession).toBe("function");
    expect("createWriteTools" in runtimeMod).toBe(false);
    expect(typeof codingMod.createWriteTools).toBe("function");

    // 2) maxSeq 跳号节点防冲突
    const jumpedEntries = [
      { id: "msg_1", parentId: null, timestamp: 1, message: { role: "system" as const, content: "sys" } },
      { id: "msg_8", parentId: "msg_1", timestamp: 2, message: { role: "user" as const, content: "hi" } },
    ];
    const nextAdded = buildSessionEntries(jumpedEntries, [{ role: "assistant", content: "ok" }], 3);
    expect(nextAdded[0]?.id).toBe("msg_9");

    // 3) 无 parameters 外部工具执行与 _invalidJson 截断拦截
    const { executeToolCalls } = await import("../src/adapters/tools.js");
    const customTool = {
      name: "ext_Action",
      description: "无 Zod 外部工具",
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      readonly: true,
      execute: (args: { q: string }) => `结果:${args.q}`,
    };
    const okRes = await executeToolCalls([{ id: "t1", name: "ext_Action", arguments: { q: "pass" } }], [customTool]);
    expect(okRes[0]?.isError).toBe(false);
    expect(okRes[0]?.content).toBe("结果:pass");
    const truncRes = await executeToolCalls([{ id: "t2", name: "ext_Action", arguments: { _invalidJson: '{"q":"half' } }], [customTool]);
    expect(truncRes[0]?.isError).toBe(true);
    expect(truncRes[0]?.content).toContain("流式输出被截断");

    // 4) 外部工具大数组/大对象/长文本折叠 + 当轮 <context_state> 保护与次轮折叠
    const u1 = `创建看板\n<context_state>\n${"S".repeat(1_200)}\n</context_state>`;
    const u2 = `改标题\n<context_state>\n${"N".repeat(1_200)}\n</context_state>`;
    const extHist: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: u1 },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "g1", name: "genui_surface", arguments: { arr: ["A".repeat(1_000)], obj: { k: "B".repeat(1_000) }, txt: "C".repeat(1_000), small: 1 } }],
      },
      { role: "tool", toolCallId: "g1", name: "genui_surface", content: "done", isError: false },
      { role: "assistant", content: "完成" },
      { role: "user", content: u2 },
    ];
    const comp = compactMessages(extHist, { maxTotalChars: 2_200, keepRecentMessages: 2, maxToolOutputChars: 100 });
    expect(comp[1]?.content).toContain("[已折叠历史上下文状态");
    expect(stripAttachedFiles(comp[1]!.content)).toBe("创建看板");
    const foldedArgs = (comp[2] as Extract<Message, { role: "assistant" }>).toolCalls?.[0]?.arguments as Record<string, any>;
    expect(foldedArgs.arr[0]).toContain("[已折叠历史数组参数");
    expect(foldedArgs.obj._folded).toContain("[已折叠历史对象参数");
    expect(foldedArgs.txt).toContain("[已折叠历史文本参数");
    expect(foldedArgs.small).toBe(1);
    expect(comp[5]?.content).toContain("N".repeat(1_200));

    // 5) leafId: "latest" 空文件首轮 + 次轮续接 + contextPrompt 注入 + 无审批回调时跨界读取默认拒绝
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "duo-latest-"));
    try {
      const sFile = path.join(tmpDir, "chat.jsonl");
      let round = 0;
      const seenMessages: Message[][] = [];
      const mockProvider: LlmProvider = {
        async chat(msgs) {
          seenMessages.push(msgs);
          round += 1;
          if (round === 1) return { role: "assistant", content: "首轮完成" };
          if (round === 2) return { role: "assistant", content: "", toolCalls: [{ id: "esc_1", name: "read_file", arguments: { path: "/etc/hosts" } }] };
          return { role: "assistant", content: "次轮完成（跨界读取已被默认拦截）" };
        },
      };
      const r1 = await runAgentSession("第一问", { workspaceRoot: tmpDir, sessionFile: sFile, leafId: "latest", systemPrompt: "固定System", contextPrompt: '{"rev":1}', provider: mockProvider, quiet: true });
      expect(r1.finalAnswer).toBe("首轮完成");
      const r2 = await runAgentSession("第二问", { workspaceRoot: tmpDir, sessionFile: sFile, leafId: "latest", systemPrompt: "固定System", contextPrompt: '{"rev":2}', provider: mockProvider, quiet: true });
      expect(r2.finalAnswer).toContain("跨界读取已被默认拦截");
      // 验证跨轮前序消息零突变且跨界读取被默认拦截
      expect(seenMessages[1]?.[0]).toEqual(seenMessages[0]?.[0]);
      expect(seenMessages[1]?.[1]).toEqual(seenMessages[0]?.[1]);
      const denyToolMsg = seenMessages[2]?.find((m) => m.role === "tool");
      expect(denyToolMsg?.content).toContain("未配置审批回调，默认拒绝");

      // 6) withSessionLock 并发排队 + 死进程陈旧 .lock 自动清理 + 父目录未创建保护
      const concFile = path.join(tmpDir, "sub-uncreated", "conc.jsonl");
      fs.mkdirSync(path.dirname(concFile), { recursive: true });
      fs.writeFileSync(`${concFile}.lock`, JSON.stringify({ pid: 99999999, ts: Date.now() - 5000, token: "dead" }), "utf-8");
      fs.rmSync(path.dirname(concFile), { recursive: true, force: true }); // 验证父目录不存在时首次自动创建
      let concStep = 0;
      const slowProvider: LlmProvider = {
        async chat() {
          concStep += 1;
          await new Promise((r) => setTimeout(r, 25));
          return { role: "assistant", content: `并发回复_${concStep}` };
        },
      };
      const [c1, c2] = await Promise.all([
        runAgentSession("并发提问A", { workspaceRoot: tmpDir, sessionFile: concFile, leafId: "latest", systemPrompt: "S", provider: slowProvider, quiet: true }),
        runAgentSession("并发提问B", { workspaceRoot: tmpDir, sessionFile: concFile, leafId: "latest", systemPrompt: "S", provider: slowProvider, quiet: true }),
      ]);
      expect(c1.finalAnswer).toBe("并发回复_1");
      expect(c2.finalAnswer).toBe("并发回复_2");
      expect(fs.existsSync(`${concFile}.lock`)).toBe(false);
      const concLines = fs.readFileSync(concFile, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const concIds = concLines.map((e) => e.id);
      expect(new Set(concIds).size).toBe(concIds.length);
      expect(concIds).toEqual(["msg_1", "msg_2", "msg_3", "msg_4", "msg_5"]);

      // 7) wire.json 超过 60 步自动归档瘦身 + 总账/当前会话账单零失真 + Xray 仅扫最近 60 步
      const { recordHttpWireLog, computeTurnMetrics, analyzeSessionXray } = runtimeMod;
      const wFile = path.join(tmpDir, "archive.wire.json");
      for (let i = 0; i < 65; i++) {
        recordHttpWireLog({
          roundTimestamp: "2026-10-28T06:00:00.000Z",
          apiUrl: "https://api.example.com",
          requestBody: {
            model: "mimo-v2.6-pro",
            messages: i === 0 || i === 10
              ? [{ role: "system", content: "sys" }, { role: "user", content: `u_${i}` }]
              : [{ role: "system", content: "sys" }, { role: "user", content: "u" }, { role: "assistant", content: "a" }],
          },
          rawSseLines: ['data: {"model":"mimo-v2.6-pro","usage":{"prompt_tokens":1000,"completion_tokens":100}}'],
          assembledMessage: { role: "assistant", content: `ans_${i}` },
        }, wFile);
      }
      const savedWire = JSON.parse(fs.readFileSync(wFile, "utf-8")) as any[];
      expect(savedWire).toHaveLength(65);
      expect(savedWire[0].requestBody.messages).toBeUndefined();
      expect(savedWire[0].requestBody.messageCount).toBe(2);
      expect(savedWire[0].requestBody.isSessionStart).toBe(true);
      expect(savedWire[4].requestBody.messages).toBeUndefined();
      expect(Array.isArray(savedWire[5].requestBody.messages)).toBe(true);
      const metrics = computeTurnMetrics(wFile, 0, false);
      expect(metrics).not.toBeNull();
      // 65 步总费用 vs 第 10 步重开后的 55 步当前会话费用精确度校验
      expect(metrics!.totalCostCny).toBeCloseTo(65 * ((1000 * 2.0 + 100 * 6.0) / 1_000_000), 6);
      expect(metrics!.sessionCostCny).toBeCloseTo(55 * ((1000 * 2.0 + 100 * 6.0) / 1_000_000), 6);
      const xray = analyzeSessionXray(sFile, wFile);
      expect(xray.wireRounds).toHaveLength(60);
      expect(xray.wireRounds[0]?.round).toBe(6);

      // 8) /plan 只读规划模式物理拦截写操作 + 落盘 .debug/plan.md + 无参 /goal 保缓存衔接与手改感知 + 分支隔离
      const { runOneShotCli, resolveGoalTaskAndContext, savePlanArtifact, handleSlashCommand, buildPlanContextPrompt } = await import("../src/adapters/repl.js");
      const { createSessionController } = await import("../src/adapters/session-controller.js");
      const planWs = path.join(tmpDir, "plan-ws");
      fs.mkdirSync(planWs, { recursive: true });
      fs.writeFileSync(path.join(planWs, "index.ts"), "export const v = 1;\n", "utf-8");
      const planSeenMsgs: Message[][] = [];
      let planStep = 0;
      const planProvider: LlmProvider = {
        async chat(msgs) {
          planSeenMsgs.push(msgs.map((m) => ({ ...m })));
          planStep++;
          if (planStep === 1) return { role: "assistant", content: "", toolCalls: [{ id: "pr_1", name: "read_file", arguments: { path: "index.ts" } }] };
          if (planStep === 2) return { role: "assistant", content: "", toolCalls: [{ id: "pw_1", name: "edit_file", arguments: { path: "index.ts", oldText: "v = 1", newText: "v = 2" } }] };
          if (planStep === 3) return { role: "assistant", content: "", toolCalls: [{ id: "pe_1", name: "grep", arguments: { pattern: "v", path: "/etc/hosts" } }] };
          if (planStep === 4) return { role: "assistant", content: "## Plan:\n1. 修改 index.ts 将 v 改为 2\n2. 运行验证" };
          return { role: "assistant", content: "已按计划完成修改。" };
        },
      };
      await runOneShotCli(["/plan", "升级版本号"], "", { workspaceRoot: planWs, homeBaseDir: tmpDir, provider: planProvider });
      const planFile = path.join(planWs, ".debug", "plan.md");
      expect(fs.existsSync(planFile)).toBe(true);
      expect(fs.readFileSync(planFile, "utf-8")).toContain("1. 修改 index.ts 将 v 改为 2");
      expect(fs.readFileSync(path.join(planWs, "index.ts"), "utf-8")).toBe("export const v = 1;\n"); // 写操作被物理拦截
      expect(planSeenMsgs[2]?.some((m) => m.role === "tool" && m.content.includes("/plan 只读规划模式，已物理拦截"))).toBe(true);
      expect(planSeenMsgs[3]?.some((m) => m.role === "tool" && m.content.includes("禁止读取工作区") && m.content.includes("切勿再读取外部目录"))).toBe(true);

      const planCtrl = createSessionController({ workspaceRoot: planWs, homeBaseDir: tmpDir, provider: planProvider });
      // 验证 [ABORT] 文本不会污染覆盖已保存的 .debug/plan.md
      expect(savePlanArtifact(planCtrl, "[ABORT] 用户取消", "msg_99").saved).toBe(false);
      expect(fs.readFileSync(planFile, "utf-8")).toContain("1. 修改 index.ts 将 v 改为 2");

      // 验证未修改 .debug/plan.md 时直接敲无参 /goal：不重复注入 <approved_plan>，100% 保护 KV 前缀缓存
      const uneditedGoal = resolveGoalTaskAndContext("", planCtrl);
      expect(uneditedGoal.task).toContain("上一轮输出的规划方案");
      expect(uneditedGoal.contextPrompt).toBeUndefined();

      // 重新标记最新 leaf 为计划节点并模拟用户手动编辑 .debug/plan.md 后敲无参 /goal：自动切回 msg_1 根节点分叉防旧对话窜味
      const prevLeaf = planCtrl.getLeafId();
      savePlanArtifact(planCtrl, "## Plan:\n1. 修改 index.ts 将 v 改为 2\n2. 运行验证", prevLeaf);
      fs.writeFileSync(planFile, "## Plan:\n1. 修改 index.ts 将 v 改为 99 (用户手改)\n", "utf-8");
      expect(buildPlanContextPrompt(planWs)).toContain("<current_plan>");
      const editedGoal = resolveGoalTaskAndContext("", planCtrl);
      expect(editedGoal.contextPrompt).toContain("修改 index.ts 将 v 改为 99 (用户手改)");
      expect(planCtrl.getLeafId()).toBe("msg_1");

      // 验证确定性计划哈希状态机 (lastExecutedPlanHash)：
      // 1) 新会话或外部写入新计划后，哪怕产生了其他记录导致 timestamp 较新，无参 /goal 仍基于内容哈希精准加载新计划并从根节点派生
      savePlanArtifact(planCtrl, "## Plan:\n1. 分支A计划", prevLeaf);
      planCtrl.newSession();
      expect(await handleSlashCommand("/goal", planCtrl)).toBe(false); // 存在未执行的 .debug/plan.md 时，新会话直接放行进入 /goal
      const newSessionGoal = resolveGoalTaskAndContext("", planCtrl);
      expect(newSessionGoal.contextPrompt).toContain("分支A计划");

      // 2) 当同一份计划已执行过 (lastExecutedPlanHash 已记录)，用户通过 /new 开启无关新课题对话后敲无参 /goal，绝不把旧计划强塞进无关对话
      planCtrl.newSession();
      await planCtrl.ask("帮我写个独立爬虫脚本 crawler.ts");
      const unrelatedGoal = resolveGoalTaskAndContext("", planCtrl);
      expect(unrelatedGoal.contextPrompt).toBeUndefined();
      expect(unrelatedGoal.task).toContain("请继续推进并完成当前目标");

      // 3) 显式输入 /goal plan 始终强制从根节点净室加载当前 .debug/plan.md
      const explicitNewGoal = resolveGoalTaskAndContext("plan", planCtrl);
      expect(explicitNewGoal.contextPrompt).toContain("分支A计划");

      // 4) 无 .debug/plan.md 且处于空会话时，敲无参 /goal 打印用法引导并返回 true
      fs.unlinkSync(planFile);
      planCtrl.newSession();
      expect(await handleSlashCommand("/goal", planCtrl)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
