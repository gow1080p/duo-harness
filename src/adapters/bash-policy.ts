import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { isPathInside, shortenWorkspaceText } from "./platform.js";
import { discoverAvailableSkills, formatSkillsSystemIndex } from "./skill-loader.js";

const SAFE_READONLY_VERBS_RE =
  /^(?:ls|cat|head|tail|wc|grep|egrep|fgrep|rg|ag|find|stat|file|du|df|pwd|realpath|dirname|basename|which|whereis|type|echo|printf|tr|cut|sort|uniq|diff|comm|cmp|md5|shasum|sha256sum|xxd|hexdump|strings|tree|uname|whoami|id|hostname|date|uptime|ps|lsof|netstat|pgrep|sed|curl|test|true|false)(?:\s|$)/;

const SAFE_PRINTENV_RE =
  /^printenv\s+(?:PATH|SHELL|PWD|LANG|LC_ALL|TERM|COLORTERM|NODE_ENV|HOME|USERPROFILE|TMPDIR|TEMP|TMP|USER|USERNAME|OS)\s*$/;

const GIT_READONLY_SUBCMD_RE =
  /^git\s+(?:(?:--no-pager|-C\s+(?:"__STR__"|\S+))\s+)*(?:(?:status|diff|log|show|rev-parse|ls-files|ls-tree|cat-file|describe|shortlog|blame|var)(?:\s|$)|reflog(?:\s+show)?\s*$|branch(?:\s+(?:-(?:a|r|v|vv)|--(?:all|remotes|list|show-current|contains|merged|no-merged)))*\s*$|remote(?:\s+(?:-v|--verbose))*\s*$|tag(?:\s+(?:-l|--list)(?:\s+\S+)*)?\s*$|config\s+(?:--(?:get|get-all|list)|-l)(?:\s|$)|(?:-v|--version)\s*$)/;

const RUNTIME_VERSION_RE =
  /^(?:(?:node|python3?|pip3?|npm|pnpm|yarn|bun|tsc|cargo|rustc|uvicorn|vite)\s+(?:-v|--version|-V)|go\s+version|(?:(?:npx|pnpm|yarn|bunx?)\s+)?tsc(?:\s+(?:--noEmit|--pretty(?:\s+(?:true|false))?|--skipLibCheck|--strict|-p\s+(?:"__STR__"|\S+)|--project\s+(?:"__STR__"|\S+)))*\s+--noEmit(?:\s+(?:--pretty(?:\s+(?:true|false))?|--skipLibCheck|--strict|-p\s+(?:"__STR__"|\S+)|--project\s+(?:"__STR__"|\S+)))*)\s*$/;

export function cleanDisplayBash(rawCmd: string, workspaceRoot?: string): string[] {
  const short = shortenWorkspaceText(rawCmd.trim(), workspaceRoot);
  const rawParts =
    short.match(
      /(?:\s*&&\s*echo\s+(?!(?:['"]?(?:===+|---+)))(?:[^;&'"]|'[^']*'|"(?:[^"\\]|\\.)*")+|'[^']*'|"(?:[^"\\]|\\.)*"|\b(?:for|while|until)\b(?:[^'"]|'[^']*'|"(?:[^"\\]|\\.)*")+?\bdone\b|\bif\b(?:[^'"]|'[^']*'|"(?:[^"\\]|\\.)*")+?\bfi\b|[^;&'"]+|(?<!&)&(?!&))+/g,
    ) ?? [short];
  const parts = rawParts
    .map((s) => s.trim().replace(/\s+2>&1(?=\s*$|\s*\|)/g, ""))
    .filter((s) => s && !/^echo(?:\s+(?:'(?:===+|---+)(?:.*(?:===+|---+))?'|"(?:===+|---+)(?:.*(?:===+|---+))?"|---+|===+))?$/.test(s))
    .filter((s, _, arr) => !(arr.length > 1 && /^echo\s+['"]?[^'"]*(?:exit|\$\?)[^'"]*['"]?$/i.test(s)));
  return parts.length > 0 ? parts : [short];
}

export function buildDefaultSystemPrompt(workspaceRoot: string): string {
  const skillsBlock = formatSkillsSystemIndex(discoverAvailableSkills(workspaceRoot));
  return [
    `你是运行在 Duo-Harness 宿主环境中的本地编程智能体（全程必须使用简明中文思考与回答，第 1 步起 reasoning 严禁输出英文 Let me...；严禁自称 Claude 或 Anthropic 模型，当用户询问模型身份时请如实回答底层模型如 DeepSeek 或小米 MiMo）。`,
    `- 当前工作区根目录 (workspaceRoot): ${workspaceRoot} (操作系统: ${process.platform})`,
    `- 工具使用纪律（必须严格遵守）：`,
    `  1. 查看目录与文件行数必须直接调用 list_dir（已自带 2 层目录树、代码文件行数及顶层/二级 [已过滤忽略目录] 如 venv/、web-ui/node_modules/），读文件调 read_file（1000 行内直接一次读完，多个文件同轮并发读取），搜索代码调 grep；严禁调用未注册的 glob、find_by_name 或 write_file 工具（找文件只用 list_dir/grep，新建与修改文件统一用 edit_file）；严禁调用 run_bash 执行 node -e、node -p、python -c、cat、find、grep、ls、wc 读取或检查文件内容（run_bash 的 readonly 参数仅对纯查询 shell 命令生效，node -e / python -c 属于脚本执行会触发高危权限弹窗打断用户）；纯问答请直接回答。`,
    `  2. 调用工具时 path 参数请直接传相对于工作区根目录的简短相对路径（如 "."、"README.md"、"src/index.ts"），不要重复拼接长绝对路径。`,
    `  3. run_bash 默认已在工作区根目录 (${workspaceRoot}) 下启动，严禁在命令开头拼接 cd "${workspaceRoot}" &&；前端/TS 类型检查请统一用只读命令 npx tsc --noEmit（自动免确认放行，勿用会写缓存的 tsc -b）；只读环境检查严禁与写操作或 python -c 混写在同一条 run_bash 中；启动常驻服务（如 uvicorn/vite/npm run dev）必须用后台方式（nohup ... > /tmp/xxx.log 2>&1 </dev/null &）并在同条命令内 sleep 1~2 后检查端口或日志，严禁前台裸跑常驻进程。`,
    `  4. 修改同一个文件的多处内容时，请使用 edit_file 的 edits 批量数组在单次调用中完成（或同一步并发调用多个 edit_file）；从 0 到 1 初始化或搭建多文件项目（Vibe Coding）时，必须采用「分批小步落盘」：每一步最多新建或修改 1~3 个文件（先写 package.json/基础配置 -> 安装依赖或写核心逻辑 -> 写页面/入口并验证），严禁在单步 tool_calls 中一口气塞入超过 3 个大文件的完整代码；严禁通过 run_bash 调用 sed -i 或脚本改写源码文件。`,
    `  5. 思考过程（reasoning）必须全程使用简明中文，调工具取证阶段思考控制在 100 字以内，聚焦下一步动作；当用户要求“拉起/启动项目”时，第 1~2 步用 list_dir 与 read_file 读齐入口配置（如 README.md、main.py、package.json、vite.config.ts）后立即在下一步直接启动服务，禁止超过 2 步纯探索；宿主终端已内置 /open（一键用系统默认应用/浏览器打开文件）、/shot、/diff、/undo、/redo 命令，严禁调用 run_bash 执行 start、cmd.exe /c start、open 或 xdg-open 打开浏览器/文件，输出本地文件路径时请附上正斜杠完整路径并提示用户输入 /open 打开。`,
    `  6. 安全与隐私沙箱铁律：严禁调用 run_bash 执行 printenv/env 或读取/遍历用户主目录敏感凭据与隐藏配置 (~、~/.config、~/.claude*、~/.codex*、~/.gemini*、~/.ssh；注：已登记在下方 <skills> 索引中的技能目录允许通过 read_file / grep 只读访问) 探测外部配置与密钥；当工作区内未找到所需配置或 API Key 时，必须立即停下直接向用户询问。若用户告知了外部密钥文件路径（如 ~/.gemini/antigravity/.mimo_key 等 .*_key / .env 文件）供当前项目接入，严禁调用 read_file 或 run_bash 读取密钥明文（防密钥暴露于上下文或硬编码进源码），必须直接在项目服务端代码中编写 fs.readFileSync 等运行时读取逻辑；若用户明确要求读取或修改工作区外的普通业务代码目录，请直接调用 read_file / edit_file 由系统弹出跨界提权确认框。`,
    ...(skillsBlock ? [skillsBlock] : []),
  ].join("\n");
}

function isTokenPathEscaped(rawToken: string, workspaceRoot?: string, baseDir = workspaceRoot): boolean {
  const val = rawToken.replace(/^--?[a-zA-Z0-9_-]+=/, "").replace(/([\\/])[*?[\]]+(?=[\\/]|$)/g, "$1_").replace(/[*?[\]]+/g, "");
  if (!val || val.startsWith("-") || val === '"__STR__"' || val === '"__LOCAL_URL__"' || /^\\+$/.test(val) || /[|^$(){}<>]/.test(val)) return false;
  if (val === '"__PATH_ESCAPE__"' || /^~(?:[\\/]|$)/.test(val)) return true;
  if (/^(?:\/tmp\/|\/private\/tmp\/|\/dev\/null\b|\/\/[a-zA-Z0-9_?-]+$)/.test(val)) return false;
  if (/^duo-bash-[a-zA-Z0-9_-]+\.log$/i.test(path.basename(val)) && [os.tmpdir(), fs.existsSync(os.tmpdir()) ? fs.realpathSync(os.tmpdir()) : os.tmpdir(), "/tmp", "/private/tmp"].some((r) => isPathInside(path.resolve(val), r))) return false;
  const hasDotDot = /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(val);
  if (hasDotDot || /^(?:[A-Za-z]:[\\/]|\/)/.test(val)) {
    if (!workspaceRoot) return true;
    const root = fs.existsSync(workspaceRoot) ? fs.realpathSync(workspaceRoot) : path.resolve(workspaceRoot);
    const base = baseDir && fs.existsSync(baseDir) ? fs.realpathSync(baseDir) : path.resolve(baseDir ?? root);
    const cand = path.resolve(base, val);
    const realCand = fs.existsSync(cand) ? fs.realpathSync(cand) : cand;
    return !isPathInside(realCand, root);
  }
  if (workspaceRoot) {
    const root = fs.existsSync(workspaceRoot) ? fs.realpathSync(workspaceRoot) : path.resolve(workspaceRoot);
    const base = baseDir && fs.existsSync(baseDir) ? fs.realpathSync(baseDir) : path.resolve(baseDir ?? root);
    const cand = path.resolve(base, val);
    if (fs.existsSync(cand) && !isPathInside(fs.realpathSync(cand), root)) return true;
  }
  return false;
}

function isSafeSingleBashSegment(seg: string, workspaceRoot?: string, baseDir = workspaceRoot): { ok: boolean; isReadVerb: boolean } {
  const core = seg.trim().replace(/^(?:(?:LC_ALL|LANG|TZ|TERM|COLORTERM)=(?:"__STR__"|\S+)\s+|(?:command|do|if|then|elif|else)\s+)*/, "");
  if (!core || core.includes('"__PATH_ESCAPE__"')) return { ok: false, isReadVerb: false };
  if (/^cd(?:\s+(\S+))?$/.test(core)) {
    const cdTarget = core.match(/^cd(?:\s+(\S+))?$/)?.[1];
    if (!cdTarget || isTokenPathEscaped(cdTarget, workspaceRoot, baseDir)) return { ok: false, isReadVerb: false };
    return { ok: true, isReadVerb: false };
  }
  if (/^(?:sleep\s+\d+(?:\.\d+)?|for\s+[a-zA-Z_]\w*\s+in(?:\s+(?:"__STR__"|\S+))+|done|fi)$/.test(core)) {
    return { ok: true, isReadVerb: false };
  }
  if (/^(?:\[\s+.+\s+\]|\[\[\s+.+\s+\]\])$/.test(core)) {
    const innerTokens = core.replace(/^\[\[?\s+|\s+\]\]?$/g, "").split(/\s+/);
    if (innerTokens.some((t) => isTokenPathEscaped(t, workspaceRoot, baseDir))) return { ok: false, isReadVerb: false };
    return { ok: true, isReadVerb: true };
  }
  const tokens = core.split(/\s+/);
  const first = tokens[0] ?? "";
  if (!first || first.includes("/") || first === '"__STR__"' || first === '"__LOCAL_URL__"' || first === '"__SED_UNSAFE__"') {
    return { ok: false, isReadVerb: false };
  }
  if (tokens.slice(1).some((t) => isTokenPathEscaped(t, workspaceRoot, baseDir))) {
    return { ok: false, isReadVerb: false };
  }
  if (first === "sed" && (core.includes('"__SED_UNSAFE__"') || tokens.find((t, i) => i > 0 && !t.startsWith("-")) !== '"__STR__"')) {
    return { ok: false, isReadVerb: false };
  }
  if (first === "curl") {
    const curlPos = core
      .slice(4)
      .replace(/\s+(?:-(?:w|H|A|e|m)|--(?:write-out|header|user-agent|referer|max-time|connect-timeout|retry))\s+(?:"__(?:STR|LOCAL_URL)__"|\S+)/g, "")
      .trim()
      .split(/\s+/)
      .filter((t) => t && !t.startsWith("-"));
    if (curlPos.length === 0 || curlPos.some((t) => !/^(?:"__LOCAL_URL__"|https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/.*)?)$/.test(t))) {
      return { ok: false, isReadVerb: false };
    }
  }
  if ((first === "uniq" || first === "xxd") && tokens.slice(1).filter((t) => !t.startsWith("-")).length > 1) {
    return { ok: false, isReadVerb: false };
  }
  if (SAFE_PRINTENV_RE.test(core) || SAFE_READONLY_VERBS_RE.test(core) || GIT_READONLY_SUBCMD_RE.test(core) || RUNTIME_VERSION_RE.test(core)) {
    return { ok: true, isReadVerb: true };
  }
  return { ok: false, isReadVerb: false };
}

export function isReadonlyBashCommand(cmd: string, explicitReadonly?: boolean, workspaceRoot?: string, initialCwd = workspaceRoot): boolean {
  if (explicitReadonly === false) return false;
  const raw = cmd.trim();
  if (!raw || /`|\$\(|\$'|\$\{|\$(?:HOME|USERPROFILE|[A-Z0-9_]*KEY|[A-Z0-9_]*TOKEN|[A-Z0-9_]*SECRET)|%[A-Za-z0-9_]+%|[\n\r]/i.test(raw)) return false;
  const unquoted = raw.replace(/['"]/g, "").replace(/(?:^|\s)(?:-o\s*|--output(?:=|\s+))\/dev\/null(?=\s|$|;|\||&)/g, " ");
  if (
    /(?:^|\s)(?:-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)\b|--(?:output|output-dir|in-place|file|ext-diff|textconv|pre|pre-glob|compress-program|data\S*|form\S*|upload-file|request|remote-name\S*|json|url\S*|next|config|dump-header|trace\S*)\b)/.test(unquoted) ||
    /(?:^|[;&|]\s*)(?:(?:\w+=\S+|env|command|do|then|elif|else|if|while|until)\s+)*(?:(?:sort|tree|git|rg|xxd)\b[^;&|]*\s-[a-zA-Z]*o|curl\b[^;&|]*\s-[a-zA-Z0-9#]*[oOdDFTPXK]|file\b[^;&|]*\s-[a-zA-Z]*C|sed\b[^;&|]*\s-[a-zA-Z]*[if])/.test(unquoted)
  ) {
    return false;
  }
  const maskedQuotes = raw.replace(/(?:'[^']*'|"(?:[^"\\]|\\.)*")/g, (m, offset: number) => {
    const inner = m.slice(1, -1).trim();
    if (/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/[^'"]*)?$/.test(inner)) return '"__LOCAL_URL__"';
    const beforeSeg = raw.slice(0, offset).split(/[;&|]/).pop()?.trim() ?? "";
    const isPatternArg = /^(?:grep|egrep|fgrep|rg|ag|sed|awk)(?:\s+-[a-zA-Z0-9-]+)*$/.test(beforeSeg);
    if (
      !isPatternArg && !/[*?^$|[\]{}()<>]/.test(inner) && (
        /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(inner) ||
        /^(?:~(?:[\\/]|$)|[A-Za-z]:[\\/]|\/(?:Users|home|root|etc|var|opt|private\/etc|private\/var)(?:\/|$))/.test(inner) ||
        (workspaceRoot && process.platform !== "win32" && /^\/(?!dev\/null\b|tmp\/|private\/tmp\/)/.test(inner))
      )
    ) {
      if (isTokenPathEscaped(inner, workspaceRoot, initialCwd)) return '"__PATH_ESCAPE__"';
    }
    const body = inner.replace(/\bs([^\w\s])(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1/g, "/").replace(/\/(?:\\.|[^/])*\//g, "/");
    return /\/[gIimMp0-9]*[ewW]|(?:^|[;{}!\s$0-9])[ewW](?:\s|$)/.test(body) ? '"__SED_UNSAFE__"' : '"__STR__"';
  });
  if (/['"]/.test(maskedQuotes.replace(/"__(?:STR|LOCAL_URL|SED_UNSAFE|PATH_ESCAPE)__"/g, ""))) return false;
  const cleaned = maskedQuotes.replace(/(?:^|\s)(?:[12]?>\s*\/dev\/null|<\s*\/dev\/null|(?:-o\s*|--output(?:=|\s+))\/dev\/null|2>&1|1>&2)(?=\s|$|;|\||&)/g, " ").trim();
  if (!cleaned || /[><]|(?:^|[^&])&(?:[^&]|$)/.test(cleaned)) return false;
  const segments = cleaned.split(/\s*(?:\|\||&&|;|\|)\s*/);
  let hasReadVerb = false;
  for (const seg of segments) {
    const check = isSafeSingleBashSegment(seg, workspaceRoot, initialCwd);
    if (!check.ok) return false;
    if (check.isReadVerb) hasReadVerb = true;
  }
  return hasReadVerb;
}

function checkJsSnippetSyntax(code: string, filename: string): string | null {
  try {
    new vm.Script(code, { filename });
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Unexpected token '<'/.test(msg)) return null;
    if (/Cannot use import statement|Unexpected token 'export'|await is only valid in async|Cannot use 'import\.meta'/.test(msg)) {
      const masked = code
        .replace(/\bimport\.meta\b/g, "({})")
        .replace(/^[ \t]*import\s+(?:[\s\S]*?\sfrom\s*)?['"][^'"]+['"]\s*;?/gm, (m) => "\n".repeat(m.split("\n").length - 1))
        .replace(/^[ \t]*export\s+default\s+/gm, "void ")
        .replace(/^[ \t]*export\s*\{[\s\S]*?\}(?:\s*from\s*['"][^'"]+['"])?\s*;?/gm, (m) => "\n".repeat(m.split("\n").length - 1))
        .replace(/^[ \t]*export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/gm, "");
      try {
        new vm.Script(`(async function(){${masked}\n})()`, { filename });
        return null;
      } catch (err2) {
        const msg2 = err2 instanceof Error ? err2.message : String(err2);
        if (/Cannot use import|Unexpected token 'export'|Unexpected token '<'|already been declared/.test(msg2)) return null;
        return String((err2 as Error).stack || msg2).split("\n").slice(0, 5).join("\n");
      }
    }
    return String((err as Error).stack || msg).split("\n").slice(0, 5).join("\n");
  }
}

export function checkFileSyntax(filePath: string, content: string): string | null {
  const norm = filePath.replace(/\\/g, "/");
  const base = path.posix.basename(norm).toLowerCase();
  const ext = path.posix.extname(base);
  if (ext === ".json") {
    if (/^(?:tsconfig(?:\..+)?\.json|jsconfig(?:\..+)?\.json)$/.test(base) || norm.includes(".vscode/")) return null;
    try {
      JSON.parse(content);
      return null;
    } catch (err) {
      return `${filePath} JSON 语法错误: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    return checkJsSnippetSyntax(content, filePath);
  }
  if (ext === ".html" || ext === ".htm") {
    for (const m of content.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const attrs = m[1] ?? "", body = m[2] ?? "";
      if (/\bsrc\s*=/i.test(attrs) || !body.trim()) continue;
      const tm = attrs.match(/\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const sType = (tm?.[1] ?? tm?.[2] ?? tm?.[3] ?? "").trim().toLowerCase();
      const bodyOffset = (m.index ?? 0) + m[0].indexOf(">") + 1;
      const lineOffset = content.slice(0, bodyOffset).split("\n").length - 1;
      if (sType === "application/json" || sType === "application/ld+json" || sType === "importmap") {
        try { JSON.parse(body); } catch (err) { return `${filePath}:${lineOffset + 1} <script type="${sType}"> JSON 语法错误: ${(err as Error).message}`; }
      } else if (!sType || sType === "text/javascript" || sType === "application/javascript" || sType === "module") {
        const jsErr = checkJsSnippetSyntax("\n".repeat(lineOffset) + body, filePath);
        if (jsErr) return jsErr;
      }
    }
  }
  return null;
}
