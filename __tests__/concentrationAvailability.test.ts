import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ChipRawTables from '@/components/chart/ChipRawTables';
import { assessExactConcentration } from '@/lib/chips/concentrationAvailability';

describe('正式集中度完整性', () => {
  test('日期列存在但 5／20 日全為空時不得標成 ready', () => {
    expect(assessExactConcentration([
      { date: '2026-08-14', c5: null, c20: null, net: null },
      { date: '2026-08-13', c5: null, c20: null, net: null },
    ])).toMatchObject({
      status: 'unavailable',
      exactDateCount: 0,
      latestComplete: false,
    });
  });

  test('只有舊日期有正式值時標成 partial', () => {
    expect(assessExactConcentration([
      { date: '2026-08-14', c5: null, c20: null },
      { date: '2026-08-13', c5: 1.2, c20: -0.5 },
    ])).toMatchObject({
      status: 'partial',
      exactDateCount: 1,
      latestDate: '2026-08-14',
    });
  });

  test('最新日期 5／20 日皆有正式值才標成 ready', () => {
    expect(assessExactConcentration([
      { date: '2026-08-13', c5: null, c20: null },
      { date: '2026-08-14', c5: 2.5, c20: 1.1 },
    ])).toMatchObject({
      status: 'ready',
      latestComplete: true,
    });
  });

  test('unavailable 狀態顯示來源限制，不會宣稱正式公式已完成', () => {
    const candles = Array.from({ length: 5 }, (_, index) => ({
      date: `2026-08-${String(10 + index).padStart(2, '0')}`,
      close: 70 + index,
      volume: 10_000,
    }));
    const broker = candles.map((row, index) => ({
      date: row.date,
      netDifference: 1_000 + index,
    }));
    const html = renderToStaticMarkup(createElement(ChipRawTables, {
      broker,
      candles,
      cursorDate: '2026-08-14',
      concentrationStatus: 'unavailable',
      concentrationError: '正式分點來源本次未回傳可用數值。',
    }));

    expect(html).toContain('正式分點來源本次未回傳可用數值');
    expect(html).not.toContain('最近日期的 5／20 日欄位已採正式分點公式');
  });
});
