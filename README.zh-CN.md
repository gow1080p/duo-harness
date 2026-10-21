<div align="center">

# Duo-Harness (简体中文文档)

**零宿主绑定的轻量级 TypeScript Coding Agent 运行时与跨项目交互式 CLI**  
*470 行纯函数内核 (Functional Core) + 可插拔 I/O 外壳 (Imperative Shell) · `.jsonl` 分支会话树 · 0ms 离线回放 · KV 前缀缓存锁 · MCP 客户端*

**[🇬🇧 English](./README.md)** · **[🇨🇳 简体中文](./README.zh-CN.md)** · **[🗺️ 架构图 (ARCH.md)](./ARCH.md)** · **[🛣️ 路线图 (ROADMAP.md)](./ROADMAP.md)**

</div>

---

## 为什么构建 `duo-harness`？

市面上的 AI 编程工具大多走向两个极端：要么与特定 IDE 客户端强绑定，要么被几万行重型黑盒框架层层包裹——一旦遇到 SSE 断流、工具配对报错或前缀缓存雪崩，开发者很难看清底层到底发生了什么。

**`duo-harness`** 是一个零黑盒框架依赖、100% 遵循行业开放标准（OpenAI Streaming / MCP JSON-RPC 2.0 / Append-only `.jsonl` 会话树）的轻量级 TypeScript Coding Agent 运行时与跨项目交互式 CLI（全库 `< 2,500 行`，运行时仅依赖 `zod`）：

- **470 行纯函数内核 (`src/core/`)**：零 `node:fs`、零 `fetch`、零 `child_process`、零厂商耦合。所有状态流转（`Idle -> Thinking -> AwaitingApproval -> Executing -> Done/Error`）、`.jsonl` 分支还原与 KV 前缀缓存折叠全部是 100% 确定性纯函数（单文件严格 $\le 250$ 行、单函数 $\le 80$ 行）。
- **零污染多项目交互终端 (`duo` / `pnpm chat`)**：对标 Claude Code、Codex CLI 与 `@mariozechner/pi-coding-agent`，可在电脑任意代码仓库直接启动交互编程与架构审查；所有项目的会话历史与网络抓包统一集中存放在 `~/.duo-harness/projects/<项目名>-<哈希>/`，**绝不在目标仓库产生任何未跟踪文件污染 `git status`**。

---

## ✨ 核心特性

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

### 4. 单次提问、离线回放、自动代码审查与 HTTP/SSE 服务

```bash
pnpm play
pnpm ask "请读取 package.json 并总结项目结构"
pnpm ask --dir ../my-other-app "帮我检查 src 下有没有未处理的 Promise 异常"
pnpm review src/core/loop.ts
pnpm serve
```
