import * as fs from "node:fs";
import { runAgentSession } from "./src/adapters/cli.js";
import {
  createReplayProvider,
  loadJsonlEntries,
} from "./src/adapters/store.js";
import { analyzeSessionXray, formatXrayReport } from "./src/adapters/xray.js";

const sessionFile = ".sessions/play.jsonl";
const wireLogFile = ".sessions/http-wire.json";
const myQuestion = "告诉我我的数据存在哪的";

function needsRecording(filePath: string, currentQuestion: string): boolean {
  try {
    if (!fs.existsSync(filePath) || !fs.existsSync(wireLogFile)) return true;
    const entries = loadJsonlEntries(filePath);
    createReplayProvider(entries);
    const recordedQuestion = entries.find((e) => e.message.role === "user")
      ?.message.content;
    const lastMsg = entries[entries.length - 1]?.message;
    const isFinished =
      lastMsg?.role === "assistant" &&
      (!lastMsg.toolCalls || lastMsg.toolCalls.length === 0);
    return recordedQuestion !== currentQuestion || !isFinished;
  } catch {
    return true;
  }
}

async function main() {
  if (needsRecording(sessionFile, myQuestion)) {
    console.log(
      "=== 🎬 第 1 步：检测到新问题或空记录，正在调用真实大模型并录制到 .sessions/play.jsonl ===",
    );
    await runAgentSession(myQuestion, {
      sessionFile,
      wireLogFile,
      showCostReport: true,
      enableWriteTools: true,
      onApprovalRequest: (toolCalls) => {
        console.log(
          `   👀 [审批详情] 允许执行写工具:`,
          JSON.stringify(toolCalls.map((c) => ({ name: c.name, args: c.arguments }))),
        );
        return { approved: true };
      },
    });
  }

  console.log(
    "\n=== 📼 第 2 步：断网 0 毫秒回放模式（直接读取刚才存下的 .sessions/play.jsonl，不发 HTTP 请求，花费 ¥0） ===",
  );
  const startMs = performance.now();
  await runAgentSession(myQuestion, {
    replayFromFile: sessionFile,
    wireLogFile,
    showCostReport: true,
    enableWriteTools: true,
  });
  const costMs = (performance.now() - startMs).toFixed(1);
  console.log(formatXrayReport(analyzeSessionXray(sessionFile, wireLogFile)));
  console.log(
    `\n⚡ [回放与 X-Ray 透视完成] 耗时仅 ${costMs} 毫秒！你也可以运行 pnpm xray 生成可视化 Mermaid 时序报告。`,
  );
}

main();
