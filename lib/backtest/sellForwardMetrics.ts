// ============================================================
// 賣出訊號回測 — forward 報酬量測（以「訊號日收盤」為基準）
//
// 與買方排行榜（lib/backtest/unifiedLeaderboard.ts 的 metricsFromLocalCandles）的關鍵差異：
//   買方用「隔日開盤」當進場價（盤後掃到、隔天才買得到）。
//   賣訊問的是「我已經持有、今天收盤訊號亮了，續抱會多痛？」——賣訊最重要的警告
//   就是「隔夜跳空下殺」，用隔日開盤當基準會把這段跳空丟掉。所以這裡 base = 訊號日收盤。
//
//   → 這量的是「訊號的資訊含量 / 急迫度」，不是可成交 P&L（d1 含你當下無法在昨收成交的部分）。
//     gapReturn 單獨把隔夜跳空拉出來，讓 close-base 的選擇可被稽核（重訊號的 gap 應明顯為負）。
//
// 純函式、零 IO、零 API：直接讀記憶體裡的 candles，讓全市場 2 年回測不打外部源。
// ============================================================

import type { RawCandle } from './unifiedLeaderboard';

export type { RawCandle };

/** forward 視窗（交易日）：涵蓋到 d20 並給 maxGain/maxDrawdown 取樣。 */
export const SELL_FORWARD_BARS = 20;

/** 停牌偵測：forward 視窗內相鄰 K 線的日曆天間隔超過此值 → 視為停牌跳空，標 suspect。 */
const SUSPECT_GAP_DAYS = 7;

export interface SellPickMetrics {
  d1: number | null;
  d3: number | null;
  d5: number | null;
  d10: number | null;
  d20: number | null;
  maxGain: number | null;      // 窗內最高 high 相對收盤基準（對稱欄：訊號後是否還彈得起來）
  maxDrawdown: number | null;  // 窗內最低 low 相對收盤基準（「最深會跌到哪」= 輕重核心量）
  gapReturn: number | null;    // 隔日開盤相對訊號日收盤（隔夜跳空隔離）
  hit3: boolean | null;        // 窗內 d1..d5 是否盤中跌破 base×0.97（跌 ≥3%）
  hit5: boolean | null;        // 窗內 d1..d5 是否盤中跌破 base×0.95（跌 ≥5%）
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** 兩個 'YYYY-MM-DD' 的日曆天差（粗略，用 Date.UTC 不依賴 local TZ）。 */
function calendarGap(a: string, b: string): number {
  const pa = a.slice(0, 10).split('-').map(Number);
  const pb = b.slice(0, 10).split('-').map(Number);
  if (pa.length < 3 || pb.length < 3) return 0;
  const ta = Date.UTC(pa[0], pa[1] - 1, pa[2]);
  const tb = Date.UTC(pb[0], pb[1] - 1, pb[2]);
  return Math.abs(tb - ta) / 86_400_000;
}

/**
 * 由 t0Idx（訊號日那根）的「收盤」當基準，算各 horizon 收盤報酬 + 窗內最高/最低。
 *   dN  = (close[t0+N] − close[t0]) / close[t0] × 100
 *   gap = (open[t0+1]  − close[t0]) / close[t0] × 100
 *   maxDrawdown = (min low over t0+1..t0+window − close[t0]) / close[t0] × 100
 * 沒有任何 forward K（t0 已是最後一根）→ 回 null（整筆剔除）。
 * suspect：forward 視窗內出現 > SUSPECT_GAP_DAYS 的日曆缺口（停牌復牌）→ 該樣本移出主統計。
 */
export function sellMetricsFromLocalCandles(
  candles: RawCandle[],
  t0Idx: number,
  window: number = SELL_FORWARD_BARS,
): { base: number; m: SellPickMetrics; suspect: boolean } | null {
  if (t0Idx < 0 || t0Idx >= candles.length) return null;
  const base = candles[t0Idx].close;
  if (!(base > 0)) return null;
  const firstFwdIdx = t0Idx + 1;
  if (firstFwdIdx >= candles.length) return null;        // 沒有隔日 K → 無法量

  const closeRet = (offset: number): number | null => {
    const i = t0Idx + offset;
    if (i >= candles.length) return null;
    return round2((candles[i].close - base) / base * 100);
  };

  // 窗內最高/最低 + 停牌缺口 + 跌幅命中
  let mg = 0;
  let md = 0;
  let saw = false;
  let suspect = false;
  let hit3 = false;
  let hit5 = false;
  let prevDate = candles[t0Idx].date;
  for (let k = 1; k <= window; k++) {
    const i = t0Idx + k;
    if (i >= candles.length) break;
    saw = true;
    const c = candles[i];
    if (calendarGap(prevDate, c.date) > SUSPECT_GAP_DAYS) suspect = true;
    prevDate = c.date;
    const hi = (c.high - base) / base * 100;
    const lo = (c.low - base) / base * 100;
    if (hi > mg) mg = hi;
    if (lo < md) md = lo;
    // 跌幅命中只看 d1..d5（窗內前 5 根的盤中最低）
    if (k <= 5) {
      if (c.low <= base * 0.97) hit3 = true;
      if (c.low <= base * 0.95) hit5 = true;
    }
  }

  const m: SellPickMetrics = {
    d1: closeRet(1),
    d3: closeRet(3),
    d5: closeRet(5),
    d10: closeRet(10),
    d20: closeRet(20),
    maxGain: saw ? round2(mg) : null,
    maxDrawdown: saw ? round2(md) : null,
    gapReturn: round2((candles[firstFwdIdx].open - base) / base * 100),
    hit3: saw ? hit3 : null,
    hit5: saw ? hit5 : null,
  };
  return { base, m, suspect };
}
