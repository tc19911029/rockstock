/**
 * YouTube tracking — type definitions (MVP 1: 抓得穩)
 *
 * 設計原則：
 *   - 不混入 LLM 結果（逐字稿/摘要/股票提取留給 MVP 2+）
 *   - should_analyze=false 一定要附 skip_reason（規格節 3 invariant）
 *   - 所有時間用 ISO string 存，前端再轉 Asia/Taipei 顯示
 */

export type VideoType =
  | 'full_program'
  | 'live_replay'
  | 'clip'
  | 'shorts'
  | 'preview'
  | 'ad'
  | 'unknown';

export type SkipReason =
  | 'shorts'
  | 'preview'
  | 'ad'
  | 'too_short'
  | 'too_old'
  | 'wrong_date'        // published_at 不在 targetDate 同日 (Asia/Taipei)
  | 'not_stock_related'
  | 'already_analyzed'
  | 'historical_backfill'
  | 'live_in_progress';

export type SourceKind = 'channel' | 'playlist';
export type ExpectedCadence = 'daily' | 'weekday' | 'weekly' | 'irregular';

export interface YouTubeSource {
  source_id: string;            // kebab-case, primary key
  display_name: string;         // '理財達人秀'
  kind: SourceKind;
  url: string;                  // canonical fetch URL for yt-dlp
  expected_cadence: ExpectedCadence;
  market_type: 'TW_STOCK' | 'US_STOCK' | 'CN_STOCK' | 'OTHER';
  first_scan_done: boolean;
  active: boolean;
  created_at: string;           // ISO
  /**
   * 該節目的固定分析師（主持人 / 招牌人）。
   *   - 一人秀 (蔡萬得 / 涂敏峰 / 藍登耀 / 許毓玲 / 陳威良)：["蔡萬得"]
   *   - 主持 + 固定夥伴 (兆華艾綸說)：["李兆華", "艾綸"]
   *   - 來賓輪替 (理財達人秀 / 57同學會 / 錢線百分百 / 金臨天下 / 股民開講)：
   *     列主持人就好，來賓從標題解析
   * 標題解析器 parseAnalysts() 會合併 default + 標題抓到的。
   */
  default_analysts?: string[];
  /**
   * 是否啟用關鍵幀抽取（影片下載 + 場景偵測 + OCR）。
   * 只開簡報重的來源（PPT 股票清單/目標價多）控制下載流量；
   * data-driven：改 sources.json 即生效，prod 免 rebuild。
   */
  keyframe_enabled?: boolean;
}

export interface YouTubeVideo {
  video_id: string;             // YouTube 11-char id (primary key)
  source_id: string;
  title: string;
  url: string;
  duration_sec: number | null;
  published_at: string | null;  // ISO; from yt-dlp upload_date/timestamp
  program_date: string | null;  // YYYY-MM-DD parsed from title (Asia/Taipei)
  video_type: VideoType;
  should_analyze: boolean;
  skip_reason: SkipReason | null;     // 與 should_analyze 互斥
  video_confidence_score: number;     // 0-100, deterministic in MVP 1
  discovered_at: string;        // ISO; first scan that saw it
  last_seen_at: string;         // ISO; most recent scan that re-saw it
  /**
   * 該集影片的分析師列表（主持人 + 來賓）。從標題解析；
   * 沒解析到就用該 source 的 default_analysts（固定一人主持的節目）。
   * 例：理財達人秀 5/20 part1 → ["李兆華", "朱家泓"]；蔡萬得每日解盤 → ["蔡萬得"]。
   * 用於 stock mention 歸屬：mention 不是「節目說的」，是「分析師說的」。
   */
  analysts: string[];
  raw: {
    live_status?: string;       // is_live / was_live / not_live / post_live / ...
    view_count?: number;
    channel_id?: string;
  };
}

export interface YouTubeSourceScanLog {
  source_id: string;
  scan_date: string;            // Asia/Taipei YYYY-MM-DD
  started_at: string;           // ISO
  finished_at: string | null;
  scanned_count: number;
  new_count: number;
  analyzable_count: number;
  skipped_count: number;
  failed_count: number;
  error: string | null;
  possible_missing_update: boolean;
  consecutive_empty_days: number;
}

/** 滾動快照，每次掃描末尾整批重算 */
export interface YouTubeSourceHealth {
  source_id: string;
  display_name: string;
  expected_cadence: ExpectedCadence;
  /** 是否仍在 active rotation，false=歷史保留不再掃 */
  active: boolean;
  last_scan_at: string | null;
  last_success_at: string | null;
  last_video_discovered_at: string | null;
  consecutive_empty_days: number;
  possible_missing_update: boolean;
  today: {
    scanned: number;
    analyzable: number;
    skipped: number;
    failed: number;
    error: string | null;
  };
}

export interface YouTubeHealthSnapshot {
  generated_at: string;         // ISO
  scan_date: string;            // Asia/Taipei YYYY-MM-DD
  sources: YouTubeSourceHealth[];
}

/** 全域 dedup index — video_id → 該影片首次被發現的日期與來源 */
export interface VideoIndex {
  /** video_id → { date, source_id } */
  byId: Record<string, { date: string; source_id: string }>;
  updated_at: string;
}
