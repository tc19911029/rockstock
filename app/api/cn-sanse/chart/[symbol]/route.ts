import { apiOk, apiError } from '@/lib/api/response';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { CN_STOCKS } from '@/lib/scanner/cnStocks';
import { computeSanSeChart } from '@/lib/cn-sanse/indicators';
import { evalConditions } from '@/lib/cn-sanse/conditions';
import { fetchDayExtrasCached } from '@/lib/cn-sanse/cnDayExtras';
import { fetchQuote, buildTodayBarFromQuote } from '@/lib/cn-sanse/cnQuote';
import { getLimitMovePct } from '@/lib/utils/limitRules';
import type { Candle } from '@/types';

export const runtime = 'nodejs';

// 股名對照：用已進 git 的 CN_STOCKS（Vercel 也讀得到），取代本地 data/cn_stocklist.json
let nameMap: Map<string, { name: string; industry: string }> | null = null;
function lookupStock(symbol: string): { name: string; industry: string } {
  if (!nameMap) {
    nameMap = new Map(CN_STOCKS.map((s) => [s.symbol, { name: s.name, industry: '' }]));
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
    // K 線走 Blob-aware adapter（本地讀 data/candles/CN，Vercel 讀 Blob），不再直接 fs 讀本地檔
    let allCandles: Candle[] | undefined;
    const file = await readCandleFile(symbol, 'CN');
    if (file?.candles) allCandles = file.candles;
    // 不在掃描宇宙（無本地 L1，如 301205）→ 用與 /api/stock 同款 pipeline 線上抓，讓任何股票都能看三色
    // （單檔 walk-the-chart，非全市場掃描，不違反鐵則 #3；dataProvider 會順手快取進 L1，下次就走本地）
    if (!Array.isArray(allCandles) || allCandles.length < 60) {
      try {
        const { dataProvider } = await import('@/lib/datasource/MultiMarketProvider');
        const fetched = await dataProvider.getHistoricalCandles(symbol, '3y', undefined, '1d');
        if (Array.isArray(fetched) && fetched.length >= 60) allCandles = fetched;
      } catch { /* 線上抓也失敗 → 下面回 404 */ }
    }
    if (!Array.isArray(allCandles) || allCandles.length < 60) {
      return apiError('本地K線不足', 404);
    }
    let candles = asOf ? allCandles.filter((c) => c.date <= asOf) : allCandles;
    // 深度走圖：asOf 早於目前載入的最早一根 → 截斷後 < 60。主要救「非宇宙股」（無本地 L1、線上抓預設 '3y'，
    // 夠畫最新圖但回放退不過 ~3 年）→ 此時補抓 'max' 更深歷史再試，讓它們深度回放也不報錯。
    // 常見路徑（最新圖 / 近端回放 / 宇宙股深 L1）candles 不會 < 60，不進這支、無額外延遲。
    if (asOf && candles.length < 60) {
      try {
        const { dataProvider } = await import('@/lib/datasource/MultiMarketProvider');
        const deeper = await dataProvider.getHistoricalCandles(symbol, 'max', undefined, '1d');
        if (Array.isArray(deeper) && deeper.length > allCandles.length) {
          allCandles = deeper;
          candles = deeper.filter((c) => c.date <= asOf);
        }
      } catch { /* 抓不到就維持原樣 → 下面回 404 */ }
    }
    if (candles.length < 60) return apiError('本地K線不足（截斷後）', 404);
    // asOf 指向「今天以前」= 步進歷史 → 凍結在該根、略過即時報價/換手率、不注入今日盤中半根。
    // 不可用 candles.length < allCandles.length 判定：asOf 正好等於最新封存日時沒 bar 被截 →
    // 誤判成「非歷史」而注入今日盤中半根，使訊號面板比畫面 K 線多算一根、共振組數崩掉、與掃描卡打架。
    const todayCN = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const isHistorical = !!asOf && asOf < todayCN;

    // 量能彩柱要 turnover 歷史 → 一律抓（走 per-symbol 快取，10min TTL）：讓走圖步進歷史的任一位置也有彩柱，
    //   又不必每步重打騰訊。騰訊只回最近 ~640 根（~2.6 年）→ 傳入 allCandles（本地 L1 全段，可達 ~5 年），
    //   由 fetchDayExtrasCached 用「校準後的本地 volume」補騰訊窗口外的更舊日期 → 深度回放也有彩柱。
    //   台股 route 本地自算 turnover 故走圖恆有彩柱，此處讓陸股對齊。
    //   （歷史背景：早期 asOf<今日 一律略過 → CN 專屬「非交易日整片彩柱消失」bug；中間改「只看最新收盤才抓」仍會在
    //    走圖步退一天就消失 → 現用快取一律抓，徹底對齊台股。）
    // 即時報價 fetchQuote 只在 !isHistorical 抓：僅用於今日 bar 注入（非宇宙股）+ 報價列，步進歷史不需要。
    // 4s 超時：首抓（快取 miss）騰訊慢時別把整個三色回應（連 conditions）拖住 → 超時退回安全值（空 Map / null）；
    //   快取命中則即時。兩函式失敗本身也回安全值不 throw，故只需擋「慢」、不需擋「炸」。
    const EMPTY_EXTRAS = new Map<string, { amount: number; vol: number; turnover: number }>();
    const [m, quote] = await Promise.race([
      Promise.all([
        fetchDayExtrasCached(symbol, allCandles), // allCandles=本地 L1 全段 → 補騰訊窗口外的更舊日期彩柱
        isHistorical ? Promise.resolve(null) : fetchQuote(symbol),
      ]),
      new Promise<[typeof EMPTY_EXTRAS, null]>((resolve) => setTimeout(() => resolve([EMPTY_EXTRAS, null]), 4000)),
    ]);

    // 盤中/盤後注入今日那根：封存最後一根 < 今日 → append 今日 bar，讓主力狀態F / 捕撈季節 / 雙B 訊號延伸到今日。
    //   今日那根「優先用騰訊即時報價」(buildTodayBarFromQuote)，L2 全市場快照只當 fallback：
    //   L2 是單點快照（每檔 O=H=L=C 平棒），且盤中刷新一旦落後（實見凍在 09:27 開盤前集合競價價、整個早盤沒更新），
    //   注進來的「今日收盤」會比即時報價舊好幾 % → 雙B 拿這個舊收盤比智能交易線會誤判跌破/突破（表頭顯示即時價
    //   在線上、訊號卻說跌破，自相矛盾）。即時報價永遠最新、有真實高低，buildTodayBarFromQuote 又把量對齊歷史單位，
    //   比 L2 平棒更貼近真實今日 bar，也更符合鐵則 #4（走圖 L3 獨立於掃描 L2）。報價無效（盤前 open=0／停牌／限流）
    //   → 回 null → 退回 L2 快照。大盤指數今日 close 仍走 L2（fetchQuote 只抓個股）。
    let injectedTodayDate: string | undefined;
    let todayIndexClose: number | undefined;
    if (!isHistorical) {
      try {
        const { readIntradaySnapshot } = await import('@/lib/datasource/IntradayCache');
        const { isTradingDay } = await import('@/lib/utils/tradingDay');
        const lastBar = candles[candles.length - 1];
        if (lastBar && lastBar.date < todayCN && isTradingDay(todayCN, 'CN')) {
          const snap = await readIntradaySnapshot('CN', todayCN);
          const snapOk = !!snap && snap.date === todayCN;
          const pureCode = symbol.replace(/\.(SS|SZ)$/i, '');
          // ① 優先即時報價（完整 OHLC、永遠最新；盤前 open=0／停牌／限流時回 null）
          const todayBar = buildTodayBarFromQuote(quote, candles.slice(-20), todayCN);
          // ② fallback：L2 全市場快照。個股用裸碼存、大盤指數用完整代號存（000001.SS / 399001.SZ）。
          //    先比完整代號（指數命中）再退裸碼（個股命中）→ 否則 000001.SS 上證會撞到 000001 平安銀行，
          //    把平安銀行今日 bar（~11）注進上證指數走圖（~4083），盤中最後一根爆跌 -99%。
          const sq = snapOk
            ? (snap!.quotes.find((q) => q.symbol === symbol.toUpperCase()) ?? snap!.quotes.find((q) => q.symbol === pureCode))
            : undefined;
          if (todayBar) {
            candles.push(todayBar);
            injectedTodayDate = todayCN;
          } else if (sq && sq.close > 0) {
            candles.push({ date: todayCN, open: sq.open, high: sq.high, low: sq.low, close: sq.close, volume: sq.volume });
            injectedTodayDate = todayCN;
          }
          // 指數今日 close：完整 symbol 比對（避免 000001 撞深市平安銀行 000001.SZ）。L2 快照恆含上證指數。
          const iq = snapOk ? snap!.quotes.find((q) => q.symbol === '000001.SS') : undefined;
          if (iq && iq.close > 0) todayIndexClose = iq.close;
        }
      } catch { /* 注入失敗不致命，退回封存 */ }
    }

    // 大盤指數（上證 000001.SS）→ 按日期對齊個股 K（主力狀態F 的中線強勢需要）
    let indexClose: number[] | undefined;
    try {
      const idxFile = await readCandleFile('000001.SS', 'CN');
      const idx = idxFile?.candles ?? [];
      const idxMap = new Map(idx.map((c) => [c.date, c.close]));
      if (injectedTodayDate && todayIndexClose != null) idxMap.set(injectedTodayDate, todayIndexClose);
      let last = NaN;
      indexClose = candles.map((c) => { const v = idxMap.get(c.date); if (v != null) last = v; return last; });
    } catch { /* 無指數 → 主力狀態F 不計算 */ }

    // 成交額/成交量/換手率（捕撈季節量能彩柱）→ 對齊 candles 日期（含今日注入那根，騰訊 qfq 已有當日）
    let extras;
    if (m.size) {
      extras = {
        amount: candles.map((c) => m.get(c.date)?.amount ?? NaN),
        vol: candles.map((c) => m.get(c.date)?.vol ?? NaN),
        turnover: candles.map((c) => m.get(c.date)?.turnover ?? NaN),
      };
    }

    // 漲跌停幅度（創業板/科創 20%、主板 10%）→ K 線漲停/大漲上色門檻；走圖可看任何股，故依代號傳入。
    const limitPct = getLimitMovePct('CN', symbol);
    // 只回最近 250 根（夠畫圖且輕量），但指標用全段算後再截
    const chart = computeSanSeChart(candles, indexClose, extras, undefined, limitPct);
    const tail = <T,>(a: T[]) => a.slice(-250);
    const cutoff = tail(chart.candles)[0].time;
    const afterCut = <T extends { time: string }>(a: T[]) => a.filter((p) => p.time >= cutoff);
    const z = chart.zhuli;
    const xt = chart.xysTiers;
    const meta = lookupStock(symbol);
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
      conditions: evalConditions(candles, indexClose, undefined, limitPct), // 三色條件報告（給中間條件面板）

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
