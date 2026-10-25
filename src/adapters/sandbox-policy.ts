import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolCall } from "../core/contracts.js";
import { isReadonlyBashCommand } from "./bash-policy.js";
import { expandHomePath, isPathInside, sanitizeSubprocessEnv, SENSITIVE_SUBPROCESS_ENV_RE, toPosixPath } from "./platform.js";

export { sanitizeSubprocessEnv };
export type SandboxRiskTier = "allow" | "ask_workspace" | "ask_escalated" | "deny";

export interface SandboxGrants {
  trustedReadDirs: Set<string>; trustedWriteDirs: Set<string>; onceAllowedPaths: Set<string>; reset(): void;
}

export interface ToolRiskDecision {
  tier: SandboxRiskTier; reason?: string; externalDirs: string[];
}

export interface BatchCallsEvaluation {
  callsNeedingApproval: ToolCall[]; deniedReasons: string[]; escalatedReasons: string[];
  externalDirs: string[]; hasDenied: boolean; hasEscalated: boolean;
}

const HARD_DENY_HOME_ENTRIES = new Set([
  ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".claude", ".claude.json",
  ".codex", ".config", ".continue", ".gemini", ".netrc", ".git-credentials", ".npmrc", ".pypirc", ".env",
]);

const SYSTEM_ESCALATED_CMD_RE =
  /(?:^|[;&|]\s*)(?:sudo\s+|su\s+|(?:npm|pnpm|yarn|bun|pip3?|cargo)\s+install\s+(?:[^;&|]*\s+)?(?:-g|--global)\b|(?:brew|winget|apt|apt-get|yum|choco)\s+(?:install|remove|uninstall|upgrade)\b|(?:kill|pkill|killall|taskkill|Stop-Process)\s+|(?:chmod|chown)\s+|(?:ssh|scp|sftp|rsync)\s+)/i;

const HARD_DENY_CMD_RE =
  /(?:^|[;&|]\s*)(?:printenv\s*(?:$|[;&|>])|env\s*(?:$|[;&|>])|set\s*(?:$|[;&|>])|export\s+-p\b|declare\s+-xp\b|Get-ChildItem\s+Env:|dir\s+env:|rm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+(?:\/|\*+|~|\$HOME)\s*(?:$|[;&|]))/i;

export function createSandboxGrants(): SandboxGrants {
  const trustedReadDirs = new Set<string>(), trustedWriteDirs = new Set<string>(), onceAllowedPaths = new Set<string>();
  return {
    trustedReadDirs, trustedWriteDirs, onceAllowedPaths,
    reset() { trustedReadDirs.clear(); trustedWriteDirs.clear(); onceAllowedPaths.clear(); },
  };
}

export function resolveExistingRealPath(targetPath: string): string {
  let curr = path.resolve(targetPath);
  const tailSegments: string[] = [];
  while (!fsSync.existsSync(curr)) {
    const parent = path.dirname(curr);
    if (parent === curr) break;
    tailSegments.unshift(path.basename(curr));
    curr = parent;
  }
  const realBase = fsSync.existsSync(curr) ? fsSync.realpathSync(curr) : curr;
  return path.join(realBase, ...tailSegments);
}

export function getBuiltinReadonlySkillRoots(home = os.homedir()): string[] {
  return [
    path.join(home, ".duo-harness", "skills"),
    path.join(home, ".codex", "skills"),
    path.join(home, ".agents", "skills"),
    path.join(home, ".claude", "skills"),
    path.join(home, ".gemini", "config", "plugins"),
    path.join(home, ".gemini", "antigravity", "builtin", "skills"),
  ].map(resolveExistingRealPath);
}

function isGrantedBySession(realCandidate: string, mode: "read" | "write", grants?: SandboxGrants): boolean {
  if (!grants) return false;
  for (const p of grants.onceAllowedPaths) if (isPathInside(realCandidate, p)) return true;
  const dirs = mode === "write" ? [...grants.trustedWriteDirs] : [...grants.trustedReadDirs, ...grants.trustedWriteDirs];
  return dirs.some((d) => isPathInside(realCandidate, d));
}

export function checkHardDeniedPath(realCandidate: string, realRoot: string, mode: "read" | "write"): string | null {
  if (isPathInside(realCandidate, realRoot)) return null;
  const home = resolveExistingRealPath(os.homedir());
  if (mode === "read" && getBuiltinReadonlySkillRoots(home).some((r) => isPathInside(realCandidate, r))) return null;
  const normCand = process.platform === "win32" ? realCandidate.toLowerCase() : realCandidate;
  const normHome = process.platform === "win32" ? home.toLowerCase() : home;
  if (normCand === normHome) return `禁止直接枚举或访问用户主目录根部 (~)`;
  if (isPathInside(realCandidate, home)) {
    const relFirst = path.relative(home, realCandidate).split(/[\\/]/)[0]?.toLowerCase() ?? "";
    if (HARD_DENY_HOME_ENTRIES.has(relFirst) || relFirst.startsWith(".claude") || relFirst.startsWith(".codex")) {
      return `禁止访问用户主目录敏感凭据或隐藏配置 (~/${relFirst})（严禁将密钥明文读入大模型上下文；若业务代码需读取该密钥文件，请在业务代码中直接编写 fs.readFileSync 等运行时读取逻辑，切勿调用工具读取密钥明文）`;
    }
  }
  return null;
}

export function resolveSafePath(workspaceRoot: string, targetPath: string, mode: "read" | "write" = "read", grants?: SandboxGrants): string {
  const home = os.homedir();
  const expanded = expandHomePath(targetPath.replace(/\$HOME|\$\{HOME\}|%USERPROFILE%/gi, home), home);
  const realCandidate = resolveExistingRealPath(path.resolve(workspaceRoot, expanded));
  const realRoot = resolveExistingRealPath(workspaceRoot);
  if (isPathInside(realCandidate, realRoot)) return realCandidate;
  if (mode === "read" && getBuiltinReadonlySkillRoots(home).some((r) => isPathInside(realCandidate, r))) return realCandidate;
  const denyMsg = checkHardDeniedPath(realCandidate, realRoot, mode);
  if (denyMsg) throw new Error(`[沙箱安全拦截] 禁止访问敏感路径 (${denyMsg}): ${targetPath}`);
  if (isGrantedBySession(realCandidate, mode, grants)) return realCandidate;
  throw new Error(`禁止访问工作区以外的路径 (未授权 ${mode}): ${targetPath}`);
}

export function toGrantDir(realCandidate: string): string {
  try { if (fsSync.existsSync(realCandidate) && fsSync.statSync(realCandidate).isDirectory()) return realCandidate; } catch {}
  const parent = path.dirname(realCandidate);
  const home = resolveExistingRealPath(os.homedir());
  if (parent === realCandidate || isPathInside(home, parent)) return realCandidate;
  return parent;
}

const PATTERN_FIRST_VERBS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "sed", "awk"]);

export function extractBashCandidatePaths(rawCmd: string): string[] {
  const stripped = rawCmd.replace(/(?:[12]?>\s*\/dev\/null|<\s*\/dev\/null)/g, " ");
  const tokensAndOps = stripped.match(/(?:'[^']*'|"(?:[^"\\]|\\.)*"|\|\||&&|[;&|]|[^\s;&|><]+)/g) ?? [];
  const out: string[] = [];
  let seg: string[] = [];
  const flushSeg = () => {
    let i = 0;
    while (i < seg.length && (/^[A-Za-z_]\w*=/.test(seg[i]!) || /^(?:command|do|if|then|elif|else|env|sudo|nohup)$/.test(seg[i]!))) i++;
    const verb = (seg[i] ?? "").replace(/^['"]|['"]$/g, "");
    if (!verb || verb === "echo" || verb === "printf") { seg = []; return; }
    const isPatternVerb = PATTERN_FIRST_VERBS.has(verb);
    let skipNext = false, hasExplicitPattern = false, positionalIdx = 0;
    for (let j = i + 1; j < seg.length; j++) {
      const tok = seg[j]!;
      if (skipNext) { skipNext = false; continue; }
      if (isPatternVerb && (tok === "-e" || tok === "-f" || tok === "--regexp" || tok === "--file")) {
        hasExplicitPattern = true;
        if (tok === "-e" || tok === "--regexp") skipNext = true;
        continue;
      }
      const unquoted = tok.replace(/^['"]|['"]$/g, "");
      if (unquoted.startsWith("-")) {
        const eqIdx = unquoted.indexOf("=");
        if (eqIdx > 0 && !/^-(?:e|-regexp)=/.test(unquoted)) out.push(unquoted.slice(eqIdx + 1));
        continue;
      }
      positionalIdx++;
      if (isPatternVerb && !hasExplicitPattern && positionalIdx === 1) continue;
      if ((tok.startsWith('"') || tok.startsWith("'")) && process.platform === "win32" && /^\/(?!(?:Users|home|root|etc|var|opt|private)\b)/.test(unquoted)) continue;
      out.push(unquoted);
    }
    seg = [];
  };
  for (const t of tokensAndOps) {
    if (/^(?:\|\||&&|[;&|])$/.test(t)) flushSeg();
    else seg.push(t);
  }
  flushSeg();
  return out;
}

export function analyzeBashSandbox(cmd: string, workspaceRoot: string, grants?: SandboxGrants): ToolRiskDecision {
  const raw = cmd.trim();
  if (HARD_DENY_CMD_RE.test(raw) || /\$(?:MIMO_|DEEPSEEK_|OPENAI_|ANTHROPIC_|GEMINI_)[A-Z0-9_]*/i.test(raw)) {
    return { tier: "deny", reason: "禁止导出全量系统环境变量或探测宿主敏感密钥", externalDirs: [] };
  }
  if (/^printenv\s+(\S+)/i.test(raw)) {
    const arg = raw.match(/^printenv\s+(\S+)/i)?.[1] ?? "";
    if (SENSITIVE_SUBPROCESS_ENV_RE.test(arg)) return { tier: "deny", reason: `禁止读取敏感环境变量 (${arg})`, externalDirs: [] };
  }
  const home = os.homedir(), realRoot = resolveExistingRealPath(workspaceRoot);
  const externalDirs = new Set<string>();
  let escalatedReason: string | undefined;

  for (const clean of extractBashCandidatePaths(raw)) {
    if (!clean || /^\\+$/.test(clean) || /[|^$(){}<>]/.test(clean) || /^(?:https?|file):\/\//i.test(clean)) continue;
    if (/^\/dev\/(?:null|fd|stdin|stdout|stderr)/.test(clean) || /^\/(?:private\/)?tmp\/[a-zA-Z0-9_.-]+\.(?:log|pid|out)$/i.test(clean) || /^\/\/[a-zA-Z0-9_?-]+$/.test(clean)) continue;
    const expanded = clean.replace(/\$HOME|\$\{HOME\}|%USERPROFILE%/gi, home).replace(/([\\/])[*?[\]]+(?=[\\/]|$)/g, "$1_").replace(/[*?[\]]+/g, "");
    const candidatePath = path.resolve(workspaceRoot, expandHomePath(expanded, home));
    const looksLikePath = /^(?:~(?:[\\/]|$)|\/|[A-Za-z]:[\\/])/.test(expanded) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(expanded) || fsSync.existsSync(candidatePath);
    if (!looksLikePath) continue;
    const realCand = resolveExistingRealPath(candidatePath);
    const hardDeny = checkHardDeniedPath(realCand, realRoot, "read");
    if (hardDeny) return { tier: "deny", reason: `${hardDeny} (${clean})`, externalDirs: [] };
    if (!isPathInside(realCand, realRoot) && !isGrantedBySession(realCand, "read", grants) && !getBuiltinReadonlySkillRoots(home).some((r) => isPathInside(realCand, r))) {
      externalDirs.add(toGrantDir(realCand));
      escalatedReason ??= `命令访问工作区外路径: ${toPosixPath(realCand)}`;
    }
  }
  if (SYSTEM_ESCALATED_CMD_RE.test(raw)) escalatedReason ??= `执行系统级或全局特权指令: ${raw.slice(0, 48)}`;
  if (/\b(?:curl|wget)\b/i.test(raw) && !/(?:127\.0\.0\.1|localhost)/i.test(raw)) escalatedReason ??= `发起外部网络请求: ${raw.slice(0, 48)}`;
  if (escalatedReason) return { tier: "ask_escalated", reason: escalatedReason, externalDirs: [...externalDirs] };
  if (isReadonlyBashCommand(raw, undefined, workspaceRoot)) return { tier: "allow", externalDirs: [] };
  return { tier: "ask_workspace", externalDirs: [] };
}

export function classifyToolCallRisk(call: ToolCall, workspaceRoot: string, readonlyMap: Map<string, boolean>, grants?: SandboxGrants): ToolRiskDecision {
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  if (call.name === "run_bash") {
    const res = analyzeBashSandbox(String(args.command ?? ""), workspaceRoot, grants);
    return res.tier === "allow" && args.readonly === false ? { tier: "ask_workspace", externalDirs: [] } : res;
  }
  if (call.name === "read_file" || call.name === "list_dir" || call.name === "grep" || call.name === "edit_file") {
    const mode = call.name === "edit_file" ? "write" : "read", rawPath = String(args.path ?? "."), home = os.homedir();
    const realCand = resolveExistingRealPath(path.resolve(workspaceRoot, expandHomePath(rawPath.replace(/\$HOME|\$\{HOME\}|%USERPROFILE%/gi, home), home)));
    const realRoot = resolveExistingRealPath(workspaceRoot);
    const hardDeny = checkHardDeniedPath(realCand, realRoot, mode);
    if (hardDeny) return { tier: "deny", reason: `${hardDeny} (${rawPath})`, externalDirs: [] };
    const inAllowed = isPathInside(realCand, realRoot) || isGrantedBySession(realCand, mode, grants) || (mode === "read" && getBuiltinReadonlySkillRoots(home).some((r) => isPathInside(realCand, r)));
    if (!inAllowed) return { tier: "ask_escalated", reason: `申请${mode === "write" ? "修改" : "读取"}工作区外路径: ${toPosixPath(realCand)}`, externalDirs: [toGrantDir(realCand)] };
    return { tier: mode === "write" ? "ask_workspace" : "allow", externalDirs: [] };
  }
  return { tier: readonlyMap.get(call.name) === false ? "ask_workspace" : "allow", externalDirs: [] };
}

export function evaluateBatchCallsRisk(calls: readonly ToolCall[], workspaceRoot: string, readonlyMap: Map<string, boolean>, grants?: SandboxGrants): BatchCallsEvaluation {
  const callsNeedingApproval: ToolCall[] = [], deniedReasons: string[] = [], escalatedReasons: string[] = [], externalDirs = new Set<string>();
  for (const c of calls) {
    const dec = classifyToolCallRisk(c, workspaceRoot, readonlyMap, grants);
    if (dec.tier === "deny") deniedReasons.push(dec.reason ?? `禁止执行高危操作 (${c.name})`);
    else if (dec.tier === "ask_escalated") {
      callsNeedingApproval.push(c);
      if (dec.reason) escalatedReasons.push(dec.reason);
      for (const d of dec.externalDirs) externalDirs.add(d);
    } else if (dec.tier === "ask_workspace") callsNeedingApproval.push(c);
  }
  return { callsNeedingApproval, deniedReasons, escalatedReasons, externalDirs: [...externalDirs], hasDenied: deniedReasons.length > 0, hasEscalated: escalatedReasons.length > 0 };
}

export function grantApprovedCalls(calls: readonly ToolCall[], workspaceRoot: string, readonlyMap: Map<string, boolean>, grants: SandboxGrants, trustDirectory = false): string[] {
  const trustedNow: string[] = [], home = os.homedir();
  for (const c of calls) {
    const args = (c.arguments ?? {}) as Record<string, unknown>;
    if (c.name === "read_file" || callIsFileTool(c.name)) {
      const realCand = resolveExistingRealPath(path.resolve(workspaceRoot, expandHomePath(String(args.path ?? ".").replace(/\$HOME|\$\{HOME\}|%USERPROFILE%/gi, home), home)));
      grants.onceAllowedPaths.add(realCand);
      if (trustDirectory) {
        const dir = toGrantDir(realCand);
        (c.name === "edit_file" ? grants.trustedWriteDirs : grants.trustedReadDirs).add(dir);
        trustedNow.push(toPosixPath(dir));
      }
    } else if (c.name === "run_bash") {
      for (const dir of classifyToolCallRisk(c, workspaceRoot, readonlyMap, grants).externalDirs) {
        grants.onceAllowedPaths.add(dir);
        if (trustDirectory) { grants.trustedReadDirs.add(dir); grants.trustedWriteDirs.add(dir); trustedNow.push(toPosixPath(dir)); }
      }
    }
  }
  return [...new Set(trustedNow)];
}

function callIsFileTool(name: string): boolean {
  return name === "read_file" || name === "list_dir" || name === "grep" || name === "edit_file";
}
