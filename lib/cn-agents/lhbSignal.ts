/**
 * 龍虎榜訊號分 — 依 scripts/backtest-cn-lhb-signals.ts（245 天回測）的實證結論排序。
 *
 * 回測結論（5 日平均漲跌，基準=全體上榜 -0.92%）：
 *   會漲：漲多上榜 +1.5%、淨買超 +0.8%
 *   會跌：拉薩在買 -5.4%、跌多上榜 -3.6%、淨賣超 -3.0%
 *   沒用：機構買/游資買/合力（≈基準，不給分）
 * 所以排序只用「實證有效」的幾項，不用一般說法的機構/游資。
 */

import type { LhbStockEntry } from './types';

export interface LhbSignal {
  /** 排序分（高=回測上比較會漲） */
  score: number;
  /** 紅字警告（回測上會跌的特徵） */
  warnings: string[];
  /** 一句話結論 */
  verdict: 'good' | 'neutral' | 'avoid';
}

export function lhbSignal(s: LhbStockEntry): LhbSignal {
  const reason = s.reason ?? '';
  const isUp = reason.includes('涨幅');
  const isDown = reason.includes('跌幅');
  const netBuy = (s.netAmt ?? 0) > 0;
  const netSell = (s.netAmt ?? 0) < 0;
  const lasaBuy = (s.seatSummary?.retailProxyBuyCount ?? 0) > 0;

  let score = 0;
  const warnings: string[] = [];
  if (isUp) score += 2;
  if (netBuy) score += 1;
  if (isDown) { score -= 2; warnings.push('跌多上榜'); }
  if (netSell) { score -= 1; warnings.push('淨賣超'); }
  if (lasaBuy) { score -= 2; warnings.push('拉薩在買'); }

  const verdict: LhbSignal['verdict'] = score >= 2 ? 'good' : score <= -1 ? 'avoid' : 'neutral';
  return { score, warnings, verdict };
}
