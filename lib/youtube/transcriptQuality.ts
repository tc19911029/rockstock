/**
 * Transcript quality scoring + status decision (MVP 3 起手版，全 deterministic)。
 *
 * 規則設計目的：拒絕餵下游 LLM 廢字串（自動字幕滾動亂碼、英文 unrelated、長度極短）。
 *
 * Status 決策矩陣：
 *   - 字幕沒抓到                  → 'unavailable' (score=0)
 *   - 抓到但 char_count==0        → 'failed'      (score=0)
 *   - 抓到、score >= 50           → 'available'
 *   - 抓到、0 < score < 50        → 'low_quality'
 */

import type { TranscriptCue, TranscriptFetchResult } from './transcript';

export type TranscriptStatus = 'available' | 'low_quality' | 'unavailable' | 'failed' | 'pending';

const CHINESE_LANG_PREFIXES = ['zh-Hant', 'zh-TW', 'zh-Hans', 'zh-CN', 'zh'];
const STOCK_KEYWORDS = [
  '股', '台股', '美股', '盤勢', '盤後', '盤前', '操作', '進場', '佈局',
  '收盤', '開盤', '個股', '台積', '輝達', 'AI', '半導體', 'ETF', '加權', '櫃買',
  '法人', '外資', '投信', '主力', '籌碼', '財報', '營收', '毛利',
];

export interface QualityInputs {
  fetched: TranscriptFetchResult;
  /** 影片標題，用於下游 keyword 比對（題材對齊） */
  title?: string;
}

export interface QualityResult {
  score: number;                  // 0-100
  status: TranscriptStatus;
  lang_ok: boolean;
  length_ok: boolean;
  has_timestamps: boolean;
  stock_keyword_hits: number;
  rolling_dup_ratio: number;      // 0-1, 越接近 1 越糟
}

const MIN_CHARS = 500;
const MAX_CHARS = 80_000;
const MIN_CUES = 50;
const MIN_KEYWORD_HITS = 3;
const AVAILABLE_THRESHOLD = 50;

export function gradeTranscript(input: QualityInputs): QualityResult {
  const f = input.fetched;

  if (!f.available) {
    return zeroResult('unavailable');
  }
  if (f.char_count === 0) {
    return zeroResult('failed');
  }

  let score = 0;

  // +20 有逐字稿（已過 available 門檻）
  score += 20;

  // +25 中文
  const langOk = isChinese(f.lang);
  if (langOk) score += 25;

  // +15 長度合理
  const lengthOk = f.char_count >= MIN_CHARS && f.char_count <= MAX_CHARS;
  if (lengthOk) score += 15;

  // +10 有時間戳（dedup 後 cue 數 ≥ 50）
  const hasTimestamps = f.cues.length >= MIN_CUES;
  if (hasTimestamps) score += 10;

  // +20 股票關鍵字命中
  const keywordHits = countKeywordHits(f.text);
  if (keywordHits >= MIN_KEYWORD_HITS) score += 20;

  // 重複率扣分（rolling dedup 後仍重複過多 → 自動字幕沒救）
  const dupRatio = computeRollingDupRatio(f.cues);
  if (dupRatio > 0.3) score = Math.max(0, score - 20);

  score = Math.min(100, score);
  const status: TranscriptStatus = score >= AVAILABLE_THRESHOLD ? 'available' : 'low_quality';

  return {
    score,
    status,
    lang_ok: langOk,
    length_ok: lengthOk,
    has_timestamps: hasTimestamps,
    stock_keyword_hits: keywordHits,
    rolling_dup_ratio: dupRatio,
  };
}

function zeroResult(status: TranscriptStatus): QualityResult {
  return {
    score: 0, status,
    lang_ok: false, length_ok: false, has_timestamps: false,
    stock_keyword_hits: 0, rolling_dup_ratio: 0,
  };
}

function isChinese(lang: string | null): boolean {
  if (!lang) return false;
  return CHINESE_LANG_PREFIXES.some(p => lang.startsWith(p));
}

function countKeywordHits(text: string): number {
  let hits = 0;
  for (const kw of STOCK_KEYWORDS) {
    if (text.includes(kw)) hits++;
  }
  return hits;
}

/**
 * 計算 cue 文字間的 prefix overlap 比率。
 * 若多數相鄰 cue 共享 prefix（且未被 dedupeRollingCues 完全清掉），代表自動字幕滾動殘渣。
 * 真人手寫字幕此值通常 < 0.1。
 */
function computeRollingDupRatio(cues: TranscriptCue[]): number {
  if (cues.length < 2) return 0;
  let overlapPairs = 0;
  for (let i = 1; i < cues.length; i++) {
    const a = cues[i - 1].text;
    const b = cues[i].text;
    const minLen = Math.min(a.length, b.length);
    if (minLen < 8) continue;
    const commonPrefix = longestCommonPrefix(a, b);
    if (commonPrefix.length > minLen * 0.6) overlapPairs++;
  }
  return overlapPairs / (cues.length - 1);
}

function longestCommonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}
