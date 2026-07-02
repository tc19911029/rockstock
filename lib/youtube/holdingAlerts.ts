/**
 * 持倉提醒 — 每日節目總結報告的「你的持股今天被誰提到」區塊（2026-07）。
 *
 * 純程式 join（不進 LLM）：analysis mentions × 持倉檔。
 * 門檻沿用 deriveStockMentions 的單一事實（matched != null 且 combined_confidence ≥ 0.6），
 * 不另訂第二套過濾規則。
 *
 * 格式差異：持倉 symbol 帶交易所後綴（"6770.TW" / "000988.SZ"），
 * mention 的 matched.code 是裸代號（"6770"）→ join 時剝後綴。
 * TW 4 碼 / CN 6 碼，裸碼無碰撞。
 */

import type { PortfolioHolding } from '@/lib/agents/portfolio/types';
import type { MarketId } from '@/lib/scanner/types';
import {
  deriveStockMentions,
  type DailyAnalysis,
  type MentionSourceType,
  type RecommendationType,
  type StockSentiment,
} from './analysisStorage';

export interface HoldingAlertMention {
  video_id: string;
  source_id: string;
  /** 節目顯示名（呼叫端以 sourceNameOf 補上） */
  source_name: string;
  sentiment: StockSentiment;
  recommendation_type?: RecommendationType;
  context: string;
  reason: string;
  analysts?: string[];
  source_type?: MentionSourceType;
  /** 簡報/口述明確給的目標價/停損（節目講的，非持倉設定） */
  target_price?: number;
  stop_loss?: number;
}

export interface HoldingAlert {
  /** 持倉原始 symbol（含後綴，走圖/連結用） */
  symbol: string;
  /** 裸代號（join key） */
  code: string;
  name: string;
  market: MarketId;
  entry_price: number;
  /** 持倉設定的停損（非節目講的） */
  holding_stop_loss?: number;
  bullish_count: number;
  bearish_count: number;
  mentions: HoldingAlertMention[];
}

/** "6770.TW" → "6770"；已是裸碼則原樣 */
export function bareCode(symbol: string): string {
  return symbol.split('.')[0];
}

/**
 * 持倉 × 當日 mentions join。
 * holdings 傳全量即可 — 函式內只留 status==='open'（過濾收在這裡，單一事實）。
 */
export function buildHoldingAlerts(
  analysis: DailyAnalysis,
  holdings: PortfolioHolding[],
  sourceNameOf: (sourceId: string) => string,
): HoldingAlert[] {
  const mentions = deriveStockMentions(analysis);
  const byCode = new Map(mentions.stocks.map(s => [s.stock_code, s]));

  return holdings
    .filter(h => h.status === 'open')
    .flatMap<HoldingAlert>(h => {
      const code = bareCode(h.symbol);
      const hit = byCode.get(code);
      if (!hit) return [];
      return [{
        symbol: h.symbol,
        code,
        name: h.name,
        market: h.market,
        entry_price: h.entryPrice,
        holding_stop_loss: h.stopLoss,
        bullish_count: hit.bullish_count,
        bearish_count: hit.bearish_count,
        mentions: hit.mentioned_in.map(m => ({
          video_id: m.video_id,
          source_id: m.source_id,
          source_name: sourceNameOf(m.source_id),
          sentiment: m.sentiment,
          recommendation_type: m.recommendation_type,
          context: m.context,
          reason: m.reason,
          analysts: m.analysts,
          source_type: m.source_type,
          target_price: m.target_price,
          stop_loss: m.stop_loss,
        })),
      }];
    });
}
