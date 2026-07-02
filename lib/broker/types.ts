/**
 * 法人報告（券商研究報告）追蹤 — 型別 + 推導純函式（單一事實來源）。
 *
 * 設計對齊 YouTube 提及管線（lib/youtube/*）：
 *   - sentiment 直接沿用 youtube 的 StockSentiment union（前端 SENTIMENT_LABEL 免改）
 *   - matched 沿用 stockMaster 的 StockLookupResult（非台股 → null）
 *   - sentiment 一律由 rating 推導（sentimentFromRating），不讓 LLM 自填 → 合約測試鎖一致性
 *
 * 流程（file-bridge，無 Anthropic SDK）：
 *   1. scripts/broker-prepare-analysis.ts 掃 PDF → 寫 /tmp/rockstock-broker/{date}-question.json
 *   2. 使用者在 Claude Code 對話跑 /broker-analysis skill 讀 question 萃取
 *   3. Claude 寫 data/broker/reports/{date}.json（BrokerDailyReports）
 *   4. 首頁「法人報告」tab 讀 /api/broker/performance 顯示報告後漲跌幅 + 目標價達成度
 */

import type { StockLookupResult } from '@/lib/youtube/stockMaster';
import type { StockSentiment } from '@/lib/youtube/analysisStorage';

/** 券商評等正規化值（原文 rating_raw 經 normalizeRating 後的標準值）。 */
export type BrokerRatingNormalized =
  | 'buy' | 'overweight' | 'neutral' | 'hold' | 'underweight' | 'sell' | 'other';

/** 評等動作（這份報告相對前一份的變化）。 */
export type RatingAction = 'initiate' | 'upgrade' | 'downgrade' | 'maintain';

/** 標的市場：台股可追蹤漲跌幅；OTHER（港股/美股等）不追蹤、不進命中率分母。 */
export type BrokerMarket = 'TW' | 'OTHER';

/** 單一報告裡對單一股票的觀點。 */
export interface BrokerStockMention {
  /** LLM 從 PDF 認出的標的原文（名稱或代號）— normalize 會用全量 master 重查覆寫 code。 */
  raw_query: string;
  /** stockMaster 對照結果；非台股（港股/美股）→ null。 */
  matched: StockLookupResult | null;
  /** 標的市場（matched 為台股 → 'TW'，否則 'OTHER'）。 */
  market: BrokerMarket;
  /** 出自哪家券商（正規化 key，例 'gs' / 'ms' / 'citi'）。 */
  broker: string;
  /** 評等原文（例 'Buy' / 'Overweight' / 'Equal-weight' / 'Conviction List Buy'）。 */
  rating_raw: string;
  /** 正規化評等（由 normalizeRating(rating_raw) 推得）。 */
  rating: BrokerRatingNormalized;
  /** 評等動作（initiate/upgrade/downgrade/maintain）。 */
  rating_action: RatingAction;
  /** 目標價（報告幣別；無則 null）。 */
  target_price: number | null;
  /** 前次目標價（升/降目標時填；無則 null）。 */
  prev_target_price: number | null;
  /** 目標價幣別（'TWD' / 'USD' / 'HKD'…）。非 TWD 不計達標度。 */
  report_currency: string;
  /** 由 rating 推導的情緒（sentimentFromRating）— 不可由 LLM 自填。 */
  sentiment: StockSentiment;
  /** 是否為這份報告的主標的（單檔深度報告 = true；族群/主題報告的個股 = false）。 */
  covered: boolean;
  /** 一句話投資論點。 */
  thesis: string;
  /** 原文片段（佐證）。 */
  context: string;
  /** LLM 對「萃取本身是否正確」的自評信心 [0,1]。 */
  llm_confidence: number;
}

/** 一份券商報告。 */
export interface BrokerReport {
  /** 全域唯一 ID（= PDF 檔名前綴 msgid）。 */
  report_id: string;
  /** 券商正規化 key（gs/ms/citi/ubs/daiwa…）。 */
  broker: string;
  /** 券商顯示名（Goldman Sachs / Morgan Stanley…）。 */
  broker_display: string;
  /** 報告日 YYYY-MM-DD（= forward 漲跌幅基準日）。 */
  report_date: string;
  /** 報告標題。 */
  title: string;
  /** 來源 PDF 檔名。 */
  source_pdf: string;
  /** 主標的代號（單檔報告填；族群/主題報告 = null）。 */
  primary_stock_code: string | null;
  /** 這份報告涵蓋/提及的股票觀點。 */
  stocks: BrokerStockMention[];
  /** PDF 解析模式（text=pypdf 抽字；vision=亂碼改 render PNG 視覺讀）。 */
  parse_mode: 'text' | 'vision';
  /** Claude 寫入時間 ISO。 */
  generated_at: string;
}

/** 某日所有券商報告。 */
export interface BrokerDailyReports {
  date: string;
  generated_at: string;
  reports: BrokerReport[];
  stats: {
    report_count: number;
    unique_brokers: number;
    unique_stocks: number;
    covered_count: number;
  };
}

/** 券商 registry entry（檔名 hint → 顯示名 + 預設幣別）。 */
export interface BrokerRegistryEntry {
  key: string;
  display: string;
  aliases: string[];
  default_currency: string;
}

// ─────────────────────────────────────────────────────────────
// 推導純函式（單一事實來源；合約測試鎖）
// ─────────────────────────────────────────────────────────────

/**
 * 把券商評等原文正規化成標準值。
 * 順序：先判 overweight/underweight（含 ow/uw 縮寫），再 neutral 群，再 buy 群，
 * 再 sell 群，最後 hold；都不中 → other（not-rated/restricted/suspended）。
 */
export function normalizeRating(raw: string): BrokerRatingNormalized {
  const s = (raw || '').toLowerCase().trim();
  if (!s) return 'other';
  // 中文券商評等（富邦/凱基/中信等本土券商）
  if (/減少持股|賣出|減碼|劣於大盤|區間偏空/.test(s)) return 'sell';
  if (/增加持股|買進|加碼|強力買進|逢低買進|優於大盤|區間偏多|看好/.test(s)) return 'buy';
  if (/中立|區間操作|區間整理|同步大盤|持有/.test(s)) return 'neutral';
  if (/(^|[^a-z])(overweight|ow)([^a-z]|$)/.test(s)) return 'overweight';
  if (/(^|[^a-z])(underweight|uw)([^a-z]|$)/.test(s)) return 'underweight';
  if (/(equal[\s-]?weight|equalwt|(^|[^a-z])ew([^a-z]|$)|market[\s-]?perform|in[\s-]?line|neutral)/.test(s)) return 'neutral';
  if (/(outperform|strong\s*buy|conviction|(^|[^a-z])buy([^a-z]|$)|accumulate|(^|[^a-z])add([^a-z]|$)|(^|[^a-z])long([^a-z]|$))/.test(s)) return 'buy';
  if (/(underperform|(^|[^a-z])sell([^a-z]|$)|reduce|(^|[^a-z])short([^a-z]|$))/.test(s)) return 'sell';
  if (/(^|[^a-z])hold([^a-z]|$)/.test(s)) return 'hold';
  return 'other';
}

/**
 * 由正規化評等推導情緒（sentiment）。
 * buy|overweight → bullish；sell|underweight → bearish；
 * neutral|hold → neutral；other → mentioned_only。
 */
export function sentimentFromRating(r: BrokerRatingNormalized): StockSentiment {
  switch (r) {
    case 'buy':
    case 'overweight':
      return 'bullish';
    case 'sell':
    case 'underweight':
      return 'bearish';
    case 'neutral':
    case 'hold':
      return 'neutral';
    default:
      return 'mentioned_only';
  }
}
