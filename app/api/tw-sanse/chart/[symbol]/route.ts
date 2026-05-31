import { apiOk, apiError } from '@/lib/api/response';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { computeSanSeChart, TW_TIER_THRESHOLDS } from '@/lib/cn-sanse/indicators';
import { fetchTwDayExtras } from '@/lib/cn-sanse/twDayExtras';
import { evalConditions } from '@/lib/cn-sanse/conditions';
import type { Candle } from '@/types';

export const runtime = 'nodejs';

// 台股三色資金走圖 — 鏡像 /api/cn-sanse/chart，但：
//   - K 線讀 data/candles/TW/{symbol}.json（透過 blob-aware readCandleFile）
//   - 大盤指數用 ^TWII（主力狀態F 的中線強勢需要）
//   - 捕撈季節「4 級彩柱」用台股周轉率（= 換手率，成交量÷發行股數）+ 台股校準門檻，
//     金叉死叉箭頭 + 動能柱照常（純 OHLCV）
// 純視覺疊圖；不進選股流程（不違反書本鐵則 #5）。

/** 補上市場後綴：2330 → 2330.TW；已有 .TW/.TWO 或指數(^開頭)則原樣 */
function normalizeTwSymbol(s: string): string {
  if (/^\^/.test(s)) return s;                       // ^TWII 加權指數 → 原樣（與陸股 000001.SS 對等）
  return /\.(TW|TWO)$/i.test(s) ? s : `${s}.TW`;
}

/** 依序試 .TW / .TWO，回第一個有足夠 K 線的（^ 指數直接讀） */
async function loadTwCandles(symbol: string): Promise<{ key: string; candles: Candle[] } | null> {
  const candidates = /^\^/.test(symbol) || /\.(TW|TWO)$/i.test(symbol)
    ? [symbol]
    : [`${symbol}.TW`, `${symbol}.TWO`];
  for (const key of candidates) {
    const data = await readCandleFile(key, 'TW');
    if (data?.candles && data.candles.length >= 60) return { key, candles: data.candles };
  }
  return null;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ symbol: string }> },
) {
  const { symbol: raw } = await params;
  const symbol = normalizeTwSymbol(raw);
  // 接受 4-6 位數台股代號 + .TW/.TWO，或 ^TWII 加權指數（指數三色為退化值但與陸股 000001 行為一致）
  if (!/^(\^[A-Za-z]+|\d{4,6}\.(TW|TWO))$/i.test(symbol)) return apiError('代號格式錯誤', 400);

  // asOf：走圖步進時截斷到該日，讓標記/條件跟著步進位置重算（不給=最新全段）
  const asOf = new URL(req.url).searchParams.get('asOf');

  try {
    const loaded = await loadTwCandles(raw);
    if (!loaded) return apiError('本地K線不足', 404);
    const allCandles = loaded.candles;
    const candles = asOf ? allCandles.filter((c) => c.date <= asOf) : allCandles;
    if (candles.length < 60) return apiError('本地K線不足（截斷後）', 404);

    // 大盤指數 ^TWII → 按日期對齊個股 K（主力狀態F 中線強勢需要）；前向填補缺漏日
    let indexClose: number[] | undefined;
    const idxData = await readCandleFile('^TWII', 'TW');
    if (idxData?.candles?.length) {
      const idxMap = new Map(idxData.candles.map((c) => [c.date, c.close]));
      let last = NaN;
      indexClose = candles.map((c) => { const v = idxMap.get(c.date); if (v != null) last = v; return last; });
    }

    // 捕撈季節 4 級彩柱：台股周轉率（成交量張×1000÷發行股數）+ 台股校準門檻。
    // 抓不到發行股數（FinMind miss）→ extras=undefined → 只少彩柱，箭頭/動能柱照常。
    const extras = await fetchTwDayExtras(loaded.key, candles);

    // 指標用全段算後再截最近 250 根（夠畫圖且輕量）
    const chart = computeSanSeChart(candles, indexClose, extras, TW_TIER_THRESHOLDS);
    const tail = <T,>(a: T[]) => a.slice(-250);
    const cutoff = tail(chart.candles)[0].time;
    const afterCut = <T extends { time: string }>(a: T[]) => a.filter((p) => p.time >= cutoff);
    const z = chart.zhuli;
    const xt = chart.xysTiers;
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    return apiOk({
      symbol: loaded.key,
      lastDate: last.date,
      price: last.close,
      changePct: prev?.close ? +(((last.close - prev.close) / prev.close) * 100).toFixed(2) : 0,
      scores: chart.scores,
      conditions: evalConditions(candles, indexClose),
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
