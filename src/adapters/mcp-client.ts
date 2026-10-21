import { spawn } from "node:child_process";
import { z } from "zod";
import type { ToolContract } from "../core/contracts.js";
import { killProcessGroup } from "./write-tools.js";

export interface McpToolInfo {
  name: string;
  description?: string;
}

export interface StdioMcpClient {
  initialize(): Promise<void>;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  toToolContracts(options?: { readonly?: boolean }): Promise<ToolContract<any>[]>;
  close(): Promise<void>;
}

interface PendingRpc {
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function parseJsonRpcLine(rawLine: string, pending: Map<number, PendingRpc>): void {
  const trimmed = rawLine.trim();
  if (!trimmed.startsWith("{")) return;
  try {
    const msg = JSON.parse(trimmed) as { id?: number; result?: any; error?: { message?: string } };
    if (typeof msg.id !== "number") return;
    const item = pending.get(msg.id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(msg.id);
    if (msg.error) {
      item.reject(new Error(msg.error.message ?? "MCP RPC error"));
    } else {
      item.resolve(msg.result);
    }
  } catch {
    // 忽略非 JSON-RPC 杂音行
  }
}

function createJsonRpcTransport(
  command: string,
  args: string[],
  cwd: string,
  defaultTimeoutMs: number,
) {
  const child = spawn(command, args, { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let nextId = 1;
  let lineBuffer = "";
  let closed = false;
  const decoder = new TextDecoder("utf-8");
  const pending = new Map<number, PendingRpc>();

  const rejectAllPending = (reason: string) => {
    for (const [, item] of pending) {
      clearTimeout(item.timer);
      item.reject(new Error(reason));
    }
    pending.clear();
  };

  child.stdout.on("data", (chunk: Buffer) => {
    lineBuffer += decoder.decode(chunk, { stream: true });
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) parseJsonRpcLine(line, pending);
  });

  child.stdout.on("error", () => {});
  child.stderr.on("error", () => {});
  child.stdin.on("error", () => {});
  child.on("error", (err) => {
    closed = true;
    rejectAllPending(`MCP 启动失败: ${err.message}`);
  });
  child.on("close", (code) => {
    closed = true;
    rejectAllPending(`MCP 子进程已退出 (code=${code ?? "null"})`);
  });

  return {
    sendRequest(method: string, params: Record<string, unknown> = {}): Promise<any> {
      if (closed) return Promise.reject(new Error("MCP 客户端已关闭"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP 请求超时 (${method}, ${defaultTimeoutMs}ms)`));
        }, defaultTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    sendNotification(method: string) {
      if (!closed) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
    },
    close() {
      if (closed) return;
      closed = true;
      rejectAllPending("MCP 客户端主动关闭");
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      killProcessGroup(child.pid);
    },
  };
}

/**
 * 创建标准 stdio JSON-RPC 2.0 MCP 客户端，支持将外部 MCP Server 工具直接转换为 ToolContract
 */
export function createStdioMcpClient(
  command: string,
  args: string[] = [],
  options: { cwd?: string; timeoutMs?: number } = {},
): StdioMcpClient {
  const rpc = createJsonRpcTransport(
    command,
    args,
    options.cwd ?? process.cwd(),
    options.timeoutMs ?? 8_000,
  );

  return {
    async initialize() {
      await rpc.sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "duo-harness", version: "0.1.0" },
      });
      rpc.sendNotification("notifications/initialized");
    },

    async listTools() {
      const res = await rpc.sendRequest("tools/list", {});
      return Array.isArray(res?.tools) ? res.tools : [];
    },

    async callTool(name: string, toolArgs: Record<string, unknown>) {
      const res = await rpc.sendRequest("tools/call", { name, arguments: toolArgs });
      const contentList = Array.isArray(res?.content) ? res.content : [];
      const text = contentList
        .map((item: any) => (typeof item?.text === "string" ? item.text : JSON.stringify(item)))
        .join("\n");
      if (res?.isError) throw new Error(text || `MCP 工具 ${name} 返回错误`);
      return text || String(res ?? "");
    },

    async toToolContracts(options: { readonly?: boolean } = {}) {
      const mcpTools = await this.listTools();
      return mcpTools.map((info): ToolContract<any> => ({
        name: info.name,
        description: info.description ?? `MCP 外部工具: ${info.name}`,
        parameters: z.object({}).passthrough(),
        readonly: options.readonly ?? true,
        execute: (validatedArgs) => this.callTool(info.name, validatedArgs),
      }));
    },

    async close() {
      rpc.close();
    },
  };
}
