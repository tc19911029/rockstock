#!/bin/zsh
# 一鍵載入所有 rockstock launchd 排程
# 用法：bash scripts/launchd/install-all.sh

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="$HOME/Library/LaunchAgents"

echo "==> 確保腳本可執行"
chmod +x "$DIR"/_*.sh

echo "==> 複製 plist 到 $TARGET"
mkdir -p "$TARGET"
for plist in "$DIR"/plists/com.rockstock.*.plist; do
  name=$(basename "$plist")
  cp "$plist" "$TARGET/$name"
  echo "  - $name"
done

echo ""
echo "==> 卸載舊版（若已存在則先停掉）"
UID_NUM=$(id -u)
for plist in "$TARGET"/com.rockstock.*.plist; do
  label=$(basename "$plist" .plist)
  launchctl bootout "gui/${UID_NUM}/${label}" 2>/dev/null || true
done

echo ""
echo "==> 載入新版（用 bootstrap，modern API）"
for plist in "$TARGET"/com.rockstock.*.plist; do
  label=$(basename "$plist" .plist)
  launchctl bootstrap "gui/${UID_NUM}" "$plist"
  echo "  - $label ✓"
done

echo ""
echo "==> 完成。目前在跑的 rockstock 排程："
launchctl list | grep com.rockstock || echo "  (查無)"

echo ""
echo "提醒："
echo "1. Mac 必須開機 + 接電源 + 不睡眠才會跑"
echo "2. npm run dev 必須常駐在 port 3000（launchd 打 localhost:3000）"
echo "3. log 檔在 /tmp/rockstock-*.log"
echo "4. 想停掉所有排程：bash scripts/launchd/uninstall-all.sh"
