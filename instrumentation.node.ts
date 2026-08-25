// instrumentation.node.ts — Node-only local cron scheduler
// 本地開發時定期呼叫 API route 模擬 Vercel Cron。
//
// 設計原則（鐵律 4：Edge-safe 模組邊界）：
//   本檔只做「時間判斷 + fetch 呼叫」，**不 import 任何含 fs/path 的模組**。
//   實際做事交給宣告 runtime='nodejs' 的 API route。
//   這樣 Edge bundler 才不會在 HMR 後把 fs 依賴拉進來炸掉（歷史傷疤：DabanScanner 2026-04-17）。

import { isMarketOpen, isPostCloseWindow, getLastTradingDay } from '@/lib/datasource/marketHours';
import { isTradingDay } from '@/lib/utils/tradingDay';
// ⚠️ 只 import 純狀態模組（無 fs/path）— 維持本檔 Edge-safe 邊界（見檔頭鐵律 4）。
import { isTranscriptionActive } from '@/lib/youtube/transcriptionLock';
import { createSingleFlightRunner } from '@/lib/scheduler/singleFlight';

function localUrl(path: string): string {
  const port = process.env.PORT || '3000';
  return `http://localhost:${port}${path}`;
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (process.env.CRON_SECRET) h['authorization'] = `Bearer ${process.env.CRON_SECRET}`;
  return h;
}

const runRouteSingleFlight = createSingleFlightRunner(path => {
  console.warn(`[local-cron] ${path} 上一輪尚未完成，共用既有請求`);
});

async function callRoute(
  path: string,
  label: string,
  { timeoutMs = 10 * 60_000 }: { timeoutMs?: number } = {},
): Promise<unknown> {
  return runRouteSingleFlight(path, async () => {
    try {
      const res = await fetch(localUrl(path), {
        headers: authHeaders(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        console.error(`[local-cron] ${label} HTTP ${res.status}`);
        return null;
      }
      return await res.json();
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      console.error(`[local-cron] ${label} ${timedOut ? `${timeoutMs}ms timeout` : 'fetch failed'}:`, err);
      return null;
    }
  });
}

// Whisper 轉錄期間，記憶體重活 cron 讓路：跳過「本輪」（不設 done 旗標 → 下一輪 60s 後再來，
// 不會掉今天的工作）。根因：whisper 子程序與重活同時跑會被 jetsam 砍（見 transcriptionLock.ts）。
// ⚠️ 守衛必須放在各工作「設 done 旗標之前」，所以在每個 interval/函式最前面呼叫，不能塞進 callRoute。
let lastDeferLogAt = 0;
function deferForWhisper(label: string): boolean {
  if (!isTranscriptionActive()) return false;
  const now = Date.now();
  if (now - lastDeferLogAt > 60_000) {  // 每分鐘最多印一次，避免洗版
    console.log(`[local-cron] ${label} 本輪跳過：Whisper 轉錄進行中，記憶體重活讓路（下輪重試）`);
    lastDeferLogAt = now;
  }
  return true;
}

export async function register() {
  // 只在本地開發啟動定時器（Vercel 有自己的 cron）
  if (process.env.VERCEL || process.env.NODE_ENV === 'test') return;
  // 只有 production（npm run start，:3000 正牌 prod server）才註冊 local-cron。
  // dev server（next dev，Claude Preview :3100）一律略過 —— 它的 cron 會打 localhost:3000
  // 與 prod 重複觸發（同一份 L2 刷新/三色掃描跑兩次，盤中多吃一份 /api/stock）。
  if (process.env.NODE_ENV !== 'production') {
    console.log('[local-cron] 非 production（dev server），略過本地 cron 模擬，避免與 prod 重複觸發');
    return;
  }
  // 手動關閉開關：DISABLE_LOCAL_CRON=1（prod 維護模式：launchctl setenv 後 kickstart）→ 連 prod 也不跑 cron
  if (process.env.DISABLE_LOCAL_CRON === '1') {
    console.log('[local-cron] DISABLE_LOCAL_CRON=1 已停用本地 cron 模擬');
    return;
  }

  console.log('[local-cron] 本地開發模式：定期呼叫 API route 模擬 Vercel Cron');
  const L2_REFRESH_INTERVAL_MS = Math.max(
    60_000,
    Number(process.env.LOCAL_L2_REFRESH_INTERVAL_MS) || 60_000,
  );
  console.log(`[local-cron] L2：每 ${Math.round(L2_REFRESH_INTERVAL_MS / 60_000)} 分鐘 | 六條件盤中：每 10 分鐘 | 買法 BCDEF：每 10 分鐘 | 盤後：L1+scan 14:10 TW / 16:10 CN | ETF：18:00/23:00 CST 1-5 | 三色推播：每 2 分鐘`);

  // 重活完成帳本必須跨 process restart 保留。過去只存在記憶體，
  // 盤後每次 kickstart 都會再跑全市場 download/append/scan。
  type PersistentCronState = {
    l1Downloaded: Record<'TW' | 'CN', string[]>;
    l1SnapshotDone: Record<'TW' | 'CN', string>;
    postCloseDailyDone: Record<'TW' | 'CN', string>;
  };
  const stateDir = `${process.env.HOME ?? '/tmp'}/.local/state/rockstock`;
  const stateFile = `${stateDir}/local-cron-state.json`;
  const emptyState = (): PersistentCronState => ({
    l1Downloaded: { TW: [], CN: [] },
    l1SnapshotDone: { TW: '', CN: '' },
    postCloseDailyDone: { TW: '', CN: '' },
  });
  let persistentState = emptyState();
  try {
    const fs = await import('node:fs/promises');
    const parsed = JSON.parse(await fs.readFile(stateFile, 'utf8')) as Partial<PersistentCronState>;
    persistentState = {
      l1Downloaded: {
        TW: parsed.l1Downloaded?.TW ?? [],
        CN: parsed.l1Downloaded?.CN ?? [],
      },
      l1SnapshotDone: {
        TW: parsed.l1SnapshotDone?.TW ?? '',
        CN: parsed.l1SnapshotDone?.CN ?? '',
      },
      postCloseDailyDone: {
        TW: parsed.postCloseDailyDone?.TW ?? '',
        CN: parsed.postCloseDailyDone?.CN ?? '',
      },
    };
    console.log('[local-cron] 已載入跨重啟完成帳本');
  } catch {
    console.log('[local-cron] 無舊帳本，從空狀態開始');
  }
  let stateWriteChain = Promise.resolve();
  function persistCronState(): Promise<void> {
    stateWriteChain = stateWriteChain.then(async () => {
      const fs = await import('node:fs/promises');
      await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
      const tmp = `${stateFile}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(persistentState), { mode: 0o600 });
      await fs.rename(tmp, stateFile);
    }).catch(err => console.error('[local-cron] 完成帳本寫入失敗:', err));
    return stateWriteChain;
  }

  // ── 開機補抓緩衝 + 錯開（2026-06-02 修：重啟補抓風暴餓死 /api/stock）────────
  // 病根：setInterval 的去重旗標（postCloseDailyDone / l1Downloaded / postCloseBmDone…）
  // 是 in-memory，kickstart 重啟後全部歸零 → 重啟若落在盤中/盤後窗口，下一輪 tick 就把
  // 「今天其實已做過的重活」（全量 CN 下載 3127 檔 + TW/CN 盤後掃描 + 盤中掃描）同時重跑，
  // 一起搶 rate-limiter 桶與 event loop → /api/stock（走圖主資料）被餓死、走圖載不出來。
  // 修法：重活在開機後一段緩衝內跳過、且彼此用 offset 錯開，讓重啟瞬間 server 先能服務
  // 請求，之後回到「正常 staggered 排程」（= 事故前運作正常的狀態）。輕量工作（L2 刷新、
  // realtime-scan）不擋。可用 LOCAL_CRON_BOOT_GRACE_MS 調整基準緩衝。
  const bootAt = Date.now();
  const BOOT_GRACE_MS = Number(process.env.LOCAL_CRON_BOOT_GRACE_MS) || 90_000;
  function bootCoolingDown(label: string, extraOffsetMs = 0): boolean {
    const elapsed = Date.now() - bootAt;
    const threshold = BOOT_GRACE_MS + extraOffsetMs;
    if (elapsed < threshold) {
      console.log(
        `[local-cron] ${label} 開機緩衝中跳過 (${Math.round(elapsed / 1000)}s/${Math.round(threshold / 1000)}s) ` +
        `— 避免重啟瞬間補抓風暴餓死 /api/stock`,
      );
      return true;
    }
    return false;
  }

  // ── 盤中：買法掃描批次（3 track 取代 16 字母）─────────────────────────
  // 0513 ABCDE E：scan-bm-batch 之後再批 intraday — 把 16 字母獨立 cron 改成
  // 3 track 一 cron。同 track 內字母共用 stockList / L2 / TurnoverRank /
  // marketTrend，比舊版省 ~5 倍前置時間。
  async function scanIntradayBatchTrack(market: 'TW' | 'CN', track: 'bullish' | 'reversal' | 'system') {
    if (bootCoolingDown(`${market} bm-batch ${track}`, 30_000)) return;
    if (!isMarketOpen(market) && !isPostCloseWindow(market)) return;
    const data = await callRoute(
      `/api/cron/update-intraday-bm-batch?market=${market}&track=${track}`,
      `${market} update-intraday-bm-batch ${track}`,
    ) as { data?: { skipped?: boolean; reason?: string; results?: Record<string, { count?: number }> } } | null;
    const payload = data?.data ?? data ?? {};
    if ((payload as { skipped?: boolean }).skipped) {
      console.log(`[local-cron] ${market} 買法批次 ${track} 跳過：${(payload as { reason?: string }).reason}`);
    } else {
      const results = (payload as { results?: Record<string, { count?: number }> }).results ?? {};
      const summary = Object.entries(results).map(([m, r]) => `${m}=${r.count ?? '?'}`).join(' ');
      console.log(`[local-cron] ${market} 買法批次 ${track}: ${summary}`);
    }
  }

  // ── 盤中：三色資金即時掃描（TW + CN 自創策略），每 10 分鐘 ──
  // 把該市場 L2 快照合成今日進行中日K 重算三色，寫 intraday 快照（不碰盤後封存）。
  const sanseIntradayInFlight = { TW: false, CN: false };
  async function scanIntradaySanSe(market: 'TW' | 'CN') {
    if (bootCoolingDown(`${market} 三色盤中`, 15_000)) return;
    if (!isMarketOpen(market) && !isPostCloseWindow(market)) return;
    if (sanseIntradayInFlight[market]) { console.log(`[local-cron] ${market} 三色盤中：上一輪未完成，跳過`); return; }
    sanseIntradayInFlight[market] = true;
    try {
    const route = market === 'CN' ? '/api/cron/update-intraday-cn-sanse' : '/api/cron/update-intraday-tw-sanse';
    const data = await callRoute(
      route,
      `${market} update-intraday-${market === 'CN' ? 'cn' : 'tw'}-sanse`,
    ) as { data?: { skipped?: boolean; reason?: string; counts?: Record<string, number>; evaluated?: number } } | null;
    const payload = data?.data ?? data ?? {};
    if ((payload as { skipped?: boolean }).skipped) {
      console.log(`[local-cron] ${market} 三色盤中跳過：${(payload as { reason?: string }).reason}`);
    } else {
      const c = (payload as { counts?: Record<string, number> }).counts ?? {};
      console.log(`[local-cron] ${market} 三色盤中: strict=${c.strict ?? '?'} medium=${c.medium ?? '?'} loose=${c.loose ?? '?'}（評估 ${(payload as { evaluated?: number }).evaluated ?? '?'} 檔）`);
    }
    } finally {
      sanseIntradayInFlight[market] = false;
    }
  }

  // ── 盤中：六條件掃描（scan-intraday），每 10 分鐘 ──
  async function scanIntradayDaily(market: 'TW' | 'CN') {
    if (bootCoolingDown(`${market} scan-intraday`, 0)) return;
    if (!isMarketOpen(market)) return;
    const data = await callRoute(
      `/api/cron/scan-intraday?market=${market}`,
      `${market} scan-intraday`,
    ) as { data?: { resultCount?: number; skipped?: boolean; reason?: string } } | null;
    const payload = data?.data ?? data ?? {};
    if ((payload as { skipped?: boolean }).skipped) {
      console.log(`[local-cron] ${market} scan-intraday 跳過：${(payload as { reason?: string }).reason}`);
    } else {
      console.log(`[local-cron] ${market} scan-intraday: ${(payload as { resultCount?: number }).resultCount ?? -1} 檔`);
    }
  }

  // ── 盤後：六條件 post_close 掃描（scan-tw / scan-cn），每日一次 ──
  // TW：14:10 CST；CN：16:10 CST（確保 L1 已下載）
  const postCloseDailyDone = persistentState.postCloseDailyDone;
  async function scanPostCloseDaily(market: 'TW' | 'CN') {
    if (deferForWhisper(`${market} scan post_close`)) return;
    if (bootCoolingDown(`${market} scan post_close`, 75_000)) return;
    const tz = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
    const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
    const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    const hhmm = nowLocal.getHours() * 100 + nowLocal.getMinutes();

    const windowStart = market === 'TW' ? 1410 : 1610;
    const windowEnd = market === 'TW' ? 1700 : 1900;
    if (hhmm < windowStart || hhmm > windowEnd) return;
    if (postCloseDailyDone[market] === todayLocal) return;
    if (!isTradingDay(todayLocal, market)) return;

    postCloseDailyDone[market] = todayLocal;
    const route = market === 'TW' ? '/api/cron/scan-tw' : '/api/cron/scan-cn';
    console.log(`[local-cron] ${market} scan post_close 啟動 (${todayLocal})...`);
    const data = await callRoute(route, `${market} scan post_close`) as
      { data?: { resultCount?: number; skipped?: boolean; reason?: string } } | null;
    if (!data) {
      postCloseDailyDone[market] = '';
      return;
    }
    await persistCronState();
    const payload = data?.data ?? data ?? {};
    console.log(`[local-cron] ${market} scan post_close: ${(payload as { resultCount?: number }).resultCount ?? -1} 檔`);
  }

  // ── 盤中：L2 刷新（update-intraday） + watchdog ──
  // 2026-05-21 加 watchdog：每輪刷新後 check L2 距上次成功 > 10 分鐘就 console.error
  // 背景：新 Mac 5/20 12:10 L2 polling 突然停 80 分鐘沒人發現 → L1 ~180 檔錯
  async function refreshAndScan(market: 'TW' | 'CN') {
    if (!isMarketOpen(market) && !isPostCloseWindow(market)) return;

    const data = await callRoute(
      `/api/cron/update-intraday?market=${market}`,
      `${market} update-intraday`,
      { timeoutMs: 3 * 60_000 },
    ) as { data?: { count?: number; skipped?: boolean; reason?: string; alert?: boolean; alertLevel?: string } } | null;
    if (!data) {
      console.error(`[L2-watchdog] ★ ${market} L2 刷新 route 無回應；下一輪會重試`);
      return;
    }
    const payload = data?.data ?? data ?? {};
    if ((payload as { skipped?: boolean }).skipped) {
      console.log(`[local-cron] ${market} L2 刷新跳過：${(payload as { reason?: string }).reason}`);
    } else {
      console.log(`[local-cron] ${market} L2 刷新 ${(payload as { count?: number }).count ?? -1} 支`);
    }

    // update-intraday route 已在 Node runtime 內完成 provider 健康判斷；instrumentation
    // 只消費回應，避免直接 import IntradayCache 把整個 data/ 動態路徑拉進啟動 trace。
    if ((payload as { alert?: boolean }).alert) {
      const alertLevel = (payload as { alertLevel?: string }).alertLevel ?? 'critical';
      console.error(`[L2-watchdog] ★ ${market} L2 刷新異常：alertLevel=${alertLevel}`);
      const webhook = process.env.HEALTH_ALERT_WEBHOOK_URL;
      if (webhook) {
        fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `🚨 ${market} L2 polling 異常：本輪無有效快照`,
            level: alertLevel,
            market,
          }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      }
    }
  }

  // ── 盤後：買法 post_close 掃描（scan-bm-batch 3 track）──
  // 0513 ABCDE E：原本一字母一 cron 共 16 次 → 改成一 track 一 cron 共 3 次，
  // 同 track 內字母共用 stockList / L2 / TurnoverRank / marketTrend / L1 cache，
  // 比舊版省 ~7 倍前置時間（對應 scan-bm-batch route 設計）。
  // TW：收盤後 14:10 CST（UTC+8 = 06:10 UTC）；CN：16:10 CST
  type Track = 'bullish' | 'reversal' | 'system';
  const postCloseBmDone = { TW: '', CN: '' };
  async function scanPostCloseBatch(market: 'TW' | 'CN', track: Track) {
    if (deferForWhisper(`${market} scan-bm-batch ${track}`)) return;
    if (bootCoolingDown(`${market} scan-bm-batch ${track}`, 60_000)) return;
    const tz = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
    const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
    const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    const hhmm = nowLocal.getHours() * 100 + nowLocal.getMinutes();

    // TW: 14:10–17:00；CN: 16:10–19:00
    const windowStart = market === 'TW' ? 1410 : 1610;
    const windowEnd = market === 'TW' ? 1700 : 1900;
    if (hhmm < windowStart || hhmm > windowEnd) return;

    const key = `${market}-${track}`;
    const doneKey = `${todayLocal}-${key}`;
    if ((postCloseBmDone as Record<string, string>)[key] === doneKey) return;
    if (!isTradingDay(todayLocal, market)) return;

    (postCloseBmDone as Record<string, string>)[key] = doneKey;
    console.log(`[local-cron] ${market} scan-bm-batch ${track} post_close 啟動 (${todayLocal})...`);
    const data = await callRoute(
      `/api/cron/scan-bm-batch?market=${market}&track=${track}`,
      `${market} scan-bm-batch ${track}`,
    ) as { data?: { results?: Record<string, unknown>; skipped?: boolean; reason?: string } } | null;
    const payload = data?.data ?? data ?? {};
    if ((payload as { skipped?: boolean }).skipped) {
      console.log(`[local-cron] ${market} scan-bm-batch ${track} 跳過：${(payload as { reason?: string }).reason}`);
    } else {
      const results = (payload as { results?: Record<string, { resultCount?: number }> }).results ?? {};
      const summary = Object.entries(results)
        .map(([m, r]) => `${m}=${r.resultCount ?? '?'}`)
        .join(' ');
      console.log(`[local-cron] ${market} scan-bm-batch ${track}: ${summary}`);
    }
  }

  // ── 盤後：L1 下載（走 download-candles route） ──
  // 0510 修：原本「每個交易日只跑一次」會有 stale 問題 — 第一次在 post-close 30 min
  // 窗口跑時，data provider 對 .TWO 上櫃股還可能是盤中快照（TPEx 14:00 才結算完）。
  // 改成每日「2 個 phase」各跑一次：
  //   TW: phase=initial 13:30-14:30 CST（best effort）+ phase=final 16:00-17:00 CST（覆蓋確認）
  //   CN: phase=initial 15:00-16:00 CST + phase=final 17:30-18:30 CST
  // 不在窗口內 = phase='rest'，每天最多再補一次。
  const l1Downloaded: Record<'TW' | 'CN', Set<string>> = {
    TW: new Set(persistentState.l1Downloaded.TW),
    CN: new Set(persistentState.l1Downloaded.CN),
  };
  function l1DownloadPhase(market: 'TW' | 'CN'): 'initial' | 'final' | 'rest' {
    const tz = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
    const hhmm = parseInt(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
        .format(new Date()).replace(':', ''),
      10,
    );
    if (market === 'TW') {
      if (hhmm >= 1330 && hhmm < 1430) return 'initial';
      if (hhmm >= 1600 && hhmm < 1700) return 'final';
      return 'rest';
    }
    // CN
    if (hhmm >= 1500 && hhmm < 1600) return 'initial';
    if (hhmm >= 1730 && hhmm < 1830) return 'final';
    return 'rest';
  }
  async function downloadL1(market: 'TW' | 'CN') {
    // 有獨立 launchd eod-settle/catch-up 的常駐主機可關掉這條全量下載，避免同時對
    // 3,000+ 檔發外部請求、跟專用補檔程序互搶記憶體與 provider 額度。
    if (process.env.DISABLE_LOCAL_CANDLE_DOWNLOAD === '1') return;
    // 最重（全量下載 3127 檔）→ 開機後最晚才放行，給前面較輕的工作先做完
    if (deferForWhisper(`${market} download-candles`)) return;
    if (bootCoolingDown(`${market} download-candles`, 90_000)) return;
    if (isMarketOpen(market)) return; // 盤中不下（收盤價還沒定）
    const lastTrading = getLastTradingDay(market);
    const phase = l1DownloadPhase(market);
    const key = `${lastTrading}:${phase}`;
    if (l1Downloaded[market].has(key)) return;

    l1Downloaded[market].add(key); // 先標記，防重複執行
    console.log(`[local-cron] ${market} 觸發 download-candles (lastTrading=${lastTrading}, phase=${phase})...`);
    const result = await callRoute(`/api/cron/download-candles?market=${market}`, `${market} download-candles ${phase}`);
    if (!result) {
      l1Downloaded[market].delete(key);
      return;
    }
    persistentState.l1Downloaded[market] = [...l1Downloaded[market]].slice(-6);
    await persistCronState();
  }

  // ── 盤後：L2 快照補 L1（收盤後 45 分鐘，TW≥14:15 / CN≥15:45，每日一次） ──
  // 比 download-candles 快（5 秒完成全市場），用於補 download-candles 遺漏的個股
  //
  // 2026-05-21：原本 14:00 / 15:30 觸發太早。L2 polling 每 5 分鐘一輪，14:00 那一刻
  // append 用到的 in-memory L2 可能是 13:55 的 stale 快照（還沒抓到 13:30 集合競價最終價）。
  // 結果 ~610 檔 L1 close 被寫成 stale 中間 tick，特別是 .TWO 上櫃股 (8358 金居 5/15+5/19+5/20
  // 即此 bug)。修法：(1) 觸發時間 → 14:15 / 15:45 (再給 L2 三輪 polling 抓收盤集合競價)；
  // (2) 觸發前強制呼叫 update-intraday route，確保用最新 L2 而非 in-memory stale。
  const l1SnapshotDone = persistentState.l1SnapshotDone;
  async function appendL1FromSnapshot(market: 'TW' | 'CN') {
    if (deferForWhisper(`${market} append-from-snapshot`)) return;
    if (bootCoolingDown(`${market} append-from-snapshot`, 45_000)) return;
    if (isMarketOpen(market)) return;
    const lastTrading = getLastTradingDay(market);
    if (l1SnapshotDone[market] === lastTrading) return;

    // 45 分鐘緩衝：TW 收盤 13:30 → 等到 14:15；CN 收盤 15:00 → 等到 15:45
    const tz = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
    const now = new Date();
    const hhmm = parseInt(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
        .format(now).replace(':', ''),
      10,
    );
    const triggerMin = market === 'TW' ? 1415 : 1545; // 14:15 CST / 15:45 CST
    if (hhmm < triggerMin) return;

    // 先標記 flag 避免重入，但實際 await refresh 失敗時 reset 讓下一輪重試
    l1SnapshotDone[market] = lastTrading;

    // 觸發前透過 Node route 強制 refresh；不要從 instrumentation 直接 import
    // IntradayCache，否則 Next.js output tracing 會把 18GB runtime data 全部納入。
    console.log(`[local-cron] ${market} append-from-snapshot 前強制 L2 refresh...`);
    const refresh = await callRoute(
      `/api/cron/update-intraday?market=${market}&force=1`,
      `${market} pre-append L2 refresh`,
    ) as { data?: { count?: number }; count?: number } | null;
    const refreshedCount = refresh?.data?.count ?? refresh?.count;
    if (refresh) {
      console.log(`[local-cron] ${market} 強制 L2 refresh 完成: ${refreshedCount ?? '?'} 筆`);
    } else {
      // 不 reset flag — append-from-snapshot 內部仍會 fallback 打官方盤後 API。
      console.warn(`[local-cron] ${market} 強制 L2 refresh 失敗 (繼續 append)`);
    }

    console.log(`[local-cron] ${market} append-from-snapshot 觸發 (lastTrading=${lastTrading})...`);
    const json = await callRoute(
      // 排程刻意等到 TW 14:15 / CN 15:45 才封存，但 route 的一般盤後窗口只到
      // TW 14:30 / CN 15:30。CN 若不帶 force 會每天回「非盤後窗口」並被誤記完成。
      // force 只略過窗口檢查，route 內的 isMarketOpen 守門仍然有效。
      `/api/cron/append-from-snapshot?market=${market}&force=1`,
      `${market} append-from-snapshot`,
    ) as { data?: { appended?: number; already?: number; skipped?: boolean; reason?: string }; appended?: number; already?: number; skipped?: boolean; reason?: string } | null;
    if (!json) {
      l1SnapshotDone[market] = '';
      return;
    }
    const payload = json.data ?? json;
    if (payload.skipped) {
      // 跳過不是完成；清旗標讓下一個 5 分鐘 tick 重試，避免把 8/19 永久當 8/20。
      l1SnapshotDone[market] = '';
      console.warn(`[local-cron] ${market} append-from-snapshot 跳過：${payload.reason ?? 'unknown'}`);
      return;
    }
    await persistCronState();
    console.log(`[local-cron] ${market} append-from-snapshot 完成: appended=${payload.appended ?? '?'}`);

    // append 完成後 15 分鐘跑 L1↔L2 一致性 audit（給 download-candles 也跑完）
    // 2026-05-21 加。這個跟 append 同個 daily flag 走，append 跑完才會走到這。
    setTimeout(() => {
      callRoute(`/api/cron/audit-l1-l2-consistency?market=${market}`, `${market} L1↔L2 audit`)
        .then(r => {
          const d = (r as { data?: unknown } | null)?.data ?? r ?? {};
          const { diff1pct, diff5pct, ohlcInconsistent, total, alertFired } = d as { diff1pct?: number; diff5pct?: number; ohlcInconsistent?: number; total?: number; alertFired?: boolean };
          console.log(
            `[local-cron] ${market} L1↔L2 audit: ` +
            `diff>1%=${diff1pct ?? '?'}/${total ?? '?'}, diff>5%=${diff5pct ?? '?'}, OHLC 不自洽=${ohlcInconsistent ?? '?'}` +
            (alertFired ? ' 🚨 ALERT' : ''),
          );
        })
        .catch(err => console.error(`[local-cron] ${market} L1↔L2 audit 失敗:`, err));
    }, 15 * 60 * 1000);
  }

  // ── 打板開盤確認（CN 9:25–9:35 CST，每日一次） ──
  const dabanConfirmed = { date: '' };
  async function maybeConfirmDabanOpen() {
    const nowCN = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const todayCN = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const hhmm = nowCN.getHours() * 100 + nowCN.getMinutes();

    if (hhmm < 925 || hhmm > 935) return;
    if (dabanConfirmed.date === todayCN) return;
    if (!isTradingDay(todayCN, 'CN')) return;

    dabanConfirmed.date = todayCN;
    console.log('[local-cron] CN 打板開盤確認啟動...');
    const json = await callRoute('/api/cron/confirm-daban-open', 'CN confirm-daban-open') as
      { data?: { confirmed?: number; total?: number; resultCount?: number } } | null;
    const data = json?.data ?? json ?? {};
    const confirmed = (data as { confirmed?: number }).confirmed ?? 0;
    const total = (data as { resultCount?: number; total?: number }).resultCount ?? (data as { total?: number }).total ?? 0;
    console.log(`[local-cron] CN 打板開盤確認完成: ${confirmed}/${total} 支確認進場`);
  }

  // 計時器
  // 開機後先補一輪；舊版要等滿 5 分鐘才有第一筆 L2，部署／重啟後題材必然先顯示舊快照。
  setTimeout(() => {
    refreshAndScan('TW').catch(err => console.error('[local-cron] TW initial refreshAndScan:', err));
  }, 15_000);
  setTimeout(() => {
    refreshAndScan('CN').catch(err => console.error('[local-cron] CN initial refreshAndScan:', err));
  }, 45_000);
  // 部署／重啟後若只等 10 分鐘 interval + 1 分鐘 offset，L4 會長達 11 分鐘顯示過期。
  // 保留 90 秒 boot grace，待 L2 首輪完成後錯開兩市場首掃，避免與開機重活同時搶資源。
  setTimeout(() => {
    scanIntradayDaily('TW').catch(err => console.error('[local-cron] TW initial scan-intraday:', err));
  }, 120_000);
  setTimeout(() => {
    scanIntradayDaily('CN').catch(err => console.error('[local-cron] CN initial scan-intraday:', err));
  }, 150_000);
  // 題材 API 快取只有 40 秒；L2 若仍每 5 分鐘刷新，畫面再勤勞 polling 也只會重複舊快照。
  // 一分鐘是供應商負載與盤中體感的折衷，下限固定 60 秒並由 route single-flight 防止重入。
  setInterval(() => { refreshAndScan('TW').catch(err => console.error('[local-cron] TW refreshAndScan:', err)); }, L2_REFRESH_INTERVAL_MS);
  // 與 TW 錯開 30 秒，避免兩個全市場 provider 同時搶 curl slots / server connections。
  setInterval(() => {
    setTimeout(() => {
      refreshAndScan('CN').catch(err => console.error('[local-cron] CN refreshAndScan:', err));
    }, 30_000);
  }, L2_REFRESH_INTERVAL_MS);

  setInterval(() => {
    // L2 也是從開機時間起算；延後一分鐘，避免每 10 分鐘固定撞上 L2 refresh。
    setTimeout(() => {
      scanIntradayDaily('TW').catch(err => console.error('[local-cron] TW scan-intraday:', err));
      scanIntradayDaily('CN').catch(err => console.error('[local-cron] CN scan-intraday:', err));
    }, 60_000);
  }, 10 * 60 * 1000);

  // 盤中買法批次：每 10 分鐘輪一個 track（bullish/reversal/system）
  // 對齊 vercel.json：
  //   :02 → bullish（B/C/E/J/K/L/M/P 8 字母共一 call）
  //   :05 → reversal（D/F/N/O 4 字母共一 call）
  //   :08 → system（Q 戰法軌，每 30 分鐘）
  setInterval(() => {
    const now = new Date();
    const min = now.getMinutes();
    // :09 → 三色資金盤中（TW + CN 自創策略，獨立於買法軌）
    if (min % 10 === 9) {
      scanIntradaySanSe('TW').catch(err => console.error('[local-cron] TW 三色盤中:', err));
      scanIntradaySanSe('CN').catch(err => console.error('[local-cron] CN 三色盤中:', err));
    }
    // :00 / :30 → 六條件(30分K)盤中掃描（TW；每 30 分掃一次、名單累加，route 內部 gate + 算邊界 + idempotent）
    // 早盤攻擊訊號最多、午後 30分K 幾乎不動(六條件⑤紅K實體 2% 是日K尺度)；用累加不取代，
    // 名單整天越疊越完整，收盤前 13:30 那次 = 當天最終。
    if (min === 0 || min === 30) {
      callRoute('/api/cron/scan-intraday-30m?market=TW', 'scan-30m').catch(err => console.error('[local-cron] TW scan-30m:', err));
    }
    let track: 'bullish' | 'reversal' | 'system' | null = null;
    if (min % 10 === 2) track = 'bullish';
    else if (min % 10 === 5) track = 'reversal';
    else if (min % 30 === 8) track = 'system';
    if (!track) return;
    scanIntradayBatchTrack('TW', track).catch(err => console.error(`[local-cron] TW bm-batch ${track}:`, err));
    scanIntradayBatchTrack('CN', track).catch(err => console.error(`[local-cron] CN bm-batch ${track}:`, err));
  }, 60 * 1000);

  setInterval(() => { maybeConfirmDabanOpen().catch(err => console.error('[local-cron] confirm-daban-open:', err)); }, 60 * 1000);
  setInterval(() => {
    downloadL1('TW').catch(err => console.error('[local-cron] TW downloadL1:', err));
    downloadL1('CN').catch(err => console.error('[local-cron] CN downloadL1:', err));
  }, 10 * 60 * 1000);
  setInterval(() => {
    appendL1FromSnapshot('TW').catch(err => console.error('[local-cron] TW appendL1FromSnapshot:', err));
    appendL1FromSnapshot('CN').catch(err => console.error('[local-cron] CN appendL1FromSnapshot:', err));
  }, 5 * 60 * 1000);

  // 盤後買法掃描：每分鐘檢查，時間窗口內對 3 個 track（bullish/reversal/system）各觸發一次
  // 0513 ABCDE E：從一字母一 cron（16 calls）改成一 track 一 cron（3 calls），
  // 跟 vercel.json 對齊（vercel cron 也用 scan-bm-batch）。
  setInterval(() => {
    // 常駐主機由 dependency-aware strategy-eod launchd 串行執行；關閉這組重複觸發
    // 可避免 coverage 尚未完成時每分鐘重試，以及同一批策略被兩套 scheduler 同時寫入。
    if (process.env.DISABLE_LOCAL_POST_CLOSE_SCAN === '1') return;
    for (const track of ['bullish', 'reversal', 'system'] as const) {
      scanPostCloseBatch('TW', track).catch(err => console.error(`[local-cron] TW scan-bm-batch ${track}:`, err));
      scanPostCloseBatch('CN', track).catch(err => console.error(`[local-cron] CN scan-bm-batch ${track}:`, err));
    }
    scanPostCloseDaily('TW').catch(err => console.error('[local-cron] TW scan post_close:', err));
    scanPostCloseDaily('CN').catch(err => console.error('[local-cron] CN scan post_close:', err));
  }, 60 * 1000);

  // ── 即時分鐘 K 爆量警示 (/realtime + ntfy)：每 30 秒 ──
  // route 內部判斷盤中時段 + 守門，盤外直接 return skip。
  // 第一次被呼叫時 lazy 跑 restoreFromDisk + startFlushLoop。
  const runRealtimeScan = () => {
    callRoute('/api/cron/realtime-scan', 'realtime-scan', { timeoutMs: 25_000 }).catch(err =>
      console.error('[local-cron] realtime-scan:', err),
    );
  };
  // 與 5 分鐘 L2 tick 錯開 15 秒；single-flight 再保證慢輪不會每 30 秒堆一條連線。
  setTimeout(() => {
    runRealtimeScan();
    setInterval(runRealtimeScan, 30 * 1000);
  }, 15_000);

  // ── 三色資金買賣推播 (/api/cron/sanse-notify → ntfy)：每 120 秒 ──
  // 取代舊爆量手機推播：盯「所有持倉人 open 持倉聯集」（2026-06-12 改，持倉派生，
  // 不再用手寫清單），三色翻成該買/該賣就推一次（route 內自帶開盤 gate + 當日去重，
  // 盤外是廉價 no-op）。
  setInterval(() => {
    callRoute('/api/cron/sanse-notify', 'sanse-notify').catch(err =>
      console.error('[local-cron] sanse-notify:', err),
    );
  }, 120 * 1000);

  // ── 持倉動作推播 (/api/cron/portfolio-notify → ntfy)：每 120 秒（2026-06-12 A1）──
  // 停損/全出/減半觸發即推手機 + 13:18-13:30 執行窗再提醒「13:25 掛市價」。
  // route 內自帶交易日/時段 gate + 當日去重，盤外是廉價 no-op。
  setInterval(() => {
    callRoute('/api/cron/portfolio-notify', 'portfolio-notify').catch(err =>
      console.error('[local-cron] portfolio-notify:', err),
    );
  }, 120 * 1000);

  // Auto-repair watchdog：主下載 cron 完成後，檢查 verify 報告，
  // 若 stocksStale > 50 或 coverage < 97% 自動觸發 retry-failed
  // 開發本地：每 30 分鐘檢查一次（vercel 上是固定排程）
  setInterval(() => {
    callRoute('/api/cron/auto-repair-watchdog?market=TW', 'TW auto-repair watchdog')
      .catch(err => console.error('[local-cron] TW watchdog:', err));
    callRoute('/api/cron/auto-repair-watchdog?market=CN', 'CN auto-repair watchdog')
      .catch(err => console.error('[local-cron] CN watchdog:', err));
  }, 30 * 60 * 1000);

  // ETF 主動式持股：每週一至五 18:00 / 23:00 CST 自動跑（鏡像 vercel.json 排程）
  // 18:00 fetch-etf-holdings、23:00 update-etf-tracking；用旗標避免同一天重跑
  let lastEtfFetchDate = '';
  let lastEtfTrackDate = '';
  setInterval(() => {
    if (deferForWhisper('ETF')) return;
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei',
      hour12: false,
      weekday: 'short',
      hour: '2-digit', minute: '2-digit',
    }).formatToParts(now);
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(now);
    const wd = get('weekday');
    const isWeekday = wd !== 'Sat' && wd !== 'Sun';
    if (!isWeekday) return;
    const hour = parseInt(get('hour'), 10);
    const min = parseInt(get('minute'), 10);

    // 用 ≥ 而非 == 比對，dev server 中途啟動（例如 18:30）也能補跑當日；旗標避免重觸發
    const minutesSinceMidnight = hour * 60 + min;
    if (minutesSinceMidnight >= 18 * 60 && today !== lastEtfFetchDate) {
      lastEtfFetchDate = today;
      console.log('[local-cron] ETF fetch-holdings 觸發');
      callRoute('/api/cron/fetch-etf-holdings', 'ETF fetch-holdings').catch(err =>
        console.error('[local-cron] ETF fetch failed:', err),
      );
    }
    if (minutesSinceMidnight >= 23 * 60 && today !== lastEtfTrackDate) {
      lastEtfTrackDate = today;
      console.log('[local-cron] ETF update-tracking 觸發');
      callRoute('/api/cron/update-etf-tracking', 'ETF update-tracking').catch(err =>
        console.error('[local-cron] ETF tracking failed:', err),
      );
    }
  }, 60 * 1000);

  // 每 30 分鐘 log heap 用量。超 2GB 印警告（之前出過 next-server 5.3GB 案例 — L1CandleCache lazy expire bug，已於 5/07 修正 evict + maxSize hard cap 6000）
  //
  // 注意：直接寫 process.memoryUsage() 會讓 Turbopack 把整個檔當 Edge runtime 解析時噴 warning
  // （即使這函式只在 Node 跑）。透過 globalThis 動態取，繞過 lexical pattern match。
  setInterval(() => {
    try {
      const proc = (globalThis as { process?: { memoryUsage?: () => { heapUsed: number; rss: number } } }).process;
      const mem = proc?.memoryUsage?.();
      if (!mem) return;
      const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
      const rssMB = Math.round(mem.rss / 1024 / 1024);
      const tag = heapMB > 2048 ? '⚠️ heap > 2GB' : heapMB > 1024 ? '注意' : '正常';
      console.log(`[local-cron] heap=${heapMB}MB rss=${rssMB}MB [${tag}]`);
    } catch (err) {
      console.error('[local-cron] heap log failed:', err);
    }
  }, 30 * 60 * 1000);

  // 每日健康快照不在這裡提前觸發。
  // 正式 dependency-aware strategy-eod 流水線會在 A／各買法／SanSe／V／Y 全部完成後，
  // 最後呼叫 daily-health-snapshot。舊版 14:30/16:30 先拍快照，早於 18:30/20:00
  // 策略流水線，會固定產生「策略未就緒」假紅燈；且同日去重會讓第二市場無法補寫。

  // TDCC 大戶持股：每天傍晚 18:00 CST 後自動檢查、抓最新一週
  // 為什麼每天而非固定週四：TDCC 的「週五分散表」是週末才公布，固定週四永遠慢一週（2026-06-07 踩過）；
  // 改每天檢查 → 哪天公布隔天傍晚就抓到、機器睡過頭也會在下次傍晚補抓；route 對已有基準日會自動 skip（便宜）。
  // 用 60s interval 偵測，hour >= 18 命中傍晚後第一個 tick；旗標避免同一天重跑、機器晚開（>18:00）也能即時補跑
  let lastTdccDate = '';
  setInterval(() => {
    const now = new Date();
    const cst = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei',
      hour12: false,
      hour: '2-digit',
    }).formatToParts(now);
    const get = (t: string) => cst.find(p => p.type === t)?.value ?? '';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(now);
    const hour = parseInt(get('hour'), 10);
    if (hour >= 18 && today !== lastTdccDate) {
      if (deferForWhisper('TDCC daily')) return;
      lastTdccDate = today;
      console.log('[local-cron] TDCC 每日自動抓取觸發');
      callRoute('/api/cron/fetch-tdcc-week', 'TDCC daily').catch(err =>
        console.error('[local-cron] TDCC fetch failed:', err),
      );
    }
  }, 60 * 1000);

  // 海外同業日K：每天 06:35 CST 後抓一次（美股已收盤、日韓抓前日；2026-06-12 B4 補掛 —
  // 當天部署時漏了這條排程）。route 內建限流退避 + 提早收工，partial 隔日自然補。
  let lastGlobalPeersDate = '';
  setInterval(() => {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei', hour12: false, hour: '2-digit', minute: '2-digit',
    }).formatToParts(now);
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(now);
    const hhmm = parseInt(get('hour'), 10) * 100 + parseInt(get('minute'), 10);
    if (hhmm >= 635 && today !== lastGlobalPeersDate) {
      if (deferForWhisper('global-peers daily')) return;
      lastGlobalPeersDate = today;
      console.log('[local-cron] global-peers 海外日K抓取觸發');
      callRoute('/api/cron/fetch-global-peers', 'global-peers daily').catch(err =>
        console.error('[local-cron] global-peers fetch failed:', err),
      );
    }
  }, 60 * 1000);

  // 板塊（題材）強弱排名：每天 17:10 CST 後算一次（TW L1 14:30 eod-settle 已封；2026-06-12 A2）
  // 讀 themeMap 成分股 L1 → data/sectors/TW/{date}.json，/sectors 頁與 /api/themes/ranking 消費。
  let lastSectorDate = '';
  setInterval(() => {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei', hour12: false, hour: '2-digit', minute: '2-digit',
    }).formatToParts(now);
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(now);
    const hhmm = parseInt(get('hour'), 10) * 100 + parseInt(get('minute'), 10);
    if (hhmm >= 1710 && today !== lastSectorDate) {
      if (deferForWhisper('sector-strength daily')) return;
      lastSectorDate = today;
      console.log('[local-cron] sector-strength 板塊排名觸發');
      callRoute('/api/cron/compute-sector-strength', 'sector-strength daily').catch(err =>
        console.error('[local-cron] sector-strength failed:', err),
      );
    }
  }, 60 * 1000);

  // 融資券/借券/當沖全市場持久化：每天 21:40 CST 後抓一次（借券 TWT93U ~21:00 後完整；2026-06-12 B2）
  // 寫 data/chips/TW/{margin,sbl,daytrade}/，給「融資暴增/借券暴增/當沖過高」時間序判斷與回測用。
  let lastChipExtrasDate = '';
  setInterval(() => {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei', hour12: false, hour: '2-digit', minute: '2-digit',
    }).formatToParts(now);
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(now);
    const hhmm = parseInt(get('hour'), 10) * 100 + parseInt(get('minute'), 10);
    if (hhmm >= 2140 && today !== lastChipExtrasDate) {
      if (deferForWhisper('chip-extras daily')) return;
      lastChipExtrasDate = today;
      console.log('[local-cron] chip-extras 持久化觸發');
      callRoute('/api/cron/fetch-chip-extras', 'chip-extras daily').catch(err =>
        console.error('[local-cron] chip-extras fetch failed:', err),
      );
    }
  }, 60 * 1000);

  // 處置股/注意股官方名單：每天 17:35 CST 後抓一次（公布在收盤後；2026-06-12 B1）
  // 寫 data/market/TW/attention/，saveScanSession 蓋 disposalVeto / applyPanelFilter 硬排除。
  // ≥ 比對 + 當日旗標：機器晚開也會在當天第一個 tick 補抓。
  let lastAttentionDate = '';
  setInterval(() => {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei', hour12: false, hour: '2-digit', minute: '2-digit',
    }).formatToParts(now);
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(now);
    const hhmm = parseInt(get('hour'), 10) * 100 + parseInt(get('minute'), 10);
    if (hhmm >= 1735 && today !== lastAttentionDate) {
      if (deferForWhisper('attention-list daily')) return;
      lastAttentionDate = today;
      console.log('[local-cron] 處置股/注意股名單抓取觸發');
      callRoute('/api/cron/fetch-attention-list', 'attention-list daily').catch(err =>
        console.error('[local-cron] attention-list fetch failed:', err),
      );
    }
  }, 60 * 1000);
}
