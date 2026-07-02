/**
 * 關鍵幀 OCR 初篩 — pure，無 I/O（合約測試守門）。
 *
 * 職責：
 *   screenFrame    — OCR 文字 → 留/丟 + 命中原因（代號/股名/關鍵字）
 *   scoreFrame     — 給 top-N 圖片挑選打分（逐字稿沒有的代號 = novel，加重）
 *   selectTopImages— 每影片 top-N + 全日上限（含時間分散規則）
 *   transcriptWindow — 幀時間 ±N 秒的逐字稿 cue 文字（「畫面出現時老師在說什麼」）
 *
 * 年份誤判防護：1900-2099 的 4 位數（如 2002 中鋼撞「2002年」）只有在
 * master 有此代號「且」±6 字內出現對應股名時才算命中。
 */

import type { StockMasterEntry, StockMasterFile } from './stockMaster';

// ── master 預處理 ────────────────────────────────────────────────────────────

export interface ScreenMaster {
  /** 全市場有效代號 */
  codeSet: Set<string>;
  /** 名稱/alias → entry（名稱長度 ≥2；長 alias 與正式名都收） */
  nameToEntry: Map<string, StockMasterEntry>;
  /** nameToEntry key 的長度集合（由長到短，substring 列舉用） */
  nameLengths: number[];
}

export function buildScreenMaster(master: StockMasterFile): ScreenMaster {
  const codeSet = new Set<string>();
  const nameToEntry = new Map<string, StockMasterEntry>();
  const lengths = new Set<number>();
  for (const e of master.entries) {
    codeSet.add(e.code);
    const names = [e.name, ...(e.aliases ?? [])];
    for (const n of names) {
      const name = n.trim();
      if (name.length < 2 || name.length > 8) continue;
      if (!nameToEntry.has(name)) {
        nameToEntry.set(name, e);
        lengths.add(name.length);
      }
    }
  }
  return { codeSet, nameToEntry, nameLengths: [...lengths].sort((a, b) => b - a) };
}

// ── 初篩 ─────────────────────────────────────────────────────────────────────

/** 財經關鍵字（命中 ≥2 個即留，獨立於代號/股名） */
const KEYWORDS = [
  '目標價', '支撐', '壓力', '滿足點', 'EPS', '本益比', 'PE', 'PB', '殖利率',
  '停損', '停利', '買進', '賣出', '加碼', '出場', '漲停', '營收', '毛利率',
  '法說', '籌碼', '外資', '投信',
];

const TW_CODE_RE = /(?<![\d.])([1-9]\d{3})(?![\d.%])/g;
const CN_CODE_RE = /(?<![\d.])([036]\d{5})(?![\d.%])/g;
/** 年份區間（與台股代號重疊段，需股名佐證才算） */
const YEAR_MIN = 1900;
const YEAR_MAX = 2099;
/** 年份歧義代號需要股名出現在代號 ±此字距內 */
const NAME_ADJACENCY = 6;

export interface ScreenResult {
  keep: boolean;
  hit_reasons: string[];   // ["code:2330","name:台積電","kw:目標價","cn_code:600519"]
  hit_codes: string[];     // 通過 master 驗證的台股代號
  hit_names: string[];     // 命中的股名（正式名）
}

/**
 * 價格/點數上下文 → 不是代號（電視盤面 OCR 常見誤判源）：
 *   「上下震1457點」「收盤 1710 +13.4%」「6~2228年」「市值 857億」
 */
export function isPriceLikeContext(text: string, idx: number, len: number): boolean {
  const after = text.slice(idx + len, idx + len + 8);
  const before = text.slice(Math.max(0, idx - 6), idx);
  // 後綴單位：點/元/年/萬/億/% 或小數延伸（1710.5）
  if (/^\s?[點元年萬億%]/.test(after)) return true;
  if (/^\.\d/.test(after)) return true;
  // 緊鄰漲跌幅（+13.4% / -2.5%）或價格欄位語境
  if (/^\s?[+-]\d+(\.\d+)?%/.test(after)) return true;
  if (/[+-]\d+(\.\d+)?%?\s?$/.test(before)) return true;
  // 前綴「震/漲/跌/約/達」+ 數字 = 點數語境
  if (/[震漲跌約達]\s?$/.test(before)) return true;
  return false;
}

/**
 * 代號上下文是否「高信心」：±adjacency 字內出現該代號的正式股名/alias，
 * 或（代號）括號格式（電視台 K 線圖標題慣例「（5522）遠雄日線圖」）。
 * audit-keyframe-coverage 的 FAIL 門檻用這個（裸代號只 WARN 不擋）。
 */
export function codeContextConfident(
  text: string,
  code: string,
  sm: ScreenMaster,
  adjacency = 10,
): boolean {
  const idx = text.indexOf(code);
  if (idx < 0) return false;
  // （code）/ (code) 括號格式
  const re = new RegExp(`[（(]\\s?${code}\\s?[）)]`);
  if (re.test(text)) return true;
  // ±adjacency 內有該代號的股名/alias
  const lo = Math.max(0, idx - adjacency);
  const hi = Math.min(text.length, idx + code.length + adjacency);
  const window = text.slice(lo, hi);
  for (const [name, entry] of sm.nameToEntry) {
    if (entry.code === code && window.includes(name)) return true;
  }
  return false;
}

/** 列舉文字內所有股名命中（substring 比對 master，長名優先、去重疊） */
function findNameHits(text: string, sm: ScreenMaster): Array<{ name: string; index: number; entry: StockMasterEntry }> {
  const hits: Array<{ name: string; index: number; entry: StockMasterEntry }> = [];
  const taken: boolean[] = new Array(text.length).fill(false);
  for (const len of sm.nameLengths) {
    for (let i = 0; i + len <= text.length; i++) {
      if (taken[i]) continue;
      const sub = text.slice(i, i + len);
      const entry = sm.nameToEntry.get(sub);
      if (!entry) continue;
      hits.push({ name: sub, index: i, entry });
      for (let k = i; k < i + len; k++) taken[k] = true;
    }
  }
  return hits;
}

export function screenFrame(ocrText: string, sm: ScreenMaster): ScreenResult {
  const text = (ocrText ?? '').trim();
  const reasons: string[] = [];
  const codes = new Set<string>();
  const names = new Set<string>();

  if (text.length < 6) {
    // talking head / logo / 空畫面
    return { keep: false, hit_reasons: [], hit_codes: [], hit_names: [] };
  }

  const nameHits = findNameHits(text, sm);
  for (const h of nameHits) {
    if (!names.has(h.entry.name)) {
      names.add(h.entry.name);
      reasons.push(`name:${h.entry.name}`);
    }
  }

  // 台股代號（master 驗證 + 年份歧義防護 + 價格/點數上下文剔除）
  for (const m of text.matchAll(TW_CODE_RE)) {
    const code = m[1];
    if (!sm.codeSet.has(code)) continue;
    const idx = m.index ?? 0;
    if (isPriceLikeContext(text, idx, code.length)) continue;
    const num = Number(code);
    if (num >= YEAR_MIN && num <= YEAR_MAX) {
      // 年份歧義段：±6 字內要有「該代號對應的股名」命中才算
      const nearby = nameHits.some(h =>
        h.entry.code === code &&
        Math.abs(h.index - idx) <= NAME_ADJACENCY + code.length,
      );
      if (!nearby) continue;
    }
    if (!codes.has(code)) {
      codes.add(code);
      reasons.push(`code:${code}`);
    }
  }

  // 陸股 6 位代號（無 master 驗證，記錄供 skill 參考；v1 不進績效事件）
  for (const m of text.matchAll(CN_CODE_RE)) {
    const r = `cn_code:${m[1]}`;
    if (!reasons.includes(r)) reasons.push(r);
  }

  // 關鍵字
  let kwHits = 0;
  for (const kw of KEYWORDS) {
    if (text.includes(kw)) {
      kwHits += 1;
      reasons.push(`kw:${kw}`);
    }
  }

  const hasCnCode = reasons.some(r => r.startsWith('cn_code:'));
  const keep = codes.size >= 1 || names.size >= 1 || hasCnCode || kwHits >= 2;
  return {
    keep,
    hit_reasons: reasons,
    hit_codes: [...codes],
    hit_names: [...names],
  };
}

// ── 評分（top-N 圖片挑選） ────────────────────────────────────────────────────

export interface ScoreInput {
  ocr_text: string;
  ocr_confidence: number;
  hit_codes: string[];
  hit_names: string[];
  hit_reasons: string[];
}

/**
 * 分數設計：slide 上有、逐字稿「沒有」的代號是整個功能的價值核心（老師沒唸出來），
 * 每個 novel 代號 +4；密集表格（長文字）多半是股票清單 +2。
 */
export function scoreFrame(f: ScoreInput, transcriptText: string): number {
  let score = 0;
  for (const code of f.hit_codes) {
    score += 3;
    if (!transcriptText.includes(code)) score += 4;  // novel：逐字稿沒提的代號
  }
  score += f.hit_names.length * 2;
  score += f.hit_reasons.filter(r => r.startsWith('kw:')).length;
  if (f.ocr_text.length > 80) score += 2;            // 密集表格
  score += f.ocr_confidence;                          // tiebreak
  return Math.round(score * 1000) / 1000;
}

// ── top-N 圖片挑選 ───────────────────────────────────────────────────────────

export interface SelectableFrame {
  video_id: string;
  ts: number;
  score: number;
}

/**
 * 每影片取 top-perVideo（同一個 10 分鐘 bucket 最多 2 張，避免連續同主題簡報洗版），
 * 再全日按分數修剪到 globalCap。回傳保留的 `${video_id}:${ts}` key 集合。
 */
export function selectTopImages(
  frames: SelectableFrame[],
  perVideo = 5,
  globalCap = 40,
): Set<string> {
  const byVideo = new Map<string, SelectableFrame[]>();
  for (const f of frames) {
    const arr = byVideo.get(f.video_id) ?? [];
    arr.push(f);
    byVideo.set(f.video_id, arr);
  }

  const candidates: SelectableFrame[] = [];
  for (const arr of byVideo.values()) {
    const sorted = [...arr].sort((a, b) => b.score - a.score);
    const picked: SelectableFrame[] = [];
    const bucketCount = new Map<number, number>();
    for (const f of sorted) {
      if (picked.length >= perVideo) break;
      const bucket = Math.floor(f.ts / 600);
      const used = bucketCount.get(bucket) ?? 0;
      if (used >= 2) continue;
      bucketCount.set(bucket, used + 1);
      picked.push(f);
    }
    candidates.push(...picked);
  }

  const final = candidates.sort((a, b) => b.score - a.score).slice(0, globalCap);
  return new Set(final.map(f => `${f.video_id}:${f.ts}`));
}

// ── 逐字稿視窗 ───────────────────────────────────────────────────────────────

export interface CueLike { start: number; end: number; text: string }

/** 幀時間 ±windowSec 的 cue 文字接成一段（畫面出現時老師在說什麼） */
export function transcriptWindow(
  cues: CueLike[] | null | undefined,
  ts: number,
  windowSec = 45,
  maxChars = 300,
): string {
  if (!cues || cues.length === 0) return '';
  const parts: string[] = [];
  for (const c of cues) {
    if (c.start > ts + windowSec) break;
    if (c.start >= ts - windowSec) parts.push(c.text);
  }
  const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}…` : joined;
}
