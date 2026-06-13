/**
 * 推薦事件抽取 — analysis/{date}.json → RecoEvent[]（pure，無 I/O）。
 *
 * 規則（2026-06-12 計畫核准）：
 *   - 沿用 deriveStockMentions 門檻：matched != null 且 combined_confidence ≥ 0.6
 *   - recommendation_type：新分析讀 mention 原生欄；舊分析由 sentiment 映射（type_source 標註）
 *   - 每位老師各記一筆（analysts ["李兆華","朱家泓"] → 2 個事件）
 *   - 同 (date, teacher, stock_code) 跨影片合併 → 1 筆（保留最強型態）
 *   - 同日同人多空衝突 → conflict=true（排除統計但保留紀錄）
 *   - analysts 清洗後為空（頻道名 fallback）→ teacher_kind='program_fallback'，
 *     teacher = `節目:${source_id}`（display_name 由 API 層再補）
 */

import type { AnalyzedStockMention, DailyAnalysis, StockSentiment } from './analysisStorage';
import { cleanTeacherNames } from './teacherName';
import type {
  RecoCohort, RecommendationType, RecoEvent, RecoEventVideoRef, RecoEventsFile,
} from './recoTypes';

/** 舊 analysis（無 recommendation_type 欄）的 sentiment fallback 映射 */
export const SENTIMENT_TO_TYPE: Record<StockSentiment, RecommendationType> = {
  bullish: '看多',
  watchlist: '觀察',
  risk_warning: '小心追高',
  bearish: '偏空',
  mentioned_only: '只介紹',
  neutral: '只介紹',
};

export const TYPE_COHORT: Record<RecommendationType, RecoCohort> = {
  明確買進: 'scored',
  看多: 'scored',
  觀察: 'watch',
  等回檔: 'watch',
  小心追高: 'excluded',
  偏空: 'bearish',
  只介紹: 'excluded',
};

/** 合併時的型態強度排序（大 = 強） */
const TYPE_STRENGTH: Record<RecommendationType, number> = {
  明確買進: 7, 看多: 6, 等回檔: 5, 觀察: 4, 小心追高: 3, 偏空: 2, 只介紹: 1,
};

/** 多空衝突判定用：看多家族 vs 偏空 */
function direction(t: RecommendationType): 'long' | 'short' | 'none' {
  if (t === '明確買進' || t === '看多' || t === '等回檔' || t === '觀察') return 'long';
  if (t === '偏空') return 'short';
  return 'none';
}

const VALID_TYPES = new Set<RecommendationType>(Object.keys(TYPE_COHORT) as RecommendationType[]);

/** mention → 推薦型態（原生欄優先，否則 sentiment fallback） */
export function resolveRecommendationType(
  m: Pick<AnalyzedStockMention, 'sentiment'> & { recommendation_type?: string },
): { type: RecommendationType; source: 'native' | 'sentiment_fallback' } {
  const native = m.recommendation_type as RecommendationType | undefined;
  if (native && VALID_TYPES.has(native)) return { type: native, source: 'native' };
  return { type: SENTIMENT_TO_TYPE[m.sentiment] ?? '只介紹', source: 'sentiment_fallback' };
}

export interface ExtractOptions {
  /** source_id → display_name（用於老師名清洗 + program_fallback 命名） */
  displayNameBySource?: Map<string, string>;
  /** video_id → analysts（mention 沒帶 analysts 時的補充來源） */
  analystsByVideo?: Map<string, string[]>;
  minConfidence?: number;
}

/**
 * DailyAnalysis → RecoEvent[]（baseline 一律 pending，由 settleBaseline 另行結算）。
 */
export function extractRecoEvents(
  analysis: DailyAnalysis,
  opts: ExtractOptions = {},
): Omit<RecoEventsFile, 'generated_at'> {
  const minConf = opts.minConfidence ?? 0.6;
  const byKey = new Map<string, RecoEvent>();
  let lowConfidence = 0;
  let unmatched = 0;

  if (analysis.is_placeholder) {
    return {
      date: analysis.date,
      source_analysis_generated_at: analysis.generated_at,
      events: [],
      skipped: { low_confidence: 0, unmatched: 0, placeholder: true },
    };
  }

  const allMentions = [...analysis.high_consensus_stocks, ...analysis.weak_signal_stocks];

  for (const m of allMentions) {
    if (!m.matched) { unmatched += 1; continue; }
    if (m.combined_confidence < minConf) { lowConfidence += 1; continue; }

    const displayName = opts.displayNameBySource?.get(m.source_id) ?? m.source_id;
    const rawAnalysts = (m.analysts && m.analysts.length > 0)
      ? m.analysts
      : opts.analystsByVideo?.get(m.video_id) ?? [];
    const persons = cleanTeacherNames(rawAnalysts, displayName);

    const { type, source: typeSource } = resolveRecommendationType(m);
    const ref: RecoEventVideoRef = {
      video_id: m.video_id,
      source_id: m.source_id,
      sentiment: m.sentiment,
      recommendation_type: type,
      type_source: typeSource,
      context: m.context,
      reason: m.reason,
      combined_confidence: m.combined_confidence,
      ...(m.target_price != null ? { target_price: m.target_price } : {}),
      ...(m.stop_loss != null ? { stop_loss: m.stop_loss } : {}),
      ...(m.mentioned_price != null ? { mentioned_price: m.mentioned_price } : {}),
    };

    // 無具名老師 → 整筆歸節目（fallback）；有具名 → 每位老師各記一筆
    const teachers: Array<{ name: string; kind: RecoEvent['teacher_kind'] }> =
      persons.length > 0
        ? persons.map(name => ({ name, kind: 'person' as const }))
        : [{ name: `節目:${m.source_id}`, kind: 'program_fallback' as const }];

    for (const t of teachers) {
      const key = `${analysis.date}:${t.name}:${m.matched.code}`;
      let ev = byKey.get(key);
      if (!ev) {
        ev = {
          id: key,
          date: analysis.date,
          teacher: t.name,
          teacher_kind: t.kind,
          stock_code: m.matched.code,
          stock_name: m.matched.name,
          symbol: m.matched.market === 'TPEx' ? `${m.matched.code}.TWO` : `${m.matched.code}.TW`,
          market: m.matched.market,
          recommendation_type: type,
          cohort: TYPE_COHORT[type],
          ...(ref.target_price != null ? { target_price: ref.target_price } : {}),
          ...(ref.stop_loss != null ? { stop_loss: ref.stop_loss } : {}),
          videos: [ref],
          baseline: {
            status: 'pending', base_date: null, entry_open: null,
            mention_close: null, settled_at: null,
          },
        };
        byKey.set(key, ev);
        continue;
      }
      // 同 key 跨影片合併：同影片同股重複 mention 只記一次
      if (!ev.videos.some(v => v.video_id === ref.video_id && v.recommendation_type === ref.recommendation_type)) {
        ev.videos.push(ref);
      }
      // 目標價/停損：取第一個有值的（合併不覆蓋既有）
      if (ev.target_price == null && ref.target_price != null) ev.target_price = ref.target_price;
      if (ev.stop_loss == null && ref.stop_loss != null) ev.stop_loss = ref.stop_loss;
      // 多空衝突偵測（合併前後方向不同）
      const dPrev = direction(ev.recommendation_type);
      const dNew = direction(type);
      if (dPrev !== 'none' && dNew !== 'none' && dPrev !== dNew) {
        ev.conflict = true;
      }
      // 保留最強型態（衝突時取 confidence 較高的那筆方向）
      if (ev.conflict) {
        const strongest = [...ev.videos].sort((a, b) => b.combined_confidence - a.combined_confidence)[0];
        ev.recommendation_type = strongest.recommendation_type;
      } else if (TYPE_STRENGTH[type] > TYPE_STRENGTH[ev.recommendation_type]) {
        ev.recommendation_type = type;
      }
      ev.cohort = TYPE_COHORT[ev.recommendation_type];
    }
  }

  // 穩定輸出順序：老師 → 股票代號
  const events = [...byKey.values()].sort(
    (a, b) => a.teacher.localeCompare(b.teacher, 'zh-Hant') || a.stock_code.localeCompare(b.stock_code),
  );

  return {
    date: analysis.date,
    source_analysis_generated_at: analysis.generated_at,
    events,
    skipped: { low_confidence: lowConfidence, unmatched, placeholder: false },
  };
}

/**
 * 重抽時保留已結算的 baseline（idempotent merge）：
 * 新事件集合中與舊檔同 id 且舊 baseline 非 pending → 沿用舊 baseline 與 symbol。
 */
export function mergePreservingBaselines(
  fresh: RecoEvent[],
  existing: RecoEvent[] | undefined,
): RecoEvent[] {
  if (!existing || existing.length === 0) return fresh;
  const oldById = new Map(existing.map(e => [e.id, e]));
  return fresh.map(ev => {
    const old = oldById.get(ev.id);
    if (old && old.baseline.status !== 'pending') {
      return { ...ev, baseline: old.baseline, symbol: old.symbol };
    }
    return ev;
  });
}
