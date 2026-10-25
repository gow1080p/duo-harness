import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { compactMessages, estimateMessagesChars, foldSingleMessage } from "../src/core/compactor.js";
import type { Message } from "../src/core/contracts.js";
import { expandAtMentions, listWorkspaceFiles } from "../src/adapters/context-mention.js";
import { buildDropdownItems } from "../src/adapters/dropdown.js";
import { resolveApprovalInput, verifyGoalCompletion } from "../src/adapters/repl.js";
import { createRouterProvider, resolveActiveModelTarget, toOpenAiMessages } from "../src/adapters/router.js";
import { analyzeBashSandbox } from "../src/adapters/sandbox-policy.js";
import { discoverAvailableSkills, expandSkillSlashCommand, formatSkillsSystemIndex } from "../src/adapters/skill-loader.js";
import { compactWireLogEntry } from "../src/adapters/store.js";

describe("Custom SKILL.md Lazy-Loading & Multimodal Image Input", () => {
  it("1. SKILL.md 扫描、同名优先级覆盖、<skills> 极简索引与 /skill 下拉指令展开", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duo-skills-test-"));
    const wsDir = path.join(tmpRoot, "workspace");
    const homeDir = path.join(tmpRoot, "home");
    try {
      const wsSkillDir = path.join(wsDir, "skills", "custom-audit");
      const globalSkillDir = path.join(homeDir, ".codex", "skills", "custom-audit");
      const globalUiDir = path.join(homeDir, ".codex", "skills", "ui-craft");
      fs.mkdirSync(wsSkillDir, { recursive: true });
      fs.mkdirSync(globalSkillDir, { recursive: true });
      fs.mkdirSync(globalUiDir, { recursive: true });

      fs.writeFileSync(
        path.join(wsSkillDir, "SKILL.md"),
        "---\nname: custom-audit\ndescription: |\n  工作区覆盖版安全审计规范\n  DO NOT trigger for: 普通问答\n---\n# 正文内容\n",
      );
      fs.writeFileSync(
        path.join(globalSkillDir, "SKILL.md"),
        "---\nname: custom-audit\ndescription: 全局版安全审计规范\n---\n",
      );
      fs.writeFileSync(
        path.join(globalUiDir, "SKILL.md"),
        "---\nname: ui-craft\ndescription: 全场景高水准 UI 设计规范\n---\n",
      );

      const skills = discoverAvailableSkills(wsDir, homeDir);
      expect(skills.length).toBe(2);
      const custom = skills.find((s) => s.name === "custom-audit")!;
      expect(custom.scope).toBe("workspace");
      expect(custom.description).toContain("工作区覆盖版安全审计规范");
      expect(custom.description).toContain("DO NOT trigger for");

      const indexBlock = formatSkillsSystemIndex(skills);
      expect(indexBlock).toContain("<skills>");
      expect(indexBlock).toContain("- custom-audit:");
      expect(indexBlock).toContain("- ui-craft:");

      const dropdown = buildDropdownItems("/skill ui", wsDir, homeDir);
      const expanded = expandSkillSlashCommand("/skill custom-audit 检查登录模块", wsDir, homeDir);
      expect(expanded).toContain("请先调用 read_file 读取技能规范文件");
      expect(expanded).toContain("custom-audit/SKILL.md");
      expect(expanded).toContain("检查登录模块");
      expect(dropdown).toBeDefined();
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("2. 多模态 @图片 解析、轻量元数据体积估算、历史图片折叠与 OpenAI image_url 序列化", () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "duo-img-test-"));
    try {
      const debugDir = path.join(tmpWs, ".debug");
      fs.mkdirSync(debugDir, { recursive: true });
      const shotPath = path.join(debugDir, "shot.png");
      const fakePng = Buffer.alloc(120 * 1024, 0x41);
      fs.writeFileSync(shotPath, fakePng);

      const wsFiles = listWorkspaceFiles(tmpWs);
      expect(wsFiles).toContain(".debug/shot.png");

      const { expandedPrompt, attachedPaths, attachedImages } = expandAtMentions("请看下 @.debug/shot.png 的导航栏", tmpWs);
      expect(expandedPrompt).toBe("请看下 @.debug/shot.png 的导航栏");
      expect(attachedPaths).toEqual([".debug/shot.png"]);
      expect(attachedImages).toEqual([
        { path: ".debug/shot.png", mimeType: "image/png", byteSize: 120 * 1024 },
      ]);

      const userMsg: Message = {
        role: "user",
        content: expandedPrompt,
        images: attachedImages,
      };
      const estimated = estimateMessagesChars([userMsg]);
      expect(estimated).toBeGreaterThan(7_000);
      expect(estimated).toBeLessThan(9_000);

      const openAiMsgs = toOpenAiMessages([userMsg], tmpWs);
      expect(Array.isArray(openAiMsgs[0]?.content)).toBe(true);
      const contentArr = openAiMsgs[0]!.content as any[];
      expect(contentArr[0]).toEqual({ type: "text", text: "请看下 @.debug/shot.png 的导航栏" });
      expect(contentArr[1]?.type).toBe("image_url");
      expect(String(contentArr[1]?.image_url?.url)).toMatch(/^data:image\/png;base64,/);

      const compactedWire = compactWireLogEntry({
        roundTimestamp: new Date().toISOString(),
        apiUrl: "https://api.xiaomimimo.com/v1/chat/completions",
        requestBody: { model: "mimo-v2.6-pro", messages: openAiMsgs },
        rawSseLines: [],
        assembledMessage: { role: "assistant", content: "看清了" },
      });
      const wireImgUrl = (compactedWire.requestBody.messages as any[])[0].content[1].image_url.url;
      expect(wireImgUrl.length).toBeLessThan(120);
      expect(wireImgUrl).toContain("...[len=");

      const folded = foldSingleMessage(userMsg);
      expect(folded.role).toBe("user");
      if (folded.role === "user") {
        expect(folded.images).toBeUndefined();
        expect(folded.content).toContain("[已折叠历史图片 @.debug/shot.png (120 KB)]");
      }

      // 保护当前最新一轮 user 消息在 keepRecentMessages 窗口内不被折叠
      const turn1Step2: Message[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "第一轮历史提问" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "index.html" } }] },
        { role: "tool", toolCallId: "c1", name: "read_file", content: "x".repeat(30_000), isError: false },
        userMsg,
      ];
      const step2Compacted = compactMessages(turn1Step2, { maxTotalChars: 20_000, keepRecentMessages: 2 });
      const latestUser = step2Compacted[step2Compacted.length - 1];
      if (latestUser?.role === "user") {
        expect(latestUser.images?.length).toBe(1);
      }

      const history: Message[] = [
        { role: "system", content: "sys" },
        userMsg,
        { role: "assistant", content: "图1回复" },
        { role: "user", content: "第二轮普通文字追问" },
      ];
      const afterCompact = compactMessages(history, { maxTotalChars: 5_000, keepRecentMessages: 1 });
      const turn1User = afterCompact[1]!;
      expect(turn1User.role).toBe("user");
      if (turn1User.role === "user") {
        expect(turn1User.images).toBeUndefined();
        expect(turn1User.content).toContain("[已折叠历史图片 @.debug/shot.png (120 KB)]");
      }
    } finally {
      fs.rmSync(tmpWs, { recursive: true, force: true });
    }
  });

  it("3. 视觉路由与完成前验证门禁：带图片时拦截锁定 deepseek 且普通轮次不误伤短回答", async () => {
    expect(() => resolveActiveModelTarget(undefined, false, "deepseek", Date.now(), true)).toThrow(/不支持视觉输入/);

    const normalShort = await verifyGoalCompletion(os.tmpdir(), "接下来我将为您说明如何部署该服务。", undefined, false);
    expect(normalShort.ok).toBe(true);

    const goalShort = await verifyGoalCompletion(os.tmpdir(), "接下来我将开始修改文件。", undefined, true);
    expect(goalShort.ok).toBe(false);
  });

  it("4. reasoningContent 计入水位估算且不改写思考正文（保 KV 缓存）+ 零 Delta 退避重试与半途断流防重发", async () => {
    const msgsWithReasoning: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "第一轮提问" },
      { role: "assistant", content: "读文件", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.ts" } }] },
      { role: "tool", toolCallId: "c1", name: "read_file", content: "A".repeat(15_000), isError: false },
      { role: "user", content: "第二轮复杂 Skill 任务" },
      { role: "assistant", content: "思考后调工具", reasoningContent: "思".repeat(16_000), toolCalls: [{ id: "c2", name: "grep", arguments: { pattern: "W1" } }] },
      { role: "tool", toolCallId: "c2", name: "grep", content: "B".repeat(5_000), isError: false },
    ];
    expect(estimateMessagesChars(msgsWithReasoning)).toBeGreaterThan(36_000);
    // 进入下一轮 User 提问后，上一轮的 reasoningContent 不再随请求发送，因此自动从估算水位中剔除，不虚增水位
    const nextTurnMsgs: Message[] = [...msgsWithReasoning, { role: "assistant", content: "第二轮结束" }, { role: "user", content: "第三轮新问题" }];
    expect(estimateMessagesChars(nextTurnMsgs)).toBeLessThan(21_000);
    const compacted = compactMessages(msgsWithReasoning, { maxTotalChars: 30_000, keepRecentMessages: 3 });
    // 旧轮次 (c1) 的 15,000 字工具输出被及时折叠，而当前轮 (c2) 的 reasoningContent 原样保留不击穿 KV 缓存
    expect(compacted[3]?.content).toContain("[已折叠历史工具输出");
    const activeAssistant = compacted[5];
    expect(activeAssistant?.role === "assistant" && activeAssistant.reasoningContent?.length).toBe(16_000);
    // 进入下一轮 (nextTurnMsgs) 剔除旧轮 reasoningContent 后，前序已折叠的 c1 严禁反向解折复活（100% 保持跨轮前缀一致）
    const nextTurnCompacted = compactMessages(nextTurnMsgs, { maxTotalChars: 30_000, keepRecentMessages: 3 });
    expect(nextTurnCompacted.slice(0, compacted.length)).toEqual(compacted);

    // 验证真实长任务防失忆：当被拒 edit_file 与分段重写触发超水位时，优先折叠 edit_file 代码参数与无关文件，100% 保护正在改写的目标文件 read_file
    const rewriteTrace: Message[] = [
      { role: "system", content: "S".repeat(5_600) },
      { role: "user", content: "页面用 p5 风格重写" },
      { role: "assistant", content: "", toolCalls: [{ id: "r_skill", name: "read_file", arguments: { path: "SKILL.md" } }] },
      { role: "tool", toolCallId: "r_skill", name: "read_file", content: "K".repeat(10_000), isError: false },
      { role: "assistant", content: "", toolCalls: [{ id: "r_idx", name: "read_file", arguments: { path: "./index.html" } }] },
      { role: "tool", toolCallId: "r_idx", name: "read_file", content: "I".repeat(37_500), isError: false },
      { role: "assistant", content: "", toolCalls: [{ id: "r_pel", name: "read_file", arguments: { path: "van-gogh-pelican.html" } }] },
      { role: "tool", toolCallId: "r_pel", name: "read_file", content: "P".repeat(31_200), isError: false },
      { role: "assistant", content: "先改鹈鹕页面", reasoningContent: "R".repeat(15_300), toolCalls: [{ id: "e_pel", name: "edit_file", arguments: { path: "van-gogh-pelican.html", oldText: "", newText: "X".repeat(15_100) } }] },
      { role: "tool", toolCallId: "e_pel", name: "edit_file", content: "执行被拦截：用户退回了本次修改并要求按以下意见重新调整：「index.html页面」", isError: true },
      { role: "assistant", content: "改为重写 index.html 第一部分", reasoningContent: "T".repeat(16_000), toolCalls: [{ id: "e_idx1", name: "edit_file", arguments: { path: "index.html", oldText: "", newText: "N".repeat(25_700) } }] },
      { role: "tool", toolCallId: "e_idx1", name: "edit_file", content: "已写入文件: index.html (v30)", isError: false },
    ];
    const afterPart1 = compactMessages(rewriteTrace);
    // 1) 被拒绝的 van-gogh-pelican.html edit_file 代码参数与无关 read_file 被优先折叠，但用户的拦截反馈指令原样保留
    const rejectedAssist = afterPart1[8] as any;
    expect(rejectedAssist.toolCalls[0].arguments.newText).toContain("[已折叠历史代码片段");
    expect(afterPart1[9]?.content).toContain("用户退回了本次修改并要求按以下意见重新调整：「index.html页面」");
    expect(afterPart1[7]?.content).toContain("[已折叠历史工具输出");
    // 2) 正在改写的目标文件 index.html 的 read_file 原文 (37.5KB) 100% 完整保留，供下一步写 PART 2
    expect(afterPart1[5]?.content.length).toBe(37_500);
    // 3) 继续追加下一步时，前序已发出前缀 100% 零字节突变
    const afterNextGrep = compactMessages([
      ...rewriteTrace,
      { role: "assistant", content: "", toolCalls: [{ id: "g1", name: "grep", arguments: { pattern: "api/vault", path: "server.js" } }] },
      { role: "tool", toolCallId: "g1", name: "grep", content: "server.js:72: /api/vault", isError: false },
    ]);
    expect(afterNextGrep.slice(0, afterPart1.length)).toEqual(afterPart1);

    // 验证零 Delta 阶段 (502 -> 200) 自动退避重试成功，而流式已吐字中途断开绝不静默重发且写入错误 Wire 日志
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "duo-retry-test-"));
    const wireFile = path.join(tmpDir, "http-wire.json");
    const origFetch = globalThis.fetch;
    const prevKey = process.env.MIMO_API_KEY;
    process.env.MIMO_API_KEY = "tp-test-key";
    try {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        if (calls === 1) return new Response("Bad Gateway", { status: 502 });
        const enc = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"重试成功"}}]}\n\ndata: [DONE]\n\n'));
            ctrl.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch;

      const provider = createRouterProvider(wireFile, false, () => "mimo");
      const reply = await provider.chat([{ role: "user", content: "测试重试" }], []);
      expect(calls).toBe(2);
      expect(reply.content).toBe("重试成功");

      // 流式已吐出 delta 后中途抛错：禁止重试 (calls 仅 +1)，且失败记录写入 http-wire.json
      let midCalls = 0;
      globalThis.fetch = (async () => {
        midCalls += 1;
        const enc = new TextEncoder();
        let pulled = false;
        const stream = new ReadableStream<Uint8Array>({
          pull(ctrl) {
            if (!pulled) {
              pulled = true;
              ctrl.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"半截话"}}]}\n\n'));
            } else {
              ctrl.error(new Error("terminated: socket closed"));
            }
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch;

      const streamed: string[] = [];
      await expect(
        provider.chat([{ role: "user", content: "测试半途断流" }], [], {
          onStreamEvent: (e) => { if (e.type === "content_delta") streamed.push(e.text); },
        }),
      ).rejects.toThrow(/terminated/);
      expect(midCalls).toBe(1);
      expect(streamed).toEqual(["半截话"]);
      const wireEntries = JSON.parse(fs.readFileSync(wireFile, "utf-8"));
      expect(wireEntries[wireEntries.length - 1]?.rawSseLines?.[0]).toContain("[ERROR]");
    } finally {
      globalThis.fetch = origFetch;
      if (prevKey === undefined) delete process.env.MIMO_API_KEY;
      else process.env.MIMO_API_KEY = prevKey;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("5. 命令语义感知路径提取与统一 y/a/d/n 审批状态机（防 Windows grep 转义误报 D:/ 与防单字母误触退回 LLM）", () => {
    const ws = process.cwd();
    const p5GrepCmd =
      'curl -s http://localhost:4174/ | grep -o "data-art-lens=\\"p5\\"\\|p5-char\\|p5-frame\\|D90429\\|cubic-bezier(0.22, 1.45, 0.36, 1)\\|prefers-reduced-motion\\|tabular-nums" | sort | uniq -c';
    const res1 = analyzeBashSandbox(p5GrepCmd, ws);
    expect(res1.tier).toBe("allow");
    expect(res1.externalDirs).toEqual([]);

    const routeGrepCmd = 'grep "/api/users" src/index.ts';
    expect(analyzeBashSandbox(routeGrepCmd, ws).tier).toBe("allow");

    const shootCmd = `node "${path.join(os.homedir(), ".gemini/config/plugins/macos-agent-guard/skills/ui-craft/scripts/shoot.mjs")}" http://localhost:4174 --size desktop --out .oil-ui/p5-restyle/shots`;
    expect(analyzeBashSandbox(shootCmd, ws).tier).toBe("ask_workspace");

    // 通配符敏感路径与跨目录路径严禁绕过沙箱 (falsify 回归防线)
    expect(analyzeBashSandbox("cat ~/.ssh/*", ws).tier).toBe("deny");
    expect(analyzeBashSandbox("cat ~/.claude*", ws).tier).toBe("deny");
    expect(analyzeBashSandbox("cat ../outside-dir/*.json", ws).tier).toBe("ask_escalated");
    expect(analyzeBashSandbox("ls -la /", ws).tier).toBe("ask_escalated");

    // 提权与普通模式下统一支持 a (及 t 别名)，未知单字母返回 invalid 拦截，中文修改意见正常返回 revise
    expect(resolveApprovalInput("a", true, true)).toEqual({ kind: "approve", autoApprove: true, trustDirectory: true });
    expect(resolveApprovalInput("t", true, true)).toEqual({ kind: "approve", autoApprove: true, trustDirectory: true });
    expect(resolveApprovalInput("a", false, false)).toEqual({ kind: "approve", autoApprove: true, trustDirectory: false });
    expect(resolveApprovalInput("x", true, true).kind).toBe("invalid");
    const rev = resolveApprovalInput("背景改成纯黑色，红色只做点缀", true, true);
    expect(rev.kind).toBe("revise");
  });
});
