# Duo-Harness

Zero-host-lock-in **Functional Core + Imperative Shell** TypeScript Agent Harness (`< 2,500 lines`).

## 核心特性 (Stage 1 ~ Stage 5)

1. **纯函数状态机 (`src/core/loop.ts`)**：`Idle -> Thinking -> AwaitingApproval -> Executing -> Done/Error`，支持写操作暂停审批（HITL）与完成前验证不过自动打回重修（`REJECT_COMPLETION`）。
2. **Append-only `.jsonl` 会话树与 0 毫秒离线回放 (`src/core/session-tree.ts`, `src/adapters/store.ts`)**：顺着 `parentId` 派生上下文并强制检查 `toolCall` 1:1 配对；支持断网 0 成本回归回放。
3. **KV 前缀缓存保护与零 Bug 成本统计 (`src/core/compactor.ts`, `src/adapters/cost-tracker.ts`)**：按需增量折叠最旧超长工具输出，锁死 64-Token 块级前缀缓存；内置 DeepSeek / 小米 MiMo 2.6 分时成本与历史前缀复用率诊断面板。
4. **沙箱工具、版本回滚与标准 MCP (`src/adapters/tools.ts`, `write-tools.ts`, `mcp-client.ts`)**：带行号切片 `read_file`、带上下文 `grep`、进程组级超时清剿 `run_bash`、异常熔断自动逆序还原文件快照，以及标准 `stdio` JSON-RPC 2.0 MCP 客户端。
5. **自主探路代码审查特工与 HTTP/SSE 接口 (`src/adapters/reviewer.ts`, `rpc-server.ts`)**：自动生成全库 `RepoMap` 导出符号行号地图 + 静态架构红线扫描 + 只读探路追查 + Zod 结构化报告强校验；原生 `node:http` 暴露 JSON 与 `text/event-stream` SSE 实时流接口。

## 快速上手 (统一使用 `pnpm`)

```bash
# 1. 运行全套类型检查与 24 项自动化测试
pnpm verify

# 2. 运行真实大模型录制 + 断网 0 毫秒回放 + 成本与 KV 缓存账单演示
pnpm play

# 3. 命令行直接提问 / 编程开发
pnpm ask "请读取 package.json 并总结项目结构"

# 4. 运行自主探路型代码与架构审查特工
pnpm review src/core/loop.ts

# 5. 启动 HTTP JSON / SSE 接口服务 (默认 http://127.0.0.1:3210)
pnpm serve
```
