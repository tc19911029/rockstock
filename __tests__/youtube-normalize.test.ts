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
