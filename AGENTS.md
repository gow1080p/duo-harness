# Duo-Harness 项目工程规范与 AI 协作宪法 (AGENTS.md)

本项目旨在构建一套高内聚、低耦合、100% 遵循行业开放标准的独立 TypeScript Agent Harness，同时帮助开发者深度掌控 Agent Runtime 核心原理。所有参与本项目的 AI 代理必须无条件遵守以下 4 条工程铁律：

---

## 1. 动刀前 15 秒报备制（Karpathy "Think Before Coding" 铁律）
- **严禁直接上手写大段实现代码**：每当开始新关卡（Stage）、新增功能或修复复杂问题时，AI 第一步必须先输出 **不超过 5~8 行的极简方案报备**：
  1. **先说痛点（为什么做）**：像同事聊天一样用大白话先说清楚“目前有什么毛病/痛点，这步要解决什么实际问题”。
  2. **贴真实 JSON + 分清“代码文件（`.ts`）”和“数据文件（`.jsonl`）”**：涉及新数据结构时直接给 3~4 行真实 JSON 例子；新建文件时说清楚哪个是写函数的 `.ts` 代码、哪个是真正永久保存在硬盘上的数据文件。
  3. **对标成熟工具 + 一行命令验证**：说明 Pi、Claude Code、反重力 IDE 里是不是也这么干的，以及用哪行 `pnpm` 命令测效果。
- **确认后全速自动施工**：人类确认方向无误后，AI 全权负责编写具体实现代码与自动化测试，严禁搞“禁止 AI 改文件、逼人类手动复制粘贴填空”的反人性阻塞门禁。

---

## 2. 高代码质量防腐红线（专治面条代码与隐式耦合）
为彻底杜绝“单文件膨胀到 1800 行、I/O 与计算混写、复制粘贴重复公式”的低质量代码，本项目实行严格的物理分层与体积预算：

1. **🧅 纯逻辑核与脏外壳物理分离（Functional Core, Imperative Shell）**：
   - **`src/core/`（纯逻辑核）**：**必须是 100% 纯函数与纯类型定义，且 100% 厂商无关、个人策略无关！** 严禁在 `src/core/` 下出现任何 `node:fs`、`fetch`、`node:sqlite`、`node:child_process`、环境变量读取、终端颜色/HTML 拼接，或任何绑定特定模型厂商/个人计费时段（如小米 MiMo / DeepSeek 分时路由）的业务策略。核心层只负责：`输入通用纯数据结构 -> 返回下一步动作指令或新状态`。
   - **`src/adapters/`（声明式脏外壳）**：所有网络 SSE 流解析、个人多模型分时路由（小米 MiMo 2.6 / DeepSeek / Gemini）、文件读写、SQLite 存储、MCP 子进程通信及 CLI 界面输出，必须 100% 隔离在 `src/adapters/` 中，且每个适配器可随时独立重写替换。
2. **📏 代码体积硬预算（Code Budget）**：
   - **单函数严格 $\le 80$ 行**；
   - **单文件严格 $\le 250$ 行**（`src/core/` 总代码量控制在 `400~500` 行以内）；
   - **零重复公式**：任何两处相似度 $\ge 50\%$ 的判断逻辑必须抽取为公共纯函数。一旦文件或函数超标，AI 必须在当轮自动按职责拆分，无需人类提醒。

---

## 3. 讲解与伴飞铁律（说人话 · 零生造比喻 · 零代码内长注释 · 真实数据流）
1. **必须说自然人话（严禁 AI 造词腔与公文八股）**：用正常程序员同事日常交流的直白语言说话。**严禁堆砌“单行事件节点契约、归约投影、不变量断言、声明式脏外壳、正交性”等生硬翻译腔/学术黑话**（直接说“JSON 格式”、“顺着 `parentId` 拼出数组”、“发请求前的格式检查函数”、“负责读写硬盘的代码文件”）。
2. **严禁生造比喻与代码内大段注释**：**绝对禁止**使用“点菜小票、传球、裁判、安检门”等外行比喻，也**禁止**把大段解释塞进代码块注释里（代码块必须保持干净易读）。
3. **痛点先行 + 真实 JSON 样本 + 分步数据流**：先讲清解决什么痛点并亮出真实 JSON 数据，再按 **「第 1 步输入什么 JSON $\rightarrow$ 第 2 步哪个函数做了什么处理 $\rightarrow$ 第 3 步输出什么结果」** 分步拆解。
4. **直观把玩（`pnpm play`）**：不要求人类阅读或编写 Vitest 测试语法（`tests/` 留给 AI 自动验真），所有可交互实验统一通过根目录的 [`play.ts`](./play.ts)（普通函数调用 + `console.log`）配合 `pnpm play` 运行。
5. **实事求是与零迎合原则**：人类开发者对已写代码与既有技术栈零沉没成本包袱（只要有更优解法随时接受推翻重来）。讨论跨项目落地或架构选型时保持客观中立，合适就用、不合适就直说，不为了证明当前手头代码有用而强行找补或搞奇技淫巧（Workaround），也不用“终极正解、完美契合、金矿、王炸”等夸张吹捧词。

---

## 4. 一行命令验真与动态地图同步（Hashimoto Proof Requirement · 全程统一使用 `pnpm`）
1. **Stop Reviewing, Start Verifying（包管理器统一用 `pnpm`）**：本项目所有依赖安装与脚本执行一律使用 `pnpm`（如 `pnpm install`、`pnpm verify`、`pnpm test:watch`、`pnpm tsx ...`，严禁混用 `npm` 生成 `package-lock.json`）。AI 交付代码前，必须自己先跑通 `pnpm verify`（`tsc --noEmit && vitest run`），并在回复末尾附上**真实终端执行输出**与**一行人类可复现的 `pnpm` 验证命令**。
2. **动态维护 `ARCH.md`**：每次模块结构或核心状态流转发生变更，AI 必须同步更新根目录的 [`ARCH.md`](./ARCH.md)（严格保持 $\le 30$ 行、$\le 8$ 个核心节点图 + 核心文件一句话职责表），让人类花 5 秒看图即可掌控全局架构。
3. **独立外审必查架构正交性与中立送审**：触发 Argon 子代理或 DeepSeek 交叉外审时，除检查逻辑 Bug 外，必须强制审查：**“是否破坏了 `src/core/` 纯函数与厂商无关隔离？是否超出 80行/250行 代码预算？是否引入了重复代码？”**；发起 `plan`/`rework` 方案外审时，中立传递用户问题与客观代码切片，不预设立场诱导外审。

---

## 5. 后续 Stage 3~5 扩展 Skill / Plugin 与工具层的 5 条必知备忘
1. **Skill 懒加载严禁破坏 KV 前缀缓存**：接入 `SKILL.md` 体系时，启动期仅在 `systemPrompt` 尾部静态固化 `<skills>` 极简索引（`name + description + DO NOT trigger` 反例门禁 + 绝对路径）；运行时严禁动态修改 `messages[0]` 或增删 `tools` Schema 数组，统一通过 `read_file` 将 `SKILL.md` 正文作为尾部 `ToolResultMessage` 追加，100% 保护 DeepSeek/Claude 头部前缀缓存。
2. **`read_file` 行区间切片与全局 Skill 软链接只读白名单**：升级 `read_file` 支持 `{ path, startLine?, endLine?, maxLines? }` 并附带行号输出；将路径校验提取为独立函数 `resolveSafePath(targetPath, mode: "read" | "write")`——先用 `os.homedir()` 展开 `~`，再对目标路径（`write` 新建文件遇 `ENOENT` 时回退取 `path.dirname`）与白名单根目录（`~/.gemini/config/plugins`、`~/.codex/skills`、`~/.agents/skills`）同步执行 `fs.realpath` 比对（兼容 `sync.sh` 软链接挂载并防工作区恶意软链接逃逸），且仅 `mode === "read"` 放行白名单，`mode === "write"` 严格锁死在 `workspaceRoot` 内。
3. **工具原语命名跨宿主对齐与代码体积拆分**：维持 `read_file`、`grep`、`list_dir` 命名，Stage 3 新增写与执行工具统一命名为 `edit_file` 与 `run_bash`，以零修改复用 `antigravity-plugins` 现有 `SKILL.md` 与 `scripts/*.mjs` 算子；鉴于 `src/adapters/tools.ts` 现已达 153 行（`createBuiltinTools` 73 行），扩充时必须将 `resolveSafePath` 与各工具拆为独立顶层函数或拆出 `src/adapters/bash-tool.ts`，严守单函数 $\le 80$ 行、单文件 $\le 250$ 行及零重复公式红线。
4. **生命周期钩子（`Hooks` / `Verification Gate`）外置与防 `done` 终态死锁**：危险命令拦截（`PreToolUse`）与完成前自动跑验证（`Pre-Complete Gate`）必须 100% 封装在 `src/adapters/` 外壳层；核心状态机通过 `LoopEvent` 中的 `{ type: "REJECT_COMPLETION"; reason: string }`（`src/core/loop.ts:101-117`，校验 `step < maxSteps` 并递增 `step` 后切回 `thinking`）实现验证不通过自动打回重修，严防终态锁死或无限重修死循环。
5. **`run_bash` 进程组级超时清剿与管道防挂死**：实现子进程命令执行时，严禁裸调 `exec`，必须使用 `spawn(cmd, { detached: true, stdio: ["ignore", "pipe", "pipe"] })`（隔离 `stdin` 防交互命令挂起）；超时或结束时通过 `if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }` 连根清理 POSIX 进程组（防 `pid` 为空转 `NaN` 误杀），并显式调用 `child.stdout.destroy()` / `child.stderr.destroy()` 切断残留管道描述符及截断超长输出。
