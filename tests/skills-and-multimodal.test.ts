import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { compactMessages, estimateMessagesChars, foldSingleMessage } from "../src/core/compactor.js";
import type { Message } from "../src/core/contracts.js";
import { buildBridgePrompt } from "../src/adapters/agy-bridge.js";
import { expandAtMentions, listWorkspaceFiles, parseShotCommandArgs, stripAttachedFiles } from "../src/adapters/context-mention.js";
import { buildDropdownItems } from "../src/adapters/dropdown.js";
import { handleSlashCommand, resolveApprovalInput, verifyGoalCompletion } from "../src/adapters/repl.js";
import { createRouterProvider, resolveActiveModelTarget, toOpenAiMessages } from "../src/adapters/router.js";
import { analyzeBashSandbox, classifyToolCallRisk, createSandboxGrants, isWriteToolCall } from "../src/adapters/sandbox-policy.js";
import { createSessionController } from "../src/adapters/session-controller.js";
import { discoverAvailableSkills, expandSkillSlashCommand, formatSkillsSystemIndex } from "../src/adapters/skill-loader.js";
import { compactWireLogEntry } from "../src/adapters/store.js";
import { createBuiltinTools, executeToolCalls } from "../src/adapters/tools.js";
import { tryExpandClipboardInLine } from "../src/adapters/vision-capture.js";

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

  it("2. 多模态 @图片 解析、轻量元数据体积估算、历史图片折叠与 OpenAI image_url 序列化", async () => {
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
      expect(contentArr[0]?.type).toBe("text");
      expect(contentArr[0]?.text).toContain("请看下 @.debug/shot.png 的导航栏");
      expect(contentArr[0]?.text).toContain('<attached_image path=".debug/shot.png" mime="image/png" />');
      expect(contentArr[1]?.type).toBe("image_url");
      expect(String(contentArr[1]?.image_url?.url)).toMatch(/^data:image\/png;base64,/);

      // read_file 原生读取图片（对齐 pi-mono read.ts & openai-completions.ts）
      const logoPath = path.join(tmpWs, "logo.png");
      fs.writeFileSync(logoPath, fakePng);
      const builtinTools = createBuiltinTools(tmpWs);
      const [toolImgRes] = await executeToolCalls([{ id: "call_img", name: "read_file", arguments: { path: "logo.png" } }], builtinTools);
      expect(toolImgRes?.content).toBe("Read image file [image/png] (120 KB)");
      expect(toolImgRes?.images).toEqual([{ path: "logo.png", mimeType: "image/png", byteSize: 120 * 1024 }]);

      // 1) 当模型调 read_file 读取了新图片 logo.png 时，toOpenAiMessages 在 tool 消息后自动追加合成 user image_url 消息
      const toolVisionMsgs = toOpenAiMessages(
        [
          { role: "user", content: "看下项目里的 logo.png" },
          { role: "assistant", content: "", toolCalls: [{ id: "call_img", name: "read_file", arguments: { path: "logo.png" } }] },
          toolImgRes!,
        ],
        tmpWs,
      );
      expect(toolVisionMsgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
      const syntheticUserContent = toolVisionMsgs[3]!.content as any[];
      expect(syntheticUserContent[0]).toEqual({ type: "text", text: "Attached image(s) from tool result:" });
      expect(syntheticUserContent[1]?.type).toBe("image_url");

      // 2) 当模型对本轮 user.images 已附带的图片重复调 read_file 时，seenTurnImages 自动去重，不重复追加合成 user 消息
      const [dupToolRes] = await executeToolCalls([{ id: "call_dup", name: "read_file", arguments: { path: ".debug/shot.png" } }], builtinTools);
      const dedupedMsgs = toOpenAiMessages(
        [
          userMsg,
          { role: "assistant", content: "", toolCalls: [{ id: "call_dup", name: "read_file", arguments: { path: ".debug/shot.png" } }] },
          dupToolRes!,
        ],
        tmpWs,
      );
      expect(dedupedMsgs.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);

      // 新会话第 1 轮 Step 2 (userMsg 位于 headPrefix[1]) 遇到大工具输出时，严禁把当轮图片折叠掉
      const newSessionStep2: Message[] = [
        { role: "system", content: "sys" },
        userMsg,
        { role: "assistant", content: "先看下文件", toolCalls: [{ id: "c0", name: "list_dir", arguments: { path: "." } }] },
        { role: "tool", toolCallId: "c0", name: "list_dir", content: "y".repeat(40_000), isError: false },
      ];
      const newSessCompacted = compactMessages(newSessionStep2, { maxTotalChars: 20_000, keepRecentMessages: 2 });
      expect(newSessCompacted[1]?.role).toBe("user");
      if (newSessCompacted[1]?.role === "user") {
        expect(newSessCompacted[1].images?.length).toBe(1);
      }

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

      const noVisionMsgs = toOpenAiMessages([userMsg], tmpWs, false);
      expect(typeof noVisionMsgs[0]?.content).toBe("string");
      expect(String(noVisionMsgs[0]?.content)).toContain('<attached_image path=".debug/shot.png"');

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

    // 验证：Finder 拖拽带空格/引号路径、@clipboard 剪贴板防覆盖哈希、外部单文件授权不污染父目录、/shot 智能参数、agy 桥接与首步失败回退 leafId
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duo-vision-ux-"));
    const wsDir = path.join(tmpRoot, "ws");
    const extDir = path.join(tmpRoot, "Desktop");
    const homeBase = path.join(tmpRoot, "home");
    const prevClipMock = process.env.DUO_MOCK_CLIPBOARD_IMAGE;
    try {
      fs.mkdirSync(path.join(wsDir, "src"), { recursive: true });
      fs.mkdirSync(extDir, { recursive: true });
      fs.writeFileSync(path.join(wsDir, "src", "my view.tsx"), "line1\nline2\nline3\nline4\n");

      const validPngA = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("IMAGE_A_DATA")]);
      const validPngB = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("IMAGE_B_DATA")]);
      const dragImgPath = path.join(extDir, "截屏 2026-10-26.png");
      const otherSecretPath = path.join(extDir, "passwords.txt");
      fs.writeFileSync(dragImgPath, validPngA);
      fs.writeFileSync(otherSecretPath, "secret");

      // (a) Finder 单引号拖拽路径 + @"带空格代码文件":行号切片 + 最小权限单文件授权（绝不污染 extDir 父目录）
      const grants = createSandboxGrants();
      const dragPrompt = `看看 '${dragImgPath}' 和 @"src/my view.tsx":2-3 的区别`;
      const expandedDrag = expandAtMentions(dragPrompt, wsDir, 300, grants);
      expect(expandedDrag.attachedImages.length).toBe(1);
      expect(expandedDrag.attachedImages[0]?.path).toBe(fs.realpathSync(dragImgPath));
      expect(expandedDrag.expandedPrompt).toContain('<attached_file path="src/my view.tsx" lines="2-3">');
      expect(expandedDrag.expandedPrompt).toContain("2: line2\n3: line3");
      expect(grants.trustedReadDirs.size).toBe(0);
      const siblingRisk = classifyToolCallRisk({ id: "t1", name: "read_file", arguments: { path: otherSecretPath } }, wsDir, new Map(), grants);
      expect(siblingRisk.tier).toBe("ask_escalated");

      // (b) 普通报错堆栈中的外部非图片路径绝不误判为拖拽文件
      const stackTracePrompt = `报错在 ${otherSecretPath}:12 请分析`;
      const expandedStack = expandAtMentions(stackTracePrompt, wsDir, 300, grants);
      expect(expandedStack.attachedPaths).toEqual([]);

      // (c) @clipboard 与 /paste 多轮防覆盖短哈希快照
      const mockClipFile = path.join(tmpRoot, "clip-src.png");
      fs.writeFileSync(mockClipFile, validPngA);
      process.env.DUO_MOCK_CLIPBOARD_IMAGE = mockClipFile;
      const clip1 = expandAtMentions("请分析 @clipboard 里的报错", wsDir);
      expect(clip1.attachedPaths).toEqual([".debug/clipboard.png"]);
      expect(clip1.attachedImages[0]?.path).toMatch(/^\.debug\/clipboard-[0-9a-f]{6}\.png$/);

      fs.writeFileSync(mockClipFile, validPngB);
      const clip2 = expandAtMentions("再看下 @clipboard 新图", wsDir);
      expect(clip2.attachedImages[0]?.path).not.toBe(clip1.attachedImages[0]?.path);
      expect(fs.existsSync(path.join(wsDir, clip1.attachedImages[0]!.path))).toBe(true);
      expect(fs.existsSync(path.join(wsDir, clip2.attachedImages[0]!.path))).toBe(true);

      // 验证终端按 Ctrl+V / Cmd+V (@clipboard ) 时直接在输入行展开为 @.debug/clipboard-xxxxxx.png 并展示就绪下拉条
      const ctrlVPasted = tryExpandClipboardInLine("", 0, wsDir, true);
      expect(ctrlVPasted?.line).toMatch(/^@\.debug\/clipboard-[0-9a-f]{6}\.png $/);
      const cmdVPasted = tryExpandClipboardInLine("@clipboard ", 11, wsDir, false);
      expect(cmdVPasted?.line).toMatch(/^@\.debug\/clipboard-[0-9a-f]{6}\.png $/);
      const pastedDropdown = buildDropdownItems(cmdVPasted!.line, wsDir, undefined, null, cmdVPasted!.cursor);
      expect(pastedDropdown[0]?.desc).toContain("已粘贴剪贴板截图");
      expect(pastedDropdown[0]?.expandOnly).toBe(false);
      const bareImgExpand = expandAtMentions(cmdVPasted!.line.trim(), wsDir);
      expect(bareImgExpand.expandedPrompt).toContain("请查看并分析这张截图");

      // (d) /shot 智能参数拆解与 stripAttachedFiles
      expect(parseShotCommandArgs("", wsDir)).toEqual({ openPreview: false, target: "", question: "" });
      expect(parseShotCommandArgs("--open localhost:5173 检查顶部间距", wsDir)).toEqual({
        openPreview: true,
        target: "http://localhost:5173",
        question: "检查顶部间距",
      });
      expect(parseShotCommandArgs("帮我看看页面留白够不够", wsDir)).toEqual({
        openPreview: false,
        target: "",
        question: "帮我看看页面留白够不够",
      });
      expect(stripAttachedFiles("[已折叠历史图片 @.debug/shot.png (120 KB)]")).toBe("[引用文件: @.debug/shot.png]");
      expect(stripAttachedFiles('[已折叠历史引用文件 @src/my view.tsx (原长 1200 字)]')).toBe("[引用文件: @src/my view.tsx]");

      // (e) /model agy 桥接提示词显式注入视觉图片绝对路径
      const bridgePrompt = buildBridgePrompt(
        [{ role: "user", content: "看图", images: [{ path: ".debug/shot.png", mimeType: "image/png", byteSize: 100 }] }],
        [],
        wsDir,
      );
      expect(bridgePrompt).toContain(`[用户附加视觉图片: ${path.join(wsDir, ".debug/shot.png")}]`);
      expect(bridgePrompt).toContain("多模态特例");

      // (f) 首步视觉报错或网络失败时自动回退 leafId，严防孤立 user 节点锁死会话后续纯文本轮次
      let callCount = 0;
      const ctrl = createSessionController({
        workspaceRoot: wsDir,
        homeBaseDir: homeBase,
        provider: {
          async chat(msgs) {
            callCount++;
            if (msgs.some((m) => m.role === "user" && m.images?.length)) {
              throw new Error("当前会话包含未折叠的图片附件，但 DeepSeek 官方接口不支持视觉输入");
            }
            return { role: "assistant", content: "纯文本正常回复" };
          },
        },
      });
      const pasteRewrite = await handleSlashCommand("/paste 看看这张剪贴板图", ctrl);
      expect(typeof pasteRewrite).toBe("string");
      await expect(ctrl.ask(String(pasteRewrite))).rejects.toThrow(/不支持视觉输入/);
      const followUp = await ctrl.ask("那先帮我写段普通文字");
      expect(followUp.finalAnswer).toBe("纯文本正常回复");
      expect(callCount).toBe(2);
    } finally {
      if (prevClipMock === undefined) delete process.env.DUO_MOCK_CLIPBOARD_IMAGE;
      else process.env.DUO_MOCK_CLIPBOARD_IMAGE = prevClipMock;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
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

    // 工作区内连跳子目录与子 Shell ((cd backend && ...) && (cd frontend && ...)) 及 cwd 参数严禁误报越界
    const multiSubdirCmd = 'export PATH="/opt/homebrew/bin:$PATH" && cd backend && go build -o zhiku-server . && ./zhiku-server --self-test && cd ../frontend && pnpm build';
    expect(analyzeBashSandbox(multiSubdirCmd, ws).tier).toBe("ask_workspace");
    expect(analyzeBashSandbox("(cd backend && go build .) && (cd frontend && pnpm build)", ws).tier).toBe("ask_workspace");
    expect(analyzeBashSandbox("cd src && ls && cd -", ws).tier).toBe("allow");
    expect(classifyToolCallRisk({ id: "c1", name: "run_bash", arguments: { command: "cat ../package.json && cd ../tests && ls", cwd: "src" } }, ws, new Map()).tier).toBe("allow");
    expect(isWriteToolCall({ id: "c1", name: "run_bash", arguments: { command: "cat ../package.json && cd ../tests && ls", cwd: "src" } }, ws, new Map())).toBe(false);
    expect(classifyToolCallRisk({ id: "c2", name: "run_bash", arguments: { command: "ls", cwd: "../outside-dir" } }, ws, new Map()).tier).toBe("ask_escalated");
    expect(classifyToolCallRisk({ id: "c3", name: "run_bash", arguments: { command: "ls", cwd: "~/.ssh" } }, ws, new Map()).tier).toBe("deny");
    // 真实连跳逃逸工作区 (cd backend && cd ../../outside) 与分号虚假 cd 抵消 .. 仍必须拦截提权
    expect(analyzeBashSandbox("cd backend && cd ../../outside && ls", ws).tier).toBe("ask_escalated");
    expect(analyzeBashSandbox("cd non_existent_1/non_existent_2 ; cat ../outside_secret.txt", ws).tier).toBe("ask_escalated");
    // 借 cd 进主目录读取敏感凭据或 echo + 换行拼接敏感路径必须硬拦截
    expect(analyzeBashSandbox("cd ~ && cat .ssh/id_rsa", ws).tier).toBe("deny");
    expect(analyzeBashSandbox("echo checking\ncat ~/.ssh/id_rsa", ws).tier).toBe("deny");

    // 提权与普通模式下统一支持 a (及 t 别名)，未知单字母返回 invalid 拦截，中文修改意见正常返回 revise
    expect(resolveApprovalInput("a", true, true)).toEqual({ kind: "approve", autoApprove: true, trustDirectory: true });
    expect(resolveApprovalInput("t", true, true)).toEqual({ kind: "approve", autoApprove: true, trustDirectory: true });
    expect(resolveApprovalInput("a", false, false)).toEqual({ kind: "approve", autoApprove: true, trustDirectory: false });
    expect(resolveApprovalInput("x", true, true).kind).toBe("invalid");
    const rev = resolveApprovalInput("背景改成纯黑色，红色只做点缀", true, true);
    expect(rev.kind).toBe("revise");
  });

  it("8. 竞品能力对齐：shell-quote 多行/Glob 沙箱、run_bash 保尾截断落盘、edit_file BOM/局部模糊匹配/互斥锁、.gitignore 过滤与 <context_archive>", async () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "duo-comp-cap-"));
    try {
      // 1) A1: shell-quote 多行换行 cd 连跳不误报越界 + $HOME/.ssh/* 敏感路径硬拦截
      fs.mkdirSync(path.join(tmpWs, "backend"), { recursive: true });
      fs.mkdirSync(path.join(tmpWs, "frontend"), { recursive: true });
      const multiLineBuildCmd = 'export PATH="/opt/homebrew/bin:$PATH"\ncd backend\ngo build -o zhiku-server .\n./zhiku-server --self-test\ncd ../frontend\npnpm build && echo "ALL_STAGE2_CHECKS_PASSED"';
      expect(analyzeBashSandbox(multiLineBuildCmd, tmpWs).tier).toBe("ask_workspace");
      expect(analyzeBashSandbox("cat $HOME/.ssh/*", tmpWs).tier).toBe("deny");
      expect(analyzeBashSandbox('cat "$HOME/.aws/credentials"', tmpWs).tier).toBe("deny");

      // 2) B1: runCommandInSandbox 超长输出保尾截断 + 完整日志落盘 + 三处沙箱白名单免确认放行
      const { runCommandInSandbox, createWriteTools, withFileMutationQueue } = await import("../src/adapters/write-tools.js");
      const longRes = await runCommandInSandbox(
        'node -e \'for(let i=1;i<=300;i++) console.log("LINE_"+i+"_"+"x".repeat(40)); console.log("FINAL_TAIL_ERROR_MARKER");\'',
        tmpWs,
        10_000,
        undefined,
        "workspace_write",
        tmpWs,
      );
      expect(longRes.output).toContain("LINE_1_");
      expect(longRes.output).toContain("FINAL_TAIL_ERROR_MARKER");
      const logMatch = longRes.output.match(/完整日志已保存至 ([^\s，,]+\.log)/);
      expect(logMatch?.[1]).toBeTruthy();
      const logFile = logMatch![1]!;
      expect(fs.existsSync(logFile)).toBe(true);
      expect(classifyToolCallRisk({ id: "r1", name: "read_file", arguments: { path: logFile } }, tmpWs, new Map()).tier).toBe("allow");
      expect(analyzeBashSandbox(`grep FINAL_TAIL_ERROR_MARKER "${logFile}"`, tmpWs).tier).toBe("allow");

      // 3) B2: edit_file UTF-8 BOM 保留 + 第 5 级 Unicode 局部窗口模糊匹配（不破坏未修改行中文弯引号）+ 同文件互斥锁
      const writeTools = createWriteTools(tmpWs, []);
      const editTool = writeTools.find((t) => t.name === "edit_file")!;
      const bomFile = path.join(tmpWs, "bom-fuzzy.ts");
      fs.writeFileSync(bomFile, "\uFEFFconst untouched = “保持全角弯引号与——破折号”;\nexport const target = “旧状态” — 1;\n", "utf-8");
      await editTool.execute({
        path: "bom-fuzzy.ts",
        oldText: 'export const target = "旧状态" - 1;',
        newText: 'export const target = "新状态" - 2;',
      });
      const afterBom = fs.readFileSync(bomFile, "utf-8");
      expect(afterBom.startsWith("\uFEFF")).toBe(true);
      expect(afterBom).toContain("const untouched = “保持全角弯引号与——破折号”;");
      expect(afterBom).toContain('export const target = "新状态" - 2;');

      const order: number[] = [];
      await Promise.all([
        withFileMutationQueue(bomFile, async () => {
          await new Promise((r) => setTimeout(r, 15));
          order.push(1);
        }),
        withFileMutationQueue(bomFile, async () => {
          order.push(2);
        }),
      ]);
      expect(order).toEqual([1, 2]);

      // 4) A3 & B3: .gitignore 目录过滤 + macOS 窄空格截图文件名自适应读取
      fs.writeFileSync(path.join(tmpWs, ".gitignore"), "custom_build/\n*.gen.ts\n", "utf-8");
      fs.mkdirSync(path.join(tmpWs, "custom_build"), { recursive: true });
      fs.writeFileSync(path.join(tmpWs, "custom_build", "bundle.js"), "console.log('ignored');", "utf-8");
      fs.writeFileSync(path.join(tmpWs, "Screen Shot 2026-10-29 at 10.00.00\u202FAM.txt"), "narrow_space_ok", "utf-8");
      const builtin = createBuiltinTools(tmpWs);
      const listOut = String(await builtin.find((t) => t.name === "list_dir")!.execute({ path: "." }));
      expect(listOut).toContain("custom_build/");
      expect(listOut).toContain("[已过滤忽略目录");
      const readOut = String(await builtin.find((t) => t.name === "read_file")!.execute({ path: "Screen Shot 2026-10-29 at 10.00.00 AM.txt" }));
      expect(readOut).toContain("narrow_space_ok");

      // 5) B4: compactMessages 极限水位淘汰早期单元时生成 <context_archive> 且保持角色交替
      const longMsgs: Message[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "第一轮需求：初始化后端" },
        { role: "assistant", content: "读取并修改文件", toolCalls: [{ id: "tc1", name: "edit_file", arguments: { path: "backend/store.go", oldText: "", newText: "package main" } }] },
        { role: "tool", toolCallId: "tc1", name: "edit_file", content: "ok", isError: false },
        { role: "user", content: "第二轮需求：" + "A".repeat(1500) },
        { role: "assistant", content: "B".repeat(1500) },
        { role: "user", content: "第三轮当前需求" },
      ];
      const compacted = compactMessages(longMsgs, { maxTotalChars: 2600, keepRecentMessages: 2 });
      expect(JSON.stringify(compacted)).toContain("<context_archive");
      expect(JSON.stringify(compacted)).toContain("backend/store.go");
      for (let i = 1; i < compacted.length; i++) {
        expect(compacted[i]!.role === "user" && compacted[i - 1]!.role === "user").toBe(false);
      }

      // 6) B5: extractPlanSteps 与 formatPlanProgressBanner
      const { formatPlanProgressBanner } = await import("../src/adapters/plan-flow.js");
      const banner = formatPlanProgressBanner("Plan:\n1. 创建 `backend/store.go`\n2. 创建 `frontend/src/App.tsx`", ["backend/store.go"]);
      expect(banner).toContain("1/2");
      expect(banner).toContain("☑ 1.");
      expect(banner).toContain("☐ 2.");
    } finally {
      fs.rmSync(tmpWs, { recursive: true, force: true });
    }
  });
});
