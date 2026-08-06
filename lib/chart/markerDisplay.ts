import type { ChartSignalMarker } from '@/types';

const AGGREGATE_BUY_RE = /^買\s*×\s*\d+\s*\(\d+\/6\)$/;
const AGGREGATE_SELL_RE = /^(?:強)?賣\s*×\s*\d+$/;

/** 規則引擎彙總的買賣訊號；字母買法與特殊風險警示不屬於這類。 */
export function isAggregateSignalMarker(
  marker: Pick<ChartSignalMarker, 'label'>,
): boolean {
  const label = marker.label.trim();
  return AGGREGATE_BUY_RE.test(label) || AGGREGATE_SELL_RE.test(label);
}

/**
 * 主圖只保留能一眼辨識的短訊號；完整六條件分數仍由條件／訊號面板呈現。
 * 其他特殊警示（例如爆量長黑、末升段）不在這裡改寫，避免遺失風險語意。
 */
export function getCompactSignalMarkerLabel(
  marker: Pick<ChartSignalMarker, 'label' | 'type' | 'strength'>,
): string {
  const label = marker.label.trim();
  const buy = label.match(/^買\s*×\s*(\d+)\s*\(\d+\/6\)$/);
  if (buy) return `買×${buy[1]}`;

  const sell = label.match(/^(?:強)?賣\s*×\s*(\d+)$/);
  if (sell) return `賣×${sell[1]}`;

  return label;
}

/**
 * 可見區彙總訊號太密時只留箭頭，不畫重複文字；字母買法／風險警示仍保留標籤。
 * 8 個約是 490px 主圖在不互撞下能容納的上限（平均每個短標籤約 40–50px）。
 */
export function shouldHideAggregateSignalLabels(
  recentMarkers: ReadonlyArray<Pick<ChartSignalMarker, 'label'>>,
  maxLabels = 8,
): boolean {
  return recentMarkers.filter(isAggregateSignalMarker).length > maxLabels;
}
