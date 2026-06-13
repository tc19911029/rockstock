/**
 * Contract test: 老師推薦事件抽取 + 基準價結算（recoEvents / recoBaseline）
 *
 * 守門員：
 *   - sentiment fallback 映射固定（舊 23 天 analysis 的口徑不可漂移）
 *   - 同 (date, teacher, stock) 跨影片合併為一筆、保留最強型態
 *   - 多空衝突 → conflict=true
 *   - 信心 < 0.6 / matched=null 過濾（與 deriveStockMentions 同門檻）
 *   - 頻道名 fallback → program_fallback、不進老師統計
 *   - 基準價：次開 / 一字鎖死 no_fill / 停牌跳根 / >25% 污染 no_data / 未封存 pending
 *   - 重抽保留已結算 baseline（idempotent）
 */

import type { AnalyzedStockMention, DailyAnalysis, StockSentiment } from '@/lib/youtube/analysisStorage';
import {
  extractRecoEvents, mergePreservingBaselines, resolveRecommendationType,
  SENTIMENT_TO_TYPE, TYPE_COHORT,
} from '@/lib/youtube/recoEvents';
import { settleBaseline, type BaselineCandle } from '@/lib/youtube/recoBaseline';
import { computeEventReturns } from '@/lib/youtube/recoPerformance';
import type { RecoEvent } from '@/lib/youtube/recoTypes';

const NOW = '2026-06-12T15:30:00+08:00';

function mention(over: Partial<AnalyzedStockMention> & { code?: string; name?: string }): AnalyzedStockMention {
  const code = over.code ?? '2330';
  const name = over.name ?? '台積電';
  return {
    raw_query: name,
    matched: { code, name, market: 'TWSE', confidence: 1.0, match_via: 'exact_code' },
    llm_confidence: 0.9,
    combined_confidence: 0.9,
    sentiment: 'bullish',
    context: '看好',
    reason: '理由',
    source_id: 'src-a',
    video_id: 'vid-1',
    analysts: ['蔡萬得'],
    ...over,
  };
}

function analysis(mentions: AnalyzedStockMention[], date = '2026-06-10'): DailyAnalysis {
  return {
    date,
    generated_at: '2026-06-10T23:55:00+08:00',
    market_view: '',
    bullish_consensus: [],
    bearish_consensus: [],
    high_consensus_stocks: mentions,
    weak_signal_stocks: [],
    stats: { videos_analyzed: 1, unique_stocks_total: mentions.length, high_consensus_count: mentions.length, weak_signal_count: 0 },
  };
}

// ── 抽取 ─────────────────────────────────────────────────────────────────────

describe('extractRecoEvents', () => {
  it('sentiment fallback 映射固定', () => {
    const cases: Array<[StockSentiment, string]> = [
      ['bullish', '看多'], ['watchlist', '觀察'], ['risk_warning', '小心追高'],
      ['bearish', '偏空'], ['mentioned_only', '只介紹'], ['neutral', '只介紹'],
    ];
    for (const [sentiment, expected] of cases) {
      expect(SENTIMENT_TO_TYPE[sentiment]).toBe(expected);
    }
    // cohort 口徑
    expect(TYPE_COHORT['明確買進']).toBe('scored');
    expect(TYPE_COHORT['看多']).toBe('scored');
    expect(TYPE_COHORT['觀察']).toBe('watch');
    expect(TYPE_COHORT['等回檔']).toBe('watch');
    expect(TYPE_COHORT['偏空']).toBe('bearish');
    expect(TYPE_COHORT['小心追高']).toBe('excluded');
    expect(TYPE_COHORT['只介紹']).toBe('excluded');
  });

  it('原生 recommendation_type 優先於 sentiment fallback', () => {
    const native = resolveRecommendationType({ sentiment: 'bullish', recommendation_type: '明確買進' });
    expect(native).toEqual({ type: '明確買進', source: 'native' });
    const fallback = resolveRecommendationType({ sentiment: 'bullish' });
    expect(fallback).toEqual({ type: '看多', source: 'sentiment_fallback' });
    // 非法字串 → fallback
    const bad = resolveRecommendationType({ sentiment: 'watchlist', recommendation_type: 'BUY' });
    expect(bad).toEqual({ type: '觀察', source: 'sentiment_fallback' });
  });

  it('同老師同股同日跨影片 → 合併為一筆、保留最強型態', () => {
    const r = extractRecoEvents(analysis([
      mention({ video_id: 'vid-1', sentiment: 'watchlist' }),
      mention({ video_id: 'vid-2', sentiment: 'bullish' }),
    ]));
    expect(r.events).toHaveLength(1);
    expect(r.events[0].videos).toHaveLength(2);
    expect(r.events[0].recommendation_type).toBe('看多');  // 看多 > 觀察
    expect(r.events[0].cohort).toBe('scored');
    expect(r.events[0].conflict).toBeUndefined();
  });

  it('多位老師 → 每位各一事件', () => {
    const r = extractRecoEvents(analysis([
      mention({ analysts: ['李兆華', '朱家泓'] }),
    ]));
    expect(r.events.map(e => e.teacher).sort()).toEqual(['朱家泓', '李兆華'].sort());
    expect(r.events.every(e => e.teacher_kind === 'person')).toBe(true);
  });

  it('同日同人多空衝突 → conflict=true', () => {
    const r = extractRecoEvents(analysis([
      mention({ video_id: 'vid-1', sentiment: 'bullish', combined_confidence: 0.7 }),
      mention({ video_id: 'vid-2', sentiment: 'bearish', combined_confidence: 0.9 }),
    ]));
    expect(r.events).toHaveLength(1);
    expect(r.events[0].conflict).toBe(true);
    // 衝突時取 confidence 較高那筆的型態
    expect(r.events[0].recommendation_type).toBe('偏空');
  });

  it('信心 < 0.6 / matched=null 過濾並計數', () => {
    const r = extractRecoEvents(analysis([
      mention({ combined_confidence: 0.5 }),
      mention({ matched: null, code: '0000' }),
      mention({ code: '2454', name: '聯發科' }),
    ]));
    expect(r.events).toHaveLength(1);
    expect(r.events[0].stock_code).toBe('2454');
    expect(r.skipped.low_confidence).toBe(1);
    expect(r.skipped.unmatched).toBe(1);
  });

  it('頻道名 fallback（清洗後無人名）→ program_fallback', () => {
    const display = new Map([['src-a', '錢線百分百']]);
    const r = extractRecoEvents(
      analysis([mention({ analysts: ['錢線百分百'] })]),
      { displayNameBySource: display },
    );
    expect(r.events).toHaveLength(1);
    expect(r.events[0].teacher_kind).toBe('program_fallback');
    expect(r.events[0].teacher).toBe('節目:src-a');
  });

  it('括號節目名清洗：「智霖(錢線百分百)」→ 智霖', () => {
    const display = new Map([['src-a', '錢線百分百']]);
    const r = extractRecoEvents(
      analysis([mention({ analysts: ['智霖(錢線百分百)'] })]),
      { displayNameBySource: display },
    );
    expect(r.events[0].teacher).toBe('智霖');
    expect(r.events[0].teacher_kind).toBe('person');
  });

  it('TPEx → .TWO 後綴', () => {
    const r = extractRecoEvents(analysis([
      mention({ matched: { code: '8069', name: '元太', market: 'TPEx', confidence: 1.0, match_via: 'exact_code' }, code: '8069' }),
    ]));
    expect(r.events[0].symbol).toBe('8069.TWO');
    expect(r.events[0].market).toBe('TPEx');
  });

  it('is_placeholder → 零事件 + skipped.placeholder', () => {
    const a = { ...analysis([mention({})]), is_placeholder: true };
    const r = extractRecoEvents(a);
    expect(r.events).toHaveLength(0);
    expect(r.skipped.placeholder).toBe(true);
  });
});

// ── 基準價結算 ───────────────────────────────────────────────────────────────

function bar(date: string, o: number, h: number, l: number, c: number, v = 1000): BaselineCandle {
  return { date, open: o, high: h, low: l, close: c, volume: v };
}

describe('settleBaseline', () => {
  it('正常：次一交易日開盤、跨週末', () => {
    // 06-10(三) 提及 → 06-11 進場；06-12(五) 提及 → 06-15(一) 進場
    const candles = [
      bar('2026-06-10', 100, 102, 99, 101),
      bar('2026-06-11', 103, 105, 102, 104),
      bar('2026-06-12', 104, 106, 103, 105),
      bar('2026-06-15', 106, 108, 105, 107),
    ];
    const wed = settleBaseline('2026-06-10', candles, NOW);
    expect(wed).toMatchObject({ status: 'filled', base_date: '2026-06-11', entry_open: 103, mention_close: 101 });
    const fri = settleBaseline('2026-06-12', candles, NOW);
    expect(fri).toMatchObject({ status: 'filled', base_date: '2026-06-15', entry_open: 106, mention_close: 105 });
  });

  it('一字鎖死 → no_fill', () => {
    const candles = [
      bar('2026-06-10', 100, 102, 99, 101),
      bar('2026-06-11', 111.5, 111.5, 111.4, 111.5),  // open===high、振幅 <0.5%
    ];
    const r = settleBaseline('2026-06-10', candles, NOW);
    expect(r.status).toBe('no_fill');
    expect(r.entry_open).toBeNull();
  });

  it('零量扁平根（停牌假根）→ 跳到下一根', () => {
    const candles = [
      bar('2026-06-10', 100, 102, 99, 101),
      bar('2026-06-11', 101, 101, 101, 101, 0),   // 停牌
      bar('2026-06-12', 102, 104, 101, 103),
    ];
    const r = settleBaseline('2026-06-10', candles, NOW);
    expect(r).toMatchObject({ status: 'filled', base_date: '2026-06-12', entry_open: 102 });
  });

  it('隔夜跳 >25%（壞 bar 污染）→ no_data', () => {
    const candles = [
      bar('2026-06-10', 100, 102, 99, 101),
      bar('2026-06-11', 140, 145, 138, 142),
    ];
    expect(settleBaseline('2026-06-10', candles, NOW).status).toBe('no_data');
  });

  it('隔日 K 未封存 → pending', () => {
    const candles = [bar('2026-06-10', 100, 102, 99, 101)];
    const r = settleBaseline('2026-06-10', candles, NOW);
    expect(r.status).toBe('pending');
    expect(r.settled_at).toBeNull();
  });

  it('5 個交易日內全停牌且資料已長過視窗 → no_data', () => {
    const candles = [
      bar('2026-06-10', 100, 102, 99, 101),
      ...['11', '12', '15', '16', '17'].map(d => bar(`2026-06-${d}`, 101, 101, 101, 101, 0)),
    ];
    expect(settleBaseline('2026-06-10', candles, NOW).status).toBe('no_data');
  });

  it('無 K 線 → no_data', () => {
    expect(settleBaseline('2026-06-10', null, NOW).status).toBe('no_data');
    expect(settleBaseline('2026-06-10', [], NOW).status).toBe('no_data');
  });
});

// ── 重抽 idempotent ──────────────────────────────────────────────────────────

describe('mergePreservingBaselines', () => {
  it('同 id 已結算 → 沿用舊 baseline/symbol；新事件照常', () => {
    const settled: RecoEvent = {
      ...extractRecoEvents(analysis([mention({})])).events[0],
      symbol: '2330.TWO',  // 假設舊檔曾 fallback 過後綴
      baseline: { status: 'filled', base_date: '2026-06-11', entry_open: 103, mention_close: 101, settled_at: NOW },
    };
    const fresh = extractRecoEvents(analysis([
      mention({}),
      mention({ code: '2454', name: '聯發科' }),
    ])).events;
    const merged = mergePreservingBaselines(fresh, [settled]);
    const tsmc = merged.find(e => e.stock_code === '2330')!;
    expect(tsmc.baseline.status).toBe('filled');
    expect(tsmc.baseline.entry_open).toBe(103);
    expect(tsmc.symbol).toBe('2330.TWO');
    const mtk = merged.find(e => e.stock_code === '2454')!;
    expect(mtk.baseline.status).toBe('pending');
  });
});

// ── 報酬計算 ─────────────────────────────────────────────────────────────────

describe('computeEventReturns', () => {
  function filledEvent(): RecoEvent {
    const ev = extractRecoEvents(analysis([mention({})])).events[0];
    ev.baseline = { status: 'filled', base_date: '2026-06-11', entry_open: 100, mention_close: 99, settled_at: NOW };
    return ev;
  }

  it('d1 = 進場日自身收盤 vs entry_open；d3 = 第 3 個交易日收盤', () => {
    const candles = [
      bar('2026-06-10', 99, 100, 98, 99),
      bar('2026-06-11', 100, 103, 99, 102),   // i0：d1 = +2%
      bar('2026-06-12', 102, 105, 101, 104),
      bar('2026-06-15', 104, 107, 103, 106),  // d3 = +6%
    ];
    const r = computeEventReturns(filledEvent(), candles, null)!;
    expect(r.d1).toBe(2);
    expect(r.d3).toBe(6);
    expect(r.d5).toBeNull();        // K 線不足
    expect(r.isOpen).toBe(true);    // d60 未走完
    expect(r.lastTrackedDate).toBe('2026-06-15');
  });

  it('MFE/MAE 用 60 根內 high/low', () => {
    const candles = [
      bar('2026-06-10', 99, 100, 98, 99),
      bar('2026-06-11', 100, 110, 95, 102),   // high +10%、low −5%
      bar('2026-06-12', 102, 105, 101, 104),
    ];
    const r = computeEventReturns(filledEvent(), candles, null)!;
    expect(r.mfe).toBe(10);
    expect(r.mae).toBe(-5);
  });

  it('超額 = 個股 dN − 指數同期（日曆日對齊，個股停牌缺根不錯位）', () => {
    const stock = [
      bar('2026-06-11', 100, 103, 99, 102),   // d1 = +2%
      // 06-12 停牌缺根
      bar('2026-06-15', 102, 107, 101, 106),  // d3 槽位的第 2 根 → null
    ];
    const index = [
      bar('2026-06-11', 1000, 1015, 995, 1010),  // 指數 06-11 = +1%
      bar('2026-06-12', 1010, 1020, 1005, 1015),
      bar('2026-06-15', 1015, 1030, 1010, 1020),  // 至 06-15 = +2%
    ];
    const r = computeEventReturns(filledEvent(), stock, index)!;
    expect(r.excess.d1).toBe(1);   // +2% − +1%
    // 個股第 3 根不存在 → d3 null、excess.d3 null
    expect(r.d3).toBeNull();
    expect(r.excess.d3).toBeNull();
  });

  it('baseline 非 filled → null', () => {
    const ev = extractRecoEvents(analysis([mention({})])).events[0];  // pending
    expect(computeEventReturns(ev, [bar('2026-06-11', 100, 103, 99, 102)], null)).toBeNull();
  });

  it('visibleUntil 防前視偏誤：只算到 as-of 當天、之後橫斷 null、holdReturn 對齊', () => {
    const candles = [
      bar('2026-06-11', 100, 103, 99, 102),   // i0：d1 = +2%
      bar('2026-06-12', 102, 105, 101, 104),
      bar('2026-06-15', 104, 107, 103, 106),  // d3 槽位 = +6%
    ];
    // 站在 06-12（as-of）：只看得到 06-11、06-12，06-15 是「未來」
    const asof = computeEventReturns(filledEvent(), candles, null, { visibleUntil: '2026-06-12' })!;
    expect(asof.d1).toBe(2);
    expect(asof.d3).toBeNull();             // 偷看未來被擋下
    expect(asof.holdReturn).toBe(4);        // 最後可見收盤 104 vs entry 100
    expect(asof.lastTrackedDate).toBe('2026-06-12');
    expect(asof.isOpen).toBe(true);
    // 不傳 visibleUntil → 看全部歷史（行為不變）
    const full = computeEventReturns(filledEvent(), candles, null)!;
    expect(full.d3).toBe(6);
    expect(full.holdReturn).toBe(6);
  });
});
