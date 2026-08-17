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
  const date = dateParam ?? getLastTradingDay('TW');
  const directions = ['long', 'short'] as const;
  const mtfModes = ['daily', 'mtf'] as const;
  const strategy = await getActiveStrategyServer();

  if (!isTradingDay(date, 'TW')) {
    return apiOk({ skipped: true, reason: 'non-trading day', date });
  }

  // launchd 會在固定間隔重試；已有四份正式主檔時直接成功返回，避免重算。
  const existing = await verifyPostCloseScanCompletion({
    market: 'TW', date,
    directions: [...directions],
    mtfModes: [...mtfModes],
    strategyId: strategy.id,
  });
  if (existing.completed && req.nextUrl.searchParams.get('force') !== '1') {
    return apiOk({ skipped: true, completed: true, reason: 'post_close already complete', market: 'TW', date });
  }

  // L1 覆蓋率守門：若 download 未完成或殘缺，拒絕跑 scan，避免覆蓋既有正確結果
  // 可用 ?force=1 強制跑（手動 backfill 場景）
  const force = req.nextUrl.searchParams.get('force') === '1';
  if (!force) {
    const coverage = await assertL1Coverage('TW', date);
    if (!coverage.ok) {
      // 2026-05-08：原 silent warn → alert + 自動觸發 download 救援
      // skip scan 是對的（避免用殘缺資料），但需告警 ops 並自我修復
      console.error(`[cron/scan-tw] ★★ 跳過 scan: ${coverage.reason} — 自動觸發 download-candles 救援`);
      const proto = req.headers.get('x-forwarded-proto') ?? 'https';
      const host = req.headers.get('host') ?? 'localhost:3000';
      const auth = req.headers.get('authorization') ?? '';
      fetch(`${proto}://${host}/api/cron/download-candles?market=TW`, { headers: { authorization: auth } })
        .catch(err => console.error('[cron/scan-tw] auto-trigger download failed:', err));
      return apiError(`TW ${date} L1 coverage insufficient: ${coverage.reason}; auto-recovery-triggered`, 503);
    }
    console.info(`[cron/scan-tw] L1 覆蓋率守門通過: ${(coverage.coverageRate * 100).toFixed(1)}% (health=${coverage.health})`);
  }

  try {
    const startedAt = Date.now();
    // 這個 endpoint 只寫 A 六條件 daily/mtf；B～R 由 scan-bm-batch 分軌負責。
    // 避免兩邊重複全市場掃描，使 A 主檔在 deadline 內可靠封存。
    const result = await runScanPipeline({
      market: 'TW',
      date,
      sessionType: 'post_close',
      directions: [...directions],
      mtfModes: [...mtfModes],
      force: true,
      strategy,
    });

    const completion = await verifyPostCloseScanCompletion({
      market: 'TW', date,
      directions: [...directions],
      mtfModes: [...mtfModes],
      startedAt,
      strategyId: strategy.id,
    });
    if (result.timedOut || !completion.completed) {
      console.error('[cron/scan-tw] post_close incomplete', { date, timedOut: result.timedOut, completion });
      return apiError(`TW ${date} post_close incomplete: missing=${completion.missing.join(',') || '-'} stale=${completion.stale.join(',') || '-'}`, 503);
    }

    const alert = (result.counts['long-daily'] ?? 0) === 0;
    if (alert) {
      console.warn(`[cron/scan-tw] ★ 交易日 ${date} long-daily 0 筆`);
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
