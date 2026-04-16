// instrumentation.ts — Next.js server startup hook
// 本地開發時自動定期刷新 L2 盤中快照 + 掃描存 L4（模擬 Vercel Cron）

export async function register() {
  // 只在本地開發啟動定時器（Vercel 有自己的 cron）
  if (process.env.VERCEL || process.env.NODE_ENV === 'test') return;

  // 動態 import 避免影響 build
  const { refreshIntradaySnapshot } = await import('./lib/datasource/IntradayCache');
  const { isMarketOpen, isPostCloseWindow, getCurrentTradingDay } = await import('./lib/datasource/marketHours');
  const { runScanPipeline } = await import('./lib/scanner/ScanPipeline');

  console.log('[local-cron] 本地開發模式，啟動 L2 快照刷新 + L4 盤中掃描');
  console.log('[local-cron] TW: 每 5 分鐘 / CN: 每 5 分鐘（盤中+盤後窗口）');

  // 共用邏輯：L2 刷新後跑 ScanPipeline
  async function refreshAndScan(market: 'TW' | 'CN') {
    if (!isMarketOpen(market) && !isPostCloseWindow(market)) return;

    // Phase 1: 刷新 L2 快照
    const snap = await refreshIntradaySnapshot(market);
    console.log(`[local-cron] ${market} L2 已刷新: ${snap.count} 支, ${snap.updatedAt}`);
    if (snap.count === 0) {
      console.warn(`[local-cron] ${market} L2 快照為空，跳過本輪掃描`);
      return;
    }

    // Phase 2: 跑 ScanPipeline（L2 注入 + 掃描 + 存 L4）
    const date = getCurrentTradingDay(market);
    try {
      const result = await runScanPipeline({
        market,
        date,
        sessionType: 'intraday',
        directions: ['long'],
        mtfModes: ['daily'],
      });
      console.log(`[local-cron] ${market} L4 掃描完成: ${result.counts['long-daily'] ?? 0} 檔`);
    } catch (scanErr) {
      console.error(`[local-cron] ${market} 掃描失敗 (non-fatal):`, scanErr);
    }
  }

  // ── L1 歷史K線自動下載（收盤後跑一次，用 L2 快照注入） ──
  // 注意：不能在頂層 import LocalCandleStore（含 'path' 模組，edge runtime 不支援）
  // 改用你的思路：盤後直接從 L2 快照注入 L1，不需要外部 API

  const l1Downloaded = { TW: '', CN: '' };

  async function downloadL1(market: 'TW' | 'CN') {
    const { isTradingDay } = await import('./lib/utils/tradingDay');
    const tz = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());

    if (l1Downloaded[market] === today) return;
    if (!isTradingDay(today, market)) return;
    if (!isPostCloseWindow(market)) return;

    console.log(`[local-cron] ${market} L1 用 L2 快照補入今日 K 棒...`);
    const startTime = Date.now();

    try {
      // 讀 L2 快照
      const snapshot = await refreshIntradaySnapshot(market);
      if (snapshot.count === 0) {
        console.warn(`[local-cron] ${market} L2 快照為空，跳過 L1 注入`);
        return;
      }

      // 動態 import fs（只在 nodejs runtime 執行）
      const { readFileSync, writeFileSync, readdirSync, existsSync } = await import('fs');
      const { join } = await import('path');
      const dataDir = join(process.cwd(), 'data', 'candles', market);
      if (!existsSync(dataDir)) return;

      // Build quote map
      const quoteMap = new Map<string, { open: number; high: number; low: number; close: number; volume: number }>();
      for (const q of snapshot.quotes) {
        if (q.close > 0) quoteMap.set(q.symbol, q);
      }

      const files = readdirSync(dataDir).filter((f: string) => f.endsWith('.json'));
      let injected = 0;

      for (const f of files) {
        try {
          const filePath = join(dataDir, f);
          const data = JSON.parse(readFileSync(filePath, 'utf8'));
          const lastCandle = data.candles?.[data.candles.length - 1];
          if (!lastCandle || lastCandle.date >= today) continue; // 已有今日數據

          const pureCode = (data.symbol || f.replace('.json', '')).replace(/\.(TW|TWO|SS|SZ)$/i, '');
          const q = quoteMap.get(pureCode);
          if (!q || q.close <= 0) continue;

          data.candles.push({ date: today, open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume });
          data.lastDate = today;
          data.updatedAt = new Date().toISOString();
          data.sealedDate = today;
          writeFileSync(filePath, JSON.stringify(data), 'utf8');
          injected++;
        } catch { /* skip individual file errors */ }
      }

      l1Downloaded[market] = today;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[local-cron] ${market} L1 注入完成: ${injected} 支, ${elapsed}s`);
    } catch (err) {
      console.error(`[local-cron] ${market} L1 注入失敗:`, err);
    }
  }

  // ── 打板開盤確認（CN 9:25 CST，每日一次） ──
  const dabanConfirmed = { date: '' };

  async function maybeConfirmDabanOpen() {
    const { isTradingDay } = await import('./lib/utils/tradingDay');
    const nowCN = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const todayCN = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const hhmm = nowCN.getHours() * 100 + nowCN.getMinutes();

    // 09:25–09:35 CST 視窗，交易日，每日只跑一次
    if (hhmm < 925 || hhmm > 935) return;
    if (dabanConfirmed.date === todayCN) return;
    if (!isTradingDay(todayCN, 'CN')) return;

    dabanConfirmed.date = todayCN; // 先標記，防重複執行
    console.log('[local-cron] CN 打板開盤確認啟動...');
    try {
      const { confirmDabanAtOpen } = await import('./lib/scanner/DabanScanner');
      const { getLastTradingDay } = await import('./lib/datasource/marketHours');
      const scanDate = getLastTradingDay('CN');
      if (scanDate === todayCN) {
        console.log('[local-cron] CN 打板確認跳過（scanDate 等於今日）');
        return;
      }
      // 強制刷新 L2 拿集合競價價格
      await refreshIntradaySnapshot('CN');
      const result = await confirmDabanAtOpen(scanDate, todayCN);
      const confirmed = result?.results.filter(r => r.openConfirmed).length ?? 0;
      console.log(`[local-cron] CN 打板開盤確認完成: ${confirmed}/${result?.resultCount ?? 0} 支確認進場`);
    } catch (err) {
      console.error('[local-cron] CN 打板開盤確認失敗:', err);
    }
  }

  // TW: 每 5 分鐘
  setInterval(async () => {
    try { await refreshAndScan('TW'); }
    catch (err) { console.error('[local-cron] TW 刷新+掃描失敗:', err); }
  }, 5 * 60 * 1000);

  // CN: 每 5 分鐘（L4 掃描 3200+ 支需 5-8 分鐘，2 分鐘刷新會浪費 API）
  setInterval(async () => {
    try { await refreshAndScan('CN'); }
    catch (err) { console.error('[local-cron] CN 刷新+掃描失敗:', err); }
  }, 5 * 60 * 1000);

  // 打板開盤確認：每 1 分鐘檢查一次（只在 09:25–09:35 CST 執行）
  setInterval(async () => {
    try { await maybeConfirmDabanOpen(); }
    catch (err) { console.error('[local-cron] 打板開盤確認失敗:', err); }
  }, 60 * 1000);

  // L1 下載：每 10 分鐘檢查一次，盤後窗口內才實際執行（每日只跑一次）
  setInterval(async () => {
    try { await downloadL1('TW'); } catch (err) { console.error('[local-cron] TW L1 下載失敗:', err); }
    try { await downloadL1('CN'); } catch (err) { console.error('[local-cron] CN L1 下載失敗:', err); }
  }, 10 * 60 * 1000);
}
