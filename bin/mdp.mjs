#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(repoRoot, "node_modules", "tsx", "dist");
const preflight = path.join(distDir, "preflight.cjs");
const loader = pathToFileURL(path.join(distDir, "loader.mjs")).href;
const mdPreviewEntry = path.join(repoRoot, "src", "adapters", "md-preview.ts");

const args = process.argv.slice(2);
const allowCreate = args.includes("--new") || args.includes("-n");
const rawArg = args.filter((a) => !a.startsWith("-"))[0] ?? "";
const ws = process.cwd();

function resolveTarget(): string {
  if (rawArg) return path.resolve(ws, rawArg.startsWith("~/") || rawArg.startsWith("~\\") ? path.join(process.env.USERPROFILE || process.env.HOME || "", rawArg.slice(2)) : rawArg);
  const planFile = path.join(ws, ".debug", "plan.md");
  if (fs.existsSync(planFile)) return planFile;
  try {
    const mdFiles = fs.readdirSync(ws, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(?:md|markdown)$/i.test(e.name))
      .map((e) => { const full = path.join(ws, e.name); return { full, mtime: fs.statSync(full).mtimeMs }; })
      .sort((a, b) => b.mtime - a.mtime);
    if (mdFiles[0]) return mdFiles[0].full;
  } catch {}
  return path.join(ws, "README.md");
}

const resolved = resolveTarget();
if (!fs.existsSync(resolved) && !allowCreate) {
  console.error(`⚠️ 未找到 Markdown 文件: ${resolved} (如需新建请加 --new)`);
  process.exit(1);
}

const nodeArgs = ["--require", preflight, "--import", loader, mdPreviewEntry, "--serve-md-preview", resolved];
const child = spawn(process.execPath, nodeArgs, { detached: true, stdio: "ignore", windowsHide: true });
child.on("error", () => {});
child.unref();
console.log(`📝 已拉起 Markdown 预览与实时编辑窗: ${resolved} (按 E 编辑 · Ctrl+S/自动保存 · Esc 关闭)`);
