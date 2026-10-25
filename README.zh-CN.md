<div align="center">

# Duo-Harness (简体中文文档)

**零宿主绑定的轻量级 TypeScript Coding Agent 运行时与跨项目交互式 CLI**  
*470 行纯函数内核 (Functional Core) + 可插拔 I/O 外壳 (Imperative Shell) · `.jsonl` 分支会话树 · 0ms 离线回放 · KV 前缀缓存锁 · MCP 客户端*

**[🇬🇧 English](./README.md)** · **[🇨🇳 简体中文](./README.zh-CN.md)** · **[🗺️ 架构与模块预算](#架构与模块体积预算)**

</div>

---

## 为什么构建 `duo-harness`？

市面上的 AI 编程工具大多走向两个极端：要么与特定 IDE 客户端强绑定，要么被几万行重型黑盒框架层层包裹——一旦遇到 SSE 断流、工具配对报错或前缀缓存雪崩，开发者很难看清底层到底发生了什么。

**`duo-harness`** 是一个零黑盒框架依赖、100% 遵循行业开放标准（OpenAI Streaming / MCP JSON-RPC 2.0 / Append-only `.jsonl` 会话树）的轻量级 TypeScript Coding Agent 运行时与跨项目交互式 CLI（全库 `< 2,500 行`，运行时仅依赖 `zod`）：

- **494 行纯函数内核 (`src/core/`)**：零 `node:fs`、零 `fetch`、零 `child_process`、零厂商耦合。所有状态流转（`Idle -> Thinking -> AwaitingApproval -> Executing -> Done/Error`）、`.jsonl` 分支还原、中断悬空 `toolCalls` 自愈与 KV 前缀缓存折叠全部是 100% 确定性纯函数（单文件严格 $\le 250$ 行、单函数 $\le 80$ 行）。
- **零污染多项目交互终端 (`duo` / `pnpm chat`)**：对标 Claude Code、Codex CLI 与 `@mariozechner/pi-coding-agent`，可在电脑任意代码仓库直接启动交互编程与架构审查；所有项目的会话历史、文件修改快照（`snapshots.json`）与网络抓包统一集中存放在 `~/.duo-harness/projects/<项目名>-<哈希>/`，**绝不在目标仓库产生任何未跟踪文件污染 `git status`**。

---

## ✨ 核心特性

1. **🧅 纯函数状态机、直输意见审批框（HITL）与完成前自动验证打回 (`src/core/loop.ts`, `src/adapters/repl.ts`, `diff-presenter.ts`)**
   - 写文件或执行非只读命令前自动挂起等待人工确认（Human-in-the-Loop），同一步多个 `edit_file` 自动合并为 1 个审批框并按修改点展示 `-删除 / +新增` LCS 代码对比预览（支持 `y`=允许本次、`a`=本轮免问/信任目录、`d`=展开全部详情、`n`=拒绝，或**直接在审批框输入中文修改意见**如 `index.html页面` 让模型当场按意见重调工具）。
   - 内置 **写盘瞬间 `0ms` 语法自检**（自动校验 `.js/.mjs/.cjs/.json` 与 `.html` `<script>` 语法）与 **`/goal` 完成前自动验证门禁**（报错自动通过 `REJECT_COMPLETION` 打回模型继续修复，直至验证全绿）。
2. **🌳 `.jsonl` 分支会话树、半途强关自愈与 0 毫秒断网录像回放 (`src/core/session-tree.ts`, `src/adapters/store.ts`)**
   - 每条消息带 `id` 与 `parentId` 追加写入 `.jsonl`，支持 `/resume`（`↑/↓` 方向键选轮次切换历史）、`/new` 开启新对话、`/branch <节点id>` 切回任意历史节点开辟平行对话分支。
   - 内置 `repairDanglingToolCalls`，即使半途按 `Ctrl+C` 或关掉终端窗口，重启后也会自动补齐悬空的工具调用回执；内置 `ReplayProvider` 支持断网 0 毫秒重放历史对话。
3. **⚡ 会话粘性模型路由、目标感知型 KV 缓存压缩与多模态视觉输入 (`src/core/compactor.ts`, `src/adapters/router.ts`, `xray.ts`)**
   - 同会话自动锁定当前模型防止跨时段切换打碎前缀缓存，支持 `/model` 手动切换（`auto / deepseek / mimo / agy / openai`）、`@图片.png` 视觉多模态路由、零 Delta 阶段指数退避重试及反重力本地订阅额度探测。
   - **目标文件感知型 KV 前缀缓存压缩**：当上下文超水位时，优先折叠被拒/已落盘的历史 `edit_file` 代码参数与无关输出，**100% 保护当前正在改写的目标文件 `read_file` 原文与头部前缀字节不变**，兼顾 DeepSeek / Claude 64-Token 块级前缀缓存与长任务连续改码记忆。
   - 内置 `/xray` 诊断面板，实时展示每轮 HTTP 首包耗时、缓存命中 Token 占比、前缀改写取证与精确到分的费用账单。
4. **💻 多项目交互终端、`SKILL.md` 技能懒加载与命令语义三级沙箱 (`src/adapters/repl.ts`, `skill-loader.ts`, `sandbox-policy.ts`, `bash-policy.ts`)**
   - **零缓存击穿 `SKILL.md` 懒加载（`/skill` & `/skills`）**：自动扫描工作区（`./skills`、`./.agents/skills`、`./.claude/skills`）与全局（`~/.duo-harness/skills`、`~/.codex/skills`、`~/.gemini/antigravity/skills`、`~/.gemini/config/plugins/*/skills`，直接支持反重力 `ui-craft` 等官方技能），启动期静态注入 `<skills>` 极简索引，按需通过 `read_file` 懒加载正文。
   - **`/` 实时下拉选择菜单、`@文件/@图片` 引用与 `↑/↓` 交互**：输入 `/` 即在光标下方实时弹出命令菜单，支持用 `↑/↓` 键直接选择历史轮次（`/resume`）、技能（`/skill`）或模型（`/model`），输入 `@` 按 `Tab` 自动补全代码文件或截图路径。
   - **命令动词感知三级沙箱（`allow / ask_workspace / ask_escalated / deny`）**：精确区分文件操作命令与 `grep -o "..."` 正则参数（避免 Windows/Git-Bash 下转义引号与管道符误报 `D:/` 跨界），硬拦截 `~/.ssh` / `.env*` 等敏感凭据探测，并在 macOS 下启用 `sandbox-exec` 内核级只读沙箱。
5. **🛡️ 原子写盘、写穿快照（Write-Through）与多段 `/diff` + `/undo` + `/redo` (`src/adapters/tools.ts`, `write-tools.ts`, `diff-presenter.ts`)**
   - **POSIX 原子写盘（`Temp + Rename`）与单步实时落盘**：所有文件修改、回退与元数据存储统一采用同目录临时文件原子重命名（`writeFileAtomicSync`），每次 `edit_file` 或 `rollback_version` 当场刷新磁盘 `snapshots.json`，彻底杜绝半途断电或强关 CLI 导致文件变 `0 字节` 或丢失回退记录。
   - **大文件多段锚点 `/diff` 与整轮 `/undo` / `/redo`**：单步与轮末实时打印 `+新增 / -删除` Diffstat 清单；900+ 行大文件多处修改自动按未改动锚点切分多段 Hunk 预览；支持 `/undo` 与 `/redo` 撤回或重做修改，并在下一轮自动注入 `lastUndoNotice` 提醒模型。
   - 内置标准 `stdio` JSON-RPC 2.0 MCP 客户端（`src/adapters/mcp-client.ts`），可一键挂载任意第三方 MCP Server。
6. **🔍 自主探路代码审查特工与双端 HTTP/SSE 服务 (`src/adapters/reviewer.ts`, `rpc-server.ts`)**
   - 自动扫描全库导出符号生成 `RepoMap` 行号地图 + 静态架构红线检查 + 只读 Agent 自主跨文件追查 + Zod 结构化报告校验。
   - 原生 `node:http` 暴露 `/health`、`/status`、`/turns`、`/diff`、`/undo`、`/ask`、`/review` 接口，支持 JSON 与 `text/event-stream` (SSE) 实时流推送。

---

## 🚀 1 分钟快速上手

### 1. 安装依赖与运行离线验证（无需 API Key）

```bash
pnpm install
pnpm verify
```

### 2. 配置 API Key（`.env.local` 或环境变量）

在项目根目录创建 `.env.local`（已被 `.gitignore` 忽略），填入任一支持的大模型 API Key（原生支持 OpenAI / Codex、DeepSeek 与小米 MiMo 2.6）：

```ini
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
MIMO_API_KEY=tp-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 3. 启动交互式命令行（`pnpm chat` 或全局 `duo`）

```bash
pnpm chat

# 挂载为全局命令后，可在任意其他项目目录下直接运行：
pnpm link --global
cd /path/to/any-other-project && duo
```

在 `duo>` 交互式终端中，输入 `/` 即可弹出命令选择菜单，输入 `@` 按 `Tab` 可补全文件或图片：

| 快捷命令 / 输入 | 功能说明 |
| :--- | :--- |
| `/skill <名称> <任务>` | 懒加载工作区或全局 `SKILL.md` 技能执行任务（如 `/skill ui-craft 页面用p5风格重写`） |
| `/skills` | 查看当前已发现的所有项目级与全局 `SKILL.md` 技能列表 |
| `/goal <任务目标>` | 开启自主目标模式（完成前自动执行语法、构建与测试验证门禁，不通过自动打回重修） |
| `/resume` | 用 `↑/↓` 方向键选择历史轮次（`#1`、`#2`...）或切换会话继续追问 |
| `/new` | 开启全新对话（旧历史安全保留在 `.jsonl` 中，随时可 `/resume` 切回） |
| `/model` | 用 `↑/↓` 方向键切换模型策略（`auto / deepseek / mimo / agy / openai`） |
| `/diff [all\|full\|文件名]` | 查看未撤回的文件修改对比（`-删除 / +新增` 多段锚点预览与行数统计） |
| `/undo [turn\|N\|all]` | 撤回文件修改（`/undo` 撤回上一轮 \| `/undo N` 撤回 N 步 \| `/undo all` 全部撤回） |
| `/redo [turn\|N\|all]` | 重做恢复已撤回的文件修改 |
| `/compact` | 手动折叠历史超长工具输出、`@文件` 引用块与 `@图片` 附件，锁定精简缓存前缀 |
| `/open [文件\|URL]` | 使用系统默认浏览器或应用直接打开本地网页文件或 URL |
| `/cd <目录路径>` | 切换到电脑上的任意其他项目目录（敲 `/cd` 后可直接按 `↑/↓` 方向键选项目） |
| `/projects` | 查看所有已管理的项目列表、记录条数与路径 |
| `/xray` | 查看当前会话每轮耗时、缓存命中率、前缀突变取证、反重力订阅额度与费用账单 |
| `/history` | 查看当前项目所有历史问答列表 |
| `/branch <节点id>` | 从指定历史消息节点分叉开辟平行对话分支 |
| `/clear` | 彻底清空当前项目磁盘历史记录、抓包与快照 |
| `/exit` | 退出交互终端 |
| `@<文件或图片路径>` | 行内上下文引用：支持附带源码切片（`@src/index.ts:1-80`）或视觉截图（`@.debug/shot.png`） |

### 4. 单次提问、离线回放、自动代码审查与 HTTP/SSE 服务

```bash
pnpm play
pnpm ask "请读取 package.json 并总结项目结构"
pnpm ask --dir ../my-other-app "帮我检查 src 下有没有未处理的 Promise 异常"
pnpm review src/core/loop.ts
pnpm serve
```
