/** 陸股財經節目追蹤共用型別。 */

export type CnMediaPlatform = 'yicai' | 'bilibili';
export type CnMediaCadence = 'weekday' | 'daily' | 'weekly' | 'irregular';

export interface CnMediaSource {
  source_id: string;
  display_name: string;
  platform: CnMediaPlatform;
  url: string;
  expected_cadence: CnMediaCadence;
  active: boolean;
  /** 節目固定主持人；來賓仍由逐字稿判斷。 */
  default_analysts: string[];
  /** 官方媒體與個人創作者分層，分析時不可把兩者可信度視為相同。 */
  source_tier: 'official_media' | 'creator';
  /** 創作者帳號可能混合其他題材，只收錄標題含任一關鍵字的內容。 */
  include_title_keywords?: string[];
  /** B站手機搜尋使用的穩定關鍵字；可含 {year}，搜尋後仍會核對作者 ID。 */
  search_query?: string;
  /** 可提供多組搜尋詞降低 B站搜尋排序波動；同樣支援 {year}。 */
  search_queries?: string[];
  /** 搜尋結果頁數，預設 3 頁。 */
  search_pages?: number;
}
export interface CnMediaVideo {
  video_id: string;
  source_id: string;
  platform: CnMediaPlatform;
  title: string;
  url: string;
  /** 可交給轉錄器的實際影音網址；簽名網址會過期，掃描可隨時重抓。 */
  media_url: string | null;
  published_at: string;
  program_date: string;
  duration_sec: number | null;
  analysts: string[];
  source_tier: CnMediaSource['source_tier'];
  discovered_at: string;
  last_seen_at: string;
}

export interface CnMediaScanResult {
  source_id: string;
  display_name: string;
  scanned_at: string;
  target_date: string;
  found_count: number;
  error: string | null;
}

export type CnTranscriptStatus = 'available' | 'low_quality' | 'failed';

export interface CnMediaTranscript {
  video_id: string;
  source_id: string;
  date: string;
  fetched_at: string;
  status: CnTranscriptStatus;
  quality_score: number;
  char_count: number;
  cue_count: number;
  text: string;
  cues: Array<{ start: number; end: number; text: string }>;
  error: string | null;
}

export type CnExchange = 'SSE' | 'SZSE' | 'BSE';

export interface CnStockMasterEntry {
  code: string;
  symbol: string;
  name: string;
  exchange: CnExchange;
  industry: string | null;
  aliases: string[];
}

export interface CnStockMatch {
  code: string;
  symbol: string;
  name: string;
  market: CnExchange;
  confidence: number;
  match_via: 'exact_code' | 'exact_name' | 'alias' | 'fuzzy_substring';
}

export interface CnMediaQuestionVideo extends CnMediaVideo {
  transcript_quality_score: number;
  transcript_char_count: number;
  transcript_cue_count: number;
  transcript_text: string;
}

export interface CnMediaFactorEvidence {
  data_provenance: 'internal_api' | 'transcript' | 'missing';
  values: Record<string, unknown>;
  sources: Array<{ url: string; fetched_at: string; raw_quote: string }>;
}

export interface CnMediaQuestionPayload {
  schema_version: 1;
  market: 'CN_STOCK';
  date: string;
  generated_at: string;
  instructions: string;
  output_path: string;
  videos: CnMediaQuestionVideo[];
  source_transcript_availability: Array<{
    source_id: string;
    display_name: string;
    source_tier: CnMediaSource['source_tier'];
    videos_found: number;
    transcript_available: number;
  }>;
  stock_candidates: CnStockMasterEntry[];
  stock_data_bundles: unknown[];
  macro: unknown;
}
