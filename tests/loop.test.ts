import { describe, expect, it } from "vitest";
import { createInitialState, stepAgentLoop } from "../src/core/loop.js";
import { createBuiltinTools, executeToolCalls } from "../src/adapters/tools.js";

describe("Step 1.2 & 1.3: loop.ts 纯状态机与 tools.ts 工具执行测试", () => {
  it("1. 完整跑通 START -> LLM_REPLIED(调工具) -> TOOLS_FINISHED -> LLM_REPLIED(完成) 闭环", () => {
    const s0 = createInitialState({ maxSteps: 3 });

    const r1 = stepAgentLoop(s0, { type: "START", userPrompt: "看下目录" });
    expect(r1.state.phase).toBe("thinking");
    expect(r1.effect.type).toBe("REQUEST_LLM");

    const r2 = stepAgentLoop(r1.state, {
      type: "LLM_REPLIED",
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "list_dir", arguments: { path: "." } }],
      },
    });
    expect(r2.state.phase).toBe("executing");
    expect(r2.state.step).toBe(1);
    expect(r2.effect.type).toBe("EXECUTE_TOOLS");

    const r3 = stepAgentLoop(r2.state, {
      type: "TOOLS_FINISHED",
      results: [
        {
          role: "tool",
          toolCallId: "call_1",
          name: "list_dir",
          content: "package.json",
          isError: false,
        },
      ],
    });
    expect(r3.state.phase).toBe("thinking");
    expect(r3.effect.type).toBe("REQUEST_LLM");

    const r4 = stepAgentLoop(r3.state, {
      type: "LLM_REPLIED",
      message: { role: "assistant", content: "目录下有 package.json" },
    });
    expect(r4.state.phase).toBe("done");
    expect(r4.effect).toEqual({
      type: "COMPLETE",
      finalAnswer: "目录下有 package.json",
    });
  });

  it("2. 当连续调用工具次数达到 maxSteps 时，触发 ABORT 熔断防死循环", () => {
    const s0 = createInitialState({ maxSteps: 1 });
    const r1 = stepAgentLoop(s0, { type: "START", userPrompt: "测试熔断" });
    const r2 = stepAgentLoop(r1.state, {
      type: "LLM_REPLIED",
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "list_dir", arguments: {} }],
      },
    });
    expect(r2.state.step).toBe(1);

    const r3 = stepAgentLoop(r2.state, {
      type: "TOOLS_FINISHED",
      results: [{ role: "tool", toolCallId: "c1", name: "list_dir", content: "ok", isError: false }],
    });

    // 第 2 次还想调工具，超过 maxSteps=1 -> 触发 ABORT
    const r4 = stepAgentLoop(r3.state, {
      type: "LLM_REPLIED",
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c2", name: "list_dir", arguments: {} }],
      },
    });
    expect(r4.state.phase).toBe("error");
    expect(r4.effect.type).toBe("ABORT");
  });

  it("3. 本地工具执行：支持真实读文件，且遇到不存在的文件时返回 isError: true 而不崩进程", async () => {
    const tools = createBuiltinTools(process.cwd());
    const results = await executeToolCalls(
      [
        { id: "call_ok", name: "read_file", arguments: { path: "package.json", maxLines: 3 } },
        { id: "call_err", name: "read_file", arguments: { path: "not_exist.txt" } },
      ],
      tools,
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.toolCallId).toBe("call_ok");
    expect(results[0]?.isError).toBe(false);
    expect(results[0]?.content).toContain("duo-harness");

    expect(results[1]?.toolCallId).toBe("call_err");
    expect(results[1]?.isError).toBe(true);
  });
});
