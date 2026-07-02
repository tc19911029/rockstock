/**
 * 事件基準價結算 — pure，無 I/O。回測共用單一事實（YouTube 老師績效 + 陸股情緒回測共用）。
 *
 * 2026-06-13 從 lib/youtube/recoBaseline.ts 原樣搬移（搬移不重構）：
 * 一字板 no_fill 守衛是單一事實，不可 fork — lib/youtube/recoBaseline.ts 為 thin re-export。
 *
 * 規則（盤後節目 → 可執行價 = 提及日 D 的次一交易日開盤）：
 *   - base_date = 第一根 date > D 的有效 K 線
 *   - 一字鎖死（open===high 且 (high−low)/low < 0.5%）→ no_fill 買不到（同 ForwardAnalyzer / unifiedLeaderboard）
 *   - 零量扁平根（量 0 且 O===C 且 H===L）= 停牌假根 → 跳下一根
 *   - D 後 5 個交易日內無有效 bar → no_data
 *   - 污染守衛：|entry_open/mention_close − 1| > 25%（隔夜不可能）→ no_data
 *   - K 線最後一根 ≤ D（隔日還沒封存）→ pending，下次 cron 再試
 */

/** 基準價結算狀態 */
export type BaselineStatus =
  | 'pending'   // 次一交易日 K 線還沒封存
  | 'filled'    // 已凍結 entry_open
  | 'no_fill'   // 隔日一字鎖死買不到（不計分）
  | 'no_data';  // 找不到 K 線 / 5 個交易日內無有效 bar / 壞 bar

export interface RecoBaseline {
  status: BaselineStatus;
  /** 進場交易日（提及日後第一個有效交易日） */
  base_date: string | null;
  /** 凍結的進場價 = base_date 開盤 */
  entry_open: number | null;
  /** 提及日 D 的收盤（隔日跳空展示用） */
  mention_close: number | null;
  /** 結算（凍結）時間 ISO；pending 時 null */
  settled_at: string | null;
}

export interface BaselineCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const MAX_SKIP_DAYS = 5;

const round2 = (x: number): number => +x.toFixed(2);

function isSuspendedBar(c: BaselineCandle): boolean {
  return c.volume === 0 && c.open === c.close && c.high === c.low;
}

function isLockedLimitUp(c: BaselineCandle): boolean {
  return c.open === c.high && c.low > 0 && (c.high - c.low) / c.low < 0.005;
}

/**
 * 結算單一事件的基準價。candles 必須依日期升序（L1 慣例，停牌日自然不存在）。
 * @param mentionDate 提及日 D（YYYY-MM-DD）
 * @param now 結算時間（ISO）— caller 傳入，pure 函式不自取時鐘
 */
export function settleBaseline(
  mentionDate: string,
  candles: BaselineCandle[] | null,
  now: string,
): RecoBaseline {
  if (!candles || candles.length === 0) {
    return { status: 'no_data', base_date: null, entry_open: null, mention_close: null, settled_at: now };
  }

  // 提及日收盤（找 ≤ D 的最近一根；節目日若逢假日退最近交易日）
  let mentionIdx = -1;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].date <= mentionDate) { mentionIdx = i; break; }
  }
  const mentionClose = mentionIdx >= 0 ? candles[mentionIdx].close : null;

  // 第一根 date > D
  const firstAfter = candles.findIndex(c => c.date > mentionDate);
  if (firstAfter < 0) {
    // 隔日 K 還沒封存 → 留待下次結算
    return { status: 'pending', base_date: null, entry_open: null, mention_close: mentionClose, settled_at: null };
  }

  for (let i = firstAfter; i < candles.length && i < firstAfter + MAX_SKIP_DAYS; i++) {
    const c = candles[i];
    if (isSuspendedBar(c)) continue;          // 停牌假根 → 跳下一根
    if (isLockedLimitUp(c)) {
      return {
        status: 'no_fill', base_date: c.date, entry_open: null,
        mention_close: mentionClose, settled_at: now,
      };
    }
    if (!(c.open > 0)) continue;              // 壞 bar
    // 污染守衛：隔夜跳 >25% 不可能（撞庫/壞 bar）
    if (mentionClose != null && mentionClose > 0 && Math.abs(c.open / mentionClose - 1) > 0.25) {
      return {
        status: 'no_data', base_date: c.date, entry_open: null,
        mention_close: mentionClose, settled_at: now,
      };
    }
    return {
      status: 'filled', base_date: c.date, entry_open: round2(c.open),
      mention_close: mentionClose, settled_at: now,
    };
  }

  // 視窗內全是停牌/壞 bar：若 K 線尚未長出足夠天數則 pending，否則 no_data
  const lastDate = candles[candles.length - 1].date;
  const daysAfter = candles.length - firstAfter;
  if (daysAfter < MAX_SKIP_DAYS && lastDate > mentionDate) {
    // 還可能等到有效 bar（例如連續停牌中）
    return { status: 'pending', base_date: null, entry_open: null, mention_close: mentionClose, settled_at: null };
  }
  return { status: 'no_data', base_date: null, entry_open: null, mention_close: mentionClose, settled_at: now };
}
