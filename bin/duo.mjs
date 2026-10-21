#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
const args = process.argv.slice(2);
const targetScript =
  args.length > 0 && !args[0].startsWith("-")
    ? path.join(repoRoot, "src", "adapters", "cli.ts")
    : path.join(repoRoot, "src", "adapters", "repl.ts");

const child = spawn(tsxBin, [targetScript, ...args], {
  stdio: "inherit",
  cwd: process.cwd(),
});
child.on("exit", (code) => process.exit(code ?? 0));
