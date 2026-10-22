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

  it("4. 支持多轮连续对话 (leafId 续写同一 .jsonl 不重复插 system 且不清空旧记录) 与多项目目录隔离", async () => {
    const { resolveProjectSessionPaths, listManagedProjects, createReplCompleter } = await import("../src/adapters/repl.js");
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "duo-projects-"));
    const projA = path.join(tmpBase, "app-alpha");
    const projB = path.join(tmpBase, "app-beta");
    fs.mkdirSync(projA, { recursive: true });
    fs.mkdirSync(projB, { recursive: true });

    const pathsA = resolveProjectSessionPaths(projA, tmpBase);
    const pathsB = resolveProjectSessionPaths(projB, tmpBase);
    expect(pathsA.projectKey).not.toBe(pathsB.projectKey);

    let callIdx = 0;
    const mockProvider = {
      async chat(messages: any[]) {
        callIdx += 1;
        // 验证第 2 轮发送的 messages 里只有 1 条 system 消息，且完整携带了第 1 轮问答
        const sysCount = messages.filter((m) => m.role === "system").length;
        expect(sysCount).toBe(1);
        return { role: "assistant" as const, content: `第${callIdx}轮回答 (收到了${messages.length}条消息)` };
      },
    };

    const turn1 = await runAgentSession("第一句提问", {
      workspaceRoot: projA,
      sessionFile: pathsA.sessionFile,
      provider: mockProvider,
    });
    expect(turn1.entries).toHaveLength(3); // msg_1(sys), msg_2(user1), msg_3(asst1)
    expect(turn1.leafId).toBe("msg_3");

    const turn2 = await runAgentSession("第二句追问", {
      workspaceRoot: projA,
      sessionFile: pathsA.sessionFile,
      leafId: turn1.leafId!,
      provider: mockProvider,
    });
    expect(turn2.entries).toHaveLength(5); // 追加了 msg_4(user2, parent=msg_3), msg_5(asst2, parent=msg_4)
    expect(turn2.finalAnswer).toContain("收到了4条消息");

    const completer = createReplCompleter(() => tmpBase, () => pathsA.sessionFile);
    expect(completer("/p")[0]).toEqual(["/projects"]);
    expect(completer("/cd app-")[0]).toContain("/cd app-alpha/");
    expect(completer("/branch msg_")[0]).toContain("/branch msg_3");

    const projects = listManagedProjects(tmpBase);
    expect(projects).toHaveLength(2);
    const foundA = projects.find((p) => p.projectKey === pathsA.projectKey);
    expect(foundA?.entryCount).toBe(5);
    expect(foundA?.lastLeafId).toBe("msg_5");

    // 验证 node:readline/promises 下 Symbol(_ttyWrite) 与下拉项目切换列表正常生效
    const readline = await import("node:readline/promises");
    const { findMethodKey, buildDropdownItems } = await import("../src/adapters/dropdown.js");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    expect(findMethodKey(rl, "_ttyWrite")).not.toBeNull();
    expect(findMethodKey(rl, "_refreshLine")).not.toBeNull();
    rl.close();
    const cdItems = buildDropdownItems("/cd ", pathsA.workspaceRoot, tmpBase);
    expect(cdItems[0]?.fillText).toBe("/cd app-beta");

    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it("5. 当历史 session.jsonl 因审批中断残留未闭合 toolCalls (及崩溃残留尾部 user 消息) 时，下次续聊自动自愈而不崩溃", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "duo-dangling-"));
    const sessionFile = path.join(tmpDir, "session.jsonl");
    // 100% 还原用户 my-ai-kb 崩溃现场：msg_8 是未闭合的 assistant toolCall，且 msg_9 是崩溃前已写入的孤儿 user 消息
    const brokenEntries: SessionEntry[] = [
      { id: "msg_1", parentId: null, timestamp: 1, message: { role: "system", content: "sys" } },
      { id: "msg_2", parentId: "msg_1", timestamp: 2, message: { role: "user", content: "查看项目" } },
      {
        id: "msg_8",
        parentId: "msg_2",
        timestamp: 3,
        message: {
          role: "assistant",
          content: "准备统计行数",
          toolCalls: [
            {
              id: "call_9dcba1abe2924419866632429117cd18f4a32823b216a",
              name: "run_bash",
              arguments: { command: "wc -l backend/*.py" },
            },
          ],
        },
      },
      { id: "msg_9", parentId: "msg_8", timestamp: 4, message: { role: "user", content: "分析代码，看下哪里有缺陷" } },
    ];
    fs.writeFileSync(sessionFile, brokenEntries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");

    const res = await runAgentSession("分析代码，看下哪里有缺陷", {
      workspaceRoot: tmpDir,
      sessionFile,
      leafId: "msg_9",
      provider: {
        async chat(messages) {
          const healedTool = messages.find(
            (m) => m.role === "tool" && m.toolCallId === "call_9dcba1abe2924419866632429117cd18f4a32823b216a",
          );
          expect(healedTool).toBeDefined();
          // 验证不会出现两条连续的 user("分析代码，看下哪里有缺陷")
          const userCount = messages.filter((m) => m.role === "user" && m.content === "分析代码，看下哪里有缺陷").length;
          expect(userCount).toBe(1);
          return { role: "assistant", content: "已自动修复中断记录并完成代码缺陷分析！" };
        },
      },
    });
    expect(res.finalAnswer).toBe("已自动修复中断记录并完成代码缺陷分析！");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
