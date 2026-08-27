import { NextRequest } from 'next/server';
import { GET as rankingGet } from '@/app/api/themes/ranking/route';
import { GET as hotGet } from '@/app/api/theme-sanse/hot/route';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { isTradingDay } from '@/lib/utils/tradingDay';

function nextTradingDate(market: 'TW' | 'CN'): string {
  const cursor = new Date(`${getLastTradingDay(market)}T12:00:00Z`);
  for (let i = 0; i < 10; i++) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const date = cursor.toISOString().slice(0, 10);
    if (isTradingDay(date, market)) return date;
  }
  throw new Error('找不到下一個交易日');
}

describe('官方產業查詢日期完整性', () => {
  it('公開排名拒絕尚未收盤的未來交易日', async () => {
    const date = nextTradingDate('TW');
    const response = await rankingGet(new NextRequest(`http://localhost/api/themes/ranking?date=${date}`));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('not closed') });
  });

  it('熱門分類查詢拒絕尚未收盤的未來交易日', async () => {
    const date = nextTradingDate('TW');
    const response = await hotGet(new NextRequest(`http://localhost/api/theme-sanse/hot?market=TW&date=${date}`));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });

  it('兩個公開端點都拒絕週末，不觸發任何補建', async () => {
    const weekend = '2026-08-29';
    const [ranking, hot] = await Promise.all([
      rankingGet(new NextRequest(`http://localhost/api/themes/ranking?date=${weekend}`)),
      hotGet(new NextRequest(`http://localhost/api/theme-sanse/hot?market=TW&date=${weekend}`)),
    ]);
    expect(ranking.status).toBe(400);
    expect(hot.status).toBe(400);
  });
});
