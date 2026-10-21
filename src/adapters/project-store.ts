import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadJsonlEntries } from "./store.js";

export interface ProjectSessionPaths {
  projectKey: string;
  workspaceRoot: string;
  projectDir: string;
  sessionFile: string;
  wireLogFile: string;
  metaFile: string;
}

export interface ManagedProjectSummary {
  projectKey: string;
  workspaceRoot: string;
  updatedAt: string;
  entryCount: number;
  lastLeafId: string | null;
}

export const SLASH_COMMANDS = [
  { cmd: "/cd ", label: "/cd <项目>", desc: "切换项目工作区 (按回车直接展开项目列表)" },
  { cmd: "/projects", label: "/projects", desc: "查看本机已管理的所有项目列表" },
  { cmd: "/xray", label: "/xray", desc: "查看每步耗时、缓存命中与费用账单" },
  { cmd: "/tree", label: "/tree", desc: "查看对话历史节点树 ID" },
  { cmd: "/branch ", label: "/branch <id>", desc: "从指定历史节点分叉重聊" },
  { cmd: "/undo", label: "/undo", desc: "撤回最近 1 次文件修改" },
  { cmd: "/clear", label: "/clear", desc: "清空当前对话重新开始" },
  { cmd: "/exit", label: "/exit", desc: "退出交互终端" },
] as const;

export function resolveProjectSessionPaths(
  workspaceRoot = process.cwd(),
  homeBaseDir = path.join(os.homedir(), ".duo-harness", "projects"),
): ProjectSessionPaths {
  const resolved = path.resolve(workspaceRoot);
  const realRoot = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
  const baseName = path.basename(realRoot).replace(/[^a-zA-Z0-9_-]/g, "_") || "root";
  const hash8 = crypto.createHash("sha256").update(realRoot).digest("hex").slice(0, 8);
  const projectKey = `${baseName}-${hash8}`;
  const projectDir = path.join(homeBaseDir, projectKey);
  fs.mkdirSync(projectDir, { recursive: true });
  const metaFile = path.join(projectDir, "meta.json");
  fs.writeFileSync(
    metaFile,
    JSON.stringify({ projectKey, workspaceRoot: realRoot, updatedAt: new Date().toISOString() }, null, 2),
    "utf-8",
  );
  return {
    projectKey,
    workspaceRoot: realRoot,
    projectDir,
    sessionFile: path.join(projectDir, "chat.jsonl"),
    wireLogFile: path.join(projectDir, "http-wire.json"),
    metaFile,
  };
}

export function listManagedProjects(
  homeBaseDir = path.join(os.homedir(), ".duo-harness", "projects"),
): ManagedProjectSummary[] {
  if (!fs.existsSync(homeBaseDir)) return [];
  const dirs = fs.readdirSync(homeBaseDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  const list: ManagedProjectSummary[] = [];
  for (const d of dirs) {
    try {
      const pDir = path.join(homeBaseDir, d.name);
      const meta = JSON.parse(fs.readFileSync(path.join(pDir, "meta.json"), "utf-8"));
      const sFile = path.join(pDir, "chat.jsonl");
      const entries = fs.existsSync(sFile) ? loadJsonlEntries(sFile) : [];
      list.push({
        projectKey: String(meta.projectKey ?? d.name),
        workspaceRoot: String(meta.workspaceRoot ?? ""),
        updatedAt: String(meta.updatedAt ?? ""),
        entryCount: entries.length,
        lastLeafId: entries.length > 0 ? entries[entries.length - 1]!.id : null,
      });
    } catch {
      continue;
    }
  }
  return list.sort((a, b) => a.projectKey.localeCompare(b.projectKey));
}

export function createReplCompleter(getWorkspaceRoot: () => string, getSessionFile: () => string) {
  return (line: string): [string[], string] => {
    if (line.startsWith("/cd ")) {
      const rawArg = line.slice(4);
      const managedNames = listManagedProjects()
        .map((p) => path.basename(p.workspaceRoot))
        .filter((name) => name.startsWith(rawArg))
        .map((name) => `/cd ${name}`);
      const expanded = rawArg.startsWith("~/") ? path.join(os.homedir(), rawArg.slice(2)) : rawArg;
      const fullTarget = path.resolve(getWorkspaceRoot(), expanded || ".");
      const searchDir = rawArg.endsWith("/") && fs.existsSync(fullTarget) ? fullTarget : path.dirname(fullTarget);
      const prefix = rawArg.endsWith("/") ? "" : path.basename(expanded);
      try {
        const dirs = fs
          .readdirSync(searchDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name.startsWith(prefix))
          .map((d) => `/cd ${rawArg.slice(0, rawArg.length - prefix.length)}${d.name}/`);
        return [[...new Set([...managedNames, ...dirs])], line];
      } catch {
        return [managedNames, line];
      }
    }
    if (line.startsWith("/branch ")) {
      const sFile = getSessionFile();
      const entries = fs.existsSync(sFile) ? loadJsonlEntries(sFile) : [];
      const hits = entries.map((e) => `/branch ${e.id}`).filter((c) => c.startsWith(line));
      return [hits, line];
    }
    if (line.startsWith("/")) {
      const all = SLASH_COMMANDS.map((c) => c.cmd);
      const hits = all.filter((c) => c.startsWith(line));
      return [hits.length > 0 ? hits : all, line];
    }
    return [[], line];
  };
}
