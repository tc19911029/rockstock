import { NextRequest, NextResponse } from 'next/server';
import { readLhbDaily, readSeatStats, listLhbDates } from '@/lib/cn-agents/storage';
import { lhbSignal } from '@/lib/cn-agents/lhbSignal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SEAT_LEADERBOARD_MIN_BUY = 5;
const SEAT_LEADERBOARD_TOP = 30;

// 龍虎榜當日榜 + 席位績效榜（前端 /health?tab=cn-agents 用）。
// ?date= 預設最新有檔日。
export async function GET(req: NextRequest) {
  try {
    let date = req.nextUrl.searchParams.get('date');
    if (!date) {
      const dates = await listLhbDates();
      date = dates.length > 0 ? dates[dates.length - 1] : null;
    }

    const lhb = date ? await readLhbDaily(date) : null;
    const seatStats = await readSeatStats();

    const stocks = lhb
      ? [...lhb.stocks]
          .map((s) => ({ s, sig: lhbSignal(s) }))
          // 淨買超排序（淨買在前、賣超落底）；verdict/warnings 仍標示拉薩/跌多風險
          .sort((a, b) => (b.s.netAmt ?? -Infinity) - (a.s.netAmt ?? -Infinity))
          .map(({ s, sig }) => ({
            code: s.code,
            name: s.name,
            board: s.board,
            changeRate: s.changeRate,
            netAmt: s.netAmt,
            reason: s.reason,
            verdict: sig.verdict,
            warnings: sig.warnings,
            buySeats: s.seats.buy.slice(0, 5).map((t) => ({
              name: t.label ?? t.deptName,
              type: t.type,
              netAmt: t.netAmt,
            })),
          }))
      : [];

    const seats = seatStats
      ? seatStats.seats
          .filter((s) => s.nBuy >= SEAT_LEADERBOARD_MIN_BUY)
          .sort((a, b) => (b.buyFwd.winD5 ?? -1) - (a.buyFwd.winD5 ?? -1))
          .slice(0, SEAT_LEADERBOARD_TOP)
          .map((s) => ({
            deptCode: s.deptCode,
            name: s.label ?? s.deptName,
            type: s.type,
            nBuy: s.nBuy,
            winD5: s.buyFwd.winD5,
            avgD1: s.buyFwd.avgD1,
            nextDayDumpRate: s.nextDayDumpRate,
          }))
      : [];

    return NextResponse.json({
      ok: true,
      date,
      detailFetched: lhb?.detailFetched ?? false,
      stocks,
      seatStats: seats,
      seatStatsWindow: seatStats ? { from: seatStats.windowFrom, to: seatStats.windowTo } : null,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'lhb route 失敗' },
      { status: 500 },
    );
  }
}
