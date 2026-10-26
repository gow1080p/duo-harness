import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentSession } from "../src/adapters/cli.js";
import { expandHomePath, isPathInside, toPosixPath } from "../src/adapters/platform.js";
import { createBuiltinTools, executeToolCalls, resolveSafePath } from "../src/adapters/tools.js";
import { shortenWorkspaceText } from "../src/adapters/ui-logger.js";
import { createWriteTools, type FileVersionSnapshot } from "../src/adapters/write-tools.js";
import type { AssistantMessage, LlmProvider, Message } from "../src/core/contracts.js";

describe("Stage 3: 写工具 (edit_file/run_bash/rollback_version)、暂停审批与完成前自动验证打回测试", () => {
  it("1. resolveSafePath 严格拦截工作区外的写操作，但允许只读白名单", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duo-stage3-path-"));
    // 允许工作区内多层尚不存在的新建子目录写操作
    const nestedNewFile = resolveSafePath(tmpRoot, "a/b/c/new.ts", "write");
    expect(nestedNewFile).toContain(path.join("a", "b", "c", "new.ts"));
    expect(toPosixPath("src\\core\\loop.ts")).toBe("src/core/loop.ts");
    expect(expandHomePath("~/skills", "/home/dev")).toBe(path.join("/home/dev", "skills"));
    expect(expandHomePath("~\\skills", "/home/dev")).toBe(path.join("/home/dev", "skills"));
    expect(isPathInside(path.join(tmpRoot, "sub", "file.ts"), tmpRoot)).toBe(true);
    expect(shortenWorkspaceText("d:\\code\\app\\src\\a.ts", "d:\\code\\app")).toBe("src\\a.ts");

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

    // 5) 兼容模型将 edits 传为 JSON 字符串的场景，不报 invalid_type 错误
    await editTool!.execute({
      path: "math.ts",
      edits: JSON.stringify([{ oldText: "export const b = 1;", newText: "export const b = 99;" }]) as any,
    });
    expect(fs.readFileSync(path.join(tmpRoot, "math.ts"), "utf-8")).toContain("export const b = 99;");

    // 6) run_bash 正常执行命令
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

    const priorSnapshots = [
      { version: 1, path: "prev.ts", beforeContent: "old", afterContent: "kept", timestamp: 1 },
    ];
    const redoBatches: any[][] = [];
    const res = await runAgentSession("尝试修改", {
      provider: mockProvider,
      workspaceRoot: tmpRoot,
      snapshots: priorSnapshots,
      redoBatches,
      enableWriteTools: true,
      maxSteps: 1, // 第 1 轮工具改完文件后 step=1，交卷验证失败时触发 maxSteps 熔断 ABORT
      verifyCompletion: () => ({ ok: false, errorOutput: "编译依然报错" }),
    });

    expect(res.finalAnswer).toContain("[ABORT]");
    // 验证硬盘上的 app.ts 已自动恢复为 clean，新建的 temp-junk.ts 已被删除，且上一轮的 prev.ts 快照未被误回滚
    expect(fs.readFileSync(targetFile, "utf-8")).toBe("export const status = 'clean';\n");
    expect(fs.existsSync(path.join(tmpRoot, "temp-junk.ts"))).toBe(false);
    expect(priorSnapshots).toHaveLength(1);
    expect(priorSnapshots[0]!.path).toBe("prev.ts");
    // 验证自动回滚的修改已压入 redoBatches，随时可通过 /redo 恢复
    expect(redoBatches).toHaveLength(1);
    expect(redoBatches[0]).toHaveLength(2);
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
    expect(isReadonlyBashCommand("env sed -i 's/a/b/g' app.ts")).toBe(false);
    expect(isReadonlyBashCommand("LC_ALL=C sort -o out.txt a.txt")).toBe(false);
    expect(isReadonlyBashCommand("sed 's/a/b/w out.txt' app.ts")).toBe(false);
    expect(isReadonlyBashCommand("sed 's#a#b#w out.txt' app.ts")).toBe(false);
    expect(isReadonlyBashCommand("sed 's/a/b/pw out.txt' app.ts")).toBe(false);
    expect(isReadonlyBashCommand("sed 's/a/b/;w out.txt' app.ts")).toBe(false);
    expect(isReadonlyBashCommand("sed 'w out.txt' app.ts")).toBe(false);
    expect(isReadonlyBashCommand("sed -n '1,5w out.txt' app.ts")).toBe(false);
    expect(isReadonlyBashCommand("sed '1e rm -rf dist' app.ts")).toBe(false);
    expect(isReadonlyBashCommand("sed w out.txt app.ts")).toBe(false);
    expect(isReadonlyBashCommand("sed 's/=.*/=***/' .env && [ -d app/w ]")).toBe(true);
    expect(
      isReadonlyBashCommand(
        'sed \'s/=.*/=***已设置***/\' .env && echo && echo \'=== 端口占用 ===\' && for p in 8000 10086; do echo -n "端口 $p: "; lsof -ti:$p >/dev/null && echo "占用" || echo "空闲"; done',
      ),
    ).toBe(true);
    expect(isReadonlyBashCommand("for p in 8000 10086; do kill $p; done")).toBe(false);
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
    expect(isReadonlyBashCommand('cd "/Volumes/T7 Shield/code/kids-essay-copilot" && venv/bin/pip install -q "httpx[socks]"')).toBe(false);
    expect(isReadonlyBashCommand("venv/bin/python -c 'import socksio'")).toBe(false);
    expect(isReadonlyBashCommand("env/bin/pip install requests")).toBe(false);
    expect(isReadonlyBashCommand("uvicorn main:app --port 8000")).toBe(false);
    expect(isReadonlyBashCommand("nohup python3 -m http.server 8000 &")).toBe(false);
    expect(isReadonlyBashCommand("cd /tmp")).toBe(false);
    expect(isReadonlyBashCommand("echo $'\\''; rm -rf dist; echo $'\\''")).toBe(false);
    expect(isReadonlyBashCommand('find . "-delete"')).toBe(false);
    expect(isReadonlyBashCommand("sort -oout.txt a.txt")).toBe(false);
    expect(isReadonlyBashCommand('sort "-o" out.txt a.txt')).toBe(false);
    expect(isReadonlyBashCommand("xxd a.txt b.txt")).toBe(false);
    expect(isReadonlyBashCommand("uniq a.txt b.txt")).toBe(false);
    expect(isReadonlyBashCommand("rg --pre sh pattern")).toBe(false);
    expect(isReadonlyBashCommand("sort --compress-program=sh a.txt")).toBe(false);
    expect(isReadonlyBashCommand("file -C -m magic")).toBe(false);
    expect(isReadonlyBashCommand('GIT_EXTERNAL_DIFF="sh -c id" git diff')).toBe(false);
    expect(isReadonlyBashCommand("git reflog delete HEAD@{0}")).toBe(false);
    expect(isReadonlyBashCommand('for f in app.ts; do sed -i "s/a/b/g" $f; done')).toBe(false);
    expect(isReadonlyBashCommand("for f in a.txt; do sort -o b.txt $f; done")).toBe(false);
    expect(isReadonlyBashCommand("curl -o /tmp/evil.sh http://127.0.0.1:8000/docs")).toBe(false);
    expect(isReadonlyBashCommand('curl -4o "/tmp/evil.sh" http://127.0.0.1:8000/docs')).toBe(false);
    expect(isReadonlyBashCommand("curl -X POST http://127.0.0.1:8000/api")).toBe(false);
    expect(isReadonlyBashCommand("curl --json '{\"a\":1}' http://127.0.0.1:8000/api")).toBe(false);
    expect(isReadonlyBashCommand("curl http://example.com/api")).toBe(false);
    expect(isReadonlyBashCommand('echo "http://127.0.0.1" && curl "example.com/shell.sh"')).toBe(false);
    expect(isReadonlyBashCommand('curl "http://localhost.evil.com/?ref=http://localhost"')).toBe(false);
    expect(isReadonlyBashCommand("curl -s -m 5 http://127.0.0.1:8000/health")).toBe(true);
    expect(
      isReadonlyBashCommand(
        'sleep 2 && tail -15 /tmp/kids-essay-backend.log && pgrep -fl "uvicorn main:app" || echo "uvicorn 进程不存在" && curl -s -o /dev/null -w "backend http_code=%{http_code}" http://127.0.0.1:8000/docs',
      ),
    ).toBe(true);
    expect(isReadonlyBashCommand("lsof -i :8000 >/dev/null 2>&1 && git --no-pager log -n 1 && go version")).toBe(true);
    expect(isReadonlyBashCommand('if [ -d web-ui/node_modules ]; then echo "exists"; else echo "missing"; fi')).toBe(true);
    expect(isReadonlyBashCommand('for p in 8000 10086; do echo -n "端口 $p: "; lsof -i :$p -t 2>/dev/null || echo "无进程"; done')).toBe(true);
    expect(
      isReadonlyBashCommand(
        "echo '=== .env 变量名(隐藏值) ===' && sed 's/=.*/=***/' .env && echo && echo '=== node/pnpm ===' && node -v 2>&1; pnpm -v 2>&1; npm -v 2>&1; echo '=== node_modules 是否存在 ===' && [ -d web-ui/node_modules ] && echo '存在' || echo '不存在'",
      ),
    ).toBe(true);

    // 验证 macOS Seatbelt 只读沙箱物理阻断文件写入并附带沙箱提示，而正常只读查询（含 /bin/ps）通过
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duo-seatbelt-"));
    fs.writeFileSync(path.join(tmpRoot, "a.py"), "print(1)\nprint(2)\n", "utf-8");
    fs.mkdirSync(path.join(tmpRoot, "venv"));
    const roOk = await runCommandInSandbox("wc -l a.py 2>/dev/null && ps -p $$ >/dev/null", tmpRoot, 5_000, undefined, true);
    expect(roOk.exitCode).toBe(0);
    const abortedRes = await runCommandInSandbox("echo should-not-run", tmpRoot, 5_000, AbortSignal.abort(), true);
    expect(abortedRes.exitCode).toBe(130);
    if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) {
      const roBlocked = await runCommandInSandbox("touch hacked.txt", tmpRoot, 5_000, undefined, true);
      expect(roBlocked.exitCode).not.toBe(0);
      expect(roBlocked.output).toContain("沙箱提示");
      expect(fs.existsSync(path.join(tmpRoot, "hacked.txt"))).toBe(false);
    }

    // 验证启动后台常驻进程（即使子进程继承了 stdout/stderr 管道未关闭）在主 Shell exit 后 150ms 内返回，不挂死满超时且进程存活
    const t0 = Date.now();
    const bgRes = await runCommandInSandbox(
      'node -e "console.log(\'BG_PID=\' + process.pid); setInterval(() => {}, 1000)" & sleep 0.15',
      tmpRoot,
      5_000,
      undefined,
      false,
    );
    const elapsed = Date.now() - t0;
    expect(bgRes.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(1_500);
    const pidMatch = bgRes.output.match(/BG_PID=(\d+)/);
    const bgPid = pidMatch ? Number(pidMatch[1]) : 0;
    expect(bgPid).toBeGreaterThan(0);
    try {
      process.kill(bgPid, 0); // 验证后台进程未被超时误杀，依然存活
    } finally {
      if (bgPid) {
        try {
          process.kill(bgPid, "SIGKILL");
        } catch {}
      }
    }
    fs.mkdirSync(path.join(tmpRoot, "web-ui", "node_modules"), { recursive: true });
    const [ , listDirTool] = createBuiltinTools(tmpRoot);
    const dirTree = await listDirTool!.execute({ path: "." });
    expect(dirTree).toContain("a.py (3 lines)");
    expect(dirTree).toContain("[已过滤忽略目录: venv/, web-ui/node_modules/]");
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {}

    // 验证 System Prompt 注入工作区路径且审批框严格区分修改文件与运行命令（含 -/+ 代码对比预览）
    expect(buildDefaultSystemPrompt("/tmp/my-ai-kb")).toContain("/tmp/my-ai-kb");
    const editBox = formatApprovalBox([
      { id: "1", name: "edit_file", arguments: { path: "a.ts", oldText: "a\nb_old", newText: "a\nb_new\nc" } },
    ]);
    expect(editBox).toContain("申请修改文件");
    expect(editBox).toContain("-1 行 / +2 行");
    expect(editBox).not.toContain("- a");
    expect(editBox).toContain("- b_old");
    expect(editBox).toContain("+ b_new");
    expect(editBox).toContain("+ c");
    const bashBox = formatApprovalBox([
      {
        id: "2",
        name: "run_bash",
        arguments: {
          command:
            "echo '=== .env ===' && sed -i 's/a/b/g' .env && echo && echo '=== 端口 ===' && for p in 8000 10086; do echo -n \"端口 $p: \"; kill $p; done",
        },
      },
    ]);
    expect(bashBox).toContain("申请执行终端命令");
    expect(bashBox).not.toContain("$ & ");
    expect(bashBox).not.toContain("echo '=== .env ==='");
    expect(bashBox).toContain("$ sed -i 's/a/b/g' .env");
    const stepTree = formatStepToolCalls(
      1,
      [
        { id: "3", name: "read_file", arguments: { path: "README.md", startLine: 1, endLine: 50 } },
        {
          id: "4",
          name: "run_bash",
          arguments: {
            command:
              "cd \"web-ui\" && cat package.json && echo \"---\" && echo '--- node_modules 是否存在 ---' && [ -d node_modules ]",
          },
        },
      ],
      new Map([["read_file", true], ["run_bash", false]]),
    );
    expect(stepTree).toContain("正在探索与读取项目");
    expect(stepTree).toContain("README.md (第 1~50 行)");
    expect(stepTree).toContain("cd \"web-ui\" · cat package.json · [ -d node_modules ]");
    expect(stepTree).not.toContain("· &");
    expect(stepTree).not.toContain("node_modules 是否存在");
    const mixedWriteTree = formatStepToolCalls(
      3,
      [
        {
          id: "5",
          name: "run_bash",
          arguments: {
            command:
              "ls web-ui/node_modules >/dev/null 2>&1 && echo \"node_modules: OK\" || echo \"node_modules: MISSING\"; venv/bin/python -c \"import fastapi\"",
          },
        },
      ],
      new Map([["run_bash", false]]),
    );
    expect(mixedWriteTree).toContain("💻 运行终端命令: venv/bin/python -c \"import fastapi\"");

    // 验证用户在审批框按 Ctrl+C (signal.abort) 时立即终止本轮循环，绝不继续发起后续 LLM 请求，且闭合 tool_calls
    let llmCallCount = 0;
    const turnAbort = new AbortController();
    const ctrlCRes = await runAgentSession("请帮我启动服务", {
      workspaceRoot: process.cwd(),
      enableWriteTools: true,
      suppressFinalEcho: true,
      signal: turnAbort.signal,
      provider: {
        async chat() {
          llmCallCount++;
          return {
            role: "assistant",
            content: "准备执行命令",
            toolCalls: [{ id: "tc_ctrlc", name: "run_bash", arguments: { command: "uvicorn main:app" } }],
          };
        },
      },
      async onApprovalRequest() {
        turnAbort.abort();
        return { approved: false, reason: "用户按 Ctrl+C 中断了本轮操作" };
      },
    });
    expect(llmCallCount).toBe(1);
    expect(ctrlCRes.finalAnswer).toContain("[ABORT] 用户按 Ctrl+C 中断了本轮操作");
    expect(ctrlCRes.entries[ctrlCRes.entries.length - 1]?.message.role).toBe("tool");

    // 验证 run_bash timeoutMs > 30000 不会触发 Zod 拒单，且 formatRecentHistoryRecap / formatSnapshotsDiff 正常展示
    const [, , bashTool] = createWriteTools(process.cwd());
    expect(bashTool!.parameters.safeParse({ command: "echo ok", timeoutMs: 180_000 }).success).toBe(true);
    const { formatRecentHistoryRecap, formatSnapshotsDiff } = await import("../src/adapters/project-store.js");
    const recap = formatRecentHistoryRecap([
      { id: "e0001", parentId: null, timestamp: 1, message: { role: "user", content: "检查项目合理性" } },
      { id: "e0002", parentId: "e0001", timestamp: 2, message: { role: "assistant", content: "项目整体清晰，有3处可优化" } },
    ]);
    expect(recap).toContain("检查项目合理性");
    expect(recap).toContain("项目整体清晰");
    const diffOut = formatSnapshotsDiff(
      [
        {
          version: 1,
          path: "main.py",
          beforeContent: "def foo():\n  return null\n",
          afterContent: `def foo():\n  return null\ndef bar():\n  return null\n${Array.from({ length: 18 }, (_, i) => `  line_${i} = ${i}`).join("\n")}\n`,
          timestamp: 1,
        },
      ],
      process.cwd(),
    );
    // LCS 差异提取：即便文件中原本已有 return null，新增的重复行 return null 也不会被吞掉（且保留相对缩进），超过 15 行自动提示 /diff full
    expect(diffOut).toContain("+ def bar():");
    expect(diffOut).toContain("+   return null");
    expect(diffOut).toContain("/diff full 查看全部");
    const fullDiffOut = formatSnapshotsDiff(
      [
        {
          version: 1,
          path: "main.py",
          beforeContent: "def foo():\n  return null\n",
          afterContent: `def foo():\n  return null\ndef bar():\n  return null\n${Array.from({ length: 18 }, (_, i) => `  line_${i} = ${i}`).join("\n")}\n`,
          timestamp: 1,
        },
      ],
      process.cwd(),
      { full: true },
    );
    expect(fullDiffOut).toContain("line_17 = 17");
    const multiSnaps = ["a.ts", "b.ts", "c.ts"].map((p, i) => ({
      version: i + 1,
      path: p,
      beforeContent: null,
      afterContent: Array.from({ length: 10 }, (_, k) => `const ${p[0]}_${k} = ${k};`).join("\n"),
      timestamp: i + 1,
    }));
    const multiOut = formatSnapshotsDiff(multiSnaps, process.cwd());
    expect(multiOut).toContain("📂 修改文件清单");
    expect(multiOut).toContain("[1] a.ts");
    expect(multiOut).toContain("[3] c.ts");
    expect(multiOut).not.toContain("const a_8 = 8;");
    const singleFiltered = formatSnapshotsDiff(multiSnaps, process.cwd(), { fileFilter: "2" });
    expect(singleFiltered).toContain("📘 b.ts");
    expect(singleFiltered).not.toContain("📘 a.ts");
    expect(singleFiltered).toContain("const b_8 = 8;");

    // 验证 formatStepToolCalls 同文件合并 & formatApprovalBox 剥离未修改上下文行（如 Volume2, Square）并展示修改点
    const stepCalls = [
      {
        id: "e1",
        name: "edit_file",
        arguments: {
          path: "web-ui/src/App.tsx",
          oldText: "  Volume2,\n  Square,\n} from 'lucide-react';",
          newText: "  Volume2,\n  Square,\n  Sparkles,\n  PenTool,\n} from 'lucide-react';",
        },
      },
      {
        id: "e2",
        name: "edit_file",
        arguments: {
          path: "web-ui/src/App.tsx",
          oldText: "            <h1 className=\"title\">小作家助手</h1>",
          newText: "            <h1 className=\"title\">小作家创作乐园</h1>",
        },
      },
    ];
    const stepTreeText = formatStepToolCalls(6, stepCalls, new Map([["edit_file", false]]), process.cwd());
    expect(stepTreeText).toContain("📝 修改文件: web-ui/src/App.tsx (2 处修改)");
    const boxText = formatApprovalBox(stepCalls, process.cwd());
    expect(boxText).toContain("共 2 处修改");
    expect(boxText).not.toContain("- Volume2");
    expect(boxText).toContain("+ Sparkles,");
    expect(boxText).toContain("@@ 修改点 #1");
    expect(boxText).toContain("@@ 修改点 #2");

    // 验证只读 tsc --noEmit 自动放行，而会写 .tsbuildinfo 的 tsc -b 必须走写审批；cleanDisplayBash 自动过滤末尾 echo exit
    const { cleanDisplayBash, formatCompactTurnFooter, formatDurationMs, formatToolResultLine, getVisualCols } = await import("../src/adapters/ui-logger.js");
    expect(formatDurationMs(12_400)).toBe("12.4s");
    expect(formatDurationMs(278_000)).toBe("4m38s");
    const htmlFooter = formatCompactTurnFooter(".sessions/non-existent.json", 4, false, [{ path: "van-gogh-pelican.html", beforeContent: null, afterContent: "<html></html>" }], process.cwd(), 278_000);
    expect(htmlFooter).toContain("⏱️ 4m38s");
    expect(htmlFooter).toContain("输入 /open 打开文件");
    expect(htmlFooter).not.toContain("\x1b]8;;");
    expect(htmlFooter).toContain(`${toPosixPath(process.cwd())}/van-gogh-pelican.html`);
    expect(getVisualCols("\x1b[32mb.html\x1b[0m")).toBe(6);
    if (process.platform === "win32") {
      const cmdRes = await runCommandInSandbox('cmd.exe /c echo msys_ok', process.cwd(), 5_000, undefined, true);
      expect(cmdRes.output.trim()).toBe("msys_ok");
    }
    expect(isReadonlyBashCommand('cd web-ui && npx tsc --noEmit 2>&1 | tail -5; echo "tsc exit: $?"', true)).toBe(true);
    expect(isReadonlyBashCommand('cd web-ui && npx tsc -b 2>&1 | tail -5; echo "tsc exit: $?"', true)).toBe(false);
    expect(cleanDisplayBash('cd web-ui && npx tsc -b 2>&1 | tail -5; echo "tsc exit: $?"')).toEqual([
      "cd web-ui",
      "npx tsc -b | tail -5",
    ]);
    expect(
      formatToolResultLine({
        role: "tool",
        toolCallId: "t1",
        name: "edit_file",
        content: "已写入文件: web-ui/src/App.tsx (共应用 5 处修改 · +53 / -18 行，当前版本 v2)",
        isError: false,
      }),
    ).toContain("↳ ✏️  已写入文件: web-ui/src/App.tsx (共应用 5 处修改 · +53 / -18 行，当前版本 v2)");

    // 验证 SessionController.ask 结束后 snapshots.json 不会被 buildStatusSummary 覆盖清空，且同轮内对同一文件的多次自修自动合并为 1 个版本
    const { createSessionController } = await import("../src/adapters/session-controller.js");
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "duo-ctrl-ws-"));
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "duo-ctrl-home-"));
    fs.writeFileSync(path.join(tmpWs, "index.html"), "<title>旧标题</title>\n", "utf-8");
    let stepIdx = 0;
    const ctrl = createSessionController({
      workspaceRoot: tmpWs,
      homeBaseDir: tmpHome,
      provider: {
        async chat() {
          stepIdx++;
          if (stepIdx === 1) {
            return {
              role: "assistant",
              content: "先改第一稿",
              toolCalls: [{ id: "c_html_1", name: "edit_file", arguments: { path: "index.html", edits: [{ oldText: "<title>旧标题</title>", newText: "<title>中间草稿</title>" }] } }],
            };
          }
          if (stepIdx === 2) {
            return {
              role: "assistant",
              content: "模型自查修正为最终标题",
              toolCalls: [{ id: "c_html_2", name: "edit_file", arguments: { path: "index.html", edits: [{ oldText: "<title>中间草稿</title>", newText: "<title>新标题</title>" }] } }],
            };
          }
          return { role: "assistant", content: "已完成标题修改" };
        },
      },
    });
    const askRes = await ctrl.ask("改标题", { suppressFinalEcho: true, onApprovalRequest: () => ({ approved: true }) });
    expect(askRes.modifiedFiles).toHaveLength(1);
    expect(askRes.modifiedFiles[0]?.addedLines).toBe(1);
    expect(askRes.modifiedFiles[0]?.removedLines).toBe(1);
    const diffAfterAsk = ctrl.getDiff();
    expect(diffAfterAsk.totalSnapshots).toBe(1);
    expect(diffAfterAsk.formattedText).toContain("index.html");
    expect(diffAfterAsk.formattedText).toContain("- <title>旧标题</title>");
    expect(diffAfterAsk.formattedText).toContain("+ <title>新标题</title>");
    expect(ctrl.getDiff("all").files[0]?.isNew).toBe(false);
    const undoInvalid = await ctrl.undo("invalid_arg");
    expect(undoInvalid.rolledBackCount).toBe(0);
    const undoOk = await ctrl.undo("turn");
    expect(undoOk.rolledBackCount).toBe(1);
    expect(fs.readFileSync(path.join(tmpWs, "index.html"), "utf-8")).toContain("<title>旧标题</title>");
    const redoInvalid = await ctrl.redo("invalid_arg");
    expect(redoInvalid.redoneCount).toBe(0);
    const redoOk = await ctrl.redo("turn");
    expect(redoOk.redoneCount).toBe(1);
    expect(redoOk.totalVersions).toBe(1);
    expect(redoOk.remainingRedoBatches).toBe(0);
    expect(fs.readFileSync(path.join(tmpWs, "index.html"), "utf-8")).toContain("<title>新标题</title>");
    await ctrl.undo("turn");
    expect(fs.readFileSync(path.join(tmpWs, "index.html"), "utf-8")).toContain("<title>旧标题</title>");

    // 验证半途断电/进程强退时：第 1 步刚改完文件（第 2 步还没开始）磁盘 snapshots.json 已实时原子落盘，重启新 Controller 后可立即 /diff 与 /undo
    let snapshotsFlushedMidTurn = 0;
    const crashCtrl = createSessionController({
      workspaceRoot: tmpWs,
      homeBaseDir: tmpHome,
      provider: {
        async chat(msgs) {
          if (msgs[msgs.length - 1]?.role === "tool") {
            const rawSnap = JSON.parse(fs.readFileSync(ctrl.getPaths().snapshotsFile, "utf-8"));
            snapshotsFlushedMidTurn = Array.isArray(rawSnap) ? rawSnap.length : 0;
            throw new Error("模拟半途进程断电/网络致命异常");
          }
          return {
            role: "assistant",
            content: "先改一步",
            toolCalls: [
              {
                id: "c_crash_1",
                name: "edit_file",
                arguments: { path: "index.html", oldText: "<title>旧标题</title>", newText: "<title>半途修改标题</title>" },
              },
            ],
          };
        },
      },
    });
    await expect(crashCtrl.ask("半途崩溃测试", { suppressFinalEcho: true, onApprovalRequest: () => ({ approved: true }) })).rejects.toThrow("模拟半途进程断电");
    expect(snapshotsFlushedMidTurn).toBe(1);
    // 验证半途异常后 Controller 内存与 meta.json 的 activeLeafId 均已保存最新断点，直接续聊不丢上下文
    expect(crashCtrl.getLeafId()).toBeTruthy();
    const { verifyGoalCompletion } = await import("../src/adapters/repl.js");
    expect(buildDefaultSystemPrompt("/tmp/ws")).toContain("严禁调用未注册的 glob");
    expect(buildDefaultSystemPrompt("/tmp/ws")).toContain("分批小步落盘");
    expect((await verifyGoalCompletion(tmpWs, "接下来我将开始创建组件文件")).ok).toBe(false);
    expect((await verifyGoalCompletion(tmpWs, "已完成全部模块初始化并通过验证。")).ok).toBe(true);
    const restartedCtrl = createSessionController({ workspaceRoot: tmpWs, homeBaseDir: tmpHome });
    expect(restartedCtrl.getDiff().totalSnapshots).toBe(1);
    const resumed = restartedCtrl.resumeTurn("#1");
    expect(resumed.ok).toBe(true);
    expect(resumed.recapText).toContain("未撤回的文件修改");
    // 验证模型在下一轮通过内置工具 rollback_version 回退上一轮快照时，磁盘 snapshots.json 同步清空且不复活
    const toolRollbackCtrl = createSessionController({
      workspaceRoot: tmpWs,
      homeBaseDir: tmpHome,
      provider: {
        async chat(msgs) {
          if (msgs[msgs.length - 1]?.role === "tool") return { role: "assistant", content: "已通过工具回退" };
          return {
            role: "assistant",
            content: "调用回退工具",
            toolCalls: [{ id: "c_rb_tool", name: "rollback_version", arguments: { stepsBack: 1 } }],
          };
        },
      },
    });
    await toolRollbackCtrl.ask("把刚才改的回退掉", { suppressFinalEcho: true, onApprovalRequest: () => ({ approved: true }) });
    expect(toolRollbackCtrl.getDiff().totalSnapshots).toBe(0);
    expect(fs.readFileSync(path.join(tmpWs, "index.html"), "utf-8")).toContain("<title>旧标题</title>");

    fs.rmSync(tmpWs, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("6. 三级沙箱与提权闭环：子进程环境变量脱敏、主目录隐私/printenv 硬拦截、跨目录显式提权与会话重置", async () => {
    const { isReadonlyBashCommand } = await import("../src/adapters/ui-logger.js");
    const { analyzeBashSandbox, createSandboxGrants, sanitizeSubprocessEnv } = await import("../src/adapters/sandbox-policy.js");

    // 1. 子进程敏感环境变量脱敏
    const scrubbed = sanitizeSubprocessEnv({
      PATH: "/usr/bin",
      HOME: "/Users/test",
      MIMO_API_KEY: "sk-mimo-secret",
      DEEPSEEK_API_KEY: "sk-ds-secret",
      OPENAI_API_KEY: "sk-oa-secret",
      ANTIGRAVITY_CSRF_TOKEN: "csrf-123",
      CUSTOM_SECRET_TOKEN: "tok-999",
    });
    expect(scrubbed.PATH).toBe("/usr/bin");
    expect(scrubbed.MIMO_API_KEY).toBeUndefined();
    expect(scrubbed.DEEPSEEK_API_KEY).toBeUndefined();
    expect(scrubbed.OPENAI_API_KEY).toBeUndefined();
    expect(scrubbed.ANTIGRAVITY_CSRF_TOKEN).toBeUndefined();
    expect(scrubbed.CUSTOM_SECRET_TOKEN).toBeUndefined();

    // 2. 只读判定与 Hard Deny 拦截
    expect(isReadonlyBashCommand("printenv", true)).toBe(false);
    expect(isReadonlyBashCommand("env", true)).toBe(false);
    expect(isReadonlyBashCommand("printenv PATH", true)).toBe(true);
    expect(isReadonlyBashCommand("ls -a ~", true)).toBe(false);
    expect(isReadonlyBashCommand("cat ~/.claude.json", true)).toBe(false);
    expect(isReadonlyBashCommand("cat ~/.codex/config.toml", true)).toBe(false);
    expect(isReadonlyBashCommand("cat ./../../.claude.json", true)).toBe(false);
    expect(isReadonlyBashCommand("cd ~ && ls -la", true)).toBe(false);

    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "duo-sandbox-tier-"));
    const wsA = path.join(tmpBase, "project-a");
    const wsSibling = path.join(tmpBase, "shared-lib");
    fs.mkdirSync(wsA, { recursive: true });
    fs.mkdirSync(wsSibling, { recursive: true });
    fs.writeFileSync(path.join(wsSibling, "config.json"), '{"port":8080}\n', "utf-8");

    expect(analyzeBashSandbox("printenv ; ls -a ~", wsA).tier).toBe("deny");
    expect(analyzeBashSandbox("cat ~/.claude.json", wsA).tier).toBe("deny");
    expect(analyzeBashSandbox("cat ./../../other-dir/secret.txt", wsA).tier).toBe("ask_escalated");
    expect(analyzeBashSandbox(`cat "${path.join(wsSibling, "config.json")}"`, wsA).tier).toBe("ask_escalated");

    // 验证即使用户信任了 $HOME 父级，checkHardDeniedPath 依然锁死 ~/.claude.json
    const { toGrantDir } = await import("../src/adapters/sandbox-policy.js");
    expect(toGrantDir(path.join(os.homedir(), "notes.txt"))).toBe(path.join(os.homedir(), "notes.txt"));
    const testGrants = createSandboxGrants();
    testGrants.trustedReadDirs.add(os.homedir());
    expect(() => resolveSafePath(wsA, "~/.claude.json", "read", testGrants)).toThrow(/禁止访问/);

    // 验证跨目录单次授权 (onceAllowedPaths) 编辑外部文件并在结束后清空单次授权时，/undo 与 /redo 仍可正常回滚恢复该外部快照
    const { rollbackFileSnapshots, redoFileSnapshots } = await import("../src/adapters/write-tools.js");
    const extSnaps: any[] = [];
    const extRedoBatches: any[][] = [];
    const onceGrants = createSandboxGrants();
    const extTarget = path.join(wsSibling, "config.json");
    onceGrants.onceAllowedPaths.add(fs.realpathSync(extTarget));
    const [editExtTool] = createWriteTools(wsA, extSnaps, undefined, undefined, onceGrants);
    await editExtTool!.execute({ path: "../shared-lib/config.json", oldText: "8080", newText: "9090" });
    onceGrants.onceAllowedPaths.clear(); // 模拟单轮结束清空单次授权
    expect(fs.readFileSync(extTarget, "utf-8")).toContain("9090");
    await rollbackFileSnapshots(wsA, extSnaps, 1, undefined, extRedoBatches);
    expect(fs.readFileSync(extTarget, "utf-8")).toContain("8080");
    redoFileSnapshots(wsA, extSnaps, extRedoBatches, 1);
    expect(fs.readFileSync(extTarget, "utf-8")).toContain("9090");
    await rollbackFileSnapshots(wsA, extSnaps, 1);

    // 3. Agent 会话中：Hard Deny 0 弹窗拦截 + 跨目录 read_file 触发 ask_escalated 提权并支持 trustDirectory 会话级信任
    const grants = createSandboxGrants();
    let approvalCalls = 0;
    let lastEscalated = false;
    const replies: AssistantMessage[] = [
      {
        role: "assistant",
        content: "先尝试偷看环境变量和主目录",
        toolCalls: [{ id: "c_deny_1", name: "run_bash", arguments: { command: "printenv ; ls -a ~" } }],
      },
      {
        role: "assistant",
        content: "申请读取兄弟项目的 config.json",
        toolCalls: [{ id: "c_esc_1", name: "read_file", arguments: { path: "../shared-lib/config.json" } }],
      },
      {
        role: "assistant",
        content: "再次读取已信任目录的 config.json（本次应免弹窗）",
        toolCalls: [{ id: "c_esc_2", name: "read_file", arguments: { path: "../shared-lib/config.json" } }],
      },
      { role: "assistant", content: "已完成跨目录安全读取！" },
    ];
    let stepIdx = 0;
    const seenMessages: any[][] = [];
    const res = await runAgentSession("帮我连一下外部配置", {
      workspaceRoot: wsA,
      sandboxGrants: grants,
      enableWriteTools: true,
      suppressFinalEcho: true,
      provider: {
        async chat(msgs) {
          seenMessages.push(msgs);
          return replies[stepIdx++]!;
        },
      },
      onApprovalRequest: (_calls, meta) => {
        approvalCalls += 1;
        lastEscalated = Boolean(meta?.hasEscalated);
        return { approved: true, trustDirectory: true };
      },
    });

    expect(res.finalAnswer).toBe("已完成跨目录安全读取！");
    // 第 1 步 Hard Deny 直接静默拦截回传错误，未触发 onApprovalRequest；第 2 步触发 1 次提权；第 3 步因已信任目录免批通过
    expect(approvalCalls).toBe(1);
    expect(lastEscalated).toBe(true);
    const denyToolMsg = seenMessages[1]?.find((m) => m.role === "tool" && m.toolCallId === "c_deny_1");
    expect(denyToolMsg?.isError).toBe(true);
    expect(denyToolMsg?.content).toContain("[沙箱安全拦截]");
    const allowedToolMsg = seenMessages[3]?.find((m) => m.role === "tool" && m.toolCallId === "c_esc_2");
    expect(allowedToolMsg?.isError).toBe(false);
    expect(allowedToolMsg?.content).toContain('{"port":8080}');

    // 4. 重置授权（如 /cd 或 /new）后，外部目录权限立即清空
    grants.reset();
    expect(grants.trustedReadDirs.size).toBe(0);
    expect(() => resolveSafePath(wsA, "../shared-lib/config.json", "read", grants)).toThrow(/禁止访问/);

    // 5. 复合命令 printenv 敏感变量绕过拦截 + edit_file 相对缩进偏移容错与多重匹配行号定位 + 运行期 Steer 插话队列
    expect(analyzeBashSandbox("true && printenv DEEPSEEK_API_KEY", wsA).tier).toBe("deny");
    expect(analyzeBashSandbox("ls; printenv 'MIMO_API_KEY'", wsA).tier).toBe("deny");

    const indentFile = path.join(wsA, "indent.ts");
    fs.writeFileSync(indentFile, "function demo() {\n    if (ok) {\n      return 1;\n    }\n}\n", "utf-8");
    const [editTool] = createWriteTools(wsA);
    await editTool!.execute({
      path: "indent.ts",
      oldText: "if (ok) {\n  return 1;\n}",
      newText: "if (ok) {\n  return 2;\n}",
    });
    expect(fs.readFileSync(indentFile, "utf-8")).toBe("function demo() {\n    if (ok) {\n      return 2;\n    }\n}\n");

    fs.writeFileSync(indentFile, "const a = 1;\nconst x = 0;\nconst a = 1;\n", "utf-8");
    await expect(editTool!.execute({ path: "indent.ts", oldText: "const a = 1;", newText: "const a = 2;" })).rejects.toThrow(/位于第 1, 3 行/);

    let steerPulled = false;
    const steerSeen: any[][] = [];
    let sStep = 0;
    const steerReplies: any[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "s1", name: "list_dir", arguments: { path: "." } }] },
      { role: "assistant", content: "已收到插话并完成" },
    ];
    await runAgentSession("初始问题", {
      workspaceRoot: wsA,
      suppressFinalEcho: true,
      drainSteerMessages: () => {
        if (!steerPulled) { steerPulled = true; return ["请顺便检查端口 8080"]; }
        return [];
      },
      provider: { async chat(msgs) { steerSeen.push(msgs); return steerReplies[sStep++]!; } },
    });
    expect(steerSeen[1]?.some((m) => m.role === "user" && m.content.includes("请顺便检查端口 8080"))).toBe(true);

    // 6. COMPLETE 阶段消费末尾插话 + 连续重复工具错误防死磕提示
    let completeSteerPulled = false, cStep = 0;
    const cSeen: any[][] = [];
    const cReplies: any[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "e1", name: "read_file", arguments: { path: "no-such-file.ts" } }] },
      { role: "assistant", content: "", toolCalls: [{ id: "e2", name: "read_file", arguments: { path: "no-such-file.ts" } }] },
      { role: "assistant", content: "准备结束回答" },
      { role: "assistant", content: "已处理末尾插话并最终完成" },
    ];
    const cRes = await runAgentSession("测试连续报错与末尾插话", {
      workspaceRoot: wsA,
      suppressFinalEcho: true,
      drainSteerMessages: () => {
        if (cStep === 3 && !completeSteerPulled) { completeSteerPulled = true; return ["再补充一句总结"]; }
        return [];
      },
      provider: { async chat(msgs) { cSeen.push(msgs); return cReplies[cStep++]!; } },
    });
    expect(cRes.finalAnswer).toBe("已处理末尾插话并最终完成");
    const secondErrMsg = cSeen[2]?.find((m) => m.role === "tool" && m.toolCallId === "e2");
    expect(secondErrMsg?.content).toContain("[系统防卡死提示：该操作已连续 2 次出现相同报错");
    expect(cSeen[3]?.some((m) => m.role === "user" && m.content.includes("再补充一句总结"))).toBe(true);

    fs.rmSync(tmpBase, { recursive: true, force: true });
  });
});
