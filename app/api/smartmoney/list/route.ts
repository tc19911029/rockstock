import { NextRequest, NextResponse } from 'next/server';
import { readDay, listDates } from '@/lib/smartmoney/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 「跌+大戶逆勢買超」每日清單。?date= 預設最新有檔日。
export async function GET(req: NextRequest) {
  try {
    let date = req.nextUrl.searchParams.get('date');
    const dates = await listDates();
    if (!date) date = dates.length ? dates[dates.length - 1] : null;
    const day = date ? await readDay(date) : null;
    return NextResponse.json({ ok: true, date, day, availableDates: dates });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'list 失敗' },
      { status: 500 },
    );
  }
}
