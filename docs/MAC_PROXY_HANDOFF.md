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


---

## 3. Key 分类、过期刷新规则与运维命令速查表（供 Mac 端 AI 随时调用）

### 3.1 Key 分类与权限矩阵

| Key 名称 | Key 字符串 | 适用对象 | 有效期规则 | 单次请求体积上限 | 腾讯云 Nginx 路由分支 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **主人永久 Key** | `sk-gow-master-999` | 本人自用（`duo-harness` / VS Code `Kilo Code`） | **永久有效** | **`20 MB`** | 识别后通过内部 `418 -> @master_proxy` 放行大体积多图请求 |
| **朋友临时 Key** | `sk-gow-friends-888` | 分享给朋友免梯子直连使用 | **默认 4 天自动过期**（当前到期时间：`2026-11-04 14:18:22 CST`） | **`4 MB`**（超出直接由腾讯云边缘返回 `413` 拦截，不消耗本机 Clash 流量） | 默认 `location /` 分支，受 `/etc/nginx/conf.d/gemini-keys.conf` 中 `# AUTO-EXPIRE-TARGET` 控制 |

### 3.2 常用 Key 管理命令（在 Mac 上直接通过 `ssh ubuntu@111.231.65.25` 执行）

1. **查询朋友 Key (`sk-gow-friends-888`) 当前状态与到期时间**：
   ```bash
   ssh ubuntu@111.231.65.25 "cat /etc/nginx/conf.d/gemini-keys.conf; echo '--- 到期时间戳 ---'; TZ=Asia/Shanghai date -d @\$(cat /etc/nginx/gemini-key-expire.ts) '+%Y-%m-%d %H:%M:%S CST'"
   ```
2. **重新激活朋友 Key 或刷新/延长有效期为 `N` 天（例如续期 4 天或 7 天）**：
   ```bash
   # 将 4 替换为任意天数（如 7 代表从现在起往后顺延 7 天自动过期）
   ssh ubuntu@111.231.65.25 "sudo /usr/local/bin/gemini-key-ttl 4"
   ```
3. **立即手动停用朋友 Key（不影响主人 `sk-gow-master-999`）**：
   ```bash
   ssh ubuntu@111.231.65.25 "sudo sed -i 's|.*# AUTO-EXPIRE-TARGET|    # EXPIRED \"sk-gow-friends-888\" 0; # AUTO-EXPIRE-TARGET|' /etc/nginx/conf.d/gemini-keys.conf && sudo rm -f /etc/cron.d/gemini-key-expiry && sudo nginx -t && sudo systemctl reload nginx"
   ```
4. **更换朋友 Key 的字符串（例如改成新的 `sk-gow-friends-666`）**：
   - 修改腾讯云 `/etc/nginx/conf.d/gemini-keys.conf` 与 `/usr/local/bin/gemini-key-ttl` 中的 `sk-gow-friends-888`，然后执行 `sudo /usr/local/bin/gemini-key-ttl 4` 即可（无需重启 Mac 端隧道，因为腾讯云 Nginx 会自动将通过验签的请求统一转为后端 `CLIProxyAPI` 内部识别的凭证头）。

### 3.3 Mac 本机常驻守护服务运维命令

- **安装目录**：`~/.gemini/antigravity/scratch/gemini-proxy`
- **Google 车位 OAuth 自动刷新机制**：`cli-proxy-api` 内置每 **15 分钟**自动刷新一次 `auth-data/antigravity-gow1080p@gmail.com.json` Token，每 **3 小时**自动同步最新 Antigravity 客户端版本号，全程无需人工干预。
- **查看 Mac 本机反代与隧道运行状态/日志**：
  ```bash
  ps aux | grep -E "cli-proxy-api|8317" | grep -v grep
  tail -n 20 ~/.gemini/antigravity/scratch/gemini-proxy/cpa.out.log
  ```
- **重启 Mac 本机常驻守护服务**：
  ```bash
  launchctl unload ~/Library/LaunchAgents/cn.gow1080p.gemini-proxy.plist
  launchctl load -w ~/Library/LaunchAgents/cn.gow1080p.gemini-proxy.plist
  ```
