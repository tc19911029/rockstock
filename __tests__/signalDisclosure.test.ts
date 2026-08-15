import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SignalDisclosure from '@/components/narrative/SignalDisclosure';
import KLineSignalAnalysisPanel from '@/components/KLineSignalAnalysisPanel';
import { analyzeKLineSignal } from '@/lib/rules/klineSignalAnalysis';
import type { RuleSignal } from '@/types';

describe('訊號面板摺疊區', () => {
  test('預設收合並保留標題、摘要與內容', () => {
    const html = renderToStaticMarkup(
      createElement(
        SignalDisclosure,
        { title: 'K 線型態', meta: '1 組 · 上升三法' },
        createElement('p', null, '型態明細'),
      ),
    );

    expect(html).toContain('<details');
    expect(html).not.toContain('<details open=""');
    expect(html).toContain('<summary');
    expect(html).toContain('min-h-11');
    expect(html).toContain('K 線型態');
    expect(html).toContain('1 組 · 上升三法');
    expect(html).toContain('型態明細');
  });

  test('嵌入摺疊區時不重複顯示 K 線型態標題', () => {
    const signal: RuleSignal = {
      type: 'BUY',
      label: '上升三法續漲',
      description: '長紅整理後再突破',
      reason: '【測試】後面長紅低點不能被跌破，否則結構失效。',
      ruleId: 'kline-rising-three-methods',
    };
    const analysis = analyzeKLineSignal(signal);
    expect(analysis).not.toBeNull();

    const html = renderToStaticMarkup(
      createElement(KLineSignalAnalysisPanel, {
        analyses: analysis ? [analysis] : [],
        showHeader: false,
      }),
    );

    expect(html).toContain('上升三法續漲');
    expect(html).not.toContain('id="kline-analysis-title"');
    expect(html).not.toContain('依趨勢、位置與確認條件解讀');
  });
});
