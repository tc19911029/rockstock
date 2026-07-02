/**
 * Contract test：YouTube source 的「高共識 boost」流經正確
 *
 * 守的規則（Stage 4 加入）：
 *   - high_consensus_stocks 內的股票 → attribution.inHighConsensus = true
 *   - weak_signal_stocks 內的股票 → attribution.inHighConsensus = false
 *   - reasons 文字會明確區分「高共識」vs「弱信號」
 *   - mentionCount / shows / combinedConfidence / sentiment 從 mentions 正確聚合
 *
 * §0 隔離：共識是 YouTube source 的 boost，不是新 source — 此 test 確認
 * 不會新增 5th source 也不會污染其他 source attribution。
 */

import { youtubeSource } from '@/lib/agents/candidates/sources/youtubeSource';
import type {
  AnalyzedStockMention,
  DailyAnalysis,
  StockSentiment,
} from '@/lib/youtube/analysisStorage';
import type { YouTubeSourceAttribution } from '@/lib/agents/candidates/types';

// ── 切斷真實網路：mock TaiwanScanner.getStockList ────────────────────────────
// youtubeSource.extract 會 `new TaiwanScanner().getStockList()` 分類上市/上櫃，
// 該方法走 curl fallback 打真實 TPEx（不經 global.fetch，mock 攔不到），
// 全套件並行跑時外連 >5s 會讓本檔間歇性 timeout。固定回傳測試用清單、零網路。
// （此清單把 2330/2454/3661 都歸 TWSE → 全部 .TW，與下方斷言一致。）
jest.mock('@/lib/scanner/TaiwanScanner', () => ({
  TaiwanScanner: jest.fn().mockImplementation(() => ({
    getStockList: jest.fn(async () => [
      { symbol: '2330.TW', name: '台積電' },
      { symbol: '2454.TW', name: '聯發科' },
      { symbol: '3661.TW', name: '世芯-KY' },
    ]),
  })),
}));

// ── 測試用 fake analysis ─────────────────────────────────────────────────────

function makeMention(opts: {
  code: string;
  name: string;
  source_id: string;
  sentiment: StockSentiment;
  combined_confidence: number;
}): AnalyzedStockMention {
  return {
    raw_query: opts.code,
    matched: { code: opts.code, name: opts.name, market: 'TWSE', confidence: 1.0, match_via: 'exact_code' },
    llm_confidence: opts.combined_confidence,
    combined_confidence: opts.combined_confidence,
    sentiment: opts.sentiment,
    context: '',
    reason: `${opts.source_id} 提到`,
    video_id: 'vid-' + opts.source_id,
    source_id: opts.source_id,
  };
}

function makeAnalysis(): DailyAnalysis {
  return {
    date: '2026-05-24',
    generated_at: new Date('2026-05-24T20:00:00Z').toISOString(),
    market_view: 'test',
    bullish_consensus: [],
    bearish_consensus: [],
    high_consensus_stocks: [
      makeMention({ code: '2330', name: '台積電', source_id: 'ustvmoney100', sentiment: 'bullish', combined_confidence: 0.85 }),
      makeMention({ code: '2330', name: '台積電', source_id: 'lasimoney',    sentiment: 'bullish', combined_confidence: 0.90 }),
      makeMention({ code: '2454', name: '聯發科', source_id: 'ustvmoney100', sentiment: 'bullish', combined_confidence: 0.80 }),
      makeMention({ code: '2454', name: '聯發科', source_id: 'zhaohuachine', sentiment: 'bullish', combined_confidence: 0.75 }),
    ],
    weak_signal_stocks: [
      makeMention({ code: '3661', name: '世芯-KY', source_id: 'jinronggug',  sentiment: 'watchlist', combined_confidence: 0.70 }),
    ],
    stats: { videos_analyzed: 6, unique_stocks_total: 3, high_consensus_count: 2, weak_signal_count: 1 },
  };
}

// ── Mock global fetch（youtubeSource 透過 fetchJSON 拉 /api/youtube/analysis）─

const originalFetch = global.fetch;

function mockFetchOnce(payload: unknown): void {
  global.fetch = jest.fn(async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

afterEach(() => {
  global.fetch = originalFetch;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('youtubeSource — inHighConsensus boost', () => {
  test('high_consensus_stocks 內的股票 → inHighConsensus = true', async () => {
    mockFetchOnce({ analysis: makeAnalysis() });
    const result = await youtubeSource.extract({ market: 'TW', date: '2026-05-24' });

    expect(result.ran).toBe(true);
    expect(result.candidates).toHaveLength(3); // 2330, 2454, 3661

    const tsmc = result.candidates.find(c => c.symbol === '2330.TW');
    expect(tsmc).toBeDefined();
    const attr = tsmc!.attribution as YouTubeSourceAttribution;
    expect(attr.inHighConsensus).toBe(true);
    expect(attr.mentionCount).toBe(2);
    expect(attr.shows).toEqual(expect.arrayContaining(['ustvmoney100', 'lasimoney']));
    expect(attr.sentiment).toBe('bullish');
    expect(attr.combinedConfidence).toBeCloseTo((0.85 + 0.90) / 2, 2);
  });

  test('weak_signal_stocks 內的股票 → inHighConsensus = false', async () => {
    mockFetchOnce({ analysis: makeAnalysis() });
    const result = await youtubeSource.extract({ market: 'TW', date: '2026-05-24' });

    const weak = result.candidates.find(c => c.symbol === '3661.TW');
    expect(weak).toBeDefined();
    const attr = weak!.attribution as YouTubeSourceAttribution;
    expect(attr.inHighConsensus).toBe(false);
    expect(attr.mentionCount).toBe(1);
  });

  test('reasons 文字明確區分「高共識」vs「弱信號」', async () => {
    mockFetchOnce({ analysis: makeAnalysis() });
    const result = await youtubeSource.extract({ market: 'TW', date: '2026-05-24' });

    const tsmc = result.candidates.find(c => c.symbol === '2330.TW');
    const weak = result.candidates.find(c => c.symbol === '3661.TW');

    const tsmcReasons = (tsmc!.attribution as YouTubeSourceAttribution).reasons.join(' ');
    const weakReasons = (weak!.attribution as YouTubeSourceAttribution).reasons.join(' ');

    expect(tsmcReasons).toContain('高共識');
    expect(weakReasons).toContain('弱信號');
  });

  test('CN market 直接回空（YouTube analysis 只覆蓋 TW）', async () => {
    // 不該 fetch — 提前 return
    global.fetch = jest.fn() as unknown as typeof fetch;
    const result = await youtubeSource.extract({ market: 'CN', date: '2026-05-24' });

    expect(result.ran).toBe(true);
    expect(result.candidates).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('analysis 不存在 → ran=true，candidates=[]', async () => {
    mockFetchOnce({ analysis: null });
    const result = await youtubeSource.extract({ market: 'TW', date: '2026-05-24' });

    expect(result.ran).toBe(true);
    expect(result.candidates).toEqual([]);
  });

  test('source 仍是 "youtube"（不可變成 "consensus" 或新 source）', async () => {
    mockFetchOnce({ analysis: makeAnalysis() });
    const result = await youtubeSource.extract({ market: 'TW', date: '2026-05-24' });

    // §0 隔離：consensus 絕不能變成第 5 個 source
    expect(result.source).toBe('youtube');
  });
});
