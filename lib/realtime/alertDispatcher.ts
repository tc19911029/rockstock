/**
 * alertDispatcher — 規則訊號 → debounce → ntfy + jsonl log
 *
 * - debounce key = `${date}:${symbol}:${rule}`，30 分鐘內同 key 不重複推
 * - 推 ntfy（NTFY_ENABLED + NTFY_TOPIC_URL 設定才會真發）
 * - append data/realtime/alerts/{date}.jsonl 一行一 record（即使 ntfy 失敗也寫）
 *
 * 跨日：debounce key 含 date，自然失效；jsonl 用 today date 寫入新檔
 */

import { promises as fs } from 'fs';
import path from 'path';
import { REALTIME_RULES } from '@/lib/config';
import { sendNtfy } from '@/lib/notify/ntfy';
import type { Signal, RuleId } from './blowoffDetector';

// ── module state ────────────────────────────────────────────────────────

const debounceMap: Map<string, number> = new Map();

export interface AlertRecord {
  /** Wall-clock ms 觸發時間 */
  firedAt: number;
  rule: RuleId;
  symbol: string;
  market: 'TW' | 'CN';
  /** Bar 觸發的 ts */
  barTs: number;
  tfMin: 1 | 5;
  isHolding: boolean;
  meta: Signal['meta'];
  /** ntfy 推送結果 */
  notified: boolean;
  notifyError?: string;
}

export interface DispatchResult {
  fired: number;
  debounced: number;
  notifyOk: number;
  notifyFail: number;
}

/** 主入口 — 收到 detector 一批 signals，去重後派發 */
export async function dispatch(
  signals: Signal[],
  options: { logToDisk?: boolean } = {},
): Promise<DispatchResult> {
  const result: DispatchResult = { fired: 0, debounced: 0, notifyOk: 0, notifyFail: 0 };
  const records: AlertRecord[] = [];
  const now = Date.now();

  for (const sig of signals) {
    const dateKey = dateKeyOf(sig.market, now);
    const key = `${dateKey}:${sig.symbol}:${sig.rule}`;
    const last = debounceMap.get(key);
    if (last && now - last < REALTIME_RULES.DEBOUNCE_MS) {
      result.debounced++;
      continue;
    }
    debounceMap.set(key, now);
    result.fired++;

    const { title, message, tags, priority } = formatPayload(sig);
    const sendResult = await sendNtfy({ title, message, tags, priority });
    if (sendResult.ok) {
      result.notifyOk++;
    } else {
      result.notifyFail++;
    }

    records.push({
      firedAt: now,
      rule: sig.rule,
      symbol: sig.symbol,
      market: sig.market,
      barTs: sig.ts,
      tfMin: sig.tfMin,
      isHolding: sig.isHolding,
      meta: sig.meta,
      notified: sendResult.ok,
      notifyError: sendResult.ok ? undefined : (sendResult.error ?? sendResult.reason),
    });
  }

  if (options.logToDisk !== false && records.length > 0) {
    try {
      await appendJsonl(records);
    } catch (err) {
      console.warn('[alertDispatcher] append jsonl failed:', err);
    }
  }

  return result;
}

/** 讀 N 條最近警示（UI 時間軸用） */
export async function listRecentAlerts(limit = 50): Promise<AlertRecord[]> {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  try {
    const p = path.join(process.cwd(), 'data', 'realtime', 'alerts', `${today}.jsonl`);
    const raw = await fs.readFile(p, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    const records: AlertRecord[] = [];
    // 從尾部讀（最新優先），最多 limit 筆
    for (let i = lines.length - 1; i >= 0 && records.length < limit; i--) {
      try {
        records.push(JSON.parse(lines[i]) as AlertRecord);
      } catch { /* skip 壞行 */ }
    }
    return records;
  } catch {
    return [];
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

const RULE_LABELS: Record<RuleId, string> = {
  'blowoff-bearish': '爆量長黑',
  'blowoff-bullish': '爆量長紅',
  'terminal-rally': '末升段警示',
  'ma5-breakdown': '5m MA5 跌破',
};

const RULE_TAGS: Record<RuleId, string[]> = {
  'blowoff-bearish': ['chart_with_downwards_trend', 'warning'],
  'blowoff-bullish': ['rocket'],
  'terminal-rally': ['rotating_light', 'warning'],
  'ma5-breakdown': ['chart_with_downwards_trend'],
};

function formatPayload(sig: Signal): {
  title: string; message: string; tags: string[]; priority: 1 | 2 | 3 | 4 | 5;
} {
  const label = RULE_LABELS[sig.rule];
  const code = sig.symbol.split('.')[0];
  const title = `🔔 ${code} ${label}（分時）`;

  const tf = `${sig.tfMin}m`;
  const arrow = sig.meta.pctChange >= 0 ? '↑' : '↓';
  const lines: string[] = [
    `${sig.symbol} [${tf}]`,
    `${sig.meta.open} ${arrow} ${sig.meta.close} (${sig.meta.pctChange >= 0 ? '+' : ''}${sig.meta.pctChange}%)`,
    `vol ${sig.meta.volume}張 (${sig.meta.volumeMultiplier}x MA20)`,
  ];
  if (sig.rule === 'terminal-rally' && sig.meta.ma20Deviation != null) {
    lines.push(`乖離 MA20: ${sig.meta.ma20Deviation > 0 ? '+' : ''}${sig.meta.ma20Deviation}%`);
  }
  lines.push('(分時推論，非書本日 K 規則)');

  // priority：holding 加一級
  let priority: 1 | 2 | 3 | 4 | 5 = 3;
  if (sig.rule === 'blowoff-bearish') priority = sig.isHolding ? 4 : 3;
  else if (sig.rule === 'blowoff-bullish') priority = 3;
  else if (sig.rule === 'terminal-rally') priority = sig.isHolding ? 5 : 4;
  else if (sig.rule === 'ma5-breakdown') priority = 4;

  return {
    title,
    message: lines.join('\n'),
    tags: RULE_TAGS[sig.rule],
    priority,
  };
}

async function appendJsonl(records: AlertRecord[]): Promise<void> {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  const dir = path.join(process.cwd(), 'data', 'realtime', 'alerts');
  await fs.mkdir(dir, { recursive: true });
  const filename = path.join(dir, `${today}.jsonl`);
  const text = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  await fs.appendFile(filename, text, 'utf-8');
}

function dateKeyOf(market: 'TW' | 'CN', ms: number): string {
  const tz = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ms));
}

// ── test-only ────────────────────────────────────────────────────────────

export function _resetDebounceForTest(): void {
  debounceMap.clear();
}

export function _peekDebounceSize(): number {
  return debounceMap.size;
}
