import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentStateSchema,
  MessageSchema,
  ToolCallSchema,
} from "../src/core/contracts.js";

describe("Step 1.1: src/core/contracts.ts 核心通用契约把玩测试", () => {
  it("1. [Zod 消息判别联合] 能自动识别并校验 system / user / assistant / tool 四种角色", () => {
    const validAssistant = MessageSchema.safeParse({
      role: "assistant",
      content: null, // 真实大模型调工具时经常返回 null，测试自动归一化为 ""
      toolCalls: [
        { id: "call_001", name: "list_dir", arguments: { path: "." } },
      ],
    });
    expect(validAssistant.success).toBe(true);
    if (validAssistant.success && validAssistant.data.role === "assistant") {
      expect(validAssistant.data.content).toBe("");
    }

    const validToolResult = MessageSchema.safeParse({
      role: "tool",
      toolCallId: "call_001",
      name: "list_dir",
      content: "AGENTS.md\nARCH.md",
    });
    expect(validToolResult.success).toBe(true);
    if (validToolResult.success && validToolResult.data.role === "tool") {
      // 验证 default(false) 自动补全
      expect(validToolResult.data.isError).toBe(false);
    }
  });

  it("2. [点菜小票防呆拦截] 当 tool 消息漏传 toolCallId 或 id 为空字符串时，Zod 精准拦截且不崩进程", () => {
    const missingTicket = MessageSchema.safeParse({
      role: "tool",
      toolCallId: "", // ❌ 故意传空小票号
      name: "read_file",
      content: "file content",
    });
    expect(missingTicket.success).toBe(false);

    const invalidToolCall = ToolCallSchema.safeParse({
      id: "call_002",
      name: "", // ❌ 故意传空工具名
      arguments: {},
    });
    expect(invalidToolCall.success).toBe(false);
  });

  it("3. [AgentState 状态快照校验] 保证整个状态树可随时 JSON 序列化与校验", () => {
    const snapshot = {
      phase: "thinking",
      step: 1,
      maxSteps: 10,
      messages: [
        { role: "system", content: "You are a helpful coding agent." },
        { role: "user", content: "读取 ARCH.md" },
      ],
    };
    const parsed = AgentStateSchema.safeParse(snapshot);
    expect(parsed.success).toBe(true);
  });

  it("4. [防屎山物理守门员] 自动扫描 src/ 全量代码：单文件 <= 250 行、core 总计 <= 500 行且 0 I/O", () => {
    const coreDir = path.resolve("src/core");
    const adaptersDir = path.resolve("src/adapters");
    let coreTotalLines = 0;

    for (const file of fs.readdirSync(coreDir).filter((f) => f.endsWith(".ts"))) {
      const content = fs.readFileSync(path.join(coreDir, file), "utf-8");
      const lines = content.split("\n").length;
      coreTotalLines += lines;
      expect(lines, `src/core/${file} 超出 250 行上限`).toBeLessThanOrEqual(250);
      expect(content, `src/core/${file} 严禁引入 I/O 模块`).not.toMatch(
        /node:fs|node:child_process|node:sqlite|\bfetch\s*\(/,
      );
    }
    expect(coreTotalLines, "src/core/ 总行数超出 500 行上限").toBeLessThanOrEqual(500);

    for (const file of fs.readdirSync(adaptersDir).filter((f) => f.endsWith(".ts"))) {
      const content = fs.readFileSync(path.join(adaptersDir, file), "utf-8");
      const lines = content.split("\n").length;
      expect(lines, `src/adapters/${file} 超出 250 行上限`).toBeLessThanOrEqual(250);
    }
  });
});
