<div align="center">

# Duo-Harness

**Zero-Host-Lock-in TypeScript Coding Agent Runtime & Multi-Project CLI**  
*Functional Core (470 LOC) + Imperative Shell · Branchable `.jsonl` Event Tree · 0ms Offline Replay · KV Prefix-Cache Compaction · MCP Client*

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.0.0-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7_Strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Runtime Deps](https://img.shields.io/badge/Dependencies-1_(zod)-brightgreen)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**[🇬🇧 English](#english)** · **[🇨🇳 简体中文](#简体中文)** ([独立中文文档](./README.zh-CN.md)) · **[🗺️ Architecture](./ARCH.md)** · **[🛣️ Roadmap](./ROADMAP.md)**

</div>

---

<a id="english"></a>

## 🇬🇧 English

### Why `duo-harness`?

Most AI coding agents today suffer from two extremes: either they are locked inside proprietary IDE extensions, or they are buried under tens of thousands of lines of heavyweight framework abstractions where a single streaming timeout or context-compaction bug takes hours to trace.

**`duo-harness`** is an open-standard, zero-framework-lock-in TypeScript Coding Agent Harness built under strict **Functional Core, Imperative Shell** constraints (`< 2,500 LOC` total, `zod` as the **only** runtime dependency):

- **470-Line Pure Functional Core (`src/core/`)**: Zero `node:fs`, zero `fetch`, zero `child_process`, and zero vendor-specific logic. Every state transition (`Idle -> Thinking -> AwaitingApproval -> Executing -> Done/Error`), `.jsonl` branch projection, and KV-cache-preserving compaction is a 100% deterministic pure function ($\le 250$ lines per file, $\le 80$ lines per function).
- **Production-Ready Multi-Project CLI (`duo` / `pnpm chat`)**: Works across any repository on your machine like Claude Code, Codex CLI, or `@mariozechner/pi-coding-agent`—storing per-project `.jsonl` sessions and HTTP wire logs cleanly in `~/.duo-harness/projects/<name>-<hash8>/` with **zero untracked files polluting your target repo's `git status`**.

---

### ✨ Key Features

1. **🧅 Pure State Machine with Durable HITL & Self-Verification Gate (`src/core/loop.ts`)**
   - Supports **Human-in-the-Loop (HITL)** suspension before executing mutating tools (`edit_file`, non-readonly `run_bash`).
   - Built-in **Pre-Complete Verification Gate**: when the model attempts to finish, an external verification hook (`verifyCompletion`) runs automatically; if typecheck/tests fail, `REJECT_COMPLETION` feeds the error back into the loop until all checks pass.
2. **🌳 Append-Only `.jsonl` Session Tree & 0ms Offline Replay (`src/core/session-tree.ts`, `src/adapters/store.ts`)**
   - Every message is stored as a tree node with `id` and `parentId`. Jump back one turn with `/undo` or fork a parallel conversation from any historical message with `/branch <id>`.
   - Enforces strict 1:1 `toolCalls` $\leftrightarrow$ `toolResult` pairing before every LLM request (`assertSessionInvariant`).
   - Includes `ReplayProvider` to replay multi-step tool-calling sessions offline in **0ms with zero API cost**.
3. **⚡ KV Prefix-Cache Compaction & Cost X-Ray (`src/core/compactor.ts`, `src/adapters/cost-tracker.ts`, `xray.ts`)**
   - Freezes the leading system prompt and early messages byte-for-byte, folding only the oldest oversized tool outputs in-place to preserve **64-token block prefix caching** on DeepSeek / Claude.
   - Built-in `/xray` inspector displays per-round HTTP latency, cached vs. uncached token ratios, and exact cost breakdowns.
4. **💻 Interactive Multi-Project Terminal (`src/adapters/repl.ts`, `project-store.ts`)**
   - **Live `/` Command Menu & `Tab` Autocomplete**: Type `/` to render a live dropdown menu below the cursor; press `Tab` to autocomplete slash commands and file paths.
   - **Smart Read-Only Auto-Approval**: Read-only shell inspection commands (`git status`, `git diff`, `ls`, `pnpm test`, etc.) execute seamlessly without manual prompts, while mutating commands trigger a highlighted confirmation box.
5. **🛡️ Sandboxed Tools, Transactional Rollback & Standard MCP (`src/adapters/tools.ts`, `write-tools.ts`, `mcp-client.ts`)**
   - Built-in `read_file` (with line slicing & symlink escape protection), `grep`, `list_dir`, `edit_file` (batch replacements with automatic in-memory snapshot rollback on failure), and `run_bash` (POSIX process-group timeout termination).
   - Native `stdio` JSON-RPC 2.0 **MCP Client** to mount any external Model Context Protocol server.
6. **🔍 Autonomous Code Reviewer & HTTP/SSE Server (`src/adapters/reviewer.ts`, `rpc-server.ts`)**
   - Generates a repository-wide `RepoMap` symbol skeleton, runs static architectural boundary checks, dispatches a read-only agent to trace cross-file callers, and validates structured JSON output via Zod.
   - Native `node:http` server exposing `/health`, `/ask`, and `/review` over both JSON and real-time `text/event-stream` (SSE).

---

### 🗺️ Architecture Overview

```mermaid
flowchart LR
  CLI["CLI / REPL / HTTP-SSE\n(adapters/cli, repl, rpc-server)"] --> Loop["🧠 Pure State Machine\n(core/loop.ts)"]
  Loop <--> Tree["🌳 Session Tree & Compactor\n(core/session-tree, compactor)"]
  Loop --> Router["⚡ Time-Aware Router & SSE\n(adapters/router, sse-stream)"]
  Loop --> Sandbox["🛠️ Sandboxed Tools & MCP\n(adapters/tools, write-tools, mcp)"]
  Tree <--> Store[("📄 Append-only .jsonl\n(adapters/store, project-store)")]
```

| Layer | File Path | Core Responsibility |
| :--- | :--- | :--- |
| **Core (Pure)** | `src/core/contracts.ts` | Zod schemas & TypeScript contracts for `Message`, `AgentState`, `SessionEntry`, `LoopEvent`, `LlmProvider` |
| **Core (Pure)** | `src/core/loop.ts` | Pure state reducer driving `Idle -> Thinking -> AwaitingApproval -> Executing -> Done/Error` |
| **Core (Pure)** | `src/core/session-tree.ts` | Reconstructs active branch `messages[]` via `parentId` & asserts 1:1 `toolCall` pairing |
| **Core (Pure)** | `src/core/compactor.ts` | Prefix-locked context compaction that folds stale tool outputs without invalidating KV caches |
| **Adapter (I/O)** | `src/adapters/repl.ts` / `project-store.ts` | Interactive multi-project CLI (live `/` dropdown, `Tab` completion, branch navigation) & `~/.duo-harness/projects/` storage |
| **Adapter (I/O)** | `src/adapters/router.ts` / `sse-stream.ts` | Time-aware multi-model router (DeepSeek / MiMo 2.6), SSE chunk assembly & `.sessions/http-wire.json` capture |
| **Adapter (I/O)** | `src/adapters/tools.ts` / `write-tools.ts` | Path-sandboxed read/write tools, process-group timeout cleanup & automatic file snapshot rollback |
| **Adapter (I/O)** | `src/adapters/reviewer.ts` / `rpc-server.ts` | `RepoMap` symbol indexer, autonomous code reviewer & HTTP/SSE streaming server |

---

### 🚀 1-Minute Quick Start

#### 1. Install & Run Offline Verification (No API Key Required)

Requires **Node.js >= 22.0.0** and `pnpm`:

```bash
pnpm install

# Run strict TypeScript typecheck + 26 unit & 0ms offline replay tests (< 1s, zero network calls)
pnpm verify
```

#### 2. Configure API Keys (`.env.local` or Environment Variables)

Create a `.env.local` file in the project root (gitignored by default) and provide any of the supported OpenAI-compatible API keys:

```ini
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
MIMO_API_KEY=tp-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

> 💡 **Multi-Model Routing (`src/adapters/router.ts`)**:
> - Supports official **OpenAI API** (`OPENAI_API_KEY` / `OPENAI_MODEL`, defaulting to `gpt-5-codex` and compatible with `gpt-5.6` / `gpt-5`), **DeepSeek**, and **MiMo 2.6**.
> - When both `MIMO_API_KEY` and `DEEPSEEK_API_KEY` are configured, weekday peak hours automatically route to `MiMo 2.6` and off-peak/weekends route to `DeepSeek` with 64-token prefix caching; set `LLM_PROVIDER=openai` or provide `OPENAI_API_KEY` to route directly to OpenAI.

#### 3. Launch Interactive Multi-Project CLI (`pnpm chat` or Global `duo`)

```bash
# Start interactive session in the current workspace
pnpm chat

# Or link `duo` globally to run inside ANY repository on your machine:
pnpm link --global
cd /path/to/any-other-project && duo
```

Inside the `duo>` prompt, type `/` to pop up the live command menu below the cursor, or press `Tab` to autocomplete:

| Slash Command | Description |
| :--- | :--- |
| `/cd <path>` | Switch active workspace to another repository on disk (sessions isolated under `~/.duo-harness/projects/`) |
| `/projects` | List all repositories you have worked on with their last active timestamp |
| `/xray` | Inspect per-round HTTP payloads, latency, KV-cache hit rate, and token cost breakdown |
| `/tree` | Visualize the `.jsonl` conversation tree and current active leaf `[⬅ 当前位置]` |
| `/undo` | Rewind one conversational turn (moves the active leaf pointer without deleting history) |
| `/branch <id>` | Jump to any historical message ID to fork a new parallel branch |
| `/clear` | Clear current project session history and start fresh |
| `/exit` | Exit interactive REPL |

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

- **470 行纯函数内核 (`src/core/`)**：零 `node:fs`、零 `fetch`、零 `child_process`、零厂商耦合。所有状态流转（`Idle -> Thinking -> AwaitingApproval -> Executing -> Done/Error`）、`.jsonl` 分支还原与 KV 前缀缓存折叠全部是 100% 确定性纯函数（单文件严格 $\le 250$ 行、单函数 $\le 80$ 行）。
- **零污染多项目交互终端 (`duo` / `pnpm chat`)**：对标 Claude Code、Codex CLI 与 `@mariozechner/pi-coding-agent`，可在电脑任意代码仓库直接启动交互编程与架构审查；所有项目的会话历史与网络抓包统一集中存放在 `~/.duo-harness/projects/<项目名>-<哈希>/`，**绝不在目标仓库产生任何未跟踪文件污染 `git status`**。

---

### ✨ 核心特性

1. **🧅 纯函数状态机、暂停审批（HITL）与完成前自动验证打回 (`src/core/loop.ts`)**
   - 写文件或执行非常规命令前自动挂起等待人工确认（Human-in-the-Loop），拒绝时自动生成 1:1 工具回执防止上下文格式损坏。
   - 内置 **Pre-Complete Verification Gate**：模型认为任务完成准备结束时，自动执行外部验证钩子（如类型检查与单测）；若报错则通过 `REJECT_COMPLETION` 自动将报错打回给模型继续修复，直至验证全绿。
2. **🌳 `.jsonl` 分支会话树与 0 毫秒断网录像回放 (`src/core/session-tree.ts`, `src/adapters/store.ts`)**
   - 每条消息带 `id` 与 `parentId` 追加写入 `.jsonl`，支持 `/undo` 一键退回上一步、`/branch <节点id>` 切回任意历史节点开辟平行对话分支。
   - 内置 `ReplayProvider`，无需 API Key、断网 0 毫秒重放完整多步 Tool Call 历史对话，用于单元测试与回归验证。
3. **⚡ KV 前缀缓存保护与真实耗时/费用账单 (`src/core/compactor.ts`, `src/adapters/cost-tracker.ts`, `xray.ts`)**
   - 当上下文超限时，仅原地折叠最旧的超长工具返回结果，**100% 锁死头部 System Prompt 与早期消息字节不变**，保护 DeepSeek / Claude 64-Token 块级前缀缓存不雪崩。
   - 内置 `/xray` 诊断面板，实时展示每轮 HTTP 首包耗时、缓存命中 Token 占比与精确到分的费用账单。
4. **💻 多项目交互式终端 (`src/adapters/repl.ts`, `project-store.ts`)**
   - **`/` 实时下拉提示菜单与 `Tab` 自动补全**：输入 `/` 即在光标下方实时弹出命令菜单，按 `Tab` 自动补全命令与文件路径。
   - **只读命令智能免审放行**：`git status`、`git diff`、`pnpm test` 等只读检查命令自动放行；改文件或高危命令弹出高亮确认框。
5. **🛡️ 沙箱工具、事务快照回滚与标准 MCP 客户端 (`src/adapters/tools.ts`, `write-tools.ts`, `mcp-client.ts`)**
   - 内置带行号切片 `read_file`（防软链接越权）、带上下文 `grep`、`list_dir`、`edit_file`（失败自动逆序还原内存快照）与进程组级超时清剿 `run_bash`。
   - 内置标准 `stdio` JSON-RPC 2.0 MCP 客户端，可一键挂载任意第三方 MCP Server。
6. **🔍 自主探路代码审查特工与 HTTP/SSE 服务 (`src/adapters/reviewer.ts`, `rpc-server.ts`)**
   - 自动扫描全库导出符号生成 `RepoMap` 行号地图 + 静态架构红线检查 + 只读 Agent 自主跨文件追查 + Zod 结构化报告校验。
   - 原生 `node:http` 暴露 `/health`、`/ask`、`/review` 接口，支持 JSON 与 `text/event-stream` (SSE) 实时流推送。

---

### 🚀 1 分钟快速上手

#### 1. 安装依赖与运行离线验证（无需 API Key）

要求 `Node.js >= 22.0.0` 并统一使用 `pnpm`：

```bash
pnpm install

# 运行 TypeScript 严格类型检查 + 26 项单元与断网回放测试（0 网络请求，耗时 < 1 秒）
pnpm verify
```

#### 2. 配置 API Key（`.env.local` 或环境变量）

在项目根目录创建 `.env.local`（已被 `.gitignore` 忽略），填入任一或两个模型的 API Key：

```ini
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

在 `duo>` 交互式终端中，输入 `/` 即可在光标下方实时弹出命令选择菜单（支持 `Tab` 自动补全）：

| 快捷命令 | 功能说明 |
| :--- | :--- |
| `/cd <目录路径>` | 切换到电脑上的任意其他项目目录（会话自动隔离保存在 `~/.duo-harness/projects/`） |
| `/projects` | 查看所有审查/交互过的历史项目列表与最后活跃时间 |
| `/xray` | 查看当前会话每轮 HTTP 请求的真实 payload、耗时、缓存命中率与费用账单 |
| `/tree` | 查看当前 `.jsonl` 会话的树状节点结构与当前所处分支叶子节点 `[⬅ 当前位置]` |
| `/undo` | 一键退回上一轮对话（底层仅移动叶子指针，不破坏历史日志） |
| `/branch <节点id>` | 切回历史上的任意消息节点重新提问，拉出平行对话分支 |
| `/clear` | 清空当前项目对话记忆，开启全新会话 |
| `/exit` | 退出交互终端 |

---

## 📄 License / 开源协议

MIT License
