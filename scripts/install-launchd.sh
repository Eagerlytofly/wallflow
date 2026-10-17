#!/usr/bin/env bash
# 安装为登录自启的 LaunchAgent。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || true)"
LABEL="com.wallflow.daemon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ -z "$NODE" ]]; then
  echo "找不到 node，请先安装 Node.js 20+" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/data"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/bin/wallflow.mjs</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$ROOT/data/daemon.log</string>
  <key>StandardErrorPath</key><string>$ROOT/data/daemon.log</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
echo "已安装：$PLIST"
echo "控制台：http://127.0.0.1:7799"
echo "日志：$ROOT/data/daemon.log"
echo
echo "提示：如需写入锁屏壁纸，请把下面这个 node 加入"
echo "系统设置 → 隐私与安全性 → 完全磁盘访问权限："
echo "  $NODE"
