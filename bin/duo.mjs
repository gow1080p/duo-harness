#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const args = process.argv.slice(2);
const targetScript = path.join(repoRoot, "src", "adapters", "repl.ts");

const child = spawn(process.execPath, [tsxCli, targetScript, ...args], {
  stdio: "inherit",
  cwd: process.cwd(),
  windowsHide: true,
});
child.on("exit", (code) => process.exit(code ?? 0));
