/**
 * B 買法（回後買上漲）條件面板資料 — gate → 顯示條目的唯一對映
 *
 * 2026-07-06 修：舊版 BuyMethodConditionsPanel 的 ② pass 綁整個 detector 結果，
 * detector 因量比等其他關卡失敗時，② 被連坐標紅還顯示「未出現站回」（001309.SZ 實例）。
 * 判定與文案的單一事實 = explainPullbackBuy（highWinPositions.ts），本檔只排序＋命名，
 * 面板純渲染。合約測試 pullback-panel-parity 守「面板每條 = detector 對應關卡」。
 */
import type { CandleWithIndicators } from '@/types';
import { explainPullbackBuy, PullbackBuyGateKey } from './highWinPositions';
import {
  BOOK_BODY_PCT_MIN,
  BOOK_VOL_RATIO_MIN,
  BOOK_RECLAIM_LOOKBACK,
} from './bookThresholds';

export interface PullbackBuyConditionItem {
  icon: string;
  name: string;
  detail: string;
  pass: boolean;
  metric?: string;
}

// 顯示順序沿用舊面板 ①-⑤ 的編號習慣，⑥-⑧ 是本次補露出的既有 gate
// （detector 一直有在判、面板以前沒顯示，導致「5 條全綠但訊號不成立」的可能）
const DISPLAY_ORDER: PullbackBuyGateKey[] = [
  'trend', 'reclaimHold', 'breakPrevHigh', 'redBody', 'volume',
  'noBreakLow', 'pullbackDepth', 'freshSignal',
];

const ICONS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧'];

const NAMES: Record<PullbackBuyGateKey, string> = {
  trend: '多頭趨勢',
  reclaimHold: `過去 ${BOOK_RECLAIM_LOOKBACK} 根內站回 MA5 且守住（書本「回後」）`,
  breakPrevHigh: '收盤突破前K高',
  redBody: `紅 K 實體 ≥ ${BOOK_BODY_PCT_MIN}%`,
  volume: `量比 ≥ ${BOOK_VOL_RATIO_MIN}`,
  noBreakLow: '回檔不破前低',
  pullbackDepth: '回檔深度 ≤ 0.618（課程：過深不買）',
  freshSignal: '未重複觸發（一次回後對應一次進場）',
};

export function buildPullbackBuyConditions(
  candles: CandleWithIndicators[],
  idx: number,
): { conditions: PullbackBuyConditionItem[]; allPass: boolean } {
  const ex = explainPullbackBuy(candles, idx);
  if (!ex.dataReady) {
    return {
      conditions: [{
        icon: '①',
        name: '資料不足',
        detail: 'K 棒不足 21 根或 MA5 未成形，無法判定回後買上漲',
        pass: false,
      }],
      allPass: false,
    };
  }
  const byKey = new Map(ex.gates.map(g => [g.key, g]));
  const conditions = DISPLAY_ORDER.map((key, i) => {
    const g = byKey.get(key)!;
    return { icon: ICONS[i], name: NAMES[key], detail: g.detail, pass: g.pass, metric: g.metric };
  });
  return { conditions, allPass: ex.ok };
}
