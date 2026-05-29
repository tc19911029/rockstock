/**
 * alertDispatcher — 規則訊號 → debounce → ntfy + jsonl log
 *
 * Dedup 策略（2026-05-25 改）：
 *   key = `${date}:${symbol}:${rule}:${barTs}`，同一根 bar 同 rule 一輩子只 fire 一次
 *   （取代原本 30 分鐘 time-window debounce — 用 time window 在「停滯收盤前最後一根 bar
 *    永遠成立」這種情境下會被 dev HMR reset map 後反覆推；換成 barTs key 後即使 in-memory
 *    map 被清，disk-backed lazy-load 從今日 jsonl 重建，永不重複）。
 *
 * - 推 ntfy（NTFY_ENABLED + NTFY_TOPIC_URL 設定才會真發）
 * - append data/realtime/alerts/{date}.jsonl 一行一 record（即使 ntfy 失敗也寫）
 *
 * 跨日：firedKeys 含 date prefix，自然失效；跨日第一次 dispatch 會偵測日期變化重建 set。
 */

import { promises as fs } from 'fs';
import path from 'path';
import { sendNtfy } from '@/lib/notify/ntfy';
import type { Signal, RuleId } from './blowoffDetector';

// ── module state ────────────────────────────────────────────────────────

/** Dedup Set：key = `${date}:${symbol}:${rule}:${barTs}` */
const firedKeys: Set<string> = new Set();
/** firedKeys 對應的日期 — 跨日重建 */
let firedKeysLoadedForDate: string | null = null;

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
  // 今日 dedup set lazy load（survive HMR / cold start）
  const todayTW = dateKeyOf('TW', now);
  await ensureFiredKeysLoaded(todayTW);

  for (const sig of signals) {
    const dateKey = dateKeyOf(sig.market, now);
    const key = `${dateKey}:${sig.symbol}:${sig.rule}:${sig.ts}`;
    if (firedKeys.has(key)) {
      result.debounced++;
      continue;
    }
    firedKeys.add(key);
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

/**
 * 第一次（或跨日後第一次）dispatch 時把今日 jsonl 內已 fire 的 records 載回 firedKeys，
 * 避免 dev HMR / serverless cold start 後 in-memory map 被清重新推一遍。
 * 同 date 內只 IO 一次。
 */
async function ensureFiredKeysLoaded(today: string): Promise<void> {
  if (firedKeysLoadedForDate === today) return;
  // 跨日：清舊 set 後再載
  firedKeys.clear();
  firedKeysLoadedForDate = today;
  try {
    const p = path.join(process.cwd(), 'data', 'realtime', 'alerts', `${today}.jsonl`);
    const raw = await fs.readFile(p, 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const r = JSON.parse(line) as AlertRecord;
        const date = dateKeyOf(r.market, r.firedAt);
        firedKeys.add(`${date}:${r.symbol}:${r.rule}:${r.barTs}`);
      } catch { /* skip 壞行 */ }
    }
  } catch { /* file 不存在 — 今日尚無 alert */ }
}

// ── test-only ────────────────────────────────────────────────────────────

export function _resetDebounceForTest(): void {
  firedKeys.clear();
  firedKeysLoadedForDate = null;
}

export function _peekDebounceSize(): number {
  return firedKeys.size;
}
