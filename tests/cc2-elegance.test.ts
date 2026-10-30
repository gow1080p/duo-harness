import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentSession } from "../src/adapters/cli.js";
import { scanArchitectureViolations } from "../src/adapters/reviewer.js";
import { createSessionController } from "../src/adapters/session-controller.js";
import { createBuiltinTools } from "../src/adapters/tools.js";
import { createWriteTools, killTrackedChildren } from "../src/adapters/write-tools.js";

describe("Claude Code 2.0 极简增强闭环验证 (background bash + leafId rewind + updatedCalls)", () => {
  it("1. run_bash(background: true): 常驻服务首屏快速返回、后续写日志零 SIGPIPE、read_file 免审读取日志与 killTrackedChildren 清剿", async () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "duo-cc2-bg-"));
    try {
      const writeTools = createWriteTools(tmpWs);
      const [readFileTool] = createBuiltinTools(tmpWs);
      const runBashTool = writeTools.find((t) => t.name === "run_bash")!;

      const t0 = Date.now();
      const out = (await runBashTool.execute({
        command: `node -e "console.log('READY_PORT=5173'); setInterval(() => console.log('TICK=' + Date.now()), 200)"`,
        background: true,
      })) as string;
      const elapsed = Date.now() - t0;

      expect(elapsed).toBeLessThan(3_500);
      expect(out).toContain("[后台服务已启动: PID=");
      expect(out).toContain("READY_PORT=5173");

      const pidMatch = out.match(/PID=(\d+)/);
      const logMatch = out.match(/实时日志:\s*(\S+\.log)/);
      const bgPid = Number(pidMatch?.[1] ?? 0);
      const bgLogPath = logMatch?.[1] ?? "";
      expect(bgPid).toBeGreaterThan(0);
      expect(bgLogPath).toContain("duo-bash-bg-");

      // 等待 500ms 验证脱离后子进程继续输出 TICK 不会触发 SIGPIPE 崩溃，且日志持续追加
      await new Promise((r) => setTimeout(r, 500));
      process.kill(bgPid, 0);

      const logContent = (await readFileTool!.execute({ path: bgLogPath })) as string;
      expect(logContent).toContain("READY_PORT=5173");
      expect(logContent).toContain("TICK=");

      killTrackedChildren();
      await new Promise((r) => setTimeout(r, 150));
      expect(() => process.kill(bgPid, 0)).toThrow();
    } finally {
      killTrackedChildren();
      fs.rmSync(tmpWs, { recursive: true, force: true });
    }
  });

  it("2. 快照绑定 leafId 与 /undo #N、/resume #N --code 精准回滚（含 #99 越界防护与默认兼容）", async () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "duo-cc2-rewind-ws-"));
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "duo-cc2-rewind-home-"));
    const targetFile = path.join(tmpWs, "app.ts");
    fs.writeFileSync(targetFile, "export const step = 0;\n", "utf-8");

    try {
      let turnCall = 0;
      const ctrl = createSessionController({
        workspaceRoot: tmpWs,
        homeBaseDir: tmpHome,
        provider: {
          async chat(msgs) {
            const last = msgs[msgs.length - 1];
            if (last?.role === "tool") return { role: "assistant", content: `已完成第 ${turnCall} 轮修改` };
            turnCall++;
            return {
              role: "assistant",
              content: `执行第 ${turnCall} 轮修改`,
              toolCalls: [
                {
                  id: `edit_${turnCall}`,
                  name: "edit_file",
                  arguments: {
                    path: "app.ts",
                    oldText: `export const step = ${turnCall - 1};`,
                    newText: `export const step = ${turnCall};`,
                  },
                },
              ],
            };
          },
        },
      });

      const r1 = await ctrl.ask("第 1 轮修改", { suppressFinalEcho: true, onApprovalRequest: () => ({ approved: true }) });
      const r2 = await ctrl.ask("第 2 轮修改", { suppressFinalEcho: true, onApprovalRequest: () => ({ approved: true }) });
      const r3 = await ctrl.ask("第 3 轮修改", { suppressFinalEcho: true, onApprovalRequest: () => ({ approved: true }) });
      expect(r1.leafId).toBeTruthy();
      expect(r2.leafId).toBeTruthy();
      expect(r3.leafId).toBeTruthy();
      expect(fs.readFileSync(targetFile, "utf-8")).toContain("step = 3;");

      // 1) 越界轮次号 /undo #99 严禁误回滚任何快照
      const badUndo = await ctrl.undo("#99");
      expect(badUndo.rolledBackCount).toBe(0);
      expect(fs.readFileSync(targetFile, "utf-8")).toContain("step = 3;");

      // 2) 默认 resumeTurn("#1") 仅切对话分支，保持磁盘 step = 3 不变并提示未撤回修改
      const resDefault = ctrl.resumeTurn("#1");
      expect(resDefault.ok).toBe(true);
      expect(resDefault.recapText).toContain("未撤回的文件修改");
      expect(fs.readFileSync(targetFile, "utf-8")).toContain("step = 3;");

      // 3) 带 --code 的 resumeTurn("#1 --code") 将第 #2、#3 轮的代码修改精准回退，保留第 #1 轮的 step = 1
      ctrl.resumeTurn("#3");
      const resWithCode = ctrl.resumeTurn("#1 --code");
      expect(resWithCode.ok).toBe(true);
      expect(resWithCode.recapText).toContain("已同步将工作区代码回滚至该轮结束状态");
      expect(fs.readFileSync(targetFile, "utf-8")).toContain("step = 1;");

      // 4) redo 恢复后，直接调用 undo("#2") 精准回退到第 #2 轮结束时的 step = 2
      await ctrl.redo("turn");
      expect(fs.readFileSync(targetFile, "utf-8")).toContain("step = 3;");
      const undoTo2 = await ctrl.undo("#2");
      expect(undoTo2.rolledBackCount).toBe(1);
      expect(fs.readFileSync(targetFile, "utf-8")).toContain("step = 2;");
    } finally {
      fs.rmSync(tmpWs, { recursive: true, force: true });
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("3. onApprovalRequest 支持 updatedCalls 原地改参（保留同批次免审工具 + 二次风控拦截 hasDenied）", async () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "duo-cc2-approve-"));
    fs.writeFileSync(path.join(tmpWs, "note.txt"), "initial\n", "utf-8");
    try {
      let step = 0;
      const res = await runAgentSession("先读文件再改文件", {
        workspaceRoot: tmpWs,
        enableWriteTools: true,
        quiet: true,
        provider: {
          async chat(msgs) {
            step++;
            if (step === 1) {
              return {
                role: "assistant",
                content: "并发读和写",
                toolCalls: [
                  { id: "c_read", name: "read_file", arguments: { path: "note.txt" } },
                  { id: "c_edit", name: "edit_file", arguments: { path: "note.txt", oldText: "initial", newText: "raw_draft" } },
                ],
              };
            }
            const toolOutputs = msgs.filter((m) => m.role === "tool").map((m) => m.content).join(" | ");
            return { role: "assistant", content: `结果: ${toolOutputs}` };
          },
        },
        onApprovalRequest(calls) {
          expect(calls).toHaveLength(1);
          expect(calls[0]!.id).toBe("c_edit");
          return {
            approved: true,
            updatedCalls: [
              { id: "c_edit", name: "edit_file", arguments: { path: "note.txt", oldText: "initial", newText: "patched_by_hook" } },
            ],
          };
        },
      });

      expect(res.finalAnswer).toContain("initial");
      expect(fs.readFileSync(path.join(tmpWs, "note.txt"), "utf-8")).toBe("patched_by_hook\n");

      // 验证若 updatedCalls 被篡改为 printenv 高危命令，二次风控会立即拦截
      let step2 = 0;
      const blockedRes = await runAgentSession("测试改参风控", {
        workspaceRoot: tmpWs,
        enableWriteTools: true,
        quiet: true,
        provider: {
          async chat(msgs) {
            step2++;
            if (step2 === 1) {
              return {
                role: "assistant",
                content: "执行命令",
                toolCalls: [{ id: "c_bash", name: "run_bash", arguments: { command: "echo safe", readonly: false } }],
              };
            }
            return { role: "assistant", content: msgs[msgs.length - 1]!.content };
          },
        },
        onApprovalRequest() {
          return {
            approved: true,
            updatedCalls: [{ id: "c_bash", name: "run_bash", arguments: { command: "printenv" } }],
          };
        },
      });
      expect(blockedRes.finalAnswer).toContain("审批改参触发安全红线");
    } finally {
      fs.rmSync(tmpWs, { recursive: true, force: true });
    }
  });

  it("4. 架构体积与单函数行数预算守恒（修改文件均 <= 350 行且 runCommandInSandbox <= 80 行）", async () => {
    const violations = await scanArchitectureViolations(process.cwd(), [
      "src/adapters/bash-tool.ts",
      "src/adapters/sandbox-policy.ts",
      "src/adapters/bash-policy.ts",
      "src/adapters/write-tools.ts",
      "src/adapters/session-controller.ts",
      "src/adapters/cli.ts",
    ]);
    expect(violations).toEqual([]);
    const bashSrc = fs.readFileSync(path.resolve(process.cwd(), "src/adapters/bash-tool.ts"), "utf-8").split("\n");
    const fnStart = bashSrc.findIndex((l) => l.startsWith("export function runCommandInSandbox("));
    const fnEnd = bashSrc.findIndex((l, idx) => idx > fnStart && l === "}");
    expect(fnEnd - fnStart + 1).toBeLessThanOrEqual(80);
  });
});
