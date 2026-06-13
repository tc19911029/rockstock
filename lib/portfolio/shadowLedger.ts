/**
 * 紀律影子帳本（2026-06-12，A2）。
 *
 * 對每檔 open 持倉，從 entryDate 起逐日重放「書本出場規則嚴格執行版」：
 *   - close ≤ 停損 → 當日收盤全出（書本：13:25 市價單 ≈ 收盤價）
 *   - 漲幅 ≥20% 且 close < MA20 → 全出（長線停利）
 *   - 漲幅 ≥10% 且 close < MA10 → 全出（中線停利）
 *   - 漲幅 ≥10% 且 close < MA5 → 減半（一次性；其餘由 MA10/MA20 規則管）
 * 規則門檻 import 自 holdingsActionEngine（單一事實，與 /portfolio 今日操作建議同源）。
 *
 * 產出「紀律差額」= 影子損益 − 實際抱單損益。正值 = 嚴格照規則本可多賺/少賠的金額。
 * 目的：把不執行停損的成本變成天天看得到的數字（3006 案例差額 ~76 萬）。
 * 純顯示層 — 不動持倉、不進選股。
 */
import type { Candle } from '@/types';
import {
  PROFIT_SHORT_RULE, PROFIT_MID_RULE, PROFIT_LONG_RULE, sma,
} from '@/lib/agents/holdingsActionEngine';

export interface ShadowEvent {
  date: string;
  action: 'stop_loss' | 'exit_all_ma20' | 'exit_all_ma10' | 'reduce_half_ma5';
  price: number;
  sharesSold: number;
  label: string;
}

export interface ShadowResult {
  symbol: string;
  entryDate: string;
  entryPrice: number;
  shares: number;
  events: ShadowEvent[];
  /** 影子帳本剩餘股數（全出後 = 0） */
  remainingShares: number;
  /** 影子損益（已實現 + 剩餘按最新收盤 mark）*/
  shadowPnL: number;
  /** 實際抱單損益（全部按最新收盤 mark）*/
  actualPnL: number;
  /** 紀律差額 = shadowPnL − actualPnL（正 = 照規則本可多賺/少賠）*/
  disciplineGap: number;
  lastClose: number;
  lastDate: string;
}

export function computeShadowLedger(args: {
  symbol: string;
  entryDate: string;
  entryPrice: number;
  shares: number;
  stopLoss: number;
  candles: Candle[];
}): ShadowResult | null {
  const { symbol, entryDate, entryPrice, shares, stopLoss, candles } = args;
  if (!candles.length) return null;
  const closes = candles.map(c => c.close);
  const lastIdx = candles.length - 1;
  const lastClose = closes[lastIdx];
  const lastDate = candles[lastIdx].date;

  let remaining = shares;
  let realized = 0;
  let halfDone = false;
  const events: ShadowEvent[] = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (c.date <= entryDate) continue; // 進場日當天不出場
    if (remaining <= 0) break;
    const close = c.close;
    const profitPct = (close - entryPrice) / entryPrice;
    const ma5 = sma(closes, i, 5);
    const ma10 = sma(closes, i, 10);
    const ma20 = sma(closes, i, 20);

    if (close <= stopLoss) {
      realized += close * remaining;
      events.push({ date: c.date, action: 'stop_loss', price: close, sharesSold: remaining, label: `觸發停損 ${stopLoss.toFixed(2)} → 全出` });
      remaining = 0;
      break;
    }
    if (profitPct >= PROFIT_LONG_RULE && ma20 != null && close < ma20) {
      realized += close * remaining;
      events.push({ date: c.date, action: 'exit_all_ma20', price: close, sharesSold: remaining, label: '漲≥20% 跌破 MA20 → 全出' });
      remaining = 0;
      break;
    }
    if (profitPct >= PROFIT_MID_RULE && ma10 != null && close < ma10) {
      realized += close * remaining;
      events.push({ date: c.date, action: 'exit_all_ma10', price: close, sharesSold: remaining, label: '漲≥10% 跌破 MA10 → 全出' });
      remaining = 0;
      break;
    }
    if (!halfDone && profitPct >= PROFIT_SHORT_RULE && ma5 != null && close < ma5) {
      const sold = Math.floor(remaining / 2);
      if (sold > 0) {
        realized += close * sold;
        remaining -= sold;
        halfDone = true;
        events.push({ date: c.date, action: 'reduce_half_ma5', price: close, sharesSold: sold, label: '漲≥10% 跌破 MA5 → 減半' });
      }
    }
  }

  const shadowFinal = realized + remaining * lastClose;
  const shadowPnL = shadowFinal - entryPrice * shares;
  const actualPnL = (lastClose - entryPrice) * shares;
  return {
    symbol, entryDate, entryPrice, shares,
    events,
    remainingShares: remaining,
    shadowPnL,
    actualPnL,
    disciplineGap: shadowPnL - actualPnL,
    lastClose,
    lastDate,
  };
}
