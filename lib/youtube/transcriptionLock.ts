/**
 * Whisper 轉錄「進行中」旗標 — 跨模組共用的最小狀態。
 *
 * 根因（2026-06-13 完整 root-cause）：prod(:3000) 由 launchd 起，next-server 內的
 * instrumentation.ts local-cron 會定期觸發記憶體重活（TDCC 抓 3105 檔、海外日K、
 * 板塊排名、處置股名單、append-from-snapshot、盤後掃描…）。這些與 Whisper 子程序
 * （ctranslate2 + model ~1GB）同時跑會造成系統記憶體壓力 → macOS jetsam 把 Whisper
 * 子程序砍掉（症狀=0-byte/部分 VTT、無 traceback、in-server 才有；standalone 無此
 * 競爭故 4 種 m4a/wav×small/medium 組合全部成功，DISABLE_LOCAL_CRON=1 後 in-server
 * 也整支跑完 829 句）。修法=Whisper 轉錄期間，讓 local-cron 的記憶體重活「讓路」跳過該輪。
 *
 * 兩邊共用同一份計數（同一個 next-server process 內的 module singleton）：
 *   - lib/youtube/whisper.ts：transcribeViaWhisper 進出時 begin/end
 *   - instrumentation.ts：callRoute 對重活 label 檢查 isTranscriptionActive() → 跳過
 */
let active = 0;

export function beginTranscription(): void {
  active += 1;
}

export function endTranscription(): void {
  active = Math.max(0, active - 1);
}

export function isTranscriptionActive(): boolean {
  return active > 0;
}
