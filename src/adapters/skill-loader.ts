import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { toPosixPath } from "./platform.js";
import { getBuiltinReadonlySkillRoots, resolveExistingRealPath } from "./sandbox-policy.js";

export interface SkillMeta {
  name: string;
  description: string;
  filePath: string;
  scope: "workspace" | "global";
  kind?: "skill" | "command";
  argumentHint?: string;
}

const skillsCache = new Map<string, { ts: number; items: SkillMeta[] }>();

export function invalidateSkillsCache(): void {
  skillsCache.clear();
}

function parseSkillFrontmatter(raw: string, fallbackName: string, isCommand = false): { name: string; description: string; argumentHint?: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const body = match ? raw.slice(match[0].length).trim() : raw.trim();
  const firstLine = body.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
  const defaultDesc = isCommand ? (firstLine.slice(0, 80) || "自定义 Markdown 命令模板") : "本地扩展技能规范";
  if (!match?.[1]) return { name: fallbackName, description: defaultDesc };
  const yaml = match[1];
  const nameMatch = yaml.match(/^name\s*:\s*(.+)$/m);
  const hintMatch = yaml.match(/^argument-hint\s*:\s*(.+)$/m);
  const name = (nameMatch?.[1]?.trim().replace(/^['"]|['"]$/g, "") || fallbackName).slice(0, 48);
  const argumentHint = hintMatch?.[1]?.trim().replace(/^['"]|['"]$/g, "");

  const lines = yaml.split(/\r?\n/);
  let desc = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const dm = line.match(/^description\s*:\s*(.*)$/);
    if (!dm) continue;
    const inline = dm[1]!.trim();
    if (inline && inline !== "|" && inline !== ">") {
      desc = inline.replace(/^['"]|['"]$/g, "");
    } else {
      const block: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s+/.test(lines[j]!)) block.push(lines[j]!.trim());
        else if (lines[j]!.trim()) break;
      }
      desc = block.join(" ");
    }
    break;
  }
  const cleanDesc = (desc.replace(/\s+/g, " ").trim() || defaultDesc).slice(0, 180);
  return { name, description: cleanDesc, ...(argumentHint ? { argumentHint } : {}) };
}

function collectSkillFilesInRoot(rootDir: string, maxDepth = 2): string[] {
  if (!fs.existsSync(rootDir)) return [];
  const results: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const directSkill = entries.find((e) => (e.isFile() || e.isSymbolicLink()) && e.name === "SKILL.md");
    if (directSkill) {
      results.push(path.join(dir, "SKILL.md"));
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const sub = path.join(dir, e.name);
      try {
        if (e.isDirectory() || (e.isSymbolicLink() && fs.statSync(sub).isDirectory())) walk(sub, depth + 1);
      } catch {}
    }
  };
  walk(rootDir, 0);
  return results;
}

function collectCommandMdFiles(rootDir: string, maxDepth = 2): Array<{ file: string; relName: string }> {
  if (!fs.existsSync(rootDir)) return [];
  const results: Array<{ file: string; relName: string }> = [];
  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = path.join(dir, e.name);
      try {
        const isDir = e.isDirectory() || (e.isSymbolicLink() && fs.statSync(full).isDirectory());
        if (isDir) walk(full, prefix ? `${prefix}:${e.name}` : e.name, depth + 1);
        else if ((e.isFile() || e.isSymbolicLink()) && /\.(?:md|markdown)$/i.test(e.name)) {
          const base = e.name.replace(/\.(?:md|markdown)$/i, "");
          results.push({ file: full, relName: prefix ? `${prefix}:${base}` : base });
        }
      } catch {}
    }
  };
  walk(rootDir, "", 0);
  return results;
}

export function discoverAvailableSkills(workspaceRoot: string, homeDir = os.homedir()): SkillMeta[] {
  const cacheKey = `${path.resolve(workspaceRoot)}::${path.resolve(homeDir)}`, now = Date.now(), cached = skillsCache.get(cacheKey);
  if (cached && now - cached.ts < 30_000) return cached.items;
  const wsSkillRoots = [path.join(workspaceRoot, "skills"), path.join(workspaceRoot, ".agents", "skills"), path.join(workspaceRoot, ".duo-harness", "skills")];
  const globalSkillRoots = getBuiltinReadonlySkillRoots(homeDir);
  const wsCmdRoots = [path.join(workspaceRoot, ".claude", "commands"), path.join(workspaceRoot, ".duo-harness", "commands"), path.join(workspaceRoot, ".pi", "prompts")];
  const globalCmdRoots = [path.join(homeDir, ".claude", "commands"), path.join(homeDir, ".duo-harness", "commands"), path.join(homeDir, ".pi", "agent", "prompts")];

  const byName = new Map<string, SkillMeta>();
  const scanSkillGroup = (roots: string[], scope: "workspace" | "global", depth: number) => {
    for (const r of roots) {
      for (const file of collectSkillFilesInRoot(r, depth)) {
        try {
          const realFile = resolveExistingRealPath(file), raw = fs.readFileSync(realFile, "utf-8");
          const { name, description, argumentHint } = parseSkillFrontmatter(raw, path.basename(path.dirname(realFile)), false);
          if (!byName.has(name)) byName.set(name, { name, description, filePath: toPosixPath(realFile), scope, kind: "skill", ...(argumentHint ? { argumentHint } : {}) });
        } catch {}
      }
    }
  };
  const scanCmdGroup = (roots: string[], scope: "workspace" | "global") => {
    for (const r of roots) {
      for (const { file, relName } of collectCommandMdFiles(r, 2)) {
        try {
          const realFile = resolveExistingRealPath(file), raw = fs.readFileSync(realFile, "utf-8");
          const { name, description, argumentHint } = parseSkillFrontmatter(raw, relName, true);
          if (!byName.has(name)) byName.set(name, { name, description, filePath: toPosixPath(realFile), scope, kind: "command", ...(argumentHint ? { argumentHint } : {}) });
        } catch {}
      }
    }
  };

  scanCmdGroup(wsCmdRoots, "workspace");
  scanSkillGroup(wsSkillRoots, "workspace", 2);
  scanCmdGroup(globalCmdRoots, "global");
  scanSkillGroup(globalSkillRoots, "global", 3);
  const items = [...byName.values()];
  skillsCache.set(cacheKey, { ts: now, items });
  return items;
}

export function substitutePromptArgs(content: string, rawArgs: string): string {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  const trimmedArgs = rawArgs.trim();
  const args = (trimmedArgs.match(/(?:"[^"]*"|'[^']*'|[^\s"']+)+/g) ?? []).map((a) => a.replace(/^['"]|['"]$/g, ""));
  const hasPlaceholder = /\$ARGUMENTS|\$@|\$\d+|\$\{@:\d+/.test(body);
  if (!trimmedArgs && !hasPlaceholder) return body;
  const replaced = body
    .replace(/\$(\d+)/g, (_m, n) => args[Number(n) - 1] ?? "")
    .replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_m, s, l) => {
      const start = Math.max(0, Number(s) - 1);
      return (l ? args.slice(start, start + Number(l)) : args.slice(start)).join(" ");
    })
    .replace(/\$ARGUMENTS|\$@/g, trimmedArgs);
  return hasPlaceholder || !trimmedArgs ? replaced.trim() : `${body}\n\nARGUMENTS: ${trimmedArgs}`;
}

export function formatSkillsSystemIndex(skills: readonly SkillMeta[], workspaceRoot?: string): string {
  const blocks: string[] = [];
  if (skills.length > 0) {
    const rows = skills.map((s) => `  - ${s.name}: ${s.description} (path: ${s.filePath})`);
    blocks.push(`- 已安装的扩展技能索引 (<skills> · 仅当用户任务与技能描述明确匹配或点名调用时，用 read_file 按需读取对应 SKILL.md 正文，严禁无关任务盲目读取)：\n<skills>\n${rows.join("\n")}\n</skills>`);
  }
  if (workspaceRoot) {
    const rulesDir = path.join(workspaceRoot, ".claude", "rules");
    const ruleFiles = collectCommandMdFiles(rulesDir, 3).map((r) => `.claude/rules/${toPosixPath(path.relative(rulesDir, r.file))}`);
    if (ruleFiles.length > 0) {
      blocks.push(`- 项目规则文件索引 (<project_rules> · 当工作涉及相关模块时，用 read_file 按需读取对应规则文档)：\n<project_rules>\n${ruleFiles.map((f) => `  - ${f}`).join("\n")}\n</project_rules>`);
    }
  }
  return blocks.join("\n");
}

export function buildSkillDropdownItems(line: string, workspaceRoot: string, homeDir?: string) {
  const filter = line.replace(/^\/skills?\s*/i, "").trim().toLowerCase();
  return discoverAvailableSkills(workspaceRoot, homeDir)
    .filter((s) => !filter || s.name.toLowerCase().includes(filter) || s.description.toLowerCase().includes(filter))
    .slice(0, 8)
    .map((s) => ({
      label: s.kind === "command" ? `/${s.name}` : `/skill ${s.name}`,
      desc: `${s.kind === "command" ? "⚡" : "🧩"} [${s.scope === "workspace" ? "项目" : "全局"}] ${s.description}`,
      fillText: s.kind === "command" ? `/${s.name} ` : `/skill ${s.name} `,
      expandOnly: true,
      cursorAfter: (s.kind === "command" ? `/${s.name} ` : `/skill ${s.name} `).length,
    }));
}

export function expandSkillSlashCommand(rawLine: string, workspaceRoot: string, homeDir?: string): string {
  const m = rawLine.match(/^\/skill\s+([^\s]+)(?:\s+([\s\S]*))?$/i);
  const direct = !m ? rawLine.match(/^\/([a-zA-Z0-9_:-]+)(?:\s+([\s\S]*))?$/) : null;
  const targetName = (m?.[1] ?? direct?.[1] ?? "").toLowerCase();
  if (!targetName) return rawLine;
  const restPrompt = (m ? m[2] : direct?.[2])?.trim() ?? "";
  const skill = discoverAvailableSkills(workspaceRoot, homeDir).find((s) => s.name.toLowerCase() === targetName && (m ? true : s.kind === "command"));
  if (!skill) return rawLine;
  if (skill.kind === "command") {
    try { return substitutePromptArgs(fs.readFileSync(skill.filePath, "utf-8"), restPrompt); } catch { return rawLine; }
  }
  const skillDir = path.posix.dirname(skill.filePath);
  const taskSuffix = restPrompt ? `并按规范完成以下任务：${restPrompt}` : `并按该技能规范执行当前任务。`;
  return `请先调用 read_file 读取技能规范文件 "${skill.filePath}"（该技能内部相对路径基准目录为 "${skillDir}"），${taskSuffix}\n[宿主环境适配说明：当前运行在 Duo-Harness 宿主中，请仅使用当前已注册工具（read_file/list_dir/grep/edit_file/run_bash），自动忽略技能文档中针对其他宿主的专有工具（如 invoke_subagent/view_file/image-generator 等），每步 reasoning 思考严格控制在 200 字以内，直接动手修改目标文件。]`;
}
