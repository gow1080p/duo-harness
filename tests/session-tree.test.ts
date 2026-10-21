import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentSession } from "../src/adapters/cli.js";
import { appendJsonlEntries, createReplayProvider, loadJsonlEntries } from "../src/adapters/store.js";
import type { Message, SessionEntry } from "../src/core/contracts.js";
import {
  assertSessionInvariant,
  buildSessionEntries,
  projectToMessages,
} from "../src/core/session-tree.js";

describe("Stage 2: .jsonl 会话树与断网录像回放测试", () => {
  it("1. 支持通过 parentId 在同一个 .jsonl 中拉出不同对话分支", () => {
    const baseMessages: Message[] = [
      { role: "system", content: "系统提示" },
      { role: "user", content: "帮我读 package.json" },
      { role: "assistant", content: "这是 package.json 的内容" },
    ];
    const entries = buildSessionEntries([], baseMessages, 1000);

    // 从第 2 条消息 (msg_2) 分叉出一条新的第 4 条消息 (msg_4)
    const branchEntries = buildSessionEntries(
      entries,
      [{ role: "user", content: "算了，改读 tsconfig.json" }],
      2000,
      "msg_2",
    );
    const allEntries: SessionEntry[] = [...entries, ...branchEntries];

    // 顺着 msg_3 往上找，拿到原分支
    const branchA = projectToMessages(allEntries, "msg_3");
    expect(branchA.map((m) => m.content)).toEqual([
      "系统提示",
      "帮我读 package.json",
      "这是 package.json 的内容",
    ]);

    // 顺着 msg_4 往上找，拿到新分支（跳过了 msg_3）
    const branchB = projectToMessages(allEntries, "msg_4");
    expect(branchB.map((m) => m.content)).toEqual([
      "系统提示",
      "帮我读 package.json",
      "算了，改读 tsconfig.json",
    ]);
  });

  it("2. 能够拦截环路死循环与缺少工具返回结果的格式错误", () => {
    const cyclicEntries: SessionEntry[] = [
      { id: "msg_1", parentId: "msg_2", timestamp: 1, message: { role: "user", content: "A" } },
      { id: "msg_2", parentId: "msg_1", timestamp: 2, message: { role: "assistant", content: "B" } },
    ];
    expect(() => projectToMessages(cyclicEntries, "msg_2")).toThrow(/环路/);

    const brokenMessages: Message[] = [
      { role: "user", content: "读文件" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: "a.txt" } }],
      },
      // 故意漏掉 role: "tool" 结果，直接跟一条 user 消息
      { role: "user", content: "继续" },
    ];
    expect(() => assertSessionInvariant(brokenMessages)).toThrow(/违反配对规则/);
    expect(() => createReplayProvider([])).toThrow(/会话记录为空/);
  });

  it("3. 支持把会话写入 .jsonl 文件并断网 0 毫秒完整回放", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "duo-stage2-"));
    const jsonlPath = path.join(tmpDir, "recorded.jsonl");

    const sampleMessages: Message[] = [
      { role: "system", content: "系统提示" },
      { role: "user", content: "读取 package.json" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: "package.json" } }],
      },
      {
        role: "tool",
        toolCallId: "call_1",
        name: "read_file",
        content: '{"name":"duo-harness"}',
        isError: false,
      },
      { role: "assistant", content: "项目名是 duo-harness" },
    ];

    const entries = buildSessionEntries([], sampleMessages, 1000);
    appendJsonlEntries(jsonlPath, entries, true);

    const loaded = loadJsonlEntries(jsonlPath);
    expect(loaded).toHaveLength(5);

    const replayProvider = createReplayProvider(loaded);
    const res = await runAgentSession("读取 package.json", {
      provider: replayProvider,
      systemPrompt: "系统提示",
    });

    expect(res.stepsUsed).toBe(1);
    expect(res.finalAnswer).toBe("项目名是 duo-harness");
    expect(res.entries).toHaveLength(5);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
