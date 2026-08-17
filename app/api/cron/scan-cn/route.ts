import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { runScanPipeline } from '@/lib/scanner/ScanPipeline';
import { assertL1Coverage } from '@/lib/scanner/coverageGuard';
import { verifyPostCloseScanCompletion } from '@/lib/scanner/scanCompletion';
import { getActiveStrategyServer } from '@/lib/strategy/activeStrategyServer';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  const dateParam = req.nextUrl.searchParams.get('date');
  const date = dateParam ?? getLastTradingDay('CN');
  const directions = ['long', 'short'] as const;
  const mtfModes = ['daily', 'mtf'] as const;
  const strategy = await getActiveStrategyServer();

  if (!isTradingDay(date, 'CN')) {
    return apiOk({ skipped: true, reason: 'non-trading day', date });
  }

  // 支援批次分割（Vercel 300s 限制）
  const batch = parseInt(req.nextUrl.searchParams.get('batch') ?? '0', 10) || undefined;
  const totalBatches = parseInt(req.nextUrl.searchParams.get('totalBatches') ?? '0', 10) || undefined;

  // 非分批本地排程會重試；已有四份正式主檔就直接成功。
  if (!batch) {
    const existing = await verifyPostCloseScanCompletion({
      market: 'CN', date,
      directions: [...directions],
      mtfModes: [...mtfModes],
      strategyId: strategy.id,
    });
    if (existing.completed && req.nextUrl.searchParams.get('force') !== '1') {
      return apiOk({ skipped: true, completed: true, reason: 'post_close already complete', market: 'CN', date });
    }
  }

  // L1 覆蓋率守門：CN 多源偶有退市/停牌長尾，但活躍股至少要 95% 含目標日 K 棒。
  // 可用 ?force=1 強制跑（手動 backfill 場景）
  const force = req.nextUrl.searchParams.get('force') === '1';
  if (!force) {
    const coverage = await assertL1Coverage('CN', date, 0.95);
    if (!coverage.ok) {
      // 2026-05-08：原 silent warn → alert + 自動觸發 download-batch 救援
      console.error(`[cron/scan-cn] ★★ 跳過 scan: ${coverage.reason} — 自動觸發 download-candles-batch 救援`);
      const proto = req.headers.get('x-forwarded-proto') ?? 'https';
      const host = req.headers.get('host') ?? 'localhost:3000';
      const auth = req.headers.get('authorization') ?? '';
      // CN 走 batch 1（含大盤指數補漏 + 第一批個股）
      fetch(`${proto}://${host}/api/cron/download-candles-batch?market=CN&batch=1&totalBatches=8`, { headers: { authorization: auth } })
        .catch(err => console.error('[cron/scan-cn] auto-trigger download failed:', err));
      return apiError(`CN ${date} L1 coverage insufficient: ${coverage.reason}; auto-recovery-triggered`, 503);
    }
    console.info(`[cron/scan-cn] L1 覆蓋率守門通過: ${(coverage.coverageRate * 100).toFixed(1)}% (health=${coverage.health})`);
  }

  try {
    const startedAt = Date.now();
    // 這個 endpoint 只寫 A 六條件 daily/mtf；B～R 由 scan-bm-batch 分軌負責。
    const result = await runScanPipeline({
      market: 'CN',
      date,
      sessionType: 'post_close',
      directions: [...directions],
      mtfModes: [...mtfModes],
      force: true,
      batch,
      totalBatches,
      strategy,
    });

    const completion = await verifyPostCloseScanCompletion({
      market: 'CN', date,
      directions: [...directions],
      mtfModes: [...mtfModes],
      startedAt,
      strategyId: strategy.id,
    });
    if (result.timedOut || !completion.completed) {
      console.error('[cron/scan-cn] post_close incomplete', { date, batch, timedOut: result.timedOut, completion });
      return apiError(`CN ${date} post_close incomplete: missing=${completion.missing.join(',') || '-'} stale=${completion.stale.join(',') || '-'}`, 503);
    }

    const alert = (result.counts['long-daily'] ?? 0) === 0;
    if (alert) {
      console.warn(`[cron/scan-cn] ★ 交易日 ${date} long-daily 0 筆`);
    }

    return apiOk({
      ...result,
      completed: true,
      ...(alert && { alert: true, warning: `交易日 ${date} long-daily 0 筆` }),
    });
  } catch (err) {
    return apiError(String(err));
  }
}
