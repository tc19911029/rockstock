import { parseTaifexFuturesCsv } from '@/lib/datasource/TaifexFuturesProvider';
import { isIndexSymbol } from '@/lib/utils/symbols';

const HEADER = '交易日期,契約,到期月份(週別),開盤價,最高價,最低價,收盤價,漲跌價,漲跌%,成交量,結算價,未沖銷契約數,最後最佳買價,最後最佳賣價,歷史最高價,歷史最低價,是否因訊息面暫停交易,交易時段,價差對單式委託成交量';

describe('TAIFEX 臺股期貨連續線', () => {
  it('合併夜盤與日盤，並選擇最近的月契約', () => {
    const csv = [
      HEADER,
      '2026/08/03,TX,202607,900,920,880,910,0,0%,999,0,0,0,0,0,0,,一般,,',
      '2026/08/03,TX,202608,100,110,99,108,0,0%,100,0,0,0,0,0,0,,一般,,',
      '2026/08/03,TX,202608,98,111,97,103,0,0%,50,0,0,0,0,0,0,,盤後,,',
      '2026/08/03,TX,202609,120,125,115,123,0,0%,10,0,0,0,0,0,0,,一般,,',
    ].join('\n');

    expect(parseTaifexFuturesCsv(csv)).toEqual([{
      date: '2026-08-03',
      open: 98,
      high: 111,
      low: 97,
      close: 108,
      volume: 150,
    }]);
  });

  it('排除週契約與無效價位', () => {
    const csv = [
      HEADER,
      '2026/08/04,TX,202608W1,100,110,90,105,0,0%,10,0,0,0,0,0,0,,一般,,',
      '2026/08/04,TX,202608,-,-,-,-,0,0%,10,0,0,0,0,0,0,,一般,,',
    ].join('\n');

    expect(parseTaifexFuturesCsv(csv)).toEqual([]);
  });

  it('將 TXF 視為市場指數類商品', () => {
    expect(isIndexSymbol('TXF')).toBe(true);
    expect(isIndexSymbol('txf')).toBe(true);
  });
});
