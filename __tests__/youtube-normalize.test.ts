/**
 * normalizeAnalysis — 確定性代號校正 + grounding 報告（2026-05-30）
 *
 * 鎖住根治：模型寫錯代號，程式會用全量 master 自動校正（光頡 3611→3624 案例）。
 */

import { describe, it, expect } from '@jest/globals';
import { normalizeAnalysis } from '@/lib/youtube/normalizeAnalysis';
import { buildTestMaster } from '@/lib/youtube/stockMaster';
import type { DailyAnalysis, AnalyzedStockMention } from '@/lib/youtube/analysisStorage';

const master = buildTestMaster([
  { code: '3624', name: '光頡', market: 'TWSE' },
  { code: '3611', name: '鼎翰', market: 'TWSE' },
  { code: '2375', name: '凱美', market: 'TWSE' },
]);

function mention(over: Partial<AnalyzedStockMention>): AnalyzedStockMention {
  return {
    raw_query: '', matched: null, llm_confidence: 0.8, combined_confidence: 0,
    sentiment: 'bullish', context: '', reason: '', source_id: 's', video_id: 'v1',
    analysts: [], ...over,
  };
}

function analysis(over: Partial<DailyAnalysis>): DailyAnalysis {
  return {
    date: '2026-05-29', generated_at: '2026-05-29T18:00:00.000Z',
    market_view: '', bullish_consensus: [], bearish_consensus: [],
    high_consensus_stocks: [], weak_signal_stocks: [],
    stats: { videos_analyzed: 0, unique_stocks_total: 0, high_consensus_count: 0, weak_signal_count: 0 } as DailyAnalysis['stats'],
    ...over,
  };
}

describe('normalizeAnalysis — 代號重查（確定性自動修）', () => {
  it('模型寫錯代號（光頡→3611）→ 用全量 master 校正成 3624 + 重算 combined', () => {
    const a = analysis({
      weak_signal_stocks: [mention({
        raw_query: '光頡',
        matched: { code: '3611', name: '鼎翰', market: 'TWSE', confidence: 0.9, match_via: 'alias' },
        llm_confidence: 0.8, combined_confidence: 0.72,
      })],
    });
    const { analysis: out, report } = normalizeAnalysis(a, master, {});
    const m = out.weak_signal_stocks[0];
    expect(m.matched?.code).toBe('3624');
    expect(m.matched?.name).toBe('光頡');
    expect(m.matched?.match_via).toBe('exact_name'); // 0.95
    expect(m.combined_confidence).toBeCloseTo(0.8 * 0.95, 5);
    expect(report.codeFixes).toHaveLength(1);
    expect(report.codeFixes[0]).toMatchObject({ oldCode: '3611', newCode: '3624' });
  });

  it('正確代號不動、不誤報 codeFix', () => {
    const a = analysis({
      high_consensus_stocks: [mention({
        raw_query: '凱美',
        matched: { code: '2375', name: '凱美', market: 'TWSE', confidence: 0.95, match_via: 'exact_name' },
      })],
    });
    const { report } = normalizeAnalysis(a, master, {});
    expect(report.codeFixes).toHaveLength(0);
  });

  it('master 查不到 → matched 設 null、combined 歸零', () => {
    const a = analysis({
      weak_signal_stocks: [mention({
        raw_query: '不存在的鬼股',
        matched: { code: '9999', name: '鬼股', market: 'TWSE', confidence: 0.9, match_via: 'alias' },
      })],
    });
    const { analysis: out, report } = normalizeAnalysis(a, master, {});
    expect(out.weak_signal_stocks[0].matched).toBeNull();
    expect(out.weak_signal_stocks[0].combined_confidence).toBe(0);
    expect(report.codeFixes[0].newCode).toBeNull();
  });

  it('stock_scoring 的 stock_code 也用 stock_name 校正', () => {
    const a = analysis({
      stock_scoring: [{
        stock_code: '3611', stock_name: '光頡',
        factor_scores: {} as never, composite_score: 60, rating: 'B',
        action: '', risk_flags: [], reasoning: '',
      }],
    });
    const { analysis: out } = normalizeAnalysis(a, master, {});
    expect(out.stock_scoring![0].stock_code).toBe('3624');
  });

  it('video_summaries.key_stocks 空白／錯誤代號會依名稱校正，查無者移除', () => {
    const a = analysis({
      video_summaries: [{
        video_id: 'v1', source_id: 's1', source_name: '測試節目', title: '今日盤勢',
        summary: '這是一段長度足夠的測試節目摘要，用來驗證股票代號校正。',
        watch_priority: 'must_watch', watch_reason: '有具體個股分析',
        key_stocks: [
          { code: '', name: '光頡' },
          { code: '9999', name: '凱美' },
          { code: '', name: '查無此股' },
        ],
      }],
    });

    const { analysis: out, report } = normalizeAnalysis(a, master, {});
    expect(out.video_summaries![0].key_stocks).toEqual([
      { code: '3624', name: '光頡' },
      { code: '2375', name: '凱美' },
    ]);
    expect(report.codeFixes).toEqual(expect.arrayContaining([
      expect.objectContaining({ oldCode: null, newCode: '3624' }),
      expect.objectContaining({ oldCode: '9999', newCode: '2375' }),
      expect.objectContaining({ oldCode: null, newCode: null, via: 'unresolved' }),
    ]));
  });

  it('video_summaries.key_stocks 校正具冪等性，重跑不會再產生修正', () => {
    const a = analysis({
      video_summaries: [{
        video_id: 'v1', source_id: 's1', source_name: '測試節目', title: '今日盤勢',
        summary: '這是一段長度足夠的測試節目摘要，用來驗證重跑結果一致。',
        watch_priority: 'skim', watch_reason: '個股內容可快速瀏覽',
        key_stocks: [{ code: '', name: '光頡' }, { code: '3624', name: '光頡' }],
      }],
    });

    const first = normalizeAnalysis(a, master, {});
    const snapshot = JSON.stringify(first.analysis.video_summaries);
    const second = normalizeAnalysis(first.analysis, master, {});
    expect(second.analysis.video_summaries![0].key_stocks).toEqual([{ code: '3624', name: '光頡' }]);
    expect(JSON.stringify(second.analysis.video_summaries)).toBe(snapshot);
    expect(second.report.codeFixes).toHaveLength(0);
  });
});

describe('normalizeAnalysis — grounding（只報告不刪）', () => {
  it('名出現在標的影片 → 不報', () => {
    const a = analysis({ weak_signal_stocks: [mention({ raw_query: '光頡', video_id: 'v1' })] });
    const { report } = normalizeAnalysis(a, master, { v1: '今天主力聊光頡很強' });
    expect(report.ungrounded).toHaveLength(0);
    expect(report.videoMismatches).toHaveLength(0);
  });

  it('證據在別支影片 → videoMismatch（不刪）', () => {
    const a = analysis({ weak_signal_stocks: [mention({ raw_query: '光頡', video_id: 'v2' })] });
    const { analysis: out, report } = normalizeAnalysis(a, master, { v1: '光頡漲停', v2: '今天聊台積電' });
    expect(report.videoMismatches).toHaveLength(1);
    expect(report.videoMismatches[0].foundIn).toContain('v1');
    expect(out.weak_signal_stocks[0]).toBeTruthy(); // 沒被刪
  });

  it('全逐字稿查無 → ungrounded（保留條目供人工複查）', () => {
    const a = analysis({ weak_signal_stocks: [mention({ raw_query: '凱美', video_id: 'v1' })] });
    const { analysis: out, report } = normalizeAnalysis(a, master, { v1: '今天只聊光頡' });
    expect(report.ungrounded).toHaveLength(1);
    expect(report.ungrounded[0].code).toBe('2375');
    expect(out.weak_signal_stocks).toHaveLength(1); // 仍在
  });

  it('代號(中文數字)出現也算 grounded', () => {
    const a = analysis({ weak_signal_stocks: [mention({ raw_query: '光頡', video_id: 'v1' })] });
    const { report } = normalizeAnalysis(a, master, { v1: '那檔三六二四今天很猛' });
    expect(report.ungrounded).toHaveLength(0);
  });
});

describe('normalizeAnalysis — keyframe 欄位正規化（2026-06-13）', () => {
  it('screenshot_ref 絕對路徑 → data/ 相對', () => {
    const a = analysis({
      high_consensus_stocks: [mention({
        raw_query: '光頡',
        matched: { code: '3624', name: '光頡', market: 'TWSE', confidence: 0.95, match_via: 'exact_name' },
        screenshot_ref: '/Users/tc/Desktop/rockstock/data/youtube/keyframes/2026-06-12/abc/f000560.webp',
      })],
    });
    const { analysis: out, report } = normalizeAnalysis(a, master, {});
    expect(out.high_consensus_stocks[0].screenshot_ref).toBe('data/youtube/keyframes/2026-06-12/abc/f000560.webp');
    expect(report.fieldFixes.some(f => f.includes('screenshot_ref'))).toBe(true);
  });

  it('screenshot_ref 無 keyframes 片段 → 移除', () => {
    const a = analysis({
      weak_signal_stocks: [mention({ raw_query: '凱美', matched: { code: '2375', name: '凱美', market: 'TWSE', confidence: 0.95, match_via: 'exact_name' }, screenshot_ref: '/tmp/random.png' })],
    });
    const { analysis: out } = normalizeAnalysis(a, master, {});
    expect(out.weak_signal_stocks[0].screenshot_ref).toBeUndefined();
  });

  it('recommendation_type 漂移枚舉（等突破→觀察、突破買進→明確買進）', () => {
    const a = analysis({
      high_consensus_stocks: [
        mention({ raw_query: '光頡', matched: { code: '3624', name: '光頡', market: 'TWSE', confidence: 0.95, match_via: 'exact_name' }, recommendation_type: '等突破' as never }),
        mention({ raw_query: '凱美', matched: { code: '2375', name: '凱美', market: 'TWSE', confidence: 0.95, match_via: 'exact_name' }, recommendation_type: '突破買進' as never }),
      ],
    });
    const { analysis: out } = normalizeAnalysis(a, master, {});
    expect(out.high_consensus_stocks[0].recommendation_type).toBe('觀察');
    expect(out.high_consensus_stocks[1].recommendation_type).toBe('明確買進');
  });

  it('未知 recommendation_type → fallback 觀察；合法值不動', () => {
    const a = analysis({
      weak_signal_stocks: [
        mention({ raw_query: '光頡', matched: { code: '3624', name: '光頡', market: 'TWSE', confidence: 0.95, match_via: 'exact_name' }, recommendation_type: '亂寫的' as never }),
        mention({ raw_query: '凱美', matched: { code: '2375', name: '凱美', market: 'TWSE', confidence: 0.95, match_via: 'exact_name' }, recommendation_type: '看多' }),
      ],
    });
    const { analysis: out, report } = normalizeAnalysis(a, master, {});
    expect(out.weak_signal_stocks[0].recommendation_type).toBe('觀察');
    expect(out.weak_signal_stocks[1].recommendation_type).toBe('看多'); // 合法不動
    expect(report.fieldFixes.filter(f => f.includes('recommendation_type'))).toHaveLength(1);
  });

  it('source_type 漂移（簡報→slide）、價位非正數 → 移除', () => {
    const a = analysis({
      high_consensus_stocks: [mention({
        raw_query: '光頡',
        matched: { code: '3624', name: '光頡', market: 'TWSE', confidence: 0.95, match_via: 'exact_name' },
        source_type: '簡報' as never, target_price: 0, mentioned_price: -5 as never,
      })],
    });
    const { analysis: out } = normalizeAnalysis(a, master, {});
    expect(out.high_consensus_stocks[0].source_type).toBe('slide');
    expect(out.high_consensus_stocks[0].target_price).toBeUndefined();
    expect(out.high_consensus_stocks[0].mentioned_price).toBeUndefined();
  });

  it('合法欄位完全不動、不誤報 fieldFix', () => {
    const a = analysis({
      high_consensus_stocks: [mention({
        raw_query: '光頡',
        matched: { code: '3624', name: '光頡', market: 'TWSE', confidence: 0.95, match_via: 'exact_name' },
        source_type: 'speech+slide', recommendation_type: '明確買進',
        screenshot_ref: 'data/youtube/keyframes/2026-06-12/abc/f001.webp', target_price: 120,
      })],
    });
    const { report } = normalizeAnalysis(a, master, {});
    expect(report.fieldFixes).toHaveLength(0);
  });
});
