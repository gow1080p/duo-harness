<div align="center">

# Duo-Harness

**Zero-Host-Lock-in TypeScript Coding Agent Runtime & Multi-Project CLI**  
*Functional Core (470 LOC) + Imperative Shell · Branchable `.jsonl` Event Tree · 0ms Offline Replay · KV Prefix-Cache Compaction · MCP Client*

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.0.0-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7_Strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Runtime Deps](https://img.shields.io/badge/Dependencies-1_(zod)-brightgreen)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**[🇬🇧 English](#english)** · **[🇨🇳 简体中文](#简体中文)** ([独立中文文档](./README.zh-CN.md)) · **[🗺️ Architecture](#architecture--module-budget)**

</div>

---

<a id="english"></a>

## 🇬🇧 English

### Why `duo-harness`?

Most AI coding agents today suffer from two extremes: either they are locked inside proprietary IDE extensions, or they are buried under tens of thousands of lines of heavyweight framework abstractions where a single streaming timeout or context-compaction bug takes hours to trace.

**`duo-harness`** is an open-standard, zero-framework-lock-in TypeScript Coding Agent Harness built under strict **Functional Core, Imperative Shell** constraints (`< 2,500 LOC` total, `zod` as the **only** runtime dependency):

- **494-Line Pure Functional Core (`src/core/`)**: Zero `node:fs`, zero `fetch`, zero `child_process`, and zero vendor-specific logic. Every state transition (`Idle -> Thinking -> AwaitingApproval -> Executing -> Done/Error`), `.jsonl` branch projection, dangling `toolCalls` self-healing, and KV-cache-preserving compaction is a 100% deterministic pure function ($\le 250$ lines per file, $\le 80$ lines per function).
- **Production-Ready Multi-Project CLI (`duo` / `pnpm chat`)**: Works across any repository on your machine like Claude Code, Codex CLI, or `@mariozechner/pi-coding-agent`—storing per-project `.jsonl` sessions, file snapshots (`snapshots.json`), and HTTP wire logs cleanly in `~/.duo-harness/projects/<name>-<hash8>/` with **zero untracked files polluting your target repo's `git status`**.

---

### ✨ Key Features

1. **🧅 Pure State Machine, Inline-Revision HITL Approval & Self-Verification Gate (`src/core/loop.ts`, `src/adapters/repl.ts`, `diff-presenter.ts`)**
   - Supports **Human-in-the-Loop (HITL)** suspension before executing mutating tools (`edit_file`, non-readonly `run_bash`), merging concurrent file edits into a single approval card with per-hunk `-removed / +added` LCS diff previews (`y`=allow once, `a`=auto-approve turn / trust directory, `d`=expand full diff, `n`=reject, or **type revision instructions directly at the prompt** to steer the model on the fly).
   - Built-in **Pre-Complete Verification Gate (`/goal`)** & **Write-Time AST/Syntax Guard**: every `edit_file` performs an instant `0ms` syntax check on `.js/.mjs/.cjs/.json/.html` (`<script>`), and `/goal` runs automated completion verification (`REJECT_COMPLETION` feeds errors back into the loop until all checks pass).
2. **🌳 Append-Only `.jsonl` Session Tree, Crash Auto-Heal & 0ms Offline Replay (`src/core/session-tree.ts`, `src/adapters/store.ts`)**
   - Every message is stored as a tree node with `id` and `parentId`. Switch historical turns with `/resume` (`↑/↓` arrow keys), start a fresh branch with `/new`, or fork from any message ID with `/branch <id>`.
   - Enforces strict 1:1 `toolCalls` $\leftrightarrow$ `toolResult` pairing (`assertSessionInvariant`) and automatically heals interrupted mid-turn tool calls (`repairDanglingToolCalls`) after unexpected crashes or `Ctrl+C`.
   - Includes `ReplayProvider` to replay multi-step tool-calling sessions offline in **0ms with zero API cost**.
3. **⚡ Sticky Multi-Model Router, Active-Target-Aware Compaction, Vision & Cost X-Ray (`src/core/compactor.ts`, `src/adapters/router.ts`, `xray.ts`)**
   - Sticky session-level model lock prevents mid-conversation model switching from invalidating KV prefix caches; supports `/model` (`auto / deepseek / mimo / agy / openai`), multimodal `@image.png` vision routing, zero-delta exponential backoff retry on transient `502/503/504` errors, and local Antigravity quota probing.
   - **Active-Target-Aware KV Prefix-Cache Compaction**: freezes the leading system prompt and early messages byte-for-byte; when context crosses the high-water mark, it folds historical/rejected `edit_file` code payloads and unrelated outputs first while **protecting the `read_file` source of files actively being edited in the current turn**, preserving **64-token block prefix caching** without mid-turn amnesia.
   - Built-in `/xray` inspector displays per-round HTTP latency, cached vs. uncached token ratios, prefix mutation forensics, and exact cost breakdowns.
4. **💻 Multi-Project Terminal, `SKILL.md` Lazy-Loader & 3-Tier Command Sandbox (`src/adapters/repl.ts`, `skill-loader.ts`, `sandbox-policy.ts`, `bash-policy.ts`)**
   - **Zero-Cache-Invalidation `SKILL.md` Lazy-Loading (`/skill` & `/skills`)**: Automatically discovers workspace (`./skills`, `./.agents/skills`, `./.claude/skills`) and global (`~/.duo-harness/skills`, `~/.codex/skills`, `~/.gemini/antigravity/skills`, `~/.gemini/config/plugins/*/skills`) skills, injects a static `<skills>` index into the system prompt, and lazy-loads full `SKILL.md` specs on demand via `read_file`.
   - **Live `/` Command Menu, `@file` / `@image` Mention & `↑/↓` Picker**: Type `/` to render a live dropdown menu below the cursor; use `↑/↓` arrows to pick commands, turns (`/resume`), skills (`/skill`), or models (`/model`), and press `Tab` to autocomplete `@path/to/file` or `@.debug/shot.png`.
   - **Command-Verb-Aware 3-Tier Sandbox (`allow / ask_workspace / ask_escalated / deny`)**: Distinguishes file-reading commands from regex/pattern arguments (`grep -o "..."`) so quoted regex metacharacters never trigger false-positive root path escalations; blocks credential harvesting (`~/.ssh`, `.env*`) and runs read-only commands inside a macOS `sandbox-exec` kernel profile.
5. **🛡️ Atomic File Writes, Write-Through Snapshots & Multi-Hunk `/diff` + `/undo` + `/redo` (`src/adapters/tools.ts`, `write-tools.ts`, `diff-presenter.ts`)**
   - **POSIX Atomic Writes (`Temp + Rename`) & Write-Through Snapshots**: Every `edit_file` and rollback uses atomic temp-file rename (`writeFileAtomicSync`) and flushes `snapshots.json` immediately per step, preventing 0-byte file truncation or lost undo history on `SIGKILL` / `SIGHUP` / power loss.
   - **Multi-Hunk `/diff`, Turn-Level `/undo` & `/redo`**: Splits multi-region edits in large files into clean anchored diff hunks, prints per-step and end-of-turn `+added / -removed` diffstats, rolls back or restores turns with `/undo` and `/redo`, and automatically injects a `lastUndoNotice` on the next turn so the model knows its previous edits were reverted.
   - Native `stdio` JSON-RPC 2.0 **MCP Client** (`src/adapters/mcp-client.ts`) to mount any external Model Context Protocol server.
6. **🔍 Autonomous Code Reviewer & Dual-End HTTP/SSE Server (`src/adapters/reviewer.ts`, `rpc-server.ts`)**
   - Generates a repository-wide `RepoMap` symbol skeleton, runs static architectural boundary checks, dispatches a read-only agent to trace cross-file callers, and validates structured JSON output via Zod.
   - Native `node:http` server exposing `/health`, `/status`, `/turns`, `/diff`, `/undo`, `/ask`, and `/review` over both JSON and real-time `text/event-stream` (SSE).

---

### 🗺️ Architecture Overview

```mermaid
flowchart LR
  CLI["CLI / REPL / HTTP-SSE\n(cli, repl, rpc-server)"] --> Loop["🧠 Pure State Machine\n(core/loop.ts)"]
  Loop <--> Tree["🌳 Session Tree & Compactor\n(core/session-tree, compactor)"]
  Loop --> Router["⚡ Time-Aware Router & SSE\n(router, agy-bridge, sse-stream)"]
  Loop --> Sandbox["🛠️ Sandboxed Tools & Skills\n(tools, write-tools, skill-loader)"]
  Tree <--> Store[("📄 Append-only .jsonl & Snapshots\n(store, project-store, session-controller)")]
```

| Layer | File Path | Core Responsibility |
| :--- | :--- | :--- |
| **Core (Pure)** | `src/core/contracts.ts` | Zod schemas & TypeScript contracts for `Message` (with `images`), `AgentState`, `SessionEntry`, `LoopEvent`, `LlmStreamEvent` |
| **Core (Pure)** | `src/core/loop.ts` | Pure state reducer driving `Idle -> Thinking -> AwaitingApproval -> Executing -> Done/Error` |
| **Core (Pure)** | `src/core/session-tree.ts` | Reconstructs active branch `messages[]` via `parentId`, auto-heals dangling `toolCalls` & asserts 1:1 pairing |
| **Core (Pure)** | `src/core/compactor.ts` | Active-target-aware prefix compaction folding historical `edit_file` args & stale outputs while locking KV caches |
| **Adapter (I/O)** | `src/adapters/repl.ts` / `dropdown.ts` / `diff-presenter.ts` / `ui-logger.ts` | Interactive CLI (`duo`), live `/` & `↑/↓` picker, unified `y/a/d/n` + inline-revision approval box & multi-hunk LCS diff |
| **Adapter (I/O)** | `src/adapters/session-controller.ts` / `project-store.ts` / `store.ts` | Dual-end session controller (`ask/new/resume/compact/diff/undo/redo`), atomic writes & `~/.duo-harness/projects/` store |
| **Adapter (I/O)** | `src/adapters/router.ts` / `agy-bridge.ts` / `sse-stream.ts` / `cost-tracker.ts` | Sticky/vision model router, zero-delta retry, Antigravity quota bridge, SSE stream bus & `http-wire.json` cost tracker |
| **Adapter (I/O)** | `src/adapters/tools.ts` / `write-tools.ts` / `sandbox-policy.ts` / `bash-policy.ts` / `skill-loader.ts` | Sandboxed read/write tools, 3-tier command sandbox, `SKILL.md` lazy-loader, AST syntax check, MCP & `/xray` inspector |

---

### 🚀 1-Minute Quick Start

#### 1. Install & Run Offline Verification (No API Key Required)

Requires **Node.js >= 22.0.0** and `pnpm`:

```bash
pnpm install

# Run strict TypeScript typecheck + 38 unit, sandbox, skill, multimodal & 0ms offline replay tests (~1s, zero network calls)
pnpm verify
```

#### 2. Configure API Keys (`.env.local` or Environment Variables)

Create a `.env.local` file in the project root (gitignored by default) and provide any of the supported OpenAI-compatible API keys:

```ini
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
MIMO_API_KEY=tp-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

> 💡 **Multi-Model & Vision Routing (`src/adapters/router.ts`)**:
> - Supports official **OpenAI API** (`OPENAI_API_KEY` / `OPENAI_MODEL`, defaulting to `gpt-5-codex`), **DeepSeek**, and **MiMo 2.6**.
> - When both `MIMO_API_KEY` and `DEEPSEEK_API_KEY` are configured, weekday peak hours automatically route to `MiMo 2.6` and off-peak/weekends route to `DeepSeek` with 64-token prefix caching; prompts with `@image.png` automatically route to vision-capable models (`MiMo 2.6` / `OpenAI`).

#### 3. Launch Interactive Multi-Project CLI (`pnpm chat` or Global `duo`)

```bash
# Start interactive session in the current workspace
pnpm chat

# Or link `duo` globally to run inside ANY repository on your machine:
pnpm link --global
cd /path/to/any-other-project && duo
```

Inside the `duo>` prompt, type `/` to pop up the live command menu below the cursor, or press `Tab` to autocomplete `@file` / `@image` paths:

| Slash Command / Input | Description |
| :--- | :--- |
| `/skill <name> <task>` | Lazy-load a workspace or global `SKILL.md` (e.g., `/skill ui-craft Restyle index.html in P5 pop style`) |
| `/skills` | List all discovered workspace and global `SKILL.md` skills with scope and description |
| `/goal <task>` | Run autonomous goal mode with Pre-Complete Verification Gate (auto-runs syntax/build/test checks before completing) |
| `/resume` | Select any historical turn (`#1`, `#2`, ...) using `↑/↓` arrow keys to continue or branch |
| `/new` | Start a brand-new conversation while safely preserving previous history in `.jsonl` |
| `/model` | Switch model routing strategy (`auto / deepseek / mimo / agy / openai`) via `↑/↓` picker |
| `/diff [all\|full\|file]` | View multi-hunk LCS code diffs (`-removed / +added`) for current turn or all uncommitted edits |
| `/undo [turn\|N\|all]` | Roll back file modifications (`/undo` reverts last turn, `/undo N` reverts N steps, `/undo all` reverts all) |
| `/redo [turn\|N\|all]` | Redo previously rolled-back file modifications |
| `/compact` | Fold historical oversized tool outputs, `@file` blocks, and `@image` attachments in-place to lock a lean prefix |
| `/open [file\|url]` | Open a local HTML page, file, or URL in your system's default browser/application |
| `/cd <path>` | Switch active workspace to another repository on disk (sessions isolated under `~/.duo-harness/projects/`) |
| `/projects` | List all repositories you have worked on with their entry count and path |
| `/xray` | Inspect per-round HTTP payloads, latency, KV-cache hit rate, prefix mutation forensics, and cost breakdown |
| `/history` | View conversation turn list and current active leaf |
| `/branch <id>` | Jump to any historical message ID to fork a new parallel branch |
| `/clear` | Clear current project session history, wire logs, and snapshots |
| `/exit` | Exit interactive REPL |
| `@<file-or-image>` | Inline context mention: attach source files (`@src/index.ts`) or images (`@.debug/shot.png`) with `Tab` completion |

#### 4. One-Shot CLI, Offline Replay, Autonomous Code Review & HTTP/SSE Server

```bash
# 1. Run live recording + 0ms offline replay + KV cache & cost report demo
pnpm play

# 2. One-shot question (supports --continue to resume and --dir for external repos)
pnpm ask "Read package.json and summarize the scripts"
pnpm ask --dir ../my-other-app "Check src/ for unhandled Promise rejections"

# 3. Run autonomous RepoMap + architectural boundary code reviewer
pnpm review src/core/loop.ts

# 4. Start HTTP JSON / SSE streaming server (defaults to http://127.0.0.1:3210)
pnpm serve
```

---
---

<a id="简体中文"></a>

## 🇨🇳 简体中文

### 为什么构建 `duo-harness`？

市面上的 AI 编程工具大多走向两个极端：要么与特定 IDE 客户端强绑定，要么被几万行重型黑盒框架层层包裹——一旦遇到 SSE 断流、工具配对报错或前缀缓存雪崩，开发者很难看清底层到底发生了什么。

**`duo-harness`** 是一个零黑盒框架依赖、100% 遵循行业开放标准（OpenAI Streaming / MCP JSON-RPC 2.0 / Append-only `.jsonl` 会话树）的轻量级 TypeScript Coding Agent 运行时与跨项目交互式 CLI（全库 `< 2,500 行`，运行时仅依赖 `zod`）：

- **494 行纯函数内核 (`src/core/`)**：零 `node:fs`、零 `fetch`、零 `child_process`、零厂商耦合。所有状态流转（`Idle -> Thinking -> AwaitingApproval -> Executing -> Done/Error`）、`.jsonl` 分支还原、中断悬空 `toolCalls` 自愈与 KV 前缀缓存折叠全部是 100% 确定性纯函数（单文件严格 $\le 250$ 行、单函数 $\le 80$ 行）。
- **零污染多项目交互终端 (`duo` / `pnpm chat`)**：对标 Claude Code、Codex CLI 与 `@mariozechner/pi-coding-agent`，可在电脑任意代码仓库直接启动交互编程与架构审查；所有项目的会话历史、文件修改快照（`snapshots.json`）与网络抓包统一集中存放在 `~/.duo-harness/projects/<项目名>-<哈希>/`，**绝不在目标仓库产生任何未跟踪文件污染 `git status`**。

---

### ✨ 核心特性

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

### 🚀 1 分钟快速上手

#### 1. 安装依赖与运行离线验证（无需 API Key）

要求 `Node.js >= 22.0.0` 并统一使用 `pnpm`：

```bash
pnpm install

# 运行 TypeScript 严格类型检查 + 38 项单元、沙箱、技能、多模态与断网回放测试（0 网络请求）
pnpm verify
```

#### 2. 配置 API Key（`.env.local` 或环境变量）

在项目根目录创建 `.env.local`（已被 `.gitignore` 忽略），填入任一支持的大模型 API Key：

```ini
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
MIMO_API_KEY=tp-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

#### 3. 启动交互式命令行（`pnpm chat` 或全局 `duo`）

```bash
# 在当前仓库启动交互式对话（自动记忆上下文）
pnpm chat

# 或者挂载为全局命令 `duo`，即可在电脑任意项目目录下直接运行：
pnpm link --global
cd /path/to/any-other-project && duo
```

在 `duo>` 交互式终端中，输入 `/` 即可在光标下方实时弹出命令选择菜单（支持 `Tab` 自动补全 `@文件` 与 `@图片`）：

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

---

## 📄 License / 开源协议

MIT License
