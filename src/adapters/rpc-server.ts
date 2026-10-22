import * as http from "node:http";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { LlmProvider, ToolCall } from "../core/contracts.js";
import { listManagedProjects } from "./project-store.js";
import { runCodeReview } from "./reviewer.js";
import { createSessionController, type SessionController } from "./session-controller.js";

const RpcRequestSchema = z.object({
  prompt: z.string().default(""),
  mode: z.enum(["ask", "review"]).default("ask"),
  files: z.array(z.string()).optional(),
  stream: z.boolean().default(false),
  maxSteps: z.number().int().positive().max(50).optional(),
  enableWriteTools: z.boolean().default(true),
  autoApprove: z.boolean().default(false),
});

const RpcCommandSchema = z.object({
  action: z.enum(["status", "turns", "new", "resume", "model", "diff", "undo", "cd", "clear", "projects", "xray"]),
  arg: z.string().optional(),
});

export interface HarnessRpcServerOptions {
  workspaceRoot?: string;
  homeBaseDir?: string;
  provider?: LlmProvider;
  maxBodyBytes?: number;
  onApprovalRequest?: (toolCalls: ToolCall[]) => Promise<{ approved: boolean; reason?: string }> | { approved: boolean; reason?: string };
}

function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        req.destroy();
        reject(new Error(`请求体超出大小上限 (${maxBytes} bytes)`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8").trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error(`JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  if (res.writableEnded) return;
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function streamAskSession(
  res: http.ServerResponse,
  body: z.infer<typeof RpcRequestSchema>,
  ctrl: SessionController,
  options: HarnessRpcServerOptions,
): Promise<void> {
  const abortCtrl = new AbortController();
  let clientClosed = false;
  res.on("close", () => {
    if (!res.writableEnded) {
      clientClosed = true;
      abortCtrl.abort();
    }
  });
  res.on("error", () => {});
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const writeSse = (event: string, data: unknown) => {
    if (!clientClosed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const result = await ctrl.ask(body.prompt, {
      provider: options.provider,
      maxSteps: body.maxSteps,
      signal: abortCtrl.signal,
      enableWriteTools: body.enableWriteTools,
      onApprovalRequest: body.autoApprove ? () => ({ approved: true }) : options.onApprovalRequest,
      onStepEvent: (evt) => writeSse("step", evt),
      onStreamEvent: (evt) => writeSse("stream", evt),
    });
    writeSse("done", { ok: true, ...result });
  } catch (err) {
    writeSse("error", { ok: false, error: err instanceof Error ? err.message : String(err) });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

async function handleCommandPost(req: http.IncomingMessage, res: http.ServerResponse, ctrl: SessionController, options: HarnessRpcServerOptions): Promise<void> {
  try {
    const { action, arg = "" } = RpcCommandSchema.parse(await readJsonBody(req, options.maxBodyBytes ?? 65_536));
    if (action === "status") return sendJson(res, 200, { ok: true, status: ctrl.getStatus(), turns: ctrl.listTurns(), diff: ctrl.getDiff() });
    if (action === "turns") return sendJson(res, 200, { ok: true, turns: ctrl.listTurns() });
    if (action === "new") return sendJson(res, 200, { ok: true, status: ctrl.newSession() });
    if (action === "resume") {
      const r = ctrl.resumeTurn(arg.trim());
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    if (action === "model") {
      const m = arg.trim().toLowerCase();
      if (m !== "auto" && m !== "deepseek" && m !== "mimo" && m !== "openai") return sendJson(res, 400, { ok: false, error: `不支持的模型模式: ${arg}` });
      return sendJson(res, 200, { ok: true, status: ctrl.setModelMode(m) });
    }
    if (action === "diff") return sendJson(res, 200, { ok: true, ...ctrl.getDiff() });
    if (action === "undo") return sendJson(res, 200, { ok: true, ...(await ctrl.undo(arg.trim() || "1")) });
    if (action === "cd") {
      const sw = ctrl.switchWorkspace(arg.trim());
      return sendJson(res, sw.ok ? 200 : 400, sw);
    }
    if (action === "clear") return sendJson(res, 200, { ok: true, status: ctrl.clearHistory() });
    if (action === "projects") return sendJson(res, 200, { ok: true, projects: listManagedProjects(options.homeBaseDir) });
    if (action === "xray") return sendJson(res, 200, { ok: true, ...ctrl.getXrayReport() });
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleSessionPost(req: http.IncomingMessage, res: http.ServerResponse, ctrl: SessionController, options: HarnessRpcServerOptions): Promise<void> {
  let body: z.infer<typeof RpcRequestSchema>;
  try {
    body = RpcRequestSchema.parse(await readJsonBody(req, options.maxBodyBytes ?? 65_536));
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
    return;
  }

  try {
    if (body.mode === "review") {
      if (!body.files || body.files.length === 0) return sendJson(res, 400, { ok: false, error: "review 模式必须提供非空 files 数组" });
      const reviewRes = await runCodeReview({ workspaceRoot: ctrl.getPaths().workspaceRoot, files: body.files, provider: options.provider, maxSteps: body.maxSteps });
      return sendJson(res, 200, { ok: true, ...reviewRes });
    }
    if (!body.prompt.trim()) return sendJson(res, 400, { ok: false, error: "ask 模式必须提供非空 prompt" });
    if (body.stream || (req.headers.accept ?? "").includes("text/event-stream")) {
      await streamAskSession(res, body, ctrl, options);
      return;
    }
    const askRes = await ctrl.ask(body.prompt, {
      provider: options.provider,
      maxSteps: body.maxSteps,
      enableWriteTools: body.enableWriteTools,
      onApprovalRequest: body.autoApprove ? () => ({ approved: true }) : options.onApprovalRequest,
    });
    sendJson(res, 200, { ok: true, ...askRes });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export function createHarnessRpcServer(options: HarnessRpcServerOptions = {}): http.Server {
  const ctrl = createSessionController({ workspaceRoot: options.workspaceRoot, homeBaseDir: options.homeBaseDir, provider: options.provider });
  return http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (req.method === "GET" && url === "/health") return sendJson(res, 200, { ok: true, status: "healthy" });
    if (req.method === "GET" && url === "/api/status") return sendJson(res, 200, { ok: true, status: ctrl.getStatus(), turns: ctrl.listTurns(), diff: ctrl.getDiff() });
    if (req.method === "POST" && url === "/api/command") { void handleCommandPost(req, res, ctrl, options); return; }
    if (req.method === "POST" && url === "/api/session") { void handleSessionPost(req, res, ctrl, options); return; }
    sendJson(res, 404, { ok: false, error: `未知路由: ${req.method} ${url}` });
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.PORT ?? 3210);
  createHarnessRpcServer().listen(port, "127.0.0.1", () => {
    console.log(`🚀 [Duo-Harness RPC Server] 已启动: http://127.0.0.1:${port} (GET /health, GET /api/status, POST /api/command, POST /api/session)`);
  });
}
