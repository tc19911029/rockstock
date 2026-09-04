#!/bin/zsh
# 一鍵載入所有 rockstock launchd 排程
# 用法：bash scripts/launchd/install-all.sh

set -e

FORCE=0
if [[ "${1:-}" == "--force" ]]; then
  FORCE=1
elif [[ -n "${1:-}" ]]; then
  echo "用法：bash scripts/launchd/install-all.sh [--force]" >&2
  exit 2
fi

DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="$HOME/Library/LaunchAgents"
ROOT="$(cd "$DIR/../.." && pwd)"

GLOBAL_NODE="$HOME/.local/node-22/bin/node"
GLOBAL_TSX="$HOME/.local/node-22/lib/node_modules/tsx/dist/cli.mjs"
if [[ ! -x "$GLOBAL_NODE" || ! -r "$GLOBAL_TSX" ]]; then
  echo "已停止：launchd 固定 runtime 不完整（需要 $GLOBAL_NODE + global tsx）。" >&2
  echo "請執行：$HOME/.local/node-22/bin/npm install -g tsx@4.23.5" >&2
  exit 1
fi

CRON_SECRET_VALUE="$(sed -n 's/^CRON_SECRET=//p' "$ROOT/.env.local" 2>/dev/null | head -1 | tr -d '\"' | tr -d "'" | xargs)"
if [[ -z "$CRON_SECRET_VALUE" || "$CRON_SECRET_VALUE" == "CRON_SECRET" ]]; then
  echo "已停止：.env.local 的 CRON_SECRET 未設定或仍是預設值。" >&2
  echo "請先用強隨機值更新，再安裝排程。" >&2
  exit 1
fi

SECRET_DIR="$HOME/.config/rockstock"
SECRET_FILE="$SECRET_DIR/cron-secret"
mkdir -p "$SECRET_DIR"
chmod 700 "$SECRET_DIR"
printf '%s\n' "$CRON_SECRET_VALUE" > "$SECRET_FILE"
chmod 600 "$SECRET_FILE"

render_plist() {
  source_plist="$1"
  output_plist="$2"
  cp "$source_plist" "$output_plist"
  CRON_SECRET_VALUE="$CRON_SECRET_VALUE" perl -pi -e '
    s{Bearer CRON_SECRET}{"Bearer " . $ENV{CRON_SECRET_VALUE}}ge;
    s{<string>CRON_SECRET</string>}{"<string>" . $ENV{CRON_SECRET_VALUE} . "</string>"}ge;
  ' "$output_plist"
}

PREFLIGHT_DIR="$(mktemp -d /tmp/rockstock-launchd-preflight.XXXXXX)"
trap 'rm -rf "$PREFLIGHT_DIR"' EXIT

echo "==> 預檢查 repo 與已安裝 plist 漂移"
DRIFT=0
for source_plist in "$DIR"/plists/com.rockstock.*.plist; do
  target_plist="$TARGET/$(basename "$source_plist")"
  rendered_plist="$PREFLIGHT_DIR/$(basename "$source_plist")"
  render_plist "$source_plist" "$rendered_plist"
  if [[ -f "$target_plist" ]] && ! /usr/bin/python3 -c \
    'import plistlib,sys; sys.exit(0 if plistlib.load(open(sys.argv[1], "rb")) == plistlib.load(open(sys.argv[2], "rb")) else 1)' \
    "$rendered_plist" "$target_plist"; then
    echo "  ! $(basename "$source_plist") 已安裝版與 repo 不同"
    DRIFT=1
  fi
done
if [[ "$DRIFT" -eq 1 && "$FORCE" -ne 1 ]]; then
  echo ""
  echo "已停止：直接安裝會覆蓋機器上的排程調整。" >&2
  echo "請先整併差異；確定要以 repo 覆蓋時才使用 --force。" >&2
  exit 1
fi

echo "==> 同步 repo 管理的執行腳本"
bash "$DIR/sync-bin.sh"

echo "==> 確保腳本可執行"
chmod +x "$DIR"/_*.sh

echo "==> 複製 plist 到 $TARGET"
mkdir -p "$TARGET"
for plist in "$DIR"/plists/com.rockstock.*.plist; do
  plutil -lint "$plist" >/dev/null
  name=$(basename "$plist")
  # Repo plist 只保留不敏感的 CRON_SECRET template token；安裝時才寫入本機密鑰。
  render_plist "$plist" "$TARGET/$name"
  echo "  - $name"
done

echo ""
echo "==> 卸載舊版（若已存在則先停掉）"
UID_NUM=$(id -u)
for source_plist in "$DIR"/plists/com.rockstock.*.plist; do
  plist="$TARGET/$(basename "$source_plist")"
  label=$(basename "$plist" .plist)
  launchctl bootout "gui/${UID_NUM}/${label}" 2>/dev/null || true
done

echo ""
echo "==> 載入新版（用 bootstrap，modern API）"
for source_plist in "$DIR"/plists/com.rockstock.*.plist; do
  plist="$TARGET/$(basename "$source_plist")"
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
echo "4. 想停掉 repo 管理的排程：bash scripts/launchd/uninstall-all.sh"
echo "5. 機器限定、未受版控的 plist 不會被此工具異動"
