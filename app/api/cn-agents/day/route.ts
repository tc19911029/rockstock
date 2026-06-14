import { NextRequest, NextResponse } from 'next/server';
import {
  readDaily, listBreadthDates, readBreadthDay, readLimitUpPoolDay, readBoardsDay, readLhbDaily,
  readBreadthIndex, readRecoEvents,
} from '@/lib/cn-agents/storage';
import { loadDateReturns } from '@/lib/cn-agents/backtest/recoPipeline';
import { lhbSignal } from '@/lib/cn-agents/lhbSignal';
import { isShortTermSuccess } from '@/lib/cn-agents/successCriterion';
import { classifyCnBoard } from '@/lib/cn-agents/cnBoard';
import type { RecoReturns } from '@/lib/backtest/eventReturns';
import type { CnBoardKind } from '@/lib/cn-agents/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// 「陸股情緒決策歷史系統」每日視圖：?date= 預設最新有檔日；一次回整天 + 可選日期列表。
// 候選股/龍虎榜股都附 7-horizon 報酬（d1,d2,d3,d4,d5,d10,d20 + 最高/回撤 + 成功旗標）。

function symbolOf(code: string, board: CnBoardKind): string {
  if (board === 'BJ') return `${code}.BJ`;
  return `${code}.${board === 'SH-main' || board === 'STAR' ? 'SS' : 'SZ'}`;
}

/** RecoReturns → 前端精簡欄位（含成功旗標） */
function perf(r: RecoReturns | null) {
  if (!r) return null;
  return {
    d1: r.d1, d2: r.d2, d3: r.d3, d4: r.d4, d5: r.d5, d10: r.d10, d20: r.d20,
    mfe: r.mfe, mae: r.mae, success: isShortTermSuccess(r),
  };
}

// CN 代號→{名稱,產業}（補既有事件的裸代號：主力流入/人氣股在 hardScore 沒拿到名/產業 → 顯示代號）。
// cn_stocklist.json 是 { updatedAt, stocks:[{symbol,name,industry}] }（舊版裸陣列也吃）。模組層快取一次。
let _cnMeta: Map<string, { name: string; industry: string | null }> | null = null;
async function loadCnStockMeta(): Promise<Map<string, { name: string; industry: string | null }>> {
  if (_cnMeta) return _cnMeta;
  try {
    const path = await import('path');
    const { promises: fs } = await import('fs');
    const parsed = JSON.parse(await fs.readFile(path.join(process.cwd(), 'data', 'cn_stocklist.json'), 'utf-8')) as
      | Array<{ symbol: string; name: string; industry?: string | null }>
      | { stocks: Array<{ symbol: string; name: string; industry?: string | null }> };
    const arr = Array.isArray(parsed) ? parsed : (parsed.stocks ?? []);
    _cnMeta = new Map(arr.map((r) => [r.symbol.split('.')[0], { name: r.name, industry: r.industry ?? null }]));
  } catch {
    _cnMeta = new Map();
  }
  return _cnMeta;
}

export async function GET(req: NextRequest) {
  try {
    // 可選日期 = 所有有寬度資料的交易日（492 天）。daily.json 只有近期 compose 過的日子有，
    // 歷史日沒有 → 用 hard_score 事件合成「當天紀錄」，讓任一交易日都能回溯復盤。
    const dates = await listBreadthDates();
    let date = req.nextUrl.searchParams.get('date');
    if (!date) date = dates.length > 0 ? dates[dates.length - 1] : null;

    if (!date) {
      return NextResponse.json({ ok: true, date: null, availableDates: [], daily: null });
    }

    const [daily, breadth, pool, boards, lhb, index, eventsFile] = await Promise.all([
      readDaily(date), readBreadthDay(date), readLimitUpPoolDay(date), readBoardsDay(date), readLhbDaily(date),
      readBreadthIndex(), readRecoEvents(date),
    ]);

    // 候選清單來源：有 daily（近期、含 skill 語意）用 daily.candidates；
    // 歷史日沒 daily → 用 hard_score_v0 事件（程式硬分）合成，top 40。
    const synthCandidates = !daily
      ? (eventsFile?.events ?? [])
          .filter((e) => e.agentSource === 'hard_score_v0' && e.tier !== 'C')
          .sort((a, b) => b.totalScore - a.totalScore)
          .slice(0, 40)
          .map((e, i) => ({
            code: e.code, name: e.name, symbol: e.symbol, board: e.board, rank: i + 1,
            totalScore: e.totalScore, light: '', confidence: '', tier: e.tier, mode: e.mode,
            subScores: e.scoreBreakdown, available: [], missing: [], themeId: null, position: null,
            reasons: e.reason ? [e.reason] : [],
          }))
      : daily.candidates;
    const baseCandidates = daily?.candidates ?? synthCandidates;

    // 近 30 日情緒分迷你序列（截至 selectedDate，不偷看 selectedDate 之後）
    const series = (index?.days ?? [])
      .filter((d) => d.date <= date!)
      .slice(-30)
      .map((d) => ({ date: d.date, emotionScore: d.cycle.emotionScore, stage: d.cycle.stage }));

    // 要算報酬的股票 = 候選 + 龍虎榜（去重，逐檔一次）
    const retItems = new Map<string, { code: string; symbol: string; board: CnBoardKind }>();
    for (const c of baseCandidates) retItems.set(c.code, { code: c.code, symbol: c.symbol, board: c.board });
    for (const s of lhb?.stocks ?? []) {
      if (!retItems.has(s.code)) retItems.set(s.code, { code: s.code, symbol: symbolOf(s.code, s.board), board: s.board });
    }
    const returns = await loadDateReturns(date, [...retItems.values()]);

    // 連板梯隊（非 ST、板數降冪 top10，可點）
    const ladder = (pool?.limitUp ?? [])
      .filter((e) => !e.isST)
      .sort((a, b) => b.consecBoards - a.consecBoards || (b.sealAmountCny ?? 0) - (a.sealAmountCny ?? 0))
      .slice(0, 12)
      .map((e) => ({ code: e.symbol, symbol: symbolOf(e.symbol, e.board), name: e.name, consecBoards: e.consecBoards, industry: e.industry, isOneWord: e.isOneWord }));

    // 龍虎榜：淨買超排序（淨買在前、賣超落底），保留 verdict/warnings，附報酬
    const lhbStocks = (lhb?.stocks ?? [])
      .map((s) => ({ s, sig: lhbSignal(s) }))
      .sort((a, b) => (b.s.netAmt ?? -Infinity) - (a.s.netAmt ?? -Infinity))
      .map(({ s, sig }) => ({
        code: s.code, symbol: symbolOf(s.code, s.board), name: s.name, board: s.board,
        changeRate: s.changeRate, netAmt: s.netAmt, reason: s.reason,
        verdict: sig.verdict, warnings: sig.warnings,
        buySeats: s.seats.buy.slice(0, 5).map((t) => ({ name: t.label ?? t.deptName, type: t.type, netAmt: t.netAmt })),
        sellSeats: s.seats.sell.slice(0, 5).map((t) => ({ name: t.label ?? t.deptName, type: t.type, netAmt: t.netAmt })),
        perf: perf(returns.get(s.code)?.returns ?? null),
      }));

    // 候選股盤面資訊（當日漲幅/股價/產業/連板/成交額）— DailyCandidate 本身沒有，
    // 從漲停池∪炸板∪跌停∪龍虎榜 join 補上，讓卡片能像台股掃描卡顯示 headline 漲幅。
    const infoByCode = new Map<string, { changePct: number | null; close: number | null; industry: string | null; consecBoards: number | null; turnoverCny: number | null; isOneWord: boolean }>();
    for (const e of pool?.limitUp ?? []) infoByCode.set(e.symbol, { changePct: e.pct, close: e.close, industry: e.industry, consecBoards: e.consecBoards, turnoverCny: e.turnoverCny, isOneWord: e.isOneWord });
    for (const e of pool?.broken ?? []) if (!infoByCode.has(e.symbol)) infoByCode.set(e.symbol, { changePct: e.pct, close: e.close, industry: e.industry, consecBoards: null, turnoverCny: null, isOneWord: false });
    for (const e of pool?.limitDown ?? []) if (!infoByCode.has(e.symbol)) infoByCode.set(e.symbol, { changePct: e.pct, close: e.close, industry: e.industry, consecBoards: null, turnoverCny: null, isOneWord: false });
    for (const s of lhb?.stocks ?? []) if (!infoByCode.has(s.code)) infoByCode.set(s.code, { changePct: s.changeRate, close: s.close, industry: null, consecBoards: null, turnoverCny: s.accumAmount, isOneWord: false });

    // 候選股附報酬 + 盤面資訊 + 補中文名/產業（裸代號從 stocklist 查回；漲幅/收盤從 pool 缺則用 K 線當日報價補）
    const cnMeta = await loadCnStockMeta();
    const candidates = baseCandidates.map((c) => {
      const meta = cnMeta.get(c.code);
      const poolInfo = infoByCode.get(c.code) ?? null;
      const q = returns.get(c.code)?.quote ?? null;
      // pool（漲停/炸板/龍虎榜）權威優先；缺的用 K 線當日報價 / stocklist 補（主力流入/波段股就靠這個）
      const info = {
        changePct: poolInfo?.changePct ?? q?.changePct ?? null,
        close: poolInfo?.close ?? q?.close ?? null,
        industry: poolInfo?.industry ?? meta?.industry ?? null,
        consecBoards: poolInfo?.consecBoards ?? null,
        turnoverCny: poolInfo?.turnoverCny ?? null,
        isOneWord: poolInfo?.isOneWord ?? false,
      };
      const hasInfo = info.changePct != null || info.close != null || info.industry != null || info.consecBoards != null;
      return {
        ...c,
        name: c.name && c.name !== c.code ? c.name : (meta?.name || c.name),
        perf: perf(returns.get(c.code)?.returns ?? null),
        info: hasInfo ? info : null,
      };
    });

    // action/avoid：daily 有就用；歷史日合成（tier A 前 5 當 action、無 avoid 名單）
    const actionList = daily?.actionList ?? candidates.filter((c) => c.tier === 'A').slice(0, 5)
      .map((c) => ({ symbol: c.code, name: c.name, tier: c.tier, mode: c.mode, note: c.reasons[0] ?? '' }));

    return NextResponse.json({
      ok: true,
      date,
      availableDates: dates,
      analysisPresent: daily?.analysisPresent ?? false,
      marketMood: daily?.marketMood ?? (breadth ? {
        stage: breadth.cycle.stage, stageLabel: breadth.cycle.stageLabel,
        emotionScore: breadth.cycle.emotionScore, strategyLabel: breadth.cycle.strategyLabel,
        positionPct: breadth.cycle.positionPct, narrative: null,
      } : null),
      breadth: breadth?.breadth ?? null,
      stats: pool?.stats ?? null,
      series,
      themes: daily?.themes ?? [],
      candidates,
      actionList,
      avoidList: daily?.avoidList ?? [],
      ladder,
      boards: boards ? {
        industries: boards.industries.slice(0, 10),
        concepts: boards.concepts.slice(0, 10),
      } : null,
      lhb: { date: lhb?.date ?? null, detailFetched: lhb?.detailFetched ?? false, stocks: lhbStocks },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'day route 失敗' }, { status: 500 });
  }
}
