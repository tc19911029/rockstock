#!/bin/zsh
# 共用 Codex CLI 探測與錯誤分類。供 ~/.local/bin 的 launchd 腳本 source。

rockstock_resolve_codex() {
  local candidate=""

  # 明確指定時不偷偷 fallback，避免設定打錯卻跑到另一套帳號／版本。
  if [[ -n "${ROCKSTOCK_CODEX_BIN:-}" ]]; then
    if [[ -x "$ROCKSTOCK_CODEX_BIN" ]]; then
      printf '%s\n' "$ROCKSTOCK_CODEX_BIN"
      return 0
    fi
    echo "ROCKSTOCK_CODEX_BIN 不可執行：$ROCKSTOCK_CODEX_BIN" >&2
    return 127
  fi

  # 官方支援的獨立 CLI／PATH 優先；App bundle 路徑只作相容 fallback。
  candidate="$(command -v codex 2>/dev/null || true)"
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  for candidate in \
    "$HOME/.local/bin/codex" \
    /opt/homebrew/bin/codex \
    /usr/local/bin/codex \
    /Applications/ChatGPT.app/Contents/Resources/codex \
    /Applications/Codex.app/Contents/Resources/codex; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  echo "找不到可執行的 Codex CLI（PATH、獨立 CLI、ChatGPT.app、Codex.app 均不存在）" >&2
  return 127
}

rockstock_codex_preflight() {
  local login_status=""
  CODEX_BIN="$(rockstock_resolve_codex)" || {
    ROCKSTOCK_CODEX_ERROR_KIND="CLI_NOT_FOUND"
    return 127
  }

  login_status="$("$CODEX_BIN" login status 2>&1)" || {
    ROCKSTOCK_CODEX_ERROR_KIND="AUTH"
    echo "Codex CLI 可執行，但登入狀態異常：${login_status:-unknown}" >&2
    return 78
  }
  ROCKSTOCK_CODEX_ERROR_KIND=""
  ROCKSTOCK_CODEX_LOGIN_STATUS="$login_status"
  return 0
}

rockstock_codex_classify_failure() {
  local log_file="${1:-}" exit_code="${2:-1}"

  if [[ "$exit_code" == "127" ]]; then
    printf '%s\n' "CLI_NOT_FOUND"
  # 只看尾端的實際失敗訊息，避免逐字稿／程式碼正文剛好談到 quota 而誤判。
  elif [[ -r "$log_file" ]] && tail -200 "$log_file" | grep -Eqi \
    'you.*(reached|hit).*usage limit|usage limit.*(reached|reset)|rate limit exceeded|insufficient_quota|out of credits|credit balance.*(zero|insufficient)'; then
    printf '%s\n' "USAGE_LIMIT"
  elif [[ -r "$log_file" ]] && tail -200 "$log_file" | grep -Eqi \
    'not logged in|login required|authentication failed|unauthorized|invalid credentials|status.?401'; then
    printf '%s\n' "AUTH"
  elif [[ -r "$log_file" ]] && tail -200 "$log_file" | grep -Eqi \
    'socket connection|connection (was )?(closed|reset|refused)|network is unreachable|timed? ?out|tls handshake'; then
    printf '%s\n' "NETWORK"
  else
    printf '%s\n' "EXECUTION"
  fi
}

rockstock_codex_error_hint() {
  case "${1:-EXECUTION}" in
    CLI_NOT_FOUND) printf '%s\n' "找不到 Codex CLI；檢查安裝或 ROCKSTOCK_CODEX_BIN" ;;
    AUTH) printf '%s\n' "Codex 登入失效；執行 codex login 後重試" ;;
    USAGE_LIMIT) printf '%s\n' "Codex 額度／使用上限已達；到 Settings > Usage 查看重置或加購" ;;
    NETWORK) printf '%s\n' "Codex 網路連線失敗；排程稍後可重試" ;;
    *) printf '%s\n' "Codex 已啟動但未產出有效結果；查看本次 log" ;;
  esac
}

rockstock_codex_retryable() {
  case "${1:-EXECUTION}" in
    CLI_NOT_FOUND|AUTH|USAGE_LIMIT) return 1 ;;
    *) return 0 ;;
  esac
}
