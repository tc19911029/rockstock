import { promises as fs } from 'node:fs';
import path from 'node:path';
import { apiOk, apiError } from '@/lib/api/response';
import { getLocalCandleDir } from '@/lib/datasource/LocalCandleStore';
import { computeSanSeChart } from '@/lib/cn-sanse/indicators';
import { evalConditions } from '@/lib/cn-sanse/conditions';
import { fetchDayExtras } from '@/lib/cn-sanse/cnDayExtras';
import { fetchQuote } from '@/lib/cn-sanse/cnQuote';
import type { Candle } from '@/types';

export const runtime = 'nodejs';

let nameMap: Map<string, { name: string; industry: string }> | null = null;
async function lookupStock(symbol: string): Promise<{ name: string; industry: string }> {
  if (!nameMap) {
    try {
      const raw = await fs.readFile(path.join(process.cwd(), 'data/cn_stocklist.json'), 'utf8');
      nameMap = new Map((JSON.parse(raw).stocks ?? []).map((s: { symbol: string; name: string; industry?: string }) => [s.symbol, { name: s.name, industry: s.industry ?? '' }]));
    } catch { nameMap = new Map(); }
  }
  return nameMap.get(symbol) ?? { name: symbol, industry: '' };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ symbol: string }> },
) {
  const { symbol } = await params;
  if (!/^\d{6}\.(SS|SZ)$/i.test(symbol)) return apiError('代號格式錯誤', 400);

  // asOf：走圖步進時截斷到該日，讓標記/條件/訊號跟著步進的位置重算（不給=最新全段）
  const asOf = new URL(req.url).searchParams.get('asOf');

  try {
    const dir = getLocalCandleDir('CN');
    const raw = await fs.readFile(path.join(dir, `${symbol}.json`), 'utf8');
    const allCandles = JSON.parse(raw)?.candles as Candle[] | undefined;
    if (!Array.isArray(allCandles) || allCandles.length < 60) {
      return apiError('本地K線不足', 404);
    }
    const candles = asOf ? allCandles.filter((c) => c.date <= asOf) : allCandles;
    if (candles.length < 60) return apiError('本地K線不足（截斷後）', 404);
    // 真的被截 = 步進歷史 → 略過即時報價/換手率（避免每步打 EastMoney 拖慢）；最新全段才抓即時
    const isHistorical = !!asOf && candles.length < allCandles.length;

    // 盤中注入：非步進歷史 + 封存最後一根 < 今日 + L2 有今日 → append 今日 bar（個股 + 上證指數），
    // 讓主力狀態F / 捕撈季節副圖延伸到今日（否則盤中今日那根沒三色數據）。對齊 scanSanSe 盤中模式。
    let injectedTodayDate: string | undefined;
    let todayIndexClose: number | undefined;
    if (!isHistorical) {
      try {
        const { readIntradaySnapshot } = await import('@/lib/datasource/IntradayCache');
        const { isTradingDay } = await import('@/lib/utils/tradingDay');
        const todayCN = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
        const lastBar = candles[candles.length - 1];
        if (lastBar && lastBar.date < todayCN && isTradingDay(todayCN, 'CN')) {
          const snap = await readIntradaySnapshot('CN', todayCN);
          if (snap && snap.date === todayCN) {
            const pureCode = symbol.replace(/\.(SS|SZ)$/i, '');
            const sq = snap.quotes.find((q) => q.symbol === pureCode); // 個股裸碼
            if (sq && sq.close > 0) {
              candles.push({ date: todayCN, open: sq.open, high: sq.high, low: sq.low, close: sq.close, volume: sq.volume });
              injectedTodayDate = todayCN;
            }
            // 指數今日 close：完整 symbol 比對（避免 000001 撞深市平安銀行 000001.SZ）
            const iq = snap.quotes.find((q) => q.symbol === '000001.SS');
            if (iq && iq.close > 0) todayIndexClose = iq.close;
          }
        }
      } catch { /* 注入失敗不致命，退回封存 */ }
    }

    // 大盤指數（上證 000001.SS）→ 按日期對齊個股 K（主力狀態F 的中線強勢需要）
    let indexClose: number[] | undefined;
    try {
      const idxRaw = await fs.readFile(path.join(dir, '000001.SS.json'), 'utf8');
      const idx = JSON.parse(idxRaw)?.candles as Candle[];
      const idxMap = new Map(idx.map((c) => [c.date, c.close]));
      if (injectedTodayDate && todayIndexClose != null) idxMap.set(injectedTodayDate, todayIndexClose);
      let last = NaN;
      indexClose = candles.map((c) => { const v = idxMap.get(c.date); if (v != null) last = v; return last; });
    } catch { /* 無指數 → 主力狀態F 不計算 */ }

    // 成交額/成交量/換手率（捕撈季節量能彩柱）+ 即時報價列 — 最新全段才抓；步進歷史只算本地
    let extras;
    const [m, quote] = isHistorical
      ? [new Map<string, { amount: number; vol: number; turnover: number }>(), null]
      : await Promise.all([fetchDayExtras(symbol), fetchQuote(symbol)]);
    if (m.size) {
      extras = {
        amount: candles.map((c) => m.get(c.date)?.amount ?? NaN),
        vol: candles.map((c) => m.get(c.date)?.vol ?? NaN),
        turnover: candles.map((c) => m.get(c.date)?.turnover ?? NaN),
      };
    }

    // 只回最近 250 根（夠畫圖且輕量），但指標用全段算後再截
    const chart = computeSanSeChart(candles, indexClose, extras);
    const tail = <T,>(a: T[]) => a.slice(-250);
    const cutoff = tail(chart.candles)[0].time;
    const afterCut = <T extends { time: string }>(a: T[]) => a.filter((p) => p.time >= cutoff);
    const z = chart.zhuli;
    const xt = chart.xysTiers;
    const meta = await lookupStock(symbol);
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    return apiOk({
      symbol,
      name: meta.name,
      industry: meta.industry,
      lastDate: last.date,
      price: last.close,
      changePct: prev?.close ? +(((last.close - prev.close) / prev.close) * 100).toFixed(2) : 0,
      quote, // 即時報價列（量比/換手/市盈/總額/總值…）；非交易時段為 null
      scores: chart.scores,
      conditions: evalConditions(candles, indexClose), // 三色條件報告（給中間條件面板）

      chart: {
        candles: tail(chart.candles),
        zhineng: tail(chart.zhineng),
        zb4: tail(chart.zb4),
        zb5: tail(chart.zb5),
        duokong: tail(chart.duokong),
        mainMarkers: chart.mainMarkers.filter((m) => m.time >= cutoff),
        xys0: tail(chart.xys0),
        xys1: tail(chart.xys1),
        xys2: tail(chart.xys2),
        subMarkers: chart.subMarkers.filter((m) => m.time >= cutoff),
        zhuli: z && {
          midStrength: tail(z.midStrength),
          midControl: tail(z.midControl),
          shortAttack: tail(z.shortAttack),
          shortOversold: tail(z.shortOversold),
          midOversold: tail(z.midOversold),
        },
        xysTiers: xt && {
          green: afterCut(xt.green),
          yellow: afterCut(xt.yellow),
          cyan: afterCut(xt.cyan),
          blue: afterCut(xt.blue),
        },
        latest: chart.latest,
      },
    });
  } catch {
    return apiError('找不到該股票本地K線', 404);
  }
}
