// ============================================================
// 三色資金 — 「策略 + 指標買點」共振計分。
//
// 設計關鍵（2026-05-28 與用戶確認）：
//   主力狀態F 與選股因子同源（中等策略=三色都>0、寬鬆=紫線翻正），若也計分=同一件事算兩次。
//   → 指標買點只計【雙B】+【捕撈季節】兩個真正獨立的訊號；主力狀態改顯示「策略強度」不計分。
//
//   等級：強(策略入選 + ≥2 指標買點) / 中(策略入選 + 1 指標買點) / 弱(只策略) / 觀察(未入選但有指標買點)
//   衝突：策略入選但出現指標賣點；或雙B買點但主力偏弱（不支持）。
// ============================================================

import type { SanSeLevel } from './selectors';
import type { StockSignals } from './signals';

export type ResonanceLevel = 'strong' | 'medium' | 'weak' | 'observe';

export interface Resonance {
  resonanceCount: number;        // 策略(1) + 雙B(1) + 捕撈(1)；觀察區則為指標買點數
  resonanceLevel: ResonanceLevel;
  indicatorBuys: number;         // 雙B + 捕撈（0-2）
  conflict: boolean;
  conflictReason: string;        // '' = 無
  note: string;                  // 判斷說明
}

const LEVEL_LABEL: Record<SanSeLevel, string> = { strict: '嚴格', medium: '中等', loose: '寬鬆' };

export function computeResonance(strategies: SanSeLevel[], sig: StockSignals): Resonance {
  const selected = strategies.length > 0;
  const indicatorBuys = (sig.doubleBBuy ? 1 : 0) + (sig.catchBuy ? 1 : 0);

  // ── 共振等級 ──
  let resonanceLevel: ResonanceLevel;
  let resonanceCount: number;
  if (selected) {
    resonanceCount = 1 + indicatorBuys;
    resonanceLevel = indicatorBuys >= 2 ? 'strong' : indicatorBuys === 1 ? 'medium' : 'weak';
  } else {
    resonanceCount = indicatorBuys; // 未入選策略
    resonanceLevel = 'observe';
  }

  // ── 訊號衝突 ──
  let conflict = false;
  let conflictReason = '';
  if (selected && (sig.doubleBSell || sig.catchSell)) {
    conflict = true;
    conflictReason = `策略入選但${sig.doubleBSell ? '雙B' : '捕撈季節'}出現賣點，訊號衝突`;
  } else if (sig.doubleBBuy && sig.zhuliWeak) {
    conflict = true;
    conflictReason = '技術買點出現，但主力狀態偏弱（中線強勢<0），需觀察';
  }

  // ── 判斷說明 ──
  const buys: string[] = [];
  if (sig.doubleBBuy) buys.push('雙B');
  if (sig.catchBuy) buys.push('捕撈季節');
  let note: string;
  if (!selected) {
    note = `未入選任何策略，但${buys.join('、')}出現買點 — 需觀察策略是否過濾過嚴或該買點品質不足`;
  } else {
    const stratStr = strategies.map((s) => LEVEL_LABEL[s]).join('/');
    if (indicatorBuys >= 2) note = `${stratStr}策略入選，同時有${buys.join('、')}買點，策略與指標強共振`;
    else if (indicatorBuys === 1) note = `${stratStr}策略入選，僅${buys.join('、')}出現買點，單一指標共振`;
    else note = `${stratStr}策略入選，但無任何圖表指標買點，弱共振`;
  }
  if (conflict) note += `；⚠️ ${conflictReason}`;

  return { resonanceCount, resonanceLevel, indicatorBuys, conflict, conflictReason, note };
}
