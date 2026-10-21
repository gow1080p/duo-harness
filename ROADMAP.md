# Duo-Harness Engineering Design & Roadmap / 架构设计与演进路线图 (ROADMAP.md)

> **Positioning / 项目定位**：A 100% host-independent, open-standard (`OpenAI Streaming` / `MCP` / `JSONL Event Sourcing`) TypeScript Coding Agent Runtime & Evaluation Micro-Kernel.  
> 一个 100% 独立、零宿主绑定、遵循行业开放标准的 TypeScript 智能体运行时与评测微内核。

---

## 1. Core Architectural Philosophy / 核心设计哲学 (`Functional Core + Imperative Shell`)

| Traditional Frontend Equivalent / 传统前端底层机制 | `duo-harness` Agent Runtime Equivalent / 对应的 Agent 内核机制 | Architectural Invariant / 架构红线与挑刺抓手 |
| :--- | :--- | :--- |
| **`Redux` `actions[]` + `array.reduce(reducer)`** | **Append-only `.jsonl` Event Log + `projectToMessages()`** | Outgoing `messages[]` must be derived purely from the `.jsonl` tree; mutating `messages` outside the event log is forbidden.<br>每次发给模型的 `messages` 必须由 `.jsonl` 纯函数唯一派生。 |
| **Virtual List + Stable React Top Keys**<br>（虚拟滚动列表 + 头部 Key 稳定） | **Prefix-Locked Context Compaction (`compactor.ts`)**<br>（上下文压缩与 KV 前缀缓存保护） | Fold oversized historical tool outputs in-place; never mutate the system prompt or early message bytes so 64-token KV prefix caches stay warm.<br>严禁篡改头部消息字节，仅原地折叠旧的大体积工具输出，防止 KV 缓存树雪崩重算。 |
| **Router Navigation Guard (`beforeEach`) + State Restore**<br>（路由守卫拦截 + 状态恢复） | **Effect Sandwich & Durable HITL (`AwaitingApproval`)**<br>（写操作暂停审批与恢复） | `Intent -> AwaitingApproval -> Approved/Rejected -> ToolResult`. Even if rejected, generate a 1:1 `ToolResultMessage` to keep `tool_call_id` paired.<br>拒绝执行时仍生成 1:1 工具回执，保证消息配对合法。 |
| **Web Worker + `postMessage (JSON-RPC 2.0)`** | **MCP Client (`stdio` pipe) & Process-Group Sandbox** | Isolate external tools over `stdio` JSON-RPC 2.0 with hard timeouts and process-group (`-pid`) cleanup.<br>通过 `stdio` 管道与子进程通信，配齐超时进程组强杀熔断。 |
| **MSW / Deterministic Network Replay** | **Zero-Key Offline Replay (`ReplayProvider`)** | Replay recorded `.jsonl` assistant responses in 0ms offline for fast unit testing.<br>离线读取 `.jsonl` 历史模型响应喂给状态机，0 成本、0 毫秒跑完回归测试。 |

---

## 2. Tech Stack & Multi-Tier Routing / 极简技术栈与四档算力路由

### Minimalist Stack / 极简技术栈
- **Language & Contracts / 语言与契约**：`TypeScript (strict: true)` + `Zod` (Single source of truth for TS types, LLM Tool JSON Schema, and runtime validation).
- **Storage & Runtime / 运行时与存储**：`Node.js >= 22` + Append-only `.jsonl` event trees (`~/.duo-harness/projects/`).
- **Verification / 测试验证**：`Vitest` (`pnpm verify` runs `tsc --noEmit && vitest run` in `< 1s`).
- **Dependency Budget / 依赖预算**：`zod` is the **only** production dependency. Zero LangChain or black-box agent frameworks.

### 4-Tier Time-Aware Router / 四档算力自动路由 (`src/adapters/router.ts`)

| Tier / 档位 | Trigger / 触发条件与时段 | Target Provider / 路由目标 | Engineering Goal / 工程目的 |
| :--- | :--- | :--- | :--- |
| **Tier 0** | Unit tests, state debugging, `--replay` mode | **`ReplayProvider` (Local `.jsonl` snapshot)** | **\$0.00 / 0ms deterministic verification**. 90% of kernel tests run offline.<br>断网 0 毫秒确定性验证，90% 内核调试不走网络。 |
| **Tier 1** | Weekday Peak Hours<br>(`09:00–12:00`, `14:00–18:00` UTC+8) | **`Xiaomi MiMo 2.6` (`mimo-v2.6-pro` / `flash`)** | High-throughput peak routing & cross-provider OpenAI streaming compatibility.<br>工作日白天高峰路由，实战检验跨模型协议兼容性。 |
| **Tier 2** | Off-Peak & Weekends<br>(`12:00–14:00`, `18:00–09:00` UTC+8) | **`DeepSeek API` (`deepseek-chat` with KV cache lock)** | Primary workhorse with 95%+ 64-token block prefix-cache hit rate.<br>主力实战档，配合 64-Token 块级前缀缓存锁大幅降低长上下文成本。 |
| **Tier 3** | Complex architecture review / External CLI bridge | **`Claude / Gemini` (External Host or MCP Bridge)** | Cross-model architectural falsification and external orchestration.<br>跨模型架构互审与标准管道协同。 |

---

## 3. Five-Stage Implementation Milestones / 五阶段闯关里程碑

- [x] **Stage 1: Minimal Agent Loop & Time-Aware Router (`contracts.ts`, `loop.ts`, `router.ts`, `tools.ts`)**
  - Pure state machine (`Idle -> Thinking -> Executing -> Done/Error`), multi-model SSE streaming router, and sandboxed read-only tools (`read_file`, `grep`, `list_dir`).
- [x] **Stage 2: Append-Only `.jsonl` Session Tree & 0ms Offline Replay (`session-tree.ts`, `store.ts`)**
  - Branchable `parentId` tree projection (`projectToMessages`), strict `toolCall` 1:1 invariant check (`assertSessionInvariant`), and offline `ReplayProvider`.
- [x] **Stage 3: Durable HITL Approval, Transactional Rollback & Self-Verification Gate (`write-tools.ts`, `cli.ts`)**
  - Mutating tools (`edit_file`, `run_bash`), `AwaitingApproval` interruption, in-memory file snapshot rollback on failure, and `REJECT_COMPLETION` pre-complete verification loop.
- [x] **Stage 4: Prefix-Locked Context Compactor & Standard MCP Client (`compactor.ts`, `mcp-client.ts`)**
  - KV-cache-safe context folding (`compactMessages`), atomic tool-pair eviction, and standard `stdio` JSON-RPC 2.0 MCP client.
- [x] **Stage 5: Autonomous Code Reviewer, Multi-Project REPL & HTTP/SSE Server (`reviewer.ts`, `repl.ts`, `project-store.ts`, `rpc-server.ts`)**
  - Repository-wide `RepoMap` symbol skeleton, static architectural linter + autonomous read-only reviewer, centralized `~/.duo-harness/projects/` multi-project interactive CLI (`duo`) with live `/` dropdown menu and `Tab` completion, and `node:http` JSON/SSE server.
