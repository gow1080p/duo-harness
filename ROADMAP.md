# Duo-Harness：2026 资深前端破局 AI Agent 与 Harness Engineering 实战方案（v2.0 定稿版）

> **项目定位**：一个 100% 独立、零宿主绑定、遵循行业开放标准（OpenAI Streaming / MCP / JSONL Event Sourcing）的 TypeScript 智能体运行时与评测微内核。
> **核心理念**：告别散装 `.mjs` 面条代码与易过期的 `.md` 提示词雕花；采用 **「Functional Core（纯函数内核） + Imperative Shell（声明式外壳）」** 架构，将投入的时间与 Token 沉淀为可跨模型、跨 IDE、跨项目永久复用的三大工程资产。

---

## 一、 为什么要做 `duo-harness`？（三大跨周期复利资产）

对标传统前端时代的“抽离通用组件库”与“积累 Nginx/Vite 排障内功”，本项目旨在沉淀 AI 时代真正抗折旧的三大硬资产：

| 传统前端时代的复利 | `duo-harness` 沉淀的 AI 时代 1:1 复利资产 | 为什么换了大模型或 IDE 依然 100% 保值？ |
| :--- | :--- | :--- |
| **1. 个人组件库 / 工具库**<br>（开新项目直接 `import`） | **📦 零宿主依赖的「Agent 核心标准库」**<br>• `LoopEngine`（带挂起审批三明治的极简状态机）<br>• `CacheCompactor`（保 95% 前缀缓存的上下文裁剪纯函数）<br>• `TimeAwareRouter`（多模型分时计费与故障自动降级路由）<br>• `ArenaVerifier`（异构双模交叉证伪与物理行号验真器） | 100% 采用标准 TS 接口、CLI 管道与 MCP 协议。无论未来使用反重力、Claude Code、Pi、Cursor，还是自研 Mac/Web 应用，均可 3 分钟直接挂载复用。 |
| **2. Nginx / Vite 排障经验**<br>（看报错一眼定位根因） | **🧠 「Agent 运行时系统级排障直觉」**<br>通过亲手拆解 400 行核心 Runtime，彻底摸透：<br>• **SSE 流控与超时链路**（防 180s 断流与背压阻塞）<br>• **KV Cache 前缀树匹配机制**（防动态字段引发缓存雪崩）<br>• **子进程与信号控制**（`AbortController` 与孤儿进程清理） | 面对 AI“变笨、死循环、卡死、改东坏西”时，不再盲目干等 1 小时重抽卡，而是 10 秒看穿哪层协议或上下文结构失灵，精准拧对底层螺丝。 |
| **3. 经典 Bug 排查笔记** | **🧪 私有「黄金翻车样本集（Golden Replay Evals）」**<br>将真实复杂任务与历史翻车轨迹存为 `.jsonl` 快照与断言。 | 模型每半年换一代，跑一遍私有 `.jsonl` 错题集，5 秒内测出新模型或新架构的回归得分。 |

---

## 二、 破除跨界盲区：十几年老前端 $\Longleftrightarrow$ Agent Runtime 100% 同构映射表

Agent 内核没有神秘魔法，其核心原语与资深前端早已烂熟于心的底层机制 **100% 同构**：

| Agent Runtime 概念 | 1:1 等价的资深前端底层机制 | 迁移后的架构审查与挑刺抓手 |
| :--- | :--- | :--- |
| **1. Append-only `.jsonl` 日志 + `messages` 请求投影**<br>（DeepSeek `invariant.ts`） | **`Redux` 的 `actions[]` 数组 + `array.reduce(reducer)` 派生当前 `state`** | 每次发给模型的 `messages` 必须由 `.jsonl` 日志纯函数唯一派生；任何绕过日志直接 `messages.push()` 的操作视为架构违规。 |
| **2. 上下文压缩（Compaction）与 KV 前缀缓存保护** | **`虚拟滚动列表（Virtual List）` + `React 列表头部 Key 稳定性`** | 滚出视口的旧工具大体积输出折叠为摘要占位符；严禁篡改列表头部 System Prompt 与早期消息字节，防止整棵 KV 缓存树雪崩重算。 |
| **3. 副作用三明治与会话挂起/审批恢复（HITL）**<br>（Pi Durable Session） | **`前端路由守卫 beforeEach` 未登录拦截 + 存 `localStorage` + 登录后重定向恢复**（或 `Generator yield`） | `Intent（存意图） -> PendingApproval（退出进程） -> Resume（校验快照未过期后执行 Effect） -> Result（存结果）`。 |
| **4. MCP 协议与 Subagent 沙箱隔离** | **`Web Worker / 跨域 iframe` + `postMessage (JSON-RPC 2.0)`** | 主线程不跑重负载防污染上下文，通过 `stdio` 管道与子进程通信，并配齐超时 `terminate()` 熔断。 |
| **5. 无 Key 录像回放测试（`llm-replay`）** | **`MSW / Mock.js` 网络请求录制与确定性回放** | 离线读取真实 `.jsonl` 中的历史模型响应块喂给状态机，0 成本、1 秒跑完百条状态流转回归测试。 |

---

## 三、 技术选型与「四档算力自动路由」方案

### 1. 极简技术栈（零框架黑盒）
- **语言与契约**：`TypeScript (strict: true)` + `Zod`（单一事实源：同源生成 TS 类型、LLM Tool JSON Schema 与运行时断言）。
- **运行时与存储**：`Node.js 22+` + `.jsonl` 纯文本事件树。
- **测试裁判**：`Vitest`（驱动 `llm-replay` 快照回归）。
- **生产依赖上限**：仅限 `zod` 与原生 `fetch`，**严禁引入 LangChain 等掩盖底层 Loop 的重型黑盒框架**。

### 2. 四档算力智能路由（Time-Aware Multi-Provider Router）
采用官方合规 OpenAI 兼容标准接口，按时段与任务类型自动切换算力档位：

| 档位 | 触发条件 / 时段 | 路由目标 Provider | 工程目的与成本控制 |
| :--- | :--- | :--- | :--- |
| **Tier 0** | 跑单测、改状态机、`--replay` 模式 | **`ReplayProvider`（本地 `.jsonl` 快照）** | **¥0.00 / 0.1s 极速验证**。90% 的内核调试不走网络。 |
| **Tier 1** | 工作日白天高峰期<br>（`09:00–12:00`, `14:00–18:00`） | **`小米 MiMo 2.6`（`mimo-v2.6-pro` / `mimo-v2.6-flash`）** | 白天自动避开原价高峰期，同时实战检验内核跨不同国产/海外模型的协议兼容性。 |
| **Tier 2** | 午休 + 夜间 + 周末全天低谷窗<br>（`12:00–14:00`, `18:00–次日09:00`） | **`DeepSeek API`（开启硬盘前缀缓存锁）** | **主力实战档**。配合 95%+ 64-Token 块级前缀缓存命中，大幅降低长上下文多轮对话成本。 |
| **Tier 3** | 复杂施工、双模架构互审、CLI 桥接 | **`Gemini / Claude`（外部宿主或 CLI 桥接）** | 作为外部架构评审或通过 `child_process` 标准管道协同调用。 |

---

## 四、 三周 5 关实战推进路线图（Simon Willison 活体拆解法）

> **学习节奏**：每关先构建 `< 150 行` 可运行的活体内核跑通正反馈 $\rightarrow$ 结合前端同构表拆解最核心的 20 行状态流转 $\rightarrow$ 按需对照阅读 `@mariozechner/pi-agent-core` 等开源标杆实现。

### 第一周：发动机点火与确定性回放（Stage 1 ~ Stage 2）
- [x] **Stage 1：最小闭环 Agent Loop + 四档算力路由器（约 150 行）**
  - 实现 `src/core/contracts.ts`（Zod 消息与工具契约）与 `src/core/loop.ts`（纯状态机步进）。
  - 实现 `src/adapters/router.ts`（小米 MiMo 2.6 + DeepSeek 分时路由）与 3 个基础只读工具（`read_file`, `grep`, `list_dir`）。
  - **验收 Proof**：终端一行命令让 `duo-harness` 自主调用工具完成一次跨文件代码探路。
- [x] **Stage 2：Event Sourcing `.jsonl` 树状日志 + 无 Key 录像回放（`llm-replay`）**
  - 实现 `src/core/session-tree.ts`（纯函数 `projectToMessages` + 字节级一致性断言 `assertSessionInvariant`）。
  - 实现 `src/adapters/store.ts`，将真实对话录制为 `.sessions/play.jsonl` 并支持断网 0 毫秒回放。
  - **验收 Proof**：断网状态下运行 `pnpm verify` / `pnpm play`，0.1 秒内完成完整多步 Tool Call 循环回放验证。

### 第二周：深水区内核机制——挂起审批、主动验证打回、前缀缓存锁与 MCP（Stage 3 ~ Stage 4）
- [x] **Stage 3：副作用三明治、跨进程挂起审批（Durable HITL）与主动验证打回门禁（Self-Verification Gate）**
  - 引入写工具（`edit_file`, `run_bash`），在 `src/core/loop.ts` 中实现 `Intent -> AwaitingApproval` 挂起中断。
  - 支持写工具执行前触发 `onApprovalRequest` 审批拦截，拒绝时 1:1 生成工具回执保配对。
  - **主动自我验证纠错闭环（Pre-Complete Verification Gate）**：当模型修改代码后认为已完成（无 `toolCalls` 欲触发 `COMPLETE`）时，自动执行 `verifyCompletion` 验收钩子；若编译或测试报错，通过 `REJECT_COMPLETION` 拒绝结束循环并将报错自动作为新消息打回给模型继续修复，直至验证全绿。
- [x] **Stage 4：KV 前缀缓存保护压缩器 + 标准 MCP 挂载**
  - 在 `src/core/compactor.ts` 中实现“锁死头部前缀 + 折叠过期大体积工具输出 + 保证 `tool_call_id` 原子配对”的纯函数。
  - 在 `src/adapters/mcp-client.ts` 中实现标准 `stdio` JSON-RPC 客户端，支持挂载任意外部 MCP Server。

### 第三周：双栖封装与真实场景赋能（Stage 5）
- [x] **Stage 5：打造「自主探路型双模代码审查特工」+ 暴露标准 RPC/MCP 接口**
  - 利用前 4 关建好的独立内核，组装出具备自主 `grep/read` 探路能力的独立代码与架构审查 CLI（自动生成 `RepoMap` 全库符号地图 + 强制校验单文件行数与纯函数解耦红线）。
  - 暴露极简 HTTP/SSE 接口与多项目交互式终端（`duo`），随时可作为后端大脑接入 Web Generative UI 或桌面端。

---

## 五、 在 `duo-harness` 开启新会话的第一句点火口令

当你切换到 `duo-harness` 工作区开启第一个对话时，直接复制发送以下口令即可无缝开干：

> **`请先读取根目录的 AGENTS.md、ARCH.md 和 ROADMAP.md。我们正式启动 Stage 1（最小闭环 Agent Loop 与四档算力路由器）：请按 AGENTS.md 铁律，先不要写具体实现，先用 5 行话向我报备 Stage 1 准备创建的几个文件及 src/core/contracts.ts 的核心数据结构设计。`**
