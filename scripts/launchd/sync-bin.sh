#!/bin/zsh
# sync-bin.sh — 把 repo scripts/launchd/bin/*.sh 部署到 ~/.local/bin（launchd 實際執行的位置）
#
# 為什麼要這支：launchd 不能執行 ~/Desktop 下的腳本（iCloud evict + macOS 沙箱，見 README），
# 所以腳本必須放 ~/.local/bin。過去 repo 那份「留作參考」→ 兩邊無聲分岔：
# 2026-06-13 加進 repo 的 normalize 步驟，到 07-15 都沒被複製到實際執行的那份，整整一個月沒跑。
# 現在 repo = 單一真相，這支是唯一的單向部署路徑。
#
# 用法：
#   bash scripts/launchd/sync-bin.sh          # 部署
#   bash scripts/launchd/sync-bin.sh --check  # 只檢查漂移（CI/排錯用，有差異回 exit 1）
set -u
SRC="$(cd "$(dirname "$0")/bin" && pwd)"
DST="$HOME/.local/bin"
CHECK=0
[[ "${1:-}" == "--check" ]] && CHECK=1

mkdir -p "$DST"

# ⚠️ 絕不可用 cp 就地覆寫：zsh 是「邊讀邊執行」，覆寫正在跑的腳本會讓它執行到亂碼。
#    改成寫暫存檔再 mv（rename 是原子的、換的是新 inode），執行中的舊 inode 不受影響，
#    跑完自然釋放。這樣即使 catchup/nightly 正在跑也能安全部署。
deploy() {
  local src=$1 dst=$2 tmp="$2.tmp.$$"
  cp "$src" "$tmp" && chmod +x "$tmp" && mv -f "$tmp" "$dst"
}

drift=0
for f in "$SRC"/*.sh; do
  name=$(basename "$f")
  if [[ ! -f "$DST/$name" ]]; then
    if (( CHECK )); then echo "⚠️  $name 尚未部署到 $DST"; drift=1
    else deploy "$f" "$DST/$name"; echo "✅ 新部署 $name"; fi
    continue
  fi
  if diff -q "$f" "$DST/$name" >/dev/null; then
    (( CHECK )) && echo "✔  $name 同步"
  else
    if (( CHECK )); then
      echo "⚠️  $name 有漂移（repo ↔ $DST 不同）— 跑 sync-bin.sh 部署，或先確認哪邊才是要的"
      drift=1
    else
      deploy "$f" "$DST/$name"; echo "✅ 已更新 $name"
    fi
  fi
done

if (( CHECK )); then
  (( drift )) && { echo "→ 有漂移，repo 的改動可能沒在生產跑"; exit 1; }
  echo "→ 全部同步 ✅"
fi
exit 0
