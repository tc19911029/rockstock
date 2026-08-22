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
import { sendNtfy, type NtfyResult } from '@/lib/notify/ntfy';
import type { Signal, RuleId } from './blowoffDetector';
import { scopeAllows, type GuardSignal, type GuardRuleId } from './holdingsGuard';
import { HOLDINGS_GUARD } from '@/lib/config';

// ── 型別聯集：既有分K形態訊號 + 持倉保命訊號 ─────────────────────────────

export type AlertRuleId = RuleId | GuardRuleId;
export type AlertSignal = Signal | GuardSignal;

const GUARD_RULES: ReadonlySet<string> = new Set<GuardRuleId>([
  'stop-loss-breach', 'pump-reversal', 'rapid-drop', 'reversal-open-low', 'gap-open-buffer',
  'key-level-breakout',
]);

function isGuardSignal(sig: AlertSignal): sig is GuardSignal {
  return GUARD_RULES.has(sig.rule);
}

// ── module state ────────────────────────────────────────────────────────

/** Dedup Set：key = `${date}:${symbol}:${rule}:${barTs}`（level 型 = `...:day`） */
const firedKeys: Set<string> = new Set();
/** firedKeys 對應的日期 — 跨日重建 */
let firedKeysLoadedForDate: string | null = null;
/** 首載 single-flight — 防兩個並行 dispatch 在 readFile 期間拿空 set 重複推播 */
let loadInFlight: Promise<void> | null = null;
/**
 * 瞬時推送失敗（http/fetch）重試計數：失敗時不消耗 dedup key，讓 30s 迴圈自然重試 —
 * 否則一次網路抖動就吃掉 day 型警報（停損）「當天唯一一次」的推播機會。
 * 上限防 ntfy 整天全掛時 jsonl 每 30s 刷一行 + 每輪白等 8s timeout。
 * 注意：'disabled'/'no-url'（刻意關閉，含 HOLDINGS_GUARD_NTFY_DISABLED 滅音）視為已消耗 —
 * 滅音期間觸發的 day 警報解除滅音後當天不補推（刻意設計：滅音就是要它安靜）。
 */
const notifyRetryCount: Map<string, number> = new Map();
const NOTIFY_MAX_RETRY = 10;

export interface AlertRecord {
  /** Wall-clock ms 觸發時間 */
  firedAt: number;
  rule: AlertRuleId;
  symbol: string;
  /** 正式名稱另存頂層，讓 UI 不必理解各類 signal 的 meta 差異。 */
  name?: string;
  market: 'TW' | 'CN';
  /** Bar 觸發的 ts */
  barTs: number;
  tfMin: 1 | 5;
  isHolding: boolean;
  meta: Signal['meta'] | GuardSignal['meta'];
  /** level 型規則（同日同檔同規則一次）；缺省 = bar 型（向下相容舊 jsonl） */
  dedupScope?: 'day';
  /** 監控池來源 */
  source?: 'holding' | 'manual' | 'watchlist' | 'scan' | 'lockroster';
  /** ntfy 推送結果 */
  notified: boolean;
  notifyError?: string;
  /**
   * 推送失敗原因（NtfyResult.reason）。重啟後 rebuild dedup 用：
   * 'http'/'fetch'（瞬時失敗）的行不消耗 dedup key → 重啟後繼續重試；
   * 'disabled'/'no-url'（刻意關閉）與舊行（缺此欄）視為已消耗（向下相容）。
   */
  notifyReason?: string;
}

export interface DispatchResult {
  fired: number;
  debounced: number;
  notifyOk: number;
  notifyFail: number;
}

/**
 * 推播 gate（export 供合約測試鎖行為）：
 * - guard 規則（1/2/3）→ HOLDINGS_GUARD.ENABLED + 各自 SCOPE
 * - 既有形態規則 → BLOWOFF_NTFY_ENABLED=true（舊全域語意：全池推，預設關）
 *   或 在 PATTERN_RULES 內且過 PATTERN_NTFY scope（新：持倉才推手機，
 *   非持倉照舊只記 jsonl / 走圖標記）
 * - env HOLDINGS_GUARD_NTFY_DISABLED=true → guard 相關路徑全滅音（緊急逃生口，
 *   不用 rebuild；jsonl 照記可事後 audit）
 */
export function decideNotify(sig: AlertSignal): boolean {
  const guardMuted = process.env.HOLDINGS_GUARD_NTFY_DISABLED === 'true';
  if (isGuardSignal(sig)) {
    if (guardMuted || !HOLDINGS_GUARD.ENABLED) return false;
    const scope = sig.rule === 'stop-loss-breach' ? HOLDINGS_GUARD.SCOPE.STOP_LOSS_BREACH
      : sig.rule === 'pump-reversal' ? HOLDINGS_GUARD.SCOPE.PUMP_REVERSAL
      : sig.rule === 'reversal-open-low' ? HOLDINGS_GUARD.SCOPE.REVERSAL_OPEN
      : sig.rule === 'gap-open-buffer' ? HOLDINGS_GUARD.SCOPE.GAP_OPEN_BUFFER
      : sig.rule === 'key-level-breakout' ? HOLDINGS_GUARD.SCOPE.KEY_LEVEL_BREAKOUT
      : HOLDINGS_GUARD.SCOPE.RAPID_DROP;
    return scopeAllows(scope, sig);
  }
  // 既有形態規則：舊全域開關語意不變（全池推播，預設關）
  if (process.env.BLOWOFF_NTFY_ENABLED === 'true') return true;
  // 新：持倉的出貨形態訊號走 guard scope 推手機
  if (guardMuted || !HOLDINGS_GUARD.ENABLED) return false;
  return (HOLDINGS_GUARD.PATTERN_RULES as readonly string[]).includes(sig.rule)
    && scopeAllows(HOLDINGS_GUARD.SCOPE.PATTERN_NTFY, sig);
}

/** 主入口 — 收到 detector/guard 一批 signals，去重後派發 */
export async function dispatch(
  signals: AlertSignal[],
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
    const dedupScope = isGuardSignal(sig) ? sig.dedupScope : undefined;
    // level 型（day）：同日同檔同規則只 fire 一次 — 價格在停損/回檔門檻附近震盪時
    // 不能用 barTs（每根新 bar 都會重推）
    const key = dedupScope === 'day'
      ? `${dateKey}:${sig.symbol}:${sig.rule}:day`
      : `${dateKey}:${sig.symbol}:${sig.rule}:${sig.ts}`;
    if (firedKeys.has(key)) {
      result.debounced++;
      continue;
    }
    firedKeys.add(key);
    result.fired++;

    const { title, message, tags, priority } = formatPayload(sig);
    const sendResult: NtfyResult = decideNotify(sig)
      ? await sendNtfy({ title, message, tags, priority })
      : { ok: false, reason: 'disabled' };
    if (sendResult.ok) {
      result.notifyOk++;
      notifyRetryCount.delete(key);
    } else {
      result.notifyFail++;
      // 瞬時失敗（http/fetch）→ 放回 dedup key，下一輪（30s）自然重試。
      // 對 day 型（停損等保命警報）尤其關鍵：不這樣做，一次網路抖動 = 整天不再推。
      if (sendResult.reason === 'http' || sendResult.reason === 'fetch') {
        const n = (notifyRetryCount.get(key) ?? 0) + 1;
        notifyRetryCount.set(key, n);
        if (n < NOTIFY_MAX_RETRY) firedKeys.delete(key);
      }
    }

    const signalName = isGuardSignal(sig) ? sig.meta.name : sig.name;
    records.push({
      firedAt: now,
      rule: sig.rule,
      symbol: sig.symbol,
      name: signalName,
      market: sig.market,
      barTs: sig.ts,
      tfMin: sig.tfMin,
      isHolding: sig.isHolding,
      meta: sig.meta,
      dedupScope,
      source: sig.source,
      notified: sendResult.ok,
      notifyError: sendResult.ok ? undefined : (sendResult.error ?? sendResult.reason),
      notifyReason: sendResult.ok ? undefined : sendResult.reason,
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

const RULE_LABELS: Record<AlertRuleId, string> = {
  'blowoff-bearish': '爆量長黑',
  'blowoff-bullish': '爆量長紅',
  'terminal-rally': '末升段警示',
  'ma5-breakdown': '5m MA5 跌破',
  'stop-loss-breach': '跌破停損',
  'pump-reversal': '拉高回落',
  'rapid-drop': '急殺',
  'reversal-open-low': '變盤開低確認',
  'gap-open-buffer': '大跌開低緩衝',
  'key-level-breakout': '鎖股越關鍵價',
};

const RULE_TAGS: Record<AlertRuleId, string[]> = {
  'blowoff-bearish': ['chart_with_downwards_trend', 'warning'],
  'blowoff-bullish': ['rocket'],
  'terminal-rally': ['rotating_light', 'warning'],
  'ma5-breakdown': ['chart_with_downwards_trend'],
  'stop-loss-breach': ['rotating_light', 'warning'],
  'pump-reversal': ['chart_with_downwards_trend', 'warning'],
  'rapid-drop': ['chart_with_downwards_trend', 'warning'],
  'reversal-open-low': ['eyes', 'warning'],
  'gap-open-buffer': ['fire_extinguisher', 'warning'],
  'key-level-breakout': ['key', 'chart_with_upwards_trend'],
};

/** 持倉保命訊號的推播文案（規則1 priority 5，其餘 4） */
function formatGuardPayload(sig: GuardSignal): {
  title: string; message: string; tags: string[]; priority: 1 | 2 | 3 | 4 | 5;
} {
  const code = sig.symbol.split('.')[0];
  const m = sig.meta;
  const nameSuffix = m.name ? ` ${m.name}` : '';
  // 標題股名：`代號 名稱`；無名稱時退回只有代號（向下相容）
  const codeName = `${code}${nameSuffix}`;
  const lines: string[] = [`${sig.symbol}${nameSuffix}`];
  let title: string;
  let priority: 4 | 5;

  if (sig.rule === 'stop-loss-breach') {
    title = `🚨 ${codeName} 跌破停損（持倉保命）`;
    priority = 5;
    lines.push(m.positionSide === 'short'
      ? `現價 ${m.price} ≥ 回補停損 ${m.stopLoss}（做空進場 ${m.entryPrice}）`
      : `現價 ${m.price} ≤ 停損 ${m.stopLoss}（進場 ${m.entryPrice}）`);
  } else if (sig.rule === 'pump-reversal') {
    title = `⚠ ${codeName} 拉高回落（持倉保命）`;
    priority = 4;
    lines.push(`當日高 ${m.dayHigh}（+${m.dayGainPct}% vs 昨收）→ 現價 ${m.price}（自高點 -${m.drawdownPct}%）`);
  } else if (sig.rule === 'reversal-open-low') {
    title = `👀 ${codeName} 昨日${m.reversalLabel ?? '轉折訊號'}・今開低（變盤確認）`;
    priority = 4;
    lines.push(`昨收 ${m.yClose} → 現價 ${m.price}（開低 -${m.openLowPct}%）`);
    lines.push(`課程 CH2：變盤線次日開低=空方確認。收盤跌破昨低 ${m.yLow} → 執行出場；拉回站穩 → 解除。`);
  } else if (sig.rule === 'gap-open-buffer') {
    title = `🧯 ${codeName} 大跌開低・先別殺（開盤緩衝）`;
    priority = 4;
    lines.push(`昨收 ${m.prevClose} → 現價 ${m.price}（開低 -${m.openLowPct}%）`);
    lines.push('課程紀律：大跌開低別開盤市價殺單（常成交在最差價）。先看開盤 30 分鐘，13:20 再按規則處理（含停損執行）。');
  } else if (sig.rule === 'key-level-breakout') {
    title = `🔑 ${codeName} 鎖股越關鍵價（${m.keyLabel ?? '發動'}）`;
    priority = 4;
    lines.push(`現價 ${m.price} 越過關鍵價 ${m.keyLevel}（昨收 ${m.prevClose} 還在下方）`);
    if (m.waitingFor) lines.push(`在等：${m.waitingFor}`);
    lines.push('課程紀律：13:20 看確認、13:25 掛市價 — 勿盤中追高；開高 ≥5% 禁追、收盤跌回關鍵價下=假突破不做。');
  } else {
    title = `⚠ ${codeName} 急殺（持倉保命）`;
    priority = 4;
    lines.push(`近 ${m.windowMin} 分鐘 -${m.dropPct}%（${m.refClose} → ${m.price}）`);
  }
  lines.push('(分時推論，非書本日 K 規則)');
  return { title, message: lines.join('\n'), tags: RULE_TAGS[sig.rule], priority };
}

function formatPayload(sig: AlertSignal): {
  title: string; message: string; tags: string[]; priority: 1 | 2 | 3 | 4 | 5;
} {
  if (isGuardSignal(sig)) return formatGuardPayload(sig);
  const label = RULE_LABELS[sig.rule];
  const code = sig.symbol.split('.')[0];
  const nameSuffix = sig.name ? ` ${sig.name}` : '';
  const title = `🔔 ${code}${nameSuffix} ${label}（分時）`;

  const tf = `${sig.tfMin}m`;
  const arrow = sig.meta.pctChange >= 0 ? '↑' : '↓';
  const lines: string[] = [
    `${sig.symbol}${nameSuffix} [${tf}]`,
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
  if (firedKeysLoadedForDate === today) {
    // single-flight：首載進行中時後進者等同一個 promise，不能拿空 set 跑 dedup
    if (loadInFlight) await loadInFlight;
    return;
  }
  // 跨日：清舊 set 後再載
  firedKeys.clear();
  notifyRetryCount.clear();
  firedKeysLoadedForDate = today;
  loadInFlight = loadFiredKeysFromDisk(today).finally(() => { loadInFlight = null; });
  await loadInFlight;
}

async function loadFiredKeysFromDisk(today: string): Promise<void> {
  try {
    const p = path.join(process.cwd(), 'data', 'realtime', 'alerts', `${today}.jsonl`);
    const raw = await fs.readFile(p, 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const r = JSON.parse(line) as AlertRecord;
        // 瞬時推送失敗（http/fetch）的行不消耗 dedup — 重啟後繼續重試；
        // 'disabled'/'no-url'（刻意關閉）與舊行（缺 notifyReason）視為已消耗（向下相容）。
        if (r.notified === false && (r.notifyReason === 'http' || r.notifyReason === 'fetch')) continue;
        const date = dateKeyOf(r.market, r.firedAt);
        // day-level dedup 與 dispatch 同款 key — 重啟/HMR 後 level 警報一樣不重推；
        // 舊 jsonl 行缺 dedupScope → 走 barTs key，向下相容。
        firedKeys.add(r.dedupScope === 'day'
          ? `${date}:${r.symbol}:${r.rule}:day`
          : `${date}:${r.symbol}:${r.rule}:${r.barTs}`);
      } catch { /* skip 壞行 */ }
    }
  } catch { /* file 不存在 — 今日尚無 alert */ }
}

// ── test-only ────────────────────────────────────────────────────────────

export function _resetDebounceForTest(): void {
  firedKeys.clear();
  firedKeysLoadedForDate = null;
  loadInFlight = null;
  notifyRetryCount.clear();
}

export function _peekDebounceSize(): number {
  return firedKeys.size;
}
