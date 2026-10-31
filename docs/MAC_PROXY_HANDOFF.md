# 🍎 Mac 端接管 24 小时 Gemini 车位 OpenAI 反代网关对接说明

> **⚠️ 跨端协同提示（给 Mac 端 AI 代理）**：
> 本次 `duo-harness` 代码修改与腾讯云网关已在 Windows 端完成全量单测（49 项通过）与双模外审。请严格遵守 `AGENTS.md`「跨端 `git pull` 单向收敛铁律」：**仅执行 `git pull` + 运行下方脚本拉起 Mac 常驻反代守护进程，严禁对本提交再次拉起 Argon/DS 外审或改写代码**。

---

## 1. 今日已完成架构总览

1. **腾讯云公网 HTTPS 入口 (`https://gemini.gow1080p.cn/v1`)**：
   - 服务器：`ubuntu@111.231.65.25`
   - Let's Encrypt 证书已配妥：`/etc/letsencrypt/live/gemini.gow1080p.cn/`
   - Nginx 站点配置：`/etc/nginx/sites-available/gemini-proxy` + `/etc/nginx/conf.d/gemini-keys.conf`
   - **双 Key 分级策略**：
     - 主人永久 Key：`sk-gow-master-999`（永不过期，单次请求上限 `20 MB`，已自动写入 `~/.gemini/antigravity/.agy_key` 与 `~/.duo-harness/.agy_key`）
     - 朋友临时 Key：`sk-gow-friends-888`（4 天自动过期：`/usr/local/bin/gemini-key-ttl 4`，单次请求上限 `4 MB` 防多图长会话滚雪球消耗梯子流量）
2. **`duo-harness` 改动摘要**：
   - `agy` 模式默认走标准 OpenAI 协议网关 `https://gemini.gow1080p.cn/v1`（模型 `gemini-4-argon-high`），密钥与 `.mimo_key`、`.deepseek_key` 同级存放于 `~/.gemini/antigravity/.agy_key`；
   - `src/adapters/cost-tracker.ts` 与 `src/adapters/ui-logger.ts`：当使用订阅车位模型时，底栏状态条与 `/xray` 不再显示无意义的 `¥0.0000`，而是直接折算显示**本轮及当前对话消耗的 5h/周订阅额度百分比**（如 `🎯 额度 本轮 0.09% / 当前对话 0.09%`）；
   - `src/adapters/bash-policy.ts`：移除 `buildDefaultSystemPrompt` 中硬编码的 `如 DeepSeek 或小米 MiMo` 身份诱导词。

---

## 2. Mac 端 AI 代理一键执行指令

由于 Windows 电脑晚上会关机，而 Mac 电脑 24 小时常开，请在 Mac 端直接运行仓库内置脚本接管 `:8317` 反向隧道与 `CLIProxyAPI` 守护服务（Google 车位 OAuth 凭证已预置在腾讯云 `ubuntu@111.231.65.25:~/.gemini-mac-sync/` 私有目录中，无需重复扫码登录）：

```bash
bash scripts/setup-mac-gemini-proxy.sh </dev/null
```

### 该脚本自动完成的事项
1. 自动创建 `~/.gemini/antigravity/.agy_key`、`~/.duo-harness/.agy_key` 与 `~/.duo-harness/models.json`；
2. 从 `ubuntu@111.231.65.25:~/.gemini-mac-sync/` 拉取已授权的 `antigravity-gow1080p@gmail.com.json` 并下载对应 Mac 芯片架构的 `CLIProxyAPI`；
3. 自动检测 Mac 本机 Clash 监听端口（`7897` / `7890` 等），清理腾讯云上 Windows 残留的 `:8317` 端口占用，并注册为 macOS `LaunchAgent`（`~/Library/LaunchAgents/cn.gow1080p.gemini-proxy.plist`）实现开机自启与断线 3 秒自愈；
4. 自动执行 `curl https://gemini.gow1080p.cn/v1/models` 验证端到端连通性。
