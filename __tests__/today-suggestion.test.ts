/**
 * composeOperationSuggestion 合約測試
 *
 * 規則：
 *   - 空 input → 「無訊號、建議空手觀望」
 *   - 有 buy 信號 → 包含「今日進場」
 *   - 有 stop_loss → 包含「持股注意」+「建議停損」
 *   - 有 blowoff-bearish → 包含「盤中警示」
 *   - blowoff-bearish 比 ma5-breakdown 優先
 *   - 有任一訊號 → 附「朱書紀律」紀律提醒
 *   - growth red 燈時的空訊號 → 加「進度落後 紅燈」
 */

import {
  composeOperationSuggestion,
  type ComposeInput,
  type DecisionRunForSuggestion,
  type PortfolioReviewForSuggestion,
  type AlertForSuggestion,
} from '@/lib/today/composeOperationSuggestion';

const EMPTY: ComposeInput = {
  decisions: [],
  portfolioReview: [],
  alertsToday: [],
  growthGap: null,
};

function buyRun(symbol: string, name: string, sizeHint: number): DecisionRunForSuggestion {
  return {
    symbol,
    name,
    decision: {
      action: 'buy',
      decisionPath: 'buy_signal',
      sizeHint,
      overview: 'test',
    },
  };
}

function review(symbol: string, name: string, action: PortfolioReviewForSuggestion['action'], returnPct?: number): PortfolioReviewForSuggestion {
  return { symbol, name, action, returnPct };
}

function alert(symbol: string, rule: AlertForSuggestion['rule'], firedAt = Date.now(), isHolding = false): AlertForSuggestion {
  return { symbol, rule, firedAt, isHolding };
}

describe('composeOperationSuggestion', () => {
  describe('空訊號分支', () => {
    test('全空 → 空手觀望', () => {
      const out = composeOperationSuggestion(EMPTY);
      expect(out).toContain('空手觀望');
      expect(out).not.toContain('今日進場');
      expect(out).not.toContain('盤中警示');
      expect(out).not.toContain('持股注意');
    });

    test('空訊號 + growth red → 附「進度落後 紅燈」', () => {
      const out = composeOperationSuggestion({
        ...EMPTY,
        growthGap: { gapPct: -0.073, status: 'red' },
      });
      expect(out).toContain('空手觀望');
      expect(out).toContain('進度落後');
      expect(out).toContain('紅燈');
    });

    test('空訊號 + growth green → 不附紅燈警告', () => {
      const out = composeOperationSuggestion({
        ...EMPTY,
        growthGap: { gapPct: 0.05, status: 'green' },
      });
      expect(out).toContain('空手觀望');
      expect(out).not.toContain('進度落後');
    });
  });

  describe('進場訊號', () => {
    test('1 個 buy → 「今日進場：X(N%倉位)」', () => {
      const out = composeOperationSuggestion({
        ...EMPTY,
        decisions: [buyRun('2330.TW', '台積電', 5)],
      });
      expect(out).toContain('今日進場');
      expect(out).toContain('台積電');
      expect(out).toContain('5%倉位');
      expect(out).toContain('13:20'); // 紀律提醒
    });

    test('多個 buy 取 top 2、用「、」連接', () => {
      const out = composeOperationSuggestion({
        ...EMPTY,
        decisions: [
          buyRun('2330.TW', '台積電', 5),
          buyRun('6770.TW', '力積電', 3),
          buyRun('3661.TW', '世芯-KY', 2),  // 應該被截掉
        ],
      });
      expect(out).toContain('台積電');
      expect(out).toContain('力積電');
      expect(out).not.toContain('世芯-KY');
    });

    test('watch / skip 不算進場', () => {
      const out = composeOperationSuggestion({
        ...EMPTY,
        decisions: [
          { symbol: '2454.TW', name: '聯發科', decision: { action: 'watch', decisionPath: 'technical_fail', sizeHint: 0, overview: '' } },
          { symbol: '2330.TW', name: '台積電', decision: { action: 'skip', decisionPath: 'risk_red', sizeHint: 0, overview: '' } },
        ],
      });
      expect(out).toContain('空手觀望');
    });
  });

  describe('持股警示', () => {
    test('stop_loss + reduce + take_profit 並存，stop_loss 排第一', () => {
      const out = composeOperationSuggestion({
        ...EMPTY,
        portfolioReview: [
          review('A.TW', 'AAA', 'take_profit', 30),
          review('B.TW', 'BBB', 'stop_loss', -8),
          review('C.TW', 'CCC', 'reduce', 10),
        ],
      });
      expect(out).toContain('持股注意');
      // stop_loss 是 BBB → 應該排第一
      const idxB = out.indexOf('BBB');
      const idxC = out.indexOf('CCC');
      const idxA = out.indexOf('AAA');
      expect(idxB).toBeGreaterThan(-1);
      expect(idxB).toBeLessThan(idxC);
      // top 2 截斷，AAA 不出現
      expect(idxA).toBe(-1);
    });

    test('returnPct 顯示帶符號百分號', () => {
      const out = composeOperationSuggestion({
        ...EMPTY,
        portfolioReview: [review('A.TW', '南亞科', 'stop_loss', -7.5)],
      });
      expect(out).toMatch(/南亞科.*-7\.5%/);
      expect(out).toContain('建議停損');
    });

    test('hold_strong / add / no_add 不算警示', () => {
      const out = composeOperationSuggestion({
        ...EMPTY,
        portfolioReview: [
          review('A.TW', 'AAA', 'hold_strong'),
          review('B.TW', 'BBB', 'add'),
          review('C.TW', 'CCC', 'no_add'),
        ],
      });
      expect(out).toContain('空手觀望');
      expect(out).not.toContain('持股注意');
    });
  });

  describe('盤中警示', () => {
    const t = new Date('2026-05-22T05:35:00Z').getTime(); // Asia/Taipei 13:35

    test('blowoff-bearish 觸發提示', () => {
      const out = composeOperationSuggestion({
        ...EMPTY,
        alertsToday: [alert('8069.TW', 'blowoff-bearish', t, false)],
      });
      expect(out).toContain('盤中警示');
      expect(out).toContain('爆量長黑');
      expect(out).toContain('8069.TW');
      expect(out).toContain('13:35');
    });

    test('持股 alert 加「持股中」標註', () => {
      const out = composeOperationSuggestion({
        ...EMPTY,
        alertsToday: [alert('6770.TW', 'terminal-rally', t, true)],
      });
      expect(out).toContain('末升段');
      expect(out).toContain('持股中');
    });

    test('blowoff-bullish 不算警示（不嚴重）', () => {
      const out = composeOperationSuggestion({
        ...EMPTY,
        alertsToday: [alert('X.TW', 'blowoff-bullish', t)],
      });
      expect(out).toContain('空手觀望');
      expect(out).not.toContain('盤中警示');
    });

    test('ma5-breakdown 也不算嚴重，不出現在 sentence', () => {
      const out = composeOperationSuggestion({
        ...EMPTY,
        alertsToday: [alert('Y.TW', 'ma5-breakdown', t)],
      });
      expect(out).toContain('空手觀望');
    });

    test('bearish + terminal-rally 並存 → 取 bearish（嚴重度 3 > 2）', () => {
      const out = composeOperationSuggestion({
        ...EMPTY,
        alertsToday: [
          alert('A.TW', 'terminal-rally', t - 1000),
          alert('B.TW', 'blowoff-bearish', t - 2000),
        ],
      });
      expect(out).toContain('B.TW');
      expect(out).toContain('爆量長黑');
      expect(out).not.toMatch(/末升段.*A\.TW/);
    });
  });

  describe('全部訊號並存', () => {
    test('buy + stop_loss + bearish 三段都出現', () => {
      const t = new Date('2026-05-22T05:35:00Z').getTime();
      const out = composeOperationSuggestion({
        decisions: [buyRun('2330.TW', '台積電', 5)],
        portfolioReview: [review('6770.TW', '力積電', 'stop_loss', -6)],
        alertsToday: [alert('8069.TW', 'blowoff-bearish', t, false)],
        growthGap: null,
      });
      expect(out).toContain('今日進場');
      expect(out).toContain('台積電');
      expect(out).toContain('持股注意');
      expect(out).toContain('力積電');
      expect(out).toContain('盤中警示');
      expect(out).toContain('8069.TW');
      expect(out).toContain('13:20');  // 紀律提醒
    });
  });
});
