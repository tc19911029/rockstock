/**
 * Video classification + program date parsing + analyze decision + confidence score.
 *
 * MVP 1: 全部 deterministic（不靠 LLM）。
 *
 * Invariant：should_analyze=false ⇒ skip_reason 一定 non-null。
 *           contract test 會驗證這一點。
 */

import type {
  SkipReason,
  VideoType,
  YouTubeSource,
  YouTubeVideo,
} from './types';
import type { YtdlpVideo } from './ytdlp';

const SHORTS_DURATION_THRESHOLD_SEC = 60;
const FULL_PROGRAM_DURATION_THRESHOLD_SEC = 8 * 60;  // 標 full_program 用，>= 8min
// too_short skip 門檻獨立於 full_program 門檻：
// 林漢偉盤前解盤每天 ~7.7min 是真實 daily 節目，會被 8min skip。降到 3min 讓 clip 也能進分析。
const TOO_SHORT_SKIP_THRESHOLD_SEC = 3 * 60;

const PREVIEW_HINTS = ['預告', '搶先看', '搶先報', 'teaser', 'preview'];
const AD_HINTS = ['業配', '廣告', 'sponsored', '#ad'];
const STOCK_KEYWORDS = [
  '股', '台股', '美股', '盤勢', '盤後', '盤前', '操作', '進場', '佈局', '布局',
  '布局', '收盤', '開盤', '分析', '理財', 'ETF', '加權', '櫃買', '個股',
  '半導體', 'AI', '伺服器', '績優', '財報',
];

export function classifyVideoType(v: YtdlpVideo): VideoType {
  const title = v.title || '';
  const url = v.url || '';

  // Shorts 最優先（不管 duration、live_status）
  if (/\/shorts\//.test(url)) return 'shorts';
  if (v.duration != null && v.duration > 0 && v.duration < SHORTS_DURATION_THRESHOLD_SEC) {
    return 'shorts';
  }

  const liveStatus = v.live_status || '';
  if (liveStatus === 'is_live') {
    // 進行中直播：視覺上是 live_replay 候選，但 decide 階段會 skip_reason='live_in_progress'
    return 'live_replay';
  }
  if (liveStatus === 'was_live' || liveStatus === 'post_live') {
    return 'live_replay';
  }

  if (PREVIEW_HINTS.some(h => title.includes(h))) return 'preview';
  if (AD_HINTS.some(h => title.toLowerCase().includes(h.toLowerCase()))) return 'ad';

  if (v.duration != null && v.duration > 0) {
    if (v.duration >= FULL_PROGRAM_DURATION_THRESHOLD_SEC) return 'full_program';
    return 'clip';
  }

  return 'unknown';
}

/**
 * 解析標題裡的節目日期。
 * 涵蓋格式：
 *   2026.05.22 / 2026/05/22 / 2026-05-22  → 完整年月日
 *   5/22 / 5-22 / 05.22                   → 月日（年份用 now 推算）
 *   0522 (4 位數字，不接其他數字)          → 月日
 *   5月22日 / 5月22號                      → 中文
 *
 * 不命中：時間（00:22）、混在其他數字中（123456）、明顯不是日期的數字
 */
export function parseProgramDate(title: string, now: Date): string | null {
  if (!title) return null;

  // 1) 完整年月日：2026.05.22 / 2026/05/22 / 2026-05-22
  let m = title.match(/(20\d{2})[./\-](\d{1,2})[./\-](\d{1,2})/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (isValidYmd(y, mo, d)) return toYmd(y, mo, d);
  }

  // 2) 中文：5月22日 / 5月22號
  m = title.match(/(\d{1,2})月(\d{1,2})[日號]/);
  if (m) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const y = inferYear(now, mo);
      if (isValidYmd(y, mo, d)) return toYmd(y, mo, d);
    }
  }

  // 3) 短格式月/日：5/22 或 5-22 或 05.22 — 需避開時間（00:22）、年份（2026）
  //    與數量單位（1.2兆、1.5%、1.29元、4.2K 點）— 後者最容易誤判
  //
  // negative lookbehind: 不能前接冒號 / 數字 (排時間和混在大數字中)
  // negative lookahead:  不能後接冒號 / 數字 / 中文數量單位 / 英文單位
  //
  // 例：「1.2兆交易量」「1.5%」「1.29元」「4.2K 點」「3.5億」必須跳過
  m = title.match(/(?<![:0-9])(\d{1,2})[./\-](\d{1,2})(?![:0-9兆億萬千百元塊圓%倍KkMmBb])/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    // 避免誤判 12.34 之類非日期數字：必須 a∈[1,12] b∈[1,31]
    if (a >= 1 && a <= 12 && b >= 1 && b <= 31) {
      const y = inferYear(now, a);
      if (isValidYmd(y, a, b)) return toYmd(y, a, b);
    }
  }

  // 4) 純 4 位數字 MMDD（不接其他數字、不接冒號）：0522
  m = title.match(/(?<![0-9:])(\d{4})(?![0-9:])/);
  if (m) {
    const s = m[1];
    const mo = Number(s.slice(0, 2));
    const d = Number(s.slice(2, 4));
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const y = inferYear(now, mo);
      if (isValidYmd(y, mo, d)) return toYmd(y, mo, d);
    }
  }

  return null;
}

function isValidYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function toYmd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 若標題只給月份，月份比「現在月份 + 1」還大 → 視為去年。否則今年。 */
function inferYear(now: Date, mo: number): number {
  const taipeiNow = new Date(now.getTime() + 8 * 3600_000);
  const curY = taipeiNow.getUTCFullYear();
  const curM = taipeiNow.getUTCMonth() + 1;
  if (mo > curM + 1) return curY - 1;
  return curY;
}

export interface DecideContext {
  now: Date;
  alreadyAnalyzed: Set<string>;     // video_id 集合
  /**
   * 嚴格同日過濾的目標日期 (YYYY-MM-DD, Asia/Taipei)。
   * 提供 → 影片的「節目日期」必須是該日才允許 should_analyze=true。
   *        節目日期 = program_date（由標題解析） ?? ymdTaipei(published_at)
   *        — 標題日期優先，因為晚間節目常常在隔天 00:xx 才 upload 完，
   *          published_at 會落在隔天，但標題仍寫前一天，這是真實的節目日。
   * 不提供 → 走舊的 72h 窗（向下相容）。
   */
  targetDate?: string;
}

/**
 * 決定 should_analyze 與 skip_reason。
 * 順序敏感：先處理「已分析過」與「規則性排除」，再處理時效。
 */
export function decideShouldAnalyze(
  video: Pick<YouTubeVideo, 'video_id' | 'video_type' | 'duration_sec' | 'published_at' | 'program_date' | 'raw'>,
  ctx: DecideContext,
): { should: boolean; reason: SkipReason | null } {
  if (ctx.alreadyAnalyzed.has(video.video_id)) {
    return { should: false, reason: 'already_analyzed' };
  }
  switch (video.video_type) {
    case 'shorts':  return { should: false, reason: 'shorts' };
    case 'preview': return { should: false, reason: 'preview' };
    case 'ad':      return { should: false, reason: 'ad' };
  }
  if (video.raw?.live_status === 'is_live') {
    return { should: false, reason: 'live_in_progress' };
  }
  if (video.duration_sec != null && video.duration_sec < TOO_SHORT_SKIP_THRESHOLD_SEC) {
    return { should: false, reason: 'too_short' };
  }
  // 時效檢查：
  //   - effective date = program_date (標題日期) ?? ymdTaipei(published_at)
  //   - targetDate 模式 → effective date 必須 === targetDate
  //   - 沒 targetDate → effective date 必須在 72h 窗內
  const effectiveDate = effectiveProgramDate(video);
  if (ctx.targetDate) {
    if (!effectiveDate) {
      // 無從判斷日期 — 不分析（保守處理）
      return { should: false, reason: 'wrong_date' };
    }
    if (effectiveDate !== ctx.targetDate) {
      return { should: false, reason: 'wrong_date' };
    }
  } else if (video.published_at) {
    const ageMs = ctx.now.getTime() - new Date(video.published_at).getTime();
    if (ageMs > 72 * 3600_000) {
      return { should: false, reason: 'too_old' };
    }
  }
  return { should: true, reason: null };
}

/**
 * 影片的「實際節目日期」(Asia/Taipei YYYY-MM-DD)。
 *   優先用 program_date（標題解析）— 因為晚間節目常常隔天 00:xx 才 upload 完，
 *   published_at 會掉到隔天，但標題仍寫前一天，標題才是真實的節目日。
 *   標題沒日期才用 published_at。
 *   兩者都沒就 null（無從判斷）。
 */
export function effectiveProgramDate(
  video: Pick<YouTubeVideo, 'program_date' | 'published_at'>,
): string | null {
  if (video.program_date) return video.program_date;
  if (video.published_at) return ymdTaipei(new Date(video.published_at));
  return null;
}

/** ISO 時間轉成 Asia/Taipei 的 YYYY-MM-DD */
export function ymdTaipei(d: Date): string {
  const taipei = new Date(d.getTime() + 8 * 3600_000);
  const y = taipei.getUTCFullYear();
  const m = taipei.getUTCMonth() + 1;
  const day = taipei.getUTCDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * 影片可信度分數（0-100，deterministic）。
 *
 * MVP 1 不含逐字稿加分（永遠不加 +20 transcript），等 MVP 3 才補。
 */
export function videoConfidenceScore(
  video: Pick<YouTubeVideo, 'video_type' | 'duration_sec' | 'published_at' | 'program_date' | 'title'>,
  source: YouTubeSource,
  now: Date,
): number {
  let score = 0;
  if (source.active) score += 20;

  if (video.published_at) {
    const ageMs = now.getTime() - new Date(video.published_at).getTime();
    if (ageMs < 24 * 3600_000) score += 15;
  }

  if (video.program_date) {
    const todayTpe = todayYmdTaipei(now);
    if (video.program_date === todayTpe) score += 20;
  }

  if (video.duration_sec != null && video.duration_sec >= FULL_PROGRAM_DURATION_THRESHOLD_SEC) {
    score += 10;
  }

  if (STOCK_KEYWORDS.some(k => video.title.includes(k))) score += 10;

  if (video.video_type !== 'shorts' && video.video_type !== 'preview' && video.video_type !== 'ad') {
    score += 5;
  }

  return Math.min(100, score);
}

export function todayYmdTaipei(now: Date): string {
  const taipei = new Date(now.getTime() + 8 * 3600_000);
  const y = taipei.getUTCFullYear();
  const m = taipei.getUTCMonth() + 1;
  const d = taipei.getUTCDate();
  return toYmd(y, m, d);
}
