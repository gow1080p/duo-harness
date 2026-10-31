#!/usr/bin/env bash
set -euo pipefail

PROXY_DIR="$HOME/.gemini/antigravity/scratch/gemini-proxy"
mkdir -p "$PROXY_DIR/auth-data" "$HOME/.gemini/antigravity" "$HOME/.duo-harness" "$HOME/Library/LaunchAgents"

echo "1/5 正在配置 ~/.gemini/antigravity/.agy_key 与 ~/.duo-harness/models.json ..."
printf "sk-gow-master-999" > "$HOME/.gemini/antigravity/.agy_key"
printf "sk-gow-master-999" > "$HOME/.duo-harness/.agy_key"
chmod 600 "$HOME/.gemini/antigravity/.agy_key" "$HOME/.duo-harness/.agy_key"

cat > "$HOME/.duo-harness/models.json" <<'JSON'
{
  "defaultModel": "auto",
  "models": {
    "agy": {
      "protocol": "openai",
      "baseUrl": "https://gemini.gow1080p.cn/v1",
      "model": "gemini-4-argon-high",
      "apiKeyEnv": "AGY_API_KEY",
      "label": "Argon·反重力",
      "supportsVision": true
    },
    "claude": {
      "protocol": "openai",
      "baseUrl": "https://gemini.gow1080p.cn/v1",
      "model": "claude-opus-4-6-thinking",
      "apiKeyEnv": "AGY_API_KEY",
      "label": "Claude-Opus-4.6",
      "supportsVision": true
    },
    "flash": {
      "protocol": "openai",
      "baseUrl": "https://gemini.gow1080p.cn/v1",
      "model": "gemini-3-flash",
      "apiKeyEnv": "AGY_API_KEY",
      "label": "Gemini-3-Flash",
      "supportsVision": true
    }
  }
}
JSON

CLASH_PORT=7897
for p in 7897 7890 7891 6152; do
  if lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1; then
    CLASH_PORT=$p
    break
  fi
done

ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  TAR_NAME="CLIProxyAPI_8.0.48_darwin_aarch64.tar.gz"
else
  TAR_NAME="CLIProxyAPI_8.0.48_darwin_amd64.tar.gz"
fi

echo "2/5 正在从腾讯云同步已授权 Google 车位凭证并下载 macOS ($ARCH) 版 CLIProxyAPI (代理端口 :$CLASH_PORT)..."
scp -q "ubuntu@111.231.65.25:~/.gemini-mac-sync/antigravity-gow1080p@gmail.com.json" "$PROXY_DIR/auth-data/antigravity-gow1080p@gmail.com.json" </dev/null
chmod 600 "$PROXY_DIR/auth-data/antigravity-gow1080p@gmail.com.json"
curl -sL -x "http://127.0.0.1:${CLASH_PORT}" "https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.48/${TAR_NAME}" -o "$PROXY_DIR/cpa.tar.gz"
tar -xzf "$PROXY_DIR/cpa.tar.gz" -C "$PROXY_DIR"
rm -f "$PROXY_DIR/cpa.tar.gz"
chmod +x "$PROXY_DIR/cli-proxy-api"

echo "3/5 正在生成 config.yaml 与 SSH 反向隧道自愈守护脚本..."
cat > "$PROXY_DIR/config.yaml" <<YAML
host: "127.0.0.1"
port: 8317
proxy-url: "http://127.0.0.1:${CLASH_PORT}"
auth-dir: "${PROXY_DIR}/auth-data"
api-keys:
  - "sk-gow-friends-888"
YAML

cat > "$PROXY_DIR/run-daemon.sh" <<'SH'
#!/usr/bin/env bash
PROXY_DIR="$HOME/.gemini/antigravity/scratch/gemini-proxy"
cd "$PROXY_DIR"

lsof -nP -tiTCP:8317 -sTCP:LISTEN | xargs kill -9 2>/dev/null || true
./cli-proxy-api --config "$PROXY_DIR/config.yaml" > "$PROXY_DIR/cpa.out.log" 2> "$PROXY_DIR/cpa.err.log" &
CPA_PID=$!
trap "kill $CPA_PID 2>/dev/null || true" EXIT

while true; do
  ssh -n -o ConnectTimeout=5 -o StrictHostKeyChecking=no ubuntu@111.231.65.25 "sudo fuser -k 8317/tcp 2>/dev/null || true"
  ssh -n -N -T \
    -o ServerAliveInterval=20 \
    -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes \
    -o StrictHostKeyChecking=no \
    -R 127.0.0.1:8317:127.0.0.1:8317 \
    ubuntu@111.231.65.25
  sleep 3
done
SH
chmod +x "$PROXY_DIR/run-daemon.sh"

PLIST="$HOME/Library/LaunchAgents/cn.gow1080p.gemini-proxy.plist"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>cn.gow1080p.gemini-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${PROXY_DIR}/run-daemon.sh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${PROXY_DIR}/tunnel.out.log</string>
  <key>StandardErrorPath</key>
  <string>${PROXY_DIR}/tunnel.err.log</string>
</dict>
</plist>
PLIST_EOF

echo "4/5 正在启动 macOS LaunchAgent 常驻守护服务..."
launchctl unload "$PLIST" </dev/null >/dev/null 2>&1 || true
launchctl load -w "$PLIST" </dev/null >/dev/null 2>&1
sleep 4

echo "5/5 正在验证 https://gemini.gow1080p.cn/v1 连通性..."
curl -sS https://gemini.gow1080p.cn/v1/models -H "Authorization: Bearer sk-gow-master-999" | head -c 240
echo ""
echo "✅ Mac 端 24 小时常驻反代与密钥已全部接管成功！（现在 Windows 电脑随时可以关机）"
