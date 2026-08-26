import {
  movingAverageRankFromSignal,
  movingAverageRankFromText,
  resolveHoldingSignalSubtype,
} from '@/lib/portfolio/holdingSignalPolicy';
import type { RuleSignal } from '@/types';

function signal(overrides: Partial<RuleSignal> = {}): RuleSignal {
  return {
    type: 'SELL',
    label: '測試出場',
    description: '測試描述',
    reason: '測試理由',
    ruleId: 'test-exit',
    ...overrides,
  };
}

describe('持倉訊號策略情境隔離', () => {
  test.each([
    ['破3日均線', 1],
    ['跌破三日移動均線', 1],
    ['跌破 MA5', 2],
    ['跌破五日線', 2],
    ['跌破十日均線', 3],
    ['跌破月線', 4],
    ['跌破季線', 5],
  ])('辨識中文與 MA 別名：%s', (text, rank) => {
    expect(movingAverageRankFromText(text)).toBe(rank);
  });

  test('同時提到多條均線時不猜測是哪一條出場線', () => {
    expect(movingAverageRankFromText('MA5 > MA20 多頭排列')).toBeNull();
  });

  test('辨識範圍包含 reason，避免顯示欄位不同而漏判', () => {
    expect(movingAverageRankFromSignal(signal({
      description: '',
      reason: '課程條件：收盤破三日均線',
    }))).toBe(1);
  });

  test.each(['zhu-surge-hold-or-sell', 'surge-stock-exit'])(
    '持倉中的飆股情境規則 %s 只保留資訊，不得直接下交易動作',
    ruleId => {
      expect(resolveHoldingSignalSubtype({
        signal: signal({ ruleId, label: '飆股出場', description: '破3日均線' }),
        subtype: 'exit_strong',
        hasPosition: true,
        operatingMA: 'MA5',
      })).toBe('warn');
    },
  );

  test('空手時仍保留飆股規則原始分類，供進場風險判讀', () => {
    expect(resolveHoldingSignalSubtype({
      signal: signal({ ruleId: 'zhu-surge-hold-or-sell', description: '破3日均線' }),
      subtype: 'exit_strong',
      hasPosition: false,
      operatingMA: 'MA5',
    })).toBe('exit_strong');
  });

  test('MA5 持倉遇到一般 MA3 硬訊號只降為警示，不得全數出場', () => {
    expect(resolveHoldingSignalSubtype({
      signal: signal({ description: '收盤破三日均線' }),
      subtype: 'exit_strong',
      hasPosition: true,
      operatingMA: 'MA5',
    })).toBe('exit_soft');
  });

  test.each([
    ['收盤跌破五日均線', 'MA5'],
    ['收盤跌破 MA20', 'MA5'],
  ])('同操作線或更長週期的硬出場維持原分類：%s / %s', (description, operatingMA) => {
    expect(resolveHoldingSignalSubtype({
      signal: signal({ description }),
      subtype: 'exit_strong',
      hasPosition: true,
      operatingMA,
    })).toBe('exit_strong');
  });
});
