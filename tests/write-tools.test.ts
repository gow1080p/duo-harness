import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentSession } from "../src/adapters/cli.js";
import { createBuiltinTools, executeToolCalls, resolveSafePath } from "../src/adapters/tools.js";
import { createWriteTools, type FileVersionSnapshot } from "../src/adapters/write-tools.js";
import type { AssistantMessage, LlmProvider, Message } from "../src/core/contracts.js";

describe("Stage 3: 写工具 (edit_file/run_bash/rollback_version)、暂停审批与完成前自动验证打回测试", () => {
  it("1. resolveSafePath 严格拦截工作区外的写操作，但允许只读白名单", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duo-stage3-path-"));
    // 允许工作区内多层尚不存在的新建子目录写操作
    const nestedNewFile = resolveSafePath(tmpRoot, "a/b/c/new.ts", "write");
    expect(nestedNewFile).toContain(path.join("a", "b", "c", "new.ts"));

    // 严禁越界写操作
    expect(() => resolveSafePath(tmpRoot, "../outside.ts", "write")).toThrow(/禁止访问/);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("2. edit_file 支持新建与唯一匹配修改，并支持同批次串行改同一文件与按版本步数回滚 (rollback_version)", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duo-stage3-edit-"));
    const snapshots: FileVersionSnapshot[] = [];
    const tools = createWriteTools(tmpRoot, snapshots);
    const [editTool, rollbackTool, bashTool] = tools;

    // 1) v1：oldText 为空新建 math.ts
    await editTool!.execute({
      path: "math.ts",
      oldText: "",
      newText: "export const a = 1;\nexport const b = 1;\n",
    });
    expect(fs.readFileSync(path.join(tmpRoot, "math.ts"), "utf-8")).toContain("export const a = 1;");
    expect(snapshots).toHaveLength(1);

    // 2) oldText 出现 2 次：报错要求补充上下文（不产生无效版本快照）
    await expect(
      editTool!.execute({ path: "math.ts", oldText: "= 1;", newText: "= 2;" }),
    ).rejects.toThrow(/出现了 2 次/);
    expect(snapshots).toHaveLength(1);

    // 3) 同批次并发发来 2 个写工具调用（v2 改 math.ts 的 a=42，v3 新建 logger.ts）：自动排队串行执行不覆盖
    await executeToolCalls(
      [
        {
          id: "c1",
          name: "edit_file",
          arguments: { path: "math.ts", oldText: "export const a = 1;", newText: "export const a = 42;" },
        },
        {
          id: "c2",
          name: "edit_file",
          arguments: { path: "logger.ts", oldText: "", newText: "export const log = true;\n" },
        },
      ],
      tools,
    );
    expect(snapshots).toHaveLength(3);
    expect(fs.existsSync(path.join(tmpRoot, "logger.ts"))).toBe(true);

    // 4) 用户要求“回滚到之前 2 个版本” (stepsBack: 2 -> 从 v3 退回 v1)
    const rbMsg = await rollbackTool!.execute({ stepsBack: 2 });
    expect(rbMsg).toContain("已成功回退 2 个版本（当前回到 v1 状态）");
    expect(fs.existsSync(path.join(tmpRoot, "logger.ts"))).toBe(false); // v3 新建的文件被自动清理
    expect(fs.readFileSync(path.join(tmpRoot, "math.ts"), "utf-8")).toContain("export const a = 1;"); // v2 修改被还原回 v1

    // 5) run_bash 正常执行命令
    const out = await bashTool!.execute({ command: "echo hello-stage3" });
    expect(out).toBe("hello-stage3");

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("3. 完整闭环：写操作暂停审批 + 完成前自动验证不过打回重修直至通过", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duo-stage3-loop-"));
    const targetFile = path.join(tmpRoot, "calc.ts");
    fs.writeFileSync(targetFile, "export const answer = 0;\n", "utf-8");

    const tools = [...createBuiltinTools(tmpRoot), ...createWriteTools(tmpRoot)];
    const scriptReplies: AssistantMessage[] = [
      // 第 1 轮：大模型尝试把 answer 改成 10（但验收要求是 42）
      {
        role: "assistant",
        content: "我先把 answer 改为 10",
        toolCalls: [
          {
            id: "call_edit_1",
            name: "edit_file",
            arguments: {
              path: "calc.ts",
              oldText: "export const answer = 0;",
              newText: "export const answer = 10;",
            },
          },
        ],
      },
      // 第 2 轮：大模型以为改完了，准备结束
      { role: "assistant", content: "修改完成！" },
      // 第 3 轮：收到验证打回报错后，大模型重新调 edit_file 改成 42
      {
        role: "assistant",
        content: "看到报错了，我把 answer 修正为 42",
        toolCalls: [
          {
            id: "call_edit_2",
            name: "edit_file",
            arguments: {
              path: "calc.ts",
              oldText: "export const answer = 10;",
              newText: "export const answer = 42;",
            },
          },
        ],
      },
      // 第 4 轮：再次提交完成
      { role: "assistant", content: "已修复为 42 并验证通过！" },
    ];

    let idx = 0;
    const mockProvider: LlmProvider = {
      async chat(_messages: Message[]): Promise<AssistantMessage> {
        return scriptReplies[idx++]!;
      },
    };

    let approvalCount = 0;
    let verifyCount = 0;

    const res = await runAgentSession("请把 calc.ts 里的 answer 改成正确的值", {
      provider: mockProvider,
      tools,
      onApprovalRequest: (calls) => {
        approvalCount += calls.length;
        return { approved: true };
      },
      verifyCompletion: () => {
        verifyCount += 1;
        const content = fs.readFileSync(targetFile, "utf-8");
        if (!content.includes("42")) {
          return { ok: false, errorOutput: "断言失败：calc.ts 中的 answer 必须等于 42，当前是 10" };
        }
        return { ok: true };
      },
    });

    expect(approvalCount).toBe(2);
    expect(verifyCount).toBe(2);
    expect(res.finalAnswer).toBe("已修复为 42 并验证通过！");
    expect(fs.readFileSync(targetFile, "utf-8")).toContain("export const answer = 42;");
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("4. 任务超步数 ABORT 熔断时，自动将本轮改坏的文件与新建脏文件全部回滚恢复原状", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duo-stage3-abort-rb-"));
    const targetFile = path.join(tmpRoot, "app.ts");
    fs.writeFileSync(targetFile, "export const status = 'clean';\n", "utf-8");

    const scriptReplies: AssistantMessage[] = [
      {
        role: "assistant",
        content: "我把 app.ts 改坏并新建一个临时文件",
        toolCalls: [
          {
            id: "call_dirty_1",
            name: "edit_file",
            arguments: {
              path: "app.ts",
              oldText: "export const status = 'clean';",
              newText: "export const status = 'broken';",
            },
          },
          {
            id: "call_dirty_2",
            name: "edit_file",
            arguments: {
              path: "temp-junk.ts",
              oldText: "",
              newText: "junk",
            },
          },
        ],
      },
      { role: "assistant", content: "尝试交卷" },
    ];

    let idx = 0;
    const mockProvider: LlmProvider = {
      async chat(): Promise<AssistantMessage> {
        return scriptReplies[idx++]!;
      },
    };

    const res = await runAgentSession("尝试修改", {
      provider: mockProvider,
      workspaceRoot: tmpRoot,
      enableWriteTools: true,
      maxSteps: 1, // 第 1 轮工具改完文件后 step=1，交卷验证失败时触发 maxSteps 熔断 ABORT
      verifyCompletion: () => ({ ok: false, errorOutput: "编译依然报错" }),
    });

    expect(res.finalAnswer).toContain("[ABORT]");
    // 验证硬盘上的 app.ts 已自动恢复为 clean，且新建的 temp-junk.ts 已被删除
    expect(fs.readFileSync(targetFile, "utf-8")).toBe("export const status = 'clean';\n");
    expect(fs.existsSync(path.join(tmpRoot, "temp-junk.ts"))).toBe(false);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("5. 纯只读查询类 run_bash (含 2>/dev/null、; 复合统计、git ls-files) 自动放行且剥离前置 cd，所有写/注入命令及 Seatbelt 沙箱严格拦截", async () => {
    const { isReadonlyBashCommand, buildDefaultSystemPrompt, formatApprovalBox, formatStepToolCalls, shortenWorkspaceText } =
      await import("../src/adapters/ui-logger.js");
    const { runCommandInSandbox } = await import("../src/adapters/write-tools.js");
    expect(
      isReadonlyBashCommand(
        'find . -type f -not -path "*/node_modules/*" -not -path "*/.git/*" | head -100',
      ),
    ).toBe(true);
    expect(isReadonlyBashCommand('wc -l backend/*.py 2>/dev/null; echo "---"; cat backend/requirements.txt')).toBe(true);
    expect(isReadonlyBashCommand('find . -name "*.py" -o -name "*.ts" | wc -l')).toBe(true);
    expect(isReadonlyBashCommand("git status && git diff && git branch --show-current")).toBe(true);
    expect(isReadonlyBashCommand("git remote -v && git branch -a && git tag -l </dev/null")).toBe(true);
    expect(isReadonlyBashCommand("uname -a && realpath . && node -v && python3 --version")).toBe(true);
    expect(
      isReadonlyBashCommand(
        'grep -n "@app\\.|def \\|async def" "/Volumes/T7 Shield/code/kids-essay-copilot/main.py" | head -50; echo ---; wc -l "/Volumes/T7 Shield/code/kids-essay-copilot/main.py"',
      ),
    ).toBe(true);
    expect(
      isReadonlyBashCommand(
        'cd "/Volumes/T7 Shield/code/kids-essay-copilot" && wc -l main.py app/services/*.py 2>/dev/null; echo \'--- git tracked? ---\'; git ls-files | grep -E \'\\.env$|^venv/|web-ui/dist/\' | head; echo \'--- gitignore ---\'; cat .gitignore',
      ),
    ).toBe(true);
    expect(
      shortenWorkspaceText(
        'cd "/Volumes/T7 Shield/code/kids-essay-copilot" && wc -l "/Volumes/T7 Shield/code/kids-essay-copilot/main.py"',
        "/Volumes/T7 Shield/code/kids-essay-copilot",
      ),
    ).toBe('wc -l "main.py"');

    // 严防绕过测试
    expect(isReadonlyBashCommand("sed -i 's/a/b/g' app.ts")).toBe(false);
    expect(isReadonlyBashCommand("sed -Ei 's/a/b/g' app.ts")).toBe(false);
    expect(isReadonlyBashCommand("sed 's/a/b/w out.txt' app.ts")).toBe(false);
    expect(isReadonlyBashCommand("sed 's/a/b/e' app.ts")).toBe(false);
    expect(isReadonlyBashCommand("find . -name '*.tmp' -delete")).toBe(false);
    expect(isReadonlyBashCommand("sort a.txt -o b.txt")).toBe(false);
    expect(isReadonlyBashCommand("tree -o out.txt")).toBe(false);
    expect(isReadonlyBashCommand("cat a > b 2>/dev/null")).toBe(false);
    expect(isReadonlyBashCommand("env rm -rf dist")).toBe(false);
    expect(isReadonlyBashCommand('node -e "console.log(1)"')).toBe(false);
    expect(isReadonlyBashCommand("git branch -D feature")).toBe(false);
    expect(isReadonlyBashCommand("git remote remove origin")).toBe(false);
    expect(isReadonlyBashCommand("ls > out.txt")).toBe(false);
    expect(isReadonlyBashCommand("rm -rf dist")).toBe(false);
    expect(isReadonlyBashCommand("git status", false)).toBe(false);

    // 验证 macOS Seatbelt 只读沙箱物理阻断文件写入，而正常只读查询通过
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duo-seatbelt-"));
    fs.writeFileSync(path.join(tmpRoot, "a.py"), "print(1)\nprint(2)\n", "utf-8");
    fs.mkdirSync(path.join(tmpRoot, "venv"));
    const roOk = await runCommandInSandbox("wc -l a.py 2>/dev/null", tmpRoot, 5_000, undefined, true);
    expect(roOk.exitCode).toBe(0);
    if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) {
      const roBlocked = await runCommandInSandbox("touch hacked.txt", tmpRoot, 5_000, undefined, true);
      expect(roBlocked.exitCode).not.toBe(0);
      expect(fs.existsSync(path.join(tmpRoot, "hacked.txt"))).toBe(false);
    }
    const [ , listDirTool] = createBuiltinTools(tmpRoot);
    const dirTree = await listDirTool!.execute({ path: "." });
    expect(dirTree).toContain("a.py (3 lines)");
    expect(dirTree).toContain("[已过滤忽略目录: venv/]");
    fs.rmSync(tmpRoot, { recursive: true, force: true });

    // 验证 System Prompt 注入工作区路径且审批框严格区分修改文件与运行命令
    expect(buildDefaultSystemPrompt("/tmp/my-ai-kb")).toContain("/tmp/my-ai-kb");
    const editBox = formatApprovalBox([
      { id: "1", name: "edit_file", arguments: { path: "a.ts", oldText: "a\nb", newText: "a\nb\nc" } },
    ]);
    expect(editBox).toContain("申请修改文件");
    expect(editBox).toContain("-2 行 / +3 行");
    const bashBox = formatApprovalBox([{ id: "2", name: "run_bash", arguments: { command: "pytest" } }]);
    expect(bashBox).toContain("申请执行终端命令");
    const stepTree = formatStepToolCalls(
      1,
      [{ id: "3", name: "read_file", arguments: { path: "README.md", startLine: 1, endLine: 50 } }],
      new Map([["read_file", true]]),
    );
    expect(stepTree).toContain("正在探索与读取项目");
    expect(stepTree).toContain("README.md (第 1~50 行)");
  });
});
