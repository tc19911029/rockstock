/**
 * 前端共用：券商評等 → 顯示樣式（單一事實來源走 lib/broker/types）。
 */

import { normalizeRating, sentimentFromRating } from '@/lib/broker/types';
import type { BrokerRatingNormalized, RatingAction } from '@/lib/broker/types';

export { normalizeRating, sentimentFromRating };

/** 正規化評等 → 中文短標籤。 */
export function ratingLabel(r: BrokerRatingNormalized): string {
  switch (r) {
    case 'buy': return '買進';
    case 'overweight': return '加碼';
    case 'neutral': return '中立';
    case 'hold': return '持有';
    case 'underweight': return '減碼';
    case 'sell': return '賣出';
    default: return '—';
  }
}

/** 正規化評等 → badge 顏色（多頭綠 / 中性黃 / 空頭紅 / 純提及灰）。 */
export function ratingBadgeClass(r: BrokerRatingNormalized): string {
  switch (r) {
    case 'buy':
    case 'overweight':
      return 'bg-green-900/50 text-green-300 border-green-600';
    case 'neutral':
    case 'hold':
      return 'bg-yellow-900/40 text-yellow-300 border-yellow-700';
    case 'underweight':
    case 'sell':
      return 'bg-red-900/40 text-red-300 border-red-700';
    default:
      return 'bg-muted/50 text-muted-foreground border-border/60';
  }
}

/** 評等動作 → 中文標籤 + 顏色。 */
export function ratingActionLabel(a: RatingAction): { text: string; cls: string } | null {
  switch (a) {
    case 'upgrade': return { text: '升評 ↑', cls: 'text-bull' };
    case 'downgrade': return { text: '降評 ↓', cls: 'text-bear' };
    case 'initiate': return { text: '首評', cls: 'text-sky-300' };
    default: return null; // maintain 不顯示
  }
}

/** 券商 key → emoji/簡稱 chip 顯示（顯示名已含在 broker_display）。 */
export function brokerChipClass(): string {
  return 'bg-secondary/60 text-foreground/70 border border-border/50';
}
