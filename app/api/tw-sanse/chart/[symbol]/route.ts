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
    // try/catch：盤中個股 L1 檔可能正被 eod-settle/repair cron 寫到一半 → JSON parse 失敗。
    // 不可讓它炸掉整條 route（會 404 → 前端三色面板整片空白）；跳過試下一個 suffix / 線上抓。
    try {
      const data = await readCandleFile(key, 'TW');
      if (data?.candles && data.candles.length >= 60) return { key, candles: data.candles };
    } catch { /* 檔案讀取/解析失敗 → 試下一個候選 */ }
  }
  // 不在掃描宇宙（無本地/blob K 線）→ 用與 /api/stock 同款 pipeline 線上抓，讓任何台股都能看三色
  // （單檔 walk-the-chart，非全市場掃描；dataProvider 會順手快取進 L1，下次走本地）
  for (const key of candidates) {
    try {
      const { dataProvider } = await import('@/lib/datasource/MultiMarketProvider');
      const fetched = await dataProvider.getHistoricalCandles(key, '3y', undefined, '1d');
      if (Array.isArray(fetched) && fetched.length >= 60) return { key, candles: fetched };
    } catch { /* 試下一個 suffix */ }
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
    // asOf 指向「今天以前」= 走圖步進歷史 → 凍結在該根、不注入今日盤中半根。
    // 不可用 candles.length < allCandles.length 判定：當 asOf 正好等於最新封存日時沒有 bar 被截掉，
    // 會誤判成「非歷史」而注入今日盤中半根，使訊號面板比畫面上的 K 線/掃描卡多算一根 →
    // 昨日的單根金叉(CROSS)失效、共振組數崩掉(3/3→1/3)、面板與掃描卡互相打架。
    const todayTW = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
    const isHistorical = !!asOf && asOf < todayTW;

    // 盤中注入：非步進歷史 + 封存最後一根 < 今日 + L2 有今日 → append 今日 bar（個股 + ^TWII），
    // 讓雙B / 主力狀態F / 捕撈季節彩柱延伸到今日（否則盤中今日那根沒三色數據，線停在前一封存日）。
    // 對齊 cn-sanse/chart 與 scanTwSanSe 盤中模式。extras 由 fetchTwDayExtras 從 candles 自算 →
    // 今日 bar 一旦 push 進去，amount/vol/turnover 今日值自動含入（不需另抓即時換手率）。
    let injectedTodayDate: string | undefined;
    let todayIndexClose: number | undefined;
    if (!isHistorical) {
      try {
        const { readIntradaySnapshot } = await import('@/lib/datasource/IntradayCache');
        const { isTradingDay } = await import('@/lib/utils/tradingDay');
        const lastBar = candles[candles.length - 1];
        if (lastBar && lastBar.date < todayTW && isTradingDay(todayTW, 'TW')) {
          const snap = await readIntradaySnapshot('TW', todayTW);
          if (snap && snap.date === todayTW) {
            const pureCode = loaded.key.replace(/\.(TW|TWO)$/i, '');
            const sq = snap.quotes.find((q) => q.symbol.split('.')[0] === pureCode);
            if (sq && sq.close > 0) {
              candles.push({ date: todayTW, open: sq.open, high: sq.high, low: sq.low, close: sq.close, volume: sq.volume });
              injectedTodayDate = todayTW;
            }
            // 指數今日 close：^TWII 完整比對（split 後唯一，不與個股裸碼撞）
            const iq = snap.quotes.find((q) => q.symbol === '^TWII');
            if (iq && iq.close > 0) todayIndexClose = iq.close;
          }
        }
      } catch { /* 注入失敗不致命，退回封存 */ }
    }

    // 大盤指數 ^TWII → 按日期對齊個股 K（主力狀態F 中線強勢需要）；前向填補缺漏日。
    // try/catch：^TWII 檔可能正被 cron 寫/壞 → 讀失敗時 indexClose 留 undefined，
    // 主力狀態F 中線強勢退化但圖/條件照常算，不可讓它 404 整條 route。
    let indexClose: number[] | undefined;
    try {
      const idxData = await readCandleFile('^TWII', 'TW');
      if (idxData?.candles?.length) {
        const idxMap = new Map(idxData.candles.map((c) => [c.date, c.close]));
        if (injectedTodayDate && todayIndexClose != null) idxMap.set(injectedTodayDate, todayIndexClose);
        let last = NaN;
        indexClose = candles.map((c) => { const v = idxMap.get(c.date); if (v != null) last = v; return last; });
      }
    } catch { /* ^TWII 讀取失敗 → 退化為無大盤對齊 */ }

    // 捕撈季節 4 級彩柱：台股周轉率（成交量張×1000÷發行股數）+ 台股校準門檻。
    // 抓不到發行股數（FinMind miss）→ extras=undefined → 只少彩柱，箭頭/動能柱照常。
    // 4s 超時：彩柱是可選視覺、conditions/圖根本不需要它。開盤 FinMind 限流時 getSharesIssued 可卡到 15s，
    // 不可讓它擋住整個三色回應（連帶 conditions 一起慢）→ 超時就退回 undefined（無彩柱），圖/訊號照常秒出。
    const extras = await Promise.race([
      fetchTwDayExtras(loaded.key, candles).catch(() => undefined),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 4000)),
    ]);

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
