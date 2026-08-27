import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { getQuoteSnapshotDate, isAfterMarketClose } from '@/lib/datasource/marketHours';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { runQuoteEndToEndProbe } from '@/lib/health/quoteEndToEnd';
import { listOpenHoldings } from '@/lib/agents/portfolio/storage';
import { loadProfiles } from '@/lib/portfolio/profiles';
import { sendNtfy } from '@/lib/notify/ntfy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

let lastAlertFingerprint = '';
let lastAlertAt = 0;
const ALERT_DEDUPE_MS = 30 * 60_000;

function baseUrl(req: NextRequest): string {
  const proto = req.headers.get('x-forwarded-proto') ?? 'http';
  const host = req.headers.get('host') ?? 'localhost:3000';
  return `${proto}://${host}`;
}

function inWatchdogWindow(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now).split(':').map(Number);
  const minute = parts[0] * 60 + parts[1];
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(now);
  return isTradingDay(today, 'TW') && isAfterMarketClose('TW', now) && minute <= 18 * 60 + 30;
}

async function monitoredSymbols(): Promise<string[]> {
  const out = new Set(['3081.TWO', '2330.TW']);
  const profiles = await loadProfiles();
  await Promise.all(profiles.profiles.map(async profile => {
    const holdings = await listOpenHoldings(profile.id).catch(() => []);
    for (const holding of holdings) {
      if (/\.(TW|TWO)$/i.test(holding.symbol)) out.add(holding.symbol.toUpperCase());
    }
  }));
  return [...out].slice(0, 50);
}

async function triggerL2Recovery(req: NextRequest): Promise<boolean> {
  const headers: Record<string, string> = {};
  if (process.env.CRON_SECRET) headers.authorization = `Bearer ${process.env.CRON_SECRET}`;
  try {
    const response = await fetch(`${baseUrl(req)}/api/cron/update-intraday?market=TW&force=1`, {
      headers,
      signal: AbortSignal.timeout(25_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;
  if (!inWatchdogWindow()) return apiOk({ skipped: true, reason: '非台股收盤後監控窗口' });

  try {
    const symbols = await monitoredSymbols();
    const expectedDate = getQuoteSnapshotDate('TW');
    const args = { baseUrl: baseUrl(req), symbols, expectedDate, sentinels: ['3081.TWO', '2330.TW'] };
    let result = await runQuoteEndToEndProbe(args);
    let recoveryAttempted = false;
    let recoverySucceeded = false;

    if (!result.ok) {
      recoveryAttempted = true;
      recoverySucceeded = await triggerL2Recovery(req);
      result = await runQuoteEndToEndProbe(args);
    }

    let alertSent = false;
    if (!result.ok) {
      const fingerprint = result.issues.map(issue => `${issue.surface}:${issue.symbol}`).sort().join('|');
      if (fingerprint !== lastAlertFingerprint || Date.now() - lastAlertAt >= ALERT_DEDUPE_MS) {
        lastAlertFingerprint = fingerprint;
        lastAlertAt = Date.now();
        const detail = result.issues.slice(0, 8).map(issue => `${issue.surface}/${issue.symbol}: ${issue.reason}`).join('\n');
        const notify = await sendNtfy({
          title: 'RockStock 行情延遲警示',
          message: `預期交易日 ${expectedDate}\n${detail}`,
          tags: ['warning', 'chart_with_downwards_trend'],
          priority: 4,
        });
        alertSent = notify.ok;

        const webhook = process.env.HEALTH_ALERT_WEBHOOK_URL;
        if (webhook) {
          const response = await fetch(webhook, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: `RockStock 行情延遲\n${detail}`, level: 'critical', result }),
            signal: AbortSignal.timeout(8_000),
          }).catch(() => null);
          alertSent ||= response?.ok === true;
        }
      }
      console.error('[quote-watchdog] end-to-end quote invariant failed', result.issues);
    }

    return apiOk({ result, recoveryAttempted, recoverySucceeded, alertSent }, { status: result.ok ? 200 : 503 });
  } catch (error) {
    return apiError(error instanceof Error ? error.message : String(error), 503);
  }
}
