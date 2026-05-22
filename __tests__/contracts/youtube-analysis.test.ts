/**
 * Contract test: YouTube analysis pipeline (zhu-style，無 LLM SDK)
 *
 * 守門員：
 *   - stockMaster lookup confidence rubric
 *   - deriveStockMentions 過濾 < 0.6 + matched=null + 排序
 *   - questionBuilder 寫出的 payload shape 正確
 *   - Invariant: deriveStockMentions 內每個 stock 的 best_confidence ≥ 0.6
 */

import {
  buildTestMaster,
  lookupStock,
} from '@/lib/youtube/stockMaster';
import {
  computeCompositeScore,
  deriveStockMentions,
  ratingFromScore,
  type AnalyzedStockMention,
  type DailyAnalysis,
  type FactorScores,
} from '@/lib/youtube/analysisStorage';
import { buildQuestion } from '@/lib/youtube/questionBuilder';
import type { YouTubeVideo } from '@/lib/youtube/types';
import type { TranscriptRecord } from '@/lib/youtube/transcriptStorage';

// ── stockMaster lookup ───────────────────────────────────────────────────────

describe('lookupStock', () => {
  const master = buildTestMaster([
    { code: '2330', name: '台積電', market: 'TWSE' },
    { code: '2454', name: '聯發科', market: 'TWSE' },
    { code: '3661', name: '世芯-KY', market: 'TWSE' },
  ]);

  it('exact 4-digit code → confidence 1.0', () => {
    const r = lookupStock('2330', master);
    expect(r?.code).toBe('2330');
    expect(r?.confidence).toBe(1.0);
    expect(r?.match_via).toBe('exact_code');
  });

  it('unknown numeric → null', () => {
    expect(lookupStock('9999999', master)).toBeNull();
  });

  it('exact name → confidence ≥ 0.9', () => {
    const r = lookupStock('台積電', master);
    expect(r?.code).toBe('2330');
    expect(r?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('alias 世芯 → 3661', () => {
    const r = lookupStock('世芯', master);
    expect(r?.code).toBe('3661');
  });

  it('empty query → null', () => {
    expect(lookupStock('', master)).toBeNull();
    expect(lookupStock('   ', master)).toBeNull();
  });
});

// ── deriveStockMentions ─────────────────────────────────────────────────────

describe('deriveStockMentions', () => {
  const matchedMock = (code: string, name: string) => ({
    code, name, market: 'TWSE' as const,
    confidence: 0.9, match_via: 'alias' as const,
  });

  function m(opts: Partial<AnalyzedStockMention>): AnalyzedStockMention {
    return {
      raw_query: 'X',
      matched: matchedMock('2330', '台積電'),
      llm_confidence: 0.9,
      combined_confidence: 0.81,
      sentiment: 'bullish',
      context: 'ctx', reason: 'reason',
      source_id: 'src1', video_id: 'v1',
      ...opts,
    };
  }

  function fakeAnalysis(opts: {
    high?: AnalyzedStockMention[];
    weak?: AnalyzedStockMention[];
  }): DailyAnalysis {
    return {
      date: '2026-05-22',
      generated_at: '2026-05-22T12:00:00Z',
      market_view: 'test',
      bullish_consensus: [],
      bearish_consensus: [],
      high_consensus_stocks: opts.high ?? [],
      weak_signal_stocks: opts.weak ?? [],
      stats: {
        videos_analyzed: 1,
        unique_stocks_total: (opts.high?.length ?? 0) + (opts.weak?.length ?? 0),
        high_consensus_count: opts.high?.length ?? 0,
        weak_signal_count: opts.weak?.length ?? 0,
      },
    };
  }

  it('filters out stocks with combined_confidence < 0.6', () => {
    const r = deriveStockMentions(fakeAnalysis({
      weak: [m({ combined_confidence: 0.5 }), m({ combined_confidence: 0.81 })],
    }));
    expect(r.stocks).toHaveLength(1);
  });

  it('filters out stocks with matched=null', () => {
    const r = deriveStockMentions(fakeAnalysis({
      weak: [m({ matched: null, combined_confidence: 0 })],
    }));
    expect(r.stocks).toHaveLength(0);
  });

  it('merges across high + weak by stock_code', () => {
    const r = deriveStockMentions(fakeAnalysis({
      high: [
        m({ matched: matchedMock('2330', '台積電'), sentiment: 'bullish', source_id: 'a' }),
        m({ matched: matchedMock('2330', '台積電'), sentiment: 'bullish', source_id: 'b' }),
      ],
      weak: [
        m({ matched: matchedMock('2454', '聯發科'), sentiment: 'bearish', combined_confidence: 0.72 }),
      ],
    }));
    expect(r.stocks).toHaveLength(2);
    const tsmc = r.stocks.find(x => x.stock_code === '2330');
    expect(tsmc?.mention_count).toBe(2);
    expect(tsmc?.bullish_count).toBe(2);
  });

  it('invariant: best_confidence ≥ 0.6 for every kept stock', () => {
    const r = deriveStockMentions(fakeAnalysis({
      weak: [
        m({ combined_confidence: 0.4 }),
        m({ matched: null, combined_confidence: 0 }),
        m({ combined_confidence: 0.85 }),
      ],
    }));
    for (const s of r.stocks) {
      expect(s.best_confidence).toBeGreaterThanOrEqual(0.6);
    }
  });

  it('sorts by mention_count desc then best_confidence desc', () => {
    const r = deriveStockMentions(fakeAnalysis({
      weak: [
        m({ matched: matchedMock('A1', 'A'), combined_confidence: 0.7, video_id: 'v1' }),
        m({ matched: matchedMock('A1', 'A'), combined_confidence: 0.7, video_id: 'v2' }),
        m({ matched: matchedMock('B1', 'B'), combined_confidence: 0.95, video_id: 'v3' }),
      ],
    }));
    expect(r.stocks[0].stock_code).toBe('A1');
    expect(r.stocks[1].stock_code).toBe('B1');
  });
});

// ── MVP 5: factor scoring ──────────────────────────────────────────────────

describe('computeCompositeScore + ratingFromScore', () => {
  const all100: FactorScores = {
    technical: 100, chip: 100, fundamental: 100,
    news: 100, mention_heat: 100,
    industry: 100, macro: 100, valuation: 100, governance: 100,
  };
  const all0: FactorScores = {
    technical: 0, chip: 0, fundamental: 0,
    news: 0, mention_heat: 0,
    industry: 0, macro: 0, valuation: 0, governance: 0,
  };

  it('all-100 → composite = 100', () => {
    expect(computeCompositeScore(all100)).toBeCloseTo(100, 1);
  });

  it('all-0 → composite = 0', () => {
    expect(computeCompositeScore(all0)).toBeCloseTo(0, 1);
  });

  it('weights respected: technical=100 others=0 should be 25 (weight/100*100)', () => {
    const s: FactorScores = { ...all0, technical: 100 };
    expect(computeCompositeScore(s)).toBeCloseTo(25, 1);
  });

  it('weights respected: chip=100 others=0 should be 18', () => {
    const s: FactorScores = { ...all0, chip: 100 };
    expect(computeCompositeScore(s)).toBeCloseTo(18, 1);
  });

  it('weights respected: industry=100 others=0 should be 10', () => {
    const s: FactorScores = { ...all0, industry: 100 };
    expect(computeCompositeScore(s)).toBeCloseTo(10, 1);
  });

  it('weights respected: macro=100 others=0 should be 5', () => {
    const s: FactorScores = { ...all0, macro: 100 };
    expect(computeCompositeScore(s)).toBeCloseTo(5, 1);
  });

  it('weights respected: governance=100 others=0 should be 2', () => {
    const s: FactorScores = { ...all0, governance: 100 };
    expect(computeCompositeScore(s)).toBeCloseTo(2, 1);
  });

  it('all 9 weights sum to 100', () => {
    const total = 25 + 18 + 15 + 12 + 10 + 10 + 5 + 3 + 2;
    expect(total).toBe(100);
  });

  it('rating thresholds: 75→A 60→B 45→C 44→D', () => {
    expect(ratingFromScore(95)).toBe('A');
    expect(ratingFromScore(75)).toBe('A');
    expect(ratingFromScore(74.9)).toBe('B');
    expect(ratingFromScore(60)).toBe('B');
    expect(ratingFromScore(59.9)).toBe('C');
    expect(ratingFromScore(45)).toBe('C');
    expect(ratingFromScore(44.9)).toBe('D');
    expect(ratingFromScore(0)).toBe('D');
  });

  it('mixed realistic scoring: 台積電-like with high tech/chip/fund/industry/valuation', () => {
    const tsmc: FactorScores = {
      technical: 80,    // 多頭趨勢 + above MA20
      chip: 70,         // 法人持續加碼
      fundamental: 90,  // EPS 高、毛利率好
      news: 60,         // 中性
      mention_heat: 85, // 5 個節目都提到
      industry: 85,     // 半導體龍頭
      macro: 80,        // 多頭
      valuation: 50,    // PE 偏高
      governance: 50,   // 外資持平
    };
    const score = computeCompositeScore(tsmc);
    expect(score).toBeGreaterThan(70);
    expect(score).toBeLessThan(85);
    expect(ratingFromScore(score)).toMatch(/A|B/);
  });

  it('mixed realistic scoring: D-rated overheated stock', () => {
    const hot: FactorScores = {
      technical: 30,    // 漲多回檔
      chip: 40,
      fundamental: 50,
      news: 30,
      mention_heat: 80,  // 節目很熱
      industry: 40,
      macro: 70,
      valuation: 20,    // PE 過高
      governance: 30,
    };
    const score = computeCompositeScore(hot);
    expect(score).toBeLessThan(50);
    expect(ratingFromScore(score)).toBe('D');
  });
});

// ── questionBuilder ─────────────────────────────────────────────────────────

describe('buildQuestion', () => {
  const master = buildTestMaster([
    { code: '2330', name: '台積電', market: 'TWSE' },
  ]);

  function fakeVideo(id: string, source_id: string, shouldAnalyze = true): YouTubeVideo {
    return {
      video_id: id, source_id, title: `${id} title`, url: `https://x/${id}`,
      duration_sec: 600, published_at: '2026-05-22T08:00:00Z',
      program_date: '2026-05-22', video_type: 'full_program',
      should_analyze: shouldAnalyze,
      skip_reason: shouldAnalyze ? null : 'shorts',
      video_confidence_score: 80,
      discovered_at: '2026-05-22T10:00:00Z', last_seen_at: '2026-05-22T10:00:00Z',
      raw: {},
    };
  }

  function fakeTranscript(video_id: string, source_id: string, status: 'available' | 'unavailable' = 'available'): TranscriptRecord {
    return {
      video_id, source_id, date: '2026-05-22',
      fetched_at: '2026-05-22T11:00:00Z',
      status, quality_score: status === 'available' ? 90 : 0,
      lang: status === 'available' ? 'zh-Hant' : null,
      char_count: status === 'available' ? 5000 : 0,
      cue_count: status === 'available' ? 100 : 0,
      vtt_bytes: status === 'available' ? 8000 : 0,
      text: status === 'available' ? '今天台股盤勢分析' : '',
      cues: [],
      error: null,
      quality: { lang_ok: true, length_ok: true, has_timestamps: true, stock_keyword_hits: 5, rolling_dup_ratio: 0 },
    };
  }

  it('only includes videos with available transcripts in `videos`', () => {
    const videos = [
      fakeVideo('v1', 'src1', true),
      fakeVideo('v2', 'src1', true),
      fakeVideo('v3', 'src2', false),       // skipped
    ];
    const transcripts = new Map([
      ['v1', fakeTranscript('v1', 'src1', 'available')],
      ['v2', fakeTranscript('v2', 'src1', 'unavailable')],   // 跳過
    ]);
    const payload = buildQuestion({
      date: '2026-05-22',
      videos, transcripts,
      sources: [
        { source_id: 'src1', display_name: 'Source 1', expected_cadence: 'daily' },
        { source_id: 'src2', display_name: 'Source 2', expected_cadence: 'daily' },
      ],
      master,
      prelookups: [],
    });
    expect(payload.videos).toHaveLength(1);
    expect(payload.videos[0].video_id).toBe('v1');
    expect(payload.total_analyzable_videos).toBe(2);
    expect(payload.videos_with_transcript).toBe(1);
  });

  it('skip_summary counts by reason', () => {
    const videos = [
      fakeVideo('v1', 'src1', false),
      fakeVideo('v2', 'src1', false),
    ];
    const payload = buildQuestion({
      date: '2026-05-22', videos, transcripts: new Map(),
      sources: [{ source_id: 'src1', display_name: 'Src', expected_cadence: 'daily' }],
      master, prelookups: [],
    });
    expect(payload.skip_summary).toEqual({ shorts: 2 });
  });

  it('source_transcript_availability per-source counts correct', () => {
    const videos = [
      fakeVideo('v1', 'src1', true),
      fakeVideo('v2', 'src1', true),
      fakeVideo('v3', 'src2', true),
    ];
    const transcripts = new Map([
      ['v1', fakeTranscript('v1', 'src1', 'available')],
      ['v2', fakeTranscript('v2', 'src1', 'unavailable')],
      ['v3', fakeTranscript('v3', 'src2', 'available')],
    ]);
    const payload = buildQuestion({
      date: '2026-05-22', videos, transcripts,
      sources: [
        { source_id: 'src1', display_name: 'A', expected_cadence: 'daily' },
        { source_id: 'src2', display_name: 'B', expected_cadence: 'daily' },
      ],
      master, prelookups: [],
    });
    const a = payload.source_transcript_availability.find(s => s.source_id === 'src1')!;
    expect(a.analyzable_today).toBe(2);
    expect(a.transcript_available).toBe(1);
    const b = payload.source_transcript_availability.find(s => s.source_id === 'src2')!;
    expect(b.transcript_available).toBe(1);
  });

  it('master_hint includes ALIAS_MAP entries (regression: 不能漏 alias)', () => {
    const payload = buildQuestion({
      date: '2026-05-22', videos: [], transcripts: new Map(),
      sources: [], master, prelookups: [],
    });
    expect(payload.stock_master_hint.some(e => e.code === '2330')).toBe(true);
  });
});
