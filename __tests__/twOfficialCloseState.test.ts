import {
  isCompleteTWOfficialCloseState,
  type TWOfficialCloseState,
} from '@/lib/datasource/twOfficialCloseState';

const completeState: TWOfficialCloseState = {
  market: 'TW',
  date: '2026-08-31',
  settledAt: '2026-08-31T06:52:37.539Z',
  twseRows: 1364,
  tpexRows: 981,
  noTradeSymbols: ['2064', '3115'],
};

describe('TW official close state', () => {
  test('兩市場官方表完整且日期相同才可作為最終狀態', () => {
    expect(isCompleteTWOfficialCloseState(completeState, '2026-08-31')).toBe(true);
  });

  test('TPEx 尚未完整或讀到別日資料時 fail closed', () => {
    expect(isCompleteTWOfficialCloseState({ ...completeState, tpexRows: 899 }, '2026-08-31')).toBe(false);
    expect(isCompleteTWOfficialCloseState(completeState, '2026-08-28')).toBe(false);
  });

  test('零成交代碼格式不合法時拒絕狀態檔', () => {
    expect(isCompleteTWOfficialCloseState({
      ...completeState,
      noTradeSymbols: ['2064.TWO'],
    }, '2026-08-31')).toBe(false);
  });
});
