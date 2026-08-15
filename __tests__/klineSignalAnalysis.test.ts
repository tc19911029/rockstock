import type { RuleSignal } from '@/types';
import {
  analyzeKLineSignal,
  analyzeKLineSignals,
  isKLineSignal,
} from '@/lib/rules/klineSignalAnalysis';

function signal(overrides: Partial<RuleSignal>): RuleSignal {
  return {
    type: 'WATCH',
    label: '測試訊號',
    description: '測試描述',
    reason: '測試理由',
    ruleId: 'test-rule',
    ...overrides,
  };
}

describe('K 線訊號分析', () => {
  test('只收錄 K 線型態與 K 線交易規則', () => {
    expect(isKLineSignal(signal({ ruleId: 'kline-one-star-two-yang' }))).toBe(true);
    expect(isKLineSignal(signal({ ruleId: 'zhu-morning-star-low' }))).toBe(true);
    expect(isKLineSignal(signal({ ruleId: 'smart-kline-buy' }))).toBe(true);
    expect(isKLineSignal(signal({ ruleId: 'zhu-bull-pullback-entry' }))).toBe(false);
  });

  test('一星二陽被判讀為已確認的多方中繼', () => {
    const result = analyzeKLineSignal(signal({
      type: 'BUY',
      ruleId: 'kline-one-star-two-yang',
      label: '一星二陽續漲',
      reason: [
        '【朱家泓《抓住K線》第5篇 組合1】一星二陽是上漲中繼訊號。',
        '第三根中長紅收盤過高，轉強確認。',
        '後面長紅K線低點不能被跌破，否則會破壞架構。',
      ].join('\n'),
    }));

    expect(result).toMatchObject({
      family: '多方中繼',
      direction: 'bullish',
      state: 'confirmed',
      stateLabel: '多方確認',
      bookRef: '【朱家泓《抓住K線》第5篇 組合1】',
    });
    expect(result?.confirmation).toContain('確認');
    expect(result?.invalidation).toContain('破壞');
  });

  test('晨星成形訊號保留等待確認與失效條件', () => {
    const result = analyzeKLineSignal(signal({
      type: 'WATCH',
      ruleId: 'zhu-morning-star-low',
      label: '低檔晨星成形（待突破確認）',
      reason: [
        '【朱家泓 課程 CH2-8】低檔晨星是轉折向上的基本型態。',
        '次日起確認：收盤突破右紅K高點才確認。',
        '收盤跌破紅K低點，結構破壞作廢。',
      ].join('\n'),
    }));

    expect(result).toMatchObject({
      family: '低檔反轉',
      direction: 'bullish',
      state: 'forming',
      stateLabel: '等待確認',
    });
    expect(result?.confirmation).toContain('次日起確認');
    expect(result?.invalidation).toContain('作廢');
  });

  test('分析清單排除非 K 線規則，並把確認訊號排在待確認之前', () => {
    const results = analyzeKLineSignals([
      signal({ type: 'WATCH', ruleId: 'candle-merge-signal', label: '子母線' }),
      signal({ type: 'BUY', ruleId: 'kline-rising-three-methods', label: '上升三法' }),
      signal({ type: 'BUY', ruleId: 'zhu-bull-pullback-entry', label: '回後買上漲' }),
    ]);

    expect(results).toHaveLength(2);
    expect(results[0].signal.label).toBe('上升三法');
    expect(results[1].signal.label).toBe('子母線');
  });
});
