#!/bin/zsh
# 一鍵停掉所有 rockstock launchd 排程
# 用法：bash scripts/launchd/uninstall-all.sh

set -e

TARGET="$HOME/Library/LaunchAgents"
DIR="$(cd "$(dirname "$0")" && pwd)"
UID_NUM=$(id -u)

echo "==> 卸載 repo 管理的 rockstock launchd 排程"
for source_plist in "$DIR"/plists/com.rockstock.*.plist; do
  plist="$TARGET/$(basename "$source_plist")"
  [ -f "$plist" ] || continue
  label=$(basename "$plist" .plist)
  launchctl bootout "gui/${UID_NUM}/${label}" 2>/dev/null || true
  rm -f "$plist"
  echo "  - $label ✓ 已停止並刪除"
done

echo ""
echo "==> 目前剩餘 rockstock 排程："
launchctl list | grep com.rockstock || echo "  (無)"

echo ""
echo "提醒：機器限定、未受 repo 管理的 plist 不會被刪除。"
