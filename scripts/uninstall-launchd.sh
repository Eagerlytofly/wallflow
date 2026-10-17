#!/usr/bin/env bash
set -euo pipefail
LABEL="com.wallflow.daemon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "已卸载 $LABEL"
