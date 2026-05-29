/**
 * 規則式 narrator —— 把 SqueezeAnalysis 轉成白話解讀
 *
 * 不打 LLM。輸出包括：
 *   - 一段「目前狀態」總結
 *   - 空方成本區間
 *   - 觸發條件提醒
 */

import type { SqueezeAnalysis } from './types';

const WARNINGS = [
  '空方成本只能估算，無法精準知道每一筆空單成本。',
  '融券與借券賣出邏輯不同，不能完全混在一起看。',
  '借券賣出不一定等於純放空，也可能是避險或套利。',
  '股價站上空方成本，不代表一定會軋空。',
  '融券追繳壓力價不是強制回補價，只是估算壓力區。',
  '投資決策不能只靠軋空分析，仍需搭配技術面、籌碼面、基本面、消息面與大盤環境。',
];

export function buildWarnings(): string[] {
  return [...WARNINGS];
}

function fmtPrice(p: number | null): string {
  return p === null ? '—' : p.toFixed(2);
}

function fmtPct(p: number | null): string {
  return p === null ? '—' : `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`;
}

export function buildInterpretation(a: SqueezeAnalysis): string {
  const lines: string[] = [];
  const c = a.shortCosts.combined;
  const close = a.close;

  // 1. 餘額狀態
  const shortDir5 = a.shortBalanceChange5d > 0 ? '增加' : (a.shortBalanceChange5d < 0 ? '減少' : '持平');
  const sblDir5   = a.lendingBalanceChange5d > 0 ? '增加' : (a.lendingBalanceChange5d < 0 ? '減少' : '持平');
  lines.push(
    `近 5 日融券餘額${shortDir5} ${Math.abs(a.shortBalanceChange5d).toLocaleString()} 張、借券賣出餘額${sblDir5} ${Math.abs(a.lendingBalanceChange5d).toLocaleString()} 張。`
  );

  // 2. 空方成本區
  const costRange = [c.d5, c.d10, c.d20].filter((x): x is number => x !== null);
  if (costRange.length >= 2) {
    const lo = Math.min(...costRange).toFixed(2);
    const hi = Math.max(...costRange).toFixed(2);
    lines.push(`推估空方主要成本區位於 ${lo}～${hi} 元（5/10/20 日加權，綜合融券+借券）。`);
  } else {
    lines.push('近期空方無顯著新建立部位，成本區無法穩定估算。');
  }

  // 3. 當前股價狀態
  const aboveCount = [c.d5, c.d10, c.d20, c.d60].filter(x => x !== null && close > x).length;
  const totalCount = [c.d5, c.d10, c.d20, c.d60].filter(x => x !== null).length;
  if (totalCount > 0) {
    if (aboveCount === totalCount) {
      lines.push(`目前股價 ${fmtPrice(close)} 已站上所有週期空方平均成本，空方進入浮虧狀態。`);
    } else if (aboveCount === 0) {
      lines.push(`目前股價 ${fmtPrice(close)} 仍低於主要空方成本區，空方暫無壓力。`);
    } else {
      lines.push(`目前股價 ${fmtPrice(close)} 站上 ${aboveCount}/${totalCount} 個週期空方成本，空方部分部位開始浮虧。`);
    }
  }

  // 4. 追繳壓力
  if (a.marginCallPrice !== null && a.distanceToMarginCallPct !== null) {
    if (a.distanceToMarginCallPct <= 20) {
      lines.push(`推估融券追繳壓力價約 ${a.marginCallPrice.toFixed(2)} 元，目前股價距追繳區僅 ${fmtPct(a.distanceToMarginCallPct)}，若放量續漲，融券回補壓力將升高。`);
    } else {
      lines.push(`推估融券追繳壓力價約 ${a.marginCallPrice.toFixed(2)} 元，距當前股價尚有 ${fmtPct(a.distanceToMarginCallPct)} 緩衝。`);
    }
  }

  // 5. 借券 vs 純放空的提醒
  if (a.lendingBalance > 0 && a.lendingBalanceChange20d > 0) {
    lines.push('借券賣出餘額位於近期高檔且仍在增加，但借券可能含避險、套利或法人對沖，不可全部視為強制回補來源。');
  }

  // 6. 結論
  switch (a.score.level) {
    case 'extreme':
      lines.push('綜合判讀：軋空壓力極高，需密切追蹤量價與融券動向。');
      break;
    case 'high':
      lines.push('綜合判讀：軋空壓力高，若持續放量突破將進一步觸發空方回補。');
      break;
    case 'potential':
      lines.push('綜合判讀：具備潛在軋空條件，但尚需量價配合確認。');
      break;
    case 'mild':
      lines.push('綜合判讀：空方有輕微壓力，但尚未進入軋空區。');
      break;
    case 'low':
      lines.push('綜合判讀：軋空壓力低，目前不具備軋空條件。');
      break;
  }

  return lines.join('\n');
}
