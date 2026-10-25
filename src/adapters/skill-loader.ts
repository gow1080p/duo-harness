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
}

function parseSkillFrontmatter(raw: string, fallbackName: string): { name: string; description: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return { name: fallbackName, description: "本地扩展技能规范" };
  const yaml = match[1];
  const nameMatch = yaml.match(/^name\s*:\s*(.+)$/m);
  const name = (nameMatch?.[1]?.trim().replace(/^['"]|['"]$/g, "") || fallbackName).slice(0, 48);

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
  const cleanDesc = (desc.replace(/\s+/g, " ").trim() || "本地扩展技能规范").slice(0, 180);
  return { name, description: cleanDesc };
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

export function discoverAvailableSkills(workspaceRoot: string, homeDir = os.homedir()): SkillMeta[] {
  const wsCandidates = [
    path.join(workspaceRoot, "skills"),
    path.join(workspaceRoot, ".agents", "skills"),
    path.join(workspaceRoot, ".duo-harness", "skills"),
  ];
  const globalCandidates = getBuiltinReadonlySkillRoots(homeDir);

  const byName = new Map<string, SkillMeta>();
  const scanGroup = (roots: string[], scope: "workspace" | "global", depth: number) => {
    for (const r of roots) {
      for (const file of collectSkillFilesInRoot(r, depth)) {
        try {
          const realFile = resolveExistingRealPath(file);
          const raw = fs.readFileSync(realFile, "utf-8");
          const fallback = path.basename(path.dirname(realFile));
          const { name, description } = parseSkillFrontmatter(raw, fallback);
          if (!byName.has(name)) {
            byName.set(name, { name, description, filePath: toPosixPath(realFile), scope });
          }
        } catch {}
      }
    }
  };

  scanGroup(wsCandidates, "workspace", 2);
  scanGroup(globalCandidates, "global", 3);
  return [...byName.values()];
}

export function formatSkillsSystemIndex(skills: readonly SkillMeta[]): string {
  if (skills.length === 0) return "";
  const rows = skills.map((s) => `  - ${s.name}: ${s.description} (path: ${s.filePath})`);
  return [
    `- 已安装的扩展技能索引 (<skills> · 仅当用户任务与技能描述明确匹配或点名调用时，用 read_file 按需读取对应 SKILL.md 正文，严禁无关任务盲目读取)：`,
    `<skills>`,
    ...rows,
    `</skills>`,
  ].join("\n");
}

export function buildSkillDropdownItems(line: string, workspaceRoot: string, homeDir?: string) {
  const filter = line.replace(/^\/skills?\s*/i, "").trim().toLowerCase();
  return discoverAvailableSkills(workspaceRoot, homeDir)
    .filter((s) => !filter || s.name.toLowerCase().includes(filter) || s.description.toLowerCase().includes(filter))
    .slice(0, 8)
    .map((s) => ({
      label: `/skill ${s.name}`,
      desc: `🧩 [${s.scope === "workspace" ? "项目" : "全局"}] ${s.description}`,
      fillText: `/skill ${s.name} `,
      expandOnly: true,
      cursorAfter: `/skill ${s.name} `.length,
    }));
}

export function expandSkillSlashCommand(rawLine: string, workspaceRoot: string, homeDir?: string): string {
  const m = rawLine.match(/^\/skill\s+([^\s]+)(?:\s+([\s\S]*))?$/i);
  if (!m?.[1]) return rawLine;
  const targetName = m[1].toLowerCase();
  const restPrompt = m[2]?.trim() ?? "";
  const skill = discoverAvailableSkills(workspaceRoot, homeDir).find((s) => s.name.toLowerCase() === targetName);
  if (!skill) return rawLine;
  const skillDir = path.posix.dirname(skill.filePath);
  const taskSuffix = restPrompt ? `并按规范完成以下任务：${restPrompt}` : `并按该技能规范执行当前任务。`;
  return `请先调用 read_file 读取技能规范文件 "${skill.filePath}"（该技能内部相对路径基准目录为 "${skillDir}"），${taskSuffix}\n[宿主环境适配说明：当前运行在 Duo-Harness 宿主中，请仅使用当前已注册工具（read_file/list_dir/grep/edit_file/run_bash），自动忽略技能文档中针对其他宿主的专有工具（如 invoke_subagent/view_file/image-generator 等），每步 reasoning 思考严格控制在 200 字以内，直接动手修改目标文件。]`;
}
