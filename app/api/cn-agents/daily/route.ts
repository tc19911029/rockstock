import { NextRequest, NextResponse } from 'next/server';
import { readDaily, listDailyDates } from '@/lib/cn-agents/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 今日總決策（A/B/C 分層 + 題材 + action/avoid list）。?date= 預設最新有檔日。
export async function GET(req: NextRequest) {
  try {
    let date = req.nextUrl.searchParams.get('date');
    if (!date) {
      const dates = await listDailyDates();
      date = dates.length > 0 ? dates[dates.length - 1] : null;
    }
    const daily = date ? await readDaily(date) : null;
    return NextResponse.json({ ok: true, date, daily });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'daily 失敗' }, { status: 500 });
  }
}
