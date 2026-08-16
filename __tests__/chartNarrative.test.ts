import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildChartNarrative } from '@/lib/narrative/buildChartNarrative';
import ChartNarrativePanel from '@/components/narrative/ChartNarrativePanel';
import type { CandleWithIndicators, RuleSignal } from '@/types';

function candle(index: number, close = 100 + index): CandleWithIndicators {
  return {
    date: `2026-01-${String(index + 1).padStart(2, '0')}`,
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    volume: 1_000 + index * 10,
    ma5: close - 1,
    ma10: close - 2,
    ma20: close - 3,
    avgVol5: 1_000,
  };
}

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

const candles = Array.from({ length: 25 }, (_, index) => candle(index));

function trendlineCandle(
  index: number,
  close: number,
  ma5: number,
  high: number,
  low: number,
): CandleWithIndicators {
  return {
    date: `2026-02-${String(index + 1).padStart(2, '0')}`,
    open: close - 1,
    high,
    low,
    close,
    volume: 1_000,
    ma5,
    ma10: close,
    ma20: close,
    avgVol5: 1_000,
  };
}

const descendingTrendlineBreakout = [
  trendlineCandle(0, 112, 110, 120, 109),
  trendlineCandle(1, 114, 112, 119, 111),
  trendlineCandle(2, 115, 113, 118, 112),
  trendlineCandle(3, 108, 110, 109, 104),
  trendlineCandle(4, 102, 104, 105, 95),
  trendlineCandle(5, 98, 100, 101, 90),
  trendlineCandle(6, 101, 99, 104, 92),
  trendlineCandle(7, 105, 103, 110, 101),
  trendlineCandle(8, 107, 105, 109, 103),
  trendlineCandle(9, 103, 105, 105, 99),
  trendlineCandle(10, 99, 101, 102, 94),
  trendlineCandle(11, 96, 98, 99, 93),
  trendlineCandle(12, 99, 97, 102, 95),
  trendlineCandle(13, 108, 106, 109, 100),
];

describe('走圖敘事建構器', () => {
  test('持股同時出現進場與硬出場時，硬出場永遠優先', () => {
    const buy = signal({
      type: 'BUY',
      subtype: 'entry_strong',
      ruleId: 'buy-confirmed',
      label: '突破確認',
    });
    const sell = signal({
      type: 'SELL',
      subtype: 'exit_strong',
      ruleId: 'sell-confirmed',
      label: '跌破前低',
    });

    const result = buildChartNarrative({
      candles,
      currentIndex: 20,
      signals: [buy, sell],
      hasPosition: true,
      operatingMA: 'MA20',
    });

    expect(result.action).toBe('exit');
    expect(result.primaryEvent.label).toBe('跌破前低');
    expect(result.headline).toContain('先處理風險');
  });

  test('未持倉時戒律可否決已成立的強進場訊號', () => {
    const result = buildChartNarrative({
      candles,
      currentIndex: 20,
      signals: [signal({
        type: 'BUY',
        subtype: 'entry_strong',
        ruleId: 'buy-confirmed',
        label: '突破確認',
      })],
      hasPosition: false,
      prohibitions: ['戒律 2：接近重大壓力區，不追價。'],
    });

    expect(result.action).toBe('avoid-entry');
    expect(result.primaryEvent.category).toBe('risk');
    expect(result.blockers).toHaveLength(1);
  });

  test('未持倉的轉弱訊號不會被誤寫成戒律尚未解除', () => {
    const result = buildChartNarrative({
      candles,
      currentIndex: 20,
      signals: [signal({
        type: 'SELL',
        subtype: 'exit_strong',
        ruleId: 'ma5-break',
        label: '跌破 MA5',
      })],
      hasPosition: false,
    });

    expect(result.action).toBe('avoid-entry');
    expect(result.confirmation).toContain('轉弱訊號是否繼續');
    expect(result.confirmation).not.toContain('戒律');
  });

  test('K 線成形只給等待確認，並保留確認與失效條件', () => {
    const result = buildChartNarrative({
      candles,
      currentIndex: 20,
      signals: [signal({
        type: 'WATCH',
        ruleId: 'zhu-morning-star-low',
        label: '低檔晨星成形',
        reason: [
          '【朱家泓 課程 CH2-8】低檔晨星。',
          '次日起確認：收盤突破右紅K高點才確認。',
          '收盤跌破紅K低點，結構破壞作廢。',
        ].join('\n'),
      })],
      hasPosition: false,
    });

    expect(result.action).toBe('wait');
    expect(result.primaryEvent.state).toBe('forming');
    expect(result.confirmation).toContain('次日起確認');
    expect(result.invalidation).toContain('作廢');
  });

  test('同一 K 線來源不會同時以 K 線與一般規則重複計票', () => {
    const duplicated = signal({
      type: 'BUY',
      ruleId: 'kline-rising-three-methods',
      label: '上升三法',
    });
    const result = buildChartNarrative({
      candles,
      currentIndex: 20,
      signals: [duplicated, duplicated],
      hasPosition: false,
    });

    expect(result.events).toHaveLength(2);
    expect(result.events.filter(event => event.category === 'kline')).toHaveLength(1);
    expect(result.events.some(event => event.category === 'trend')).toBe(true);
    expect(result.evidenceLevel).toBe('medium');
  });

  test('同一來源家族的多條訊號不會膨脹成多來源信心', () => {
    const result = buildChartNarrative({
      candles,
      currentIndex: 20,
      signals: [
        signal({ type: 'BUY', subtype: 'entry_strong', ruleId: 'entry-a' }),
        signal({ type: 'BUY', subtype: 'entry_strong', ruleId: 'entry-b' }),
      ],
      hasPosition: false,
    });

    expect(result.events.filter(event => event.category === 'entry')).toHaveLength(2);
    expect(result.events.filter(event => event.category === 'trend')).toHaveLength(1);
    expect(result.evidenceLevel).toBe('medium');
  });

  test('下降切線突破會進入敘事證據並在面板顯示為結構進展', () => {
    const result = buildChartNarrative({
      candles: descendingTrendlineBreakout,
      currentIndex: descendingTrendlineBreakout.length - 1,
      signals: [],
      hasPosition: false,
    });
    const event = result.events.find(item => item.sourceRuleIds.includes('trendline-breakout-bullish'));

    expect(event).toMatchObject({
      label: '下降切線已突破',
      category: 'trend',
      direction: 'bullish',
      action: 'wait',
    });
    expect(event?.description).toContain('不等於完整 ABC 突破');

    const html = renderToStaticMarkup(createElement(ChartNarrativePanel, {
      narrative: result,
      actionPlan: {
        label: '今日動作：保持觀望',
        detail: '等待下一根確認。',
        tone: 'neutral',
      },
    }));
    expect(html).toContain('切線結構進展');
    expect(html).toContain('下降切線已突破');
    expect(html).toContain('不等於完整 ABC 突破');
  });

  test('同日同方向的多個 K 線名稱只形成一個獨立證據群', () => {
    const result = buildChartNarrative({
      candles,
      currentIndex: 20,
      signals: [
        signal({ type: 'BUY', ruleId: 'kline-one-star-two-yang', label: '一星二陽續漲' }),
        signal({ type: 'BUY', ruleId: 'kline-rising-three-methods', label: '上升三法續漲' }),
        signal({ type: 'BUY', ruleId: 'kline-red-black-red', label: '紅黑紅中繼' }),
      ],
      hasPosition: true,
      prohibitions: ['戒律8：空頭趨勢下紅K反彈，勿進場做多'],
      operatingMA: 'MA5',
    });

    const bullishKlineGroup = result.evidenceGroups.find(group => group.key.includes('kline:') && group.direction === 'bullish');
    expect(result.action).toBe('reduce');
    expect(bullishKlineGroup).toMatchObject({
      disposition: 'conflicting',
      eventCount: 3,
      label: '多方 K 線型態',
    });
    expect(result.evidenceGroups.filter(group => group.category === 'kline')).toHaveLength(1);
  });

  test('持股續抱時以趨勢與操作均線為主依據，不借用買進型態的確認條件', () => {
    const result = buildChartNarrative({
      candles,
      currentIndex: 20,
      signals: [signal({
        type: 'BUY',
        subtype: 'entry_strong',
        ruleId: 'kline-rising-three-methods',
        label: '上升三法',
        reason: '次日突破高點才確認。',
      })],
      hasPosition: true,
      operatingMA: 'MA20',
    });

    expect(result.action).toBe('hold');
    expect(result.primaryEvent.category).toBe('trend');
    expect(result.confirmation).toContain('MA20');
    expect(result.confirmation).not.toContain('突破高點');
  });

  test('戒律與軟出場同時存在時，優先採用可執行的減碼訊號', () => {
    const result = buildChartNarrative({
      candles,
      currentIndex: 20,
      signals: [signal({
        type: 'REDUCE',
        subtype: 'exit_soft',
        ruleId: 'soft-ma-break',
        label: '短均線轉弱',
      })],
      hasPosition: true,
      prohibitions: ['戒律8：空頭反彈風險'],
      operatingMA: 'MA20',
    });

    expect(result.action).toBe('reduce');
    expect(result.headline).toContain('評估減碼');
    expect(result.actionLabel).toBe('減碼防守');
    expect(result.primaryEvent.label).toBe('短均線轉弱');
    expect(result.primaryEvent.category).toBe('exit');
  });

  test('只有持股戒律時不會誤寫成已出現軟出場訊號', () => {
    const result = buildChartNarrative({
      candles,
      currentIndex: 20,
      signals: [],
      hasPosition: true,
      prohibitions: ['戒律8：空頭反彈風險'],
      operatingMA: 'MA5',
    });
    expect(result.action).toBe('reduce');
    expect(result.actionLabel).toBe('續抱警戒');
    expect(result.headline).toContain('先保護部位');
    expect(result.headline).not.toContain('評估減碼');
    expect(result.primaryEvent.category).toBe('risk');
  });

  test('硬出場的重判條件不會被另一條進場戒律取代', () => {
    const result = buildChartNarrative({
      candles,
      currentIndex: 20,
      signals: [signal({
        type: 'SELL',
        subtype: 'exit_strong',
        ruleId: 'ma20-break',
        label: '跌破 MA20',
      })],
      hasPosition: true,
      prohibitions: ['戒律6：回檔底底低，多頭結構已破'],
      operatingMA: 'MA20',
    });

    expect(result.action).toBe('exit');
    expect(result.invalidation).toContain('站回 MA20');
    expect(result.invalidation).not.toContain('戒律6');
  });

  test('追加未來 K 棒不會改寫當下敘事', () => {
    const input = {
      currentIndex: 20,
      signals: [signal({
        type: 'BUY' as const,
        subtype: 'entry_strong' as const,
        ruleId: 'breakout-now',
        label: '當日突破',
      })],
      hasPosition: false,
    };
    const before = buildChartNarrative({ ...input, candles });
    const after = buildChartNarrative({
      ...input,
      candles: [...candles, candle(25, 20), candle(26, 300)],
    });

    expect(after).toEqual(before);
  });

  test('輸出事件與陣列不可被後續流程原地修改', () => {
    const result = buildChartNarrative({
      candles,
      currentIndex: 20,
      signals: [],
      hasPosition: false,
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.events)).toBe(true);
    expect(Object.isFrozen(result.evidenceGroups)).toBe(true);
    expect(Object.isFrozen(result.evidenceGroups[0])).toBe(true);
    expect(Object.isFrozen(result.primaryEvent)).toBe(true);
    expect(Object.isFrozen(result.primaryEvent.sourceRuleIds)).toBe(true);
  });
});
