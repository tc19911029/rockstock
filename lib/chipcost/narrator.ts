/**
 * 規則式 narrator —— 融資斷頭壓力白話解讀（不打 LLM）
 *
 * 警示必須誠實揭露：成本是估算、維持率是「整戶」非「個股」、窗口敏感、主力是 proxy。
 */

import type { CostBucket, MarginLiquidationScore } from './types';

const MARGIN_WARNINGS = [
  '各路成本只能「估算」（以當日均價 × 淨增張數加權），無法精準知道每一筆實際成本。',
  '融資維持率券商是看「整戶」擔保維持率，不是「單一個股」；此斷頭價僅為單股理論壓力區，不等於你的帳戶會被斷頭。',
  '成本估算對「起算窗口」很敏感，5/10/20/60 日算出來可能差很多。',
  '主力成本是「前 15 大分點淨買」聚合 proxy，需歷史累積才準；分點 ≠ 真實主力（可能分散或用人頭戶）。',
  '法人買賣超揭露的是「淨額」，外資含 ETF 調整、期現避險、借券，成本僅供參考。',
  '融資斷頭價是估算壓力區、非強制斷頭點；投資決策仍需搭配技術面、籌碼面、基本面、消息面與大盤環境。',
];

export function buildMarginWarnings(): string[] {
  return [...MARGIN_WARNINGS];
}

export interface MarginInterpretationInput {
  close: number;
  marginCost: CostBucket;
  marginBalance: number;
  marginBalanceChange5d: number;
  marginUtilRate: number;
  liquidationPrice: number | null;
  marginCallPrice140: number | null;
  distanceToLiquidationPct: number | null;
  level: MarginLiquidationScore['level'];
}

export function buildMarginInterpretation(a: MarginInterpretationInput): string {
  const lines: string[] = [];
  const c = a.marginCost;
  const close = a.close;

  // 1. 融資餘額 + 使用率
  const dir5 = a.marginBalanceChange5d > 0 ? '增加' : (a.marginBalanceChange5d < 0 ? '減少' : '持平');
  lines.push(
    `融資餘額 ${a.marginBalance.toLocaleString()} 張，近 5 日${dir5} ${Math.abs(a.marginBalanceChange5d).toLocaleString()} 張，融資使用率 ${a.marginUtilRate.toFixed(1)}%。`
  );

  // 2. 融資成本區
  const costRange = [c.d5, c.d10, c.d20].filter((x): x is number => x !== null);
  if (costRange.length >= 2) {
    const lo = Math.min(...costRange).toFixed(2);
    const hi = Math.max(...costRange).toFixed(2);
    lines.push(`推估融資（散戶）主要成本區位於 ${lo}～${hi} 元（5/10/20 日加權）。`);
  } else {
    lines.push('近期融資無顯著新建立部位，成本區無法穩定估算。');
  }

  // 3. 現價 vs 融資成本（跌破=套牢）
  const buckets = [c.d5, c.d10, c.d20, c.d60];
  const totalCount = buckets.filter(x => x !== null).length;
  const belowCount = buckets.filter(x => x !== null && close < x).length;
  if (totalCount > 0) {
    if (belowCount === totalCount) {
      lines.push(`目前股價 ${close.toFixed(2)} 已跌破所有週期融資平均成本，融資戶全面套牢、追繳/停損壓力升高。`);
    } else if (belowCount === 0) {
      lines.push(`目前股價 ${close.toFixed(2)} 仍站在各週期融資成本之上，融資戶尚未套牢。`);
    } else {
      lines.push(`目前股價 ${close.toFixed(2)} 跌破 ${belowCount}/${totalCount} 個週期融資成本，部分融資戶開始套牢。`);
    }
  }

  // 4. 斷頭/追繳壓力
  if (a.liquidationPrice !== null && a.distanceToLiquidationPct !== null) {
    const callTxt = a.marginCallPrice140 !== null ? `追繳警戒價（140%）約 ${a.marginCallPrice140.toFixed(2)} 元、` : '';
    const d = a.distanceToLiquidationPct;
    if (d < 0) {
      lines.push(`${callTxt}斷頭價（130%）約 ${a.liquidationPrice.toFixed(2)} 元，現價已跌破此估算斷頭區，融資追繳／多殺多風險最高。`);
    } else if (d <= 15) {
      lines.push(`${callTxt}斷頭價（130%）約 ${a.liquidationPrice.toFixed(2)} 元，現價距斷頭區僅約 ${d.toFixed(1)}%，若續跌恐引發融資追繳與多殺多。`);
    } else {
      lines.push(`${callTxt}斷頭價（130%）約 ${a.liquidationPrice.toFixed(2)} 元，距現價尚有約 ${d.toFixed(1)}% 緩衝。`);
    }
  }

  // 5. 結論
  switch (a.level) {
    case 'extreme':
      lines.push('綜合判讀：融資斷頭壓力極高，續跌易觸發融資追繳連鎖賣壓，務必控管槓桿。');
      break;
    case 'high':
      lines.push('綜合判讀：融資斷頭壓力高，若放量破底將進一步觸發斷頭賣壓。');
      break;
    case 'potential':
      lines.push('綜合判讀：具備潛在斷頭風險，但尚需量價走弱確認。');
      break;
    case 'mild':
      lines.push('綜合判讀：融資有輕微壓力，但尚未進入斷頭風險區。');
      break;
    case 'low':
      lines.push('綜合判讀：融資斷頭壓力低，目前籌碼結構穩定。');
      break;
  }

  return lines.join('\n');
}
