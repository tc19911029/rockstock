import { create } from 'zustand';
import {
  CandleWithIndicators,
  AccountState,
  AccountMetrics,
  RuleSignal,
  PerformanceStats,
  StockInfo,
  ChartSignalMarker,
} from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { detectCandleGaps } from '@/lib/datasource/validateCandles';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { isFundSymbol } from '@/lib/market/classify';
import { loadMockData } from '@/lib/data/mockData';
import { useSearchHistoryStore } from '@/store/searchHistoryStore';
import {
  createAccount,
  executeBuy,
  executeSell,
  computeMetrics,
  sharesFromPercent,
} from '@/lib/engines/tradeEngine';
import {
  TrendState,
  TrendPosition,
  SixConditionsResult,
} from '@/lib/analysis/trendAnalysis';
import { type ProhibitionResult } from '@/lib/rules/entryProhibitions';
import { type ShortSixConditionsResult } from '@/lib/analysis/shortAnalysis';
import { type WinnerPatternResult } from '@/lib/rules/winnerPatternRules';

// ── Extracted modules ──────────────────────────────────────────────────────────
import { buildState } from './replay/buildState';
import {
  precomputeMarkers,
  clearCachedMarkers,
  getCachedMarkers,
  setSignalStrengthMin as _setStrengthMin,
} from './replay/signalCache';
import { clearWinnerPatternsCache } from './replay/winnerPatternsCache';

const INITIAL_CAPITAL = 1_000_000;

const EMPTY_STATS: PerformanceStats = {
  totalTrades: 0, winCount: 0, lossCount: 0, winRate: 0,
  totalRealizedPnL: 0, totalReturnRate: 0, equityCurve: [],
};

interface ReplayStore {
  // ── Data ──────────────────────────────────────────────────
  allCandles: CandleWithIndicators[];
  currentIndex: number;
  visibleCandles: CandleWithIndicators[];
  currentStock: StockInfo | null;
  currentInterval: string;
  /** 從掃描結果載入時的訊號日，切換週期時用來定位 */
  targetDate: string | null;
  isLoadingStock: boolean;

  // ── Playback ──────────────────────────────────────────────
  isPlaying: boolean;
  playSpeed: number;

  // ── Trading ───────────────────────────────────────────────
  account: AccountState;
  metrics: AccountMetrics;
  stats: PerformanceStats;

  // ── Signals ───────────────────────────────────────────────
  currentSignals: RuleSignal[];
  chartMarkers: ChartSignalMarker[];
  signalStrengthMin: number;

  // ── Analysis ──────────────────────────────────────────────
  trendState: TrendState;
  trendPosition: TrendPosition;
  sixConditions: SixConditionsResult | null;
  prevSixConditions: SixConditionsResult | null;  // 前一根K棒的六條件（用於偵測變化）
  longProhibitions: ProhibitionResult | null;
  shortProhibitions: ProhibitionResult | null;
  shortConditions: ShortSixConditionsResult | null;
  winnerPatterns: WinnerPatternResult | null;

  // ── Polling（盤中自動刷新） ──────────────────────────────
  isPolling: boolean;

  // ── Data Integrity ───────────────────────────────────────
  /** K線資料斷層（日曆天數 > 10 天的gap） */
  dataGaps: Array<{ fromDate: string; toDate: string; calendarDays: number }>;

  // ── Actions ───────────────────────────────────────────────
  initData: () => void;
  loadStock: (symbol: string, interval?: string, period?: string, targetDate?: string) => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
  nextCandle: () => void;
  prevCandle: () => void;
  jumpToIndex: (index: number) => void;
  jumpToNextBuySignal: () => void;
  jumpToPrevBuySignal: () => void;
  startPlay: () => void;
  stopPlay: () => void;
  setPlaySpeed: (ms: number) => void;
  resetReplay: () => void;
  buy: (shares: number) => void;
  sell: (shares: number) => void;
  buyPercent: (percent: number) => void;
  sellPercent: (percent: number) => void;
  setSignalStrengthMin: (min: number) => void;
}

/** Always start replay at the latest (rightmost) candle */
function calcStartIndex(candles: CandleWithIndicators[]): number {
  return candles.length - 1;
}

// ── Polling（盤中自動刷新） ──────────────────────────────────
let pollingTimer: ReturnType<typeof setInterval> | null = null;

// ── loadStock race-guard：每次呼叫 +1，applyData 時檢查仍是當前 token 才寫入 ──
let _loadStockToken = 0;

/** 根據 interval 決定 polling 頻率 (ms) */
function getPollingInterval(interval: string): number {
  switch (interval) {
    case '1m':  return 15_000;  // 15 秒（接近手機 app 跳動感）
    case '5m':  return 30_000;  // 30 秒
    case '15m': return 45_000;  // 45 秒
    case '30m': return 60_000;  // 1 分鐘
    case '60m': return 90_000;  // 1.5 分鐘
    case '1d':  return 30_000;  // 30 秒（日K 即時報價 overlay，對齊分K 更新節奏）
    case '1wk': return 30_000;  // 30 秒（週K 聚合自日K）
    case '1mo': return 30_000;  // 30 秒（月K 聚合自日K）
    default:    return 0;
  }
}

export const useReplayStore = create<ReplayStore>((set, get) => ({
  allCandles: [],
  currentIndex: 0,
  visibleCandles: [],
  currentStock: null,
  currentInterval: '1d',
  targetDate: null,
  dataGaps: [],
  isLoadingStock: false,
  isPolling: false,
  isPlaying: false,
  playSpeed: 800,
  account: createAccount(INITIAL_CAPITAL),
  metrics: computeMetrics(createAccount(INITIAL_CAPITAL), 0),
  stats: EMPTY_STATS,
  currentSignals: [],
  chartMarkers: [],
  signalStrengthMin: 2,
  trendState: '盤整' as TrendState,
  trendPosition: '盤整觀望' as TrendPosition,
  sixConditions: null,
  prevSixConditions: null,
  longProhibitions: null,
  shortProhibitions: null,
  shortConditions: null,
  winnerPatterns: null,

  // ── Init with mock data ───────────────────────────────────
  initData: () => {
    const rawCandles = loadMockData();
    const allCandles = computeIndicators(rawCandles);
    precomputeMarkers(allCandles);
    const index = calcStartIndex(allCandles);
    const account = createAccount(INITIAL_CAPITAL);
    set({
      allCandles,
      currentIndex: index,
      currentInterval: '1d',
      targetDate: null,
      account,
      currentStock: { ticker: 'DEMO', name: '範例資料（模擬）' },
      ...buildState(allCandles, index, account),
    });
  },

  // ── Load real stock ──────────────────────────────────────
  loadStock: async (symbol: string, interval = '1d', period?: string, targetDate?: string) => {
    if (symbol === 'mock') {
      get().initData();
      return;
    }

    // 切換股票前先停止舊的 polling（ScanChartPanel 等外部呼叫路徑不經過 StockSelector）
    get().stopPolling();

    // race guard：每次呼叫拿一個 token，applyData 寫 store 前確認 token 仍然有效
    // 防止「連續切兩支股票時第一支 fetch 晚到把第二支結果蓋掉」
    const myToken = ++_loadStockToken;

    const defaultPeriod: Record<string, string> = {
      '1m': '5d', '5m': '60d', '15m': '60d', '30m': '60d', '60m': '6mo',
      '1d': '2y', '1wk': '5y', '1mo': '10y',
    };
    const p = period ?? defaultPeriod[interval] ?? '2y';
    const isMinuteInterval = ['1m', '5m', '15m', '30m', '60m'].includes(interval);

    set({ isLoadingStock: true, isPlaying: false });
    clearCachedMarkers();
    clearWinnerPatternsCache();

    /** 共用：把 API 回傳的 json 塞進 store（會檢查 race token） */
    const applyData = (json: { ticker: string; name: string; candles: unknown[] }, showLoading: boolean) => {
      // 已被新的 loadStock 取代 → 放棄寫入
      if (myToken !== _loadStockToken) return false;
      const allCandles = computeIndicators(json.candles as { date: string; open: number; high: number; low: number; close: number; volume: number }[]);
      if (allCandles.length === 0) return false;

      precomputeMarkers(allCandles);
      let index: number;
      if (targetDate) {
        // 分鐘K的 date 格式是 "YYYY-MM-DD HH:mm"，日K是 "YYYY-MM-DD"
        // 比較時統一截取前10碼（日期部分）
        const dateOf = (d: string) => d.slice(0, 10);
        const dateIdx = allCandles.findIndex(c => dateOf(c.date) === targetDate);
        if (dateIdx !== -1) {
          index = dateIdx;
        } else {
          let closest = -1;
          for (let i = allCandles.length - 1; i >= 0; i--) {
            if (dateOf(allCandles[i].date) <= targetDate) { closest = i; break; }
          }
          // 找不到精確日期時：若候選的最後一根 K 棒比 targetDate 還舊超過 30 天，
          // 代表本地資料嚴重落後（可能下載 cron 失敗），拋出明確錯誤而非默默顯示過時資料
          if (closest === -1) {
            const lastDate = allCandles[allCandles.length - 1]?.date;
            if (lastDate && dateOf(lastDate) < targetDate) {
              const daysGap = (new Date(targetDate).getTime() - new Date(dateOf(lastDate)).getTime()) / 86400000;
              if (daysGap > 30) {
                throw new Error(`K線本地資料僅到 ${dateOf(lastDate)}（落後 ${Math.round(daysGap)} 天），可能是每日下載尚未完成。請至「歷史資料」確認資料完整性，或等待下一個交易日自動更新。`);
              }
            }
            // 差距 <= 30 天時（如週末），往回找最接近的 K 棒
            for (let i = allCandles.length - 1; i >= 0; i--) {
              if (dateOf(allCandles[i].date) <= targetDate) { closest = i; break; }
            }
            if (closest === -1) closest = 0;
          }
          index = closest;
        }
      } else {
        index = calcStartIndex(allCandles);
      }
      // 偵測資料斷層（日K限定，週/月K不檢查因為聚合後自然有gap）
      const gaps = interval === '1d' ? detectCandleGaps(allCandles, 15) : [];
      // 末端斷層：最後一根 K 棒距今超過 15 天（資料過舊，容忍農曆新年/國慶等長假）
      if (interval === '1d' && allCandles.length > 0) {
        const lastDate = allCandles[allCandles.length - 1].date;
        const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
        const diffMs = new Date(todayStr + 'T12:00:00').getTime() - new Date(lastDate + 'T12:00:00').getTime();
        const diffDays = Math.round(diffMs / 86400000);
        if (diffDays > 15) {
          gaps.push({ fromDate: lastDate, toDate: todayStr, calendarDays: diffDays });
        }
      }

      const account = createAccount(INITIAL_CAPITAL);
      // 名稱查詢逾時時 API 會回空名（server 冷啟動 nameMap 還沒建好）：
      // 同一檔已有名字就別被空值洗掉（背景更新晚到帶空名的情況）；換股票時不沿用舊名
      const prevStock = get().currentStock;
      const keptName = json.name
        || (prevStock?.ticker === json.ticker ? prevStock.name : '')
        || '';
      set({
        allCandles,
        currentIndex: index,
        currentInterval: interval,
        targetDate: targetDate ?? null,
        account,
        dataGaps: gaps,
        currentStock: { ticker: json.ticker, name: keptName },
        ...(showLoading ? { isLoadingStock: false } : {}),
        ...buildState(allCandles, index, account),
      });
      // 記錄到「最近搜尋」：不論從搜尋框、掃描清單、候選池或 URL 進來都留紀錄；
      // 排除指數（^TWII / ^IXIC / 000001.SS 等），代號去掉市場後綴讓清單乾淨
      const isIndex = /^\^|^000001\.SS$/.test(json.ticker);
      if (!isIndex) {
        const cleanSymbol = json.ticker.replace(/\.(TW|TWO|SS|SZ)$/i, '');
        useSearchHistoryStore.getState().record(cleanSymbol, keptName);
      }
      return true;
    };

    /** 冷啟動 / dev 編譯期 / 上游瞬斷時，API 偶爾暫回 0 筆或 5xx → 退避重試（最多 3 次）才放棄。
     *  回傳含 candles 的 json，或 null（重試後仍無資料）。延遲只在失敗時發生。 */
    const fetchCandlesRetry = async (
      url: string, tries = 3,
    ): Promise<{ ticker: string; name: string; candles: unknown[] } | null> => {
      for (let i = 0; i < tries; i++) {
        try {
          const res = await fetch(url);
          if (res.ok) {
            const json = await res.json();
            if (Array.isArray(json?.candles) && json.candles.length > 0) return json;
          }
        } catch { /* 重試 */ }
        if (i < tries - 1) await new Promise((r) => setTimeout(r, 600 * (i + 1)));
      }
      return null;
    };

    try {
      // ── 日K 混合模式：先讀本地秒開 → 背景 API 更新 ──
      if (!isMinuteInterval) {
        // Step 1: 嘗試本地檔案（瞬間回應；冷啟動/編譯期暫回 0 會自動退避重試）
        const scanDateParam = targetDate ? `&scanDate=${encodeURIComponent(targetDate)}` : '';
        const localJson = await fetchCandlesRetry(
          `/api/stock?symbol=${encodeURIComponent(symbol)}&interval=${interval}&period=${p}&local=1${scanDateParam}`
        );
        const localLoaded = localJson ? applyData(localJson, true) : false;

        if (localLoaded) {
          // 本地已秒開 → 背景靜默更新今日 K 棒（不阻塞 UI）
          // 一律走 local=1：才會觸發 L2/即時報價注入今日 K，否則 MultiMarketProvider 只回歷史
          const bgSymbol = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
          const bgInterval = interval;
          fetch(`/api/stock?symbol=${encodeURIComponent(symbol)}&interval=${interval}&period=${p}&local=1`)
            .then(r => r.ok ? r.json() : null)
            .then(json => {
              // 只在用戶還停在同一股票+週期才套用，避免覆蓋已換的資料
              const cur = get();
              const curSymbol = cur.currentStock?.ticker.replace(/\.(TW|TWO|SS|SZ)$/i, '');
              if (curSymbol === bgSymbol && cur.currentInterval === bgInterval && json?.candles?.length > 0) {
                applyData(json, false);
              }
            })
            .catch(() => {}); // 靜默忽略
          get().startPolling();
          return;
        }

        // 本地無資料 → 走 API 路徑（同樣退避重試，吸收冷啟動/編譯期瞬斷）
        const apiJson = await fetchCandlesRetry(
          `/api/stock?symbol=${encodeURIComponent(symbol)}&interval=${interval}&period=${p}`
        );
        if (!apiJson || !applyData(apiJson, true)) throw new Error('資料筆數為 0');
      } else {
        // ── 分鐘K：直接 API（本地沒有分鐘K數據；同樣退避重試） ──
        const json = await fetchCandlesRetry(
          `/api/stock?symbol=${encodeURIComponent(symbol)}&interval=${interval}&period=${p}`
        );
        if (!json || !applyData(json, true)) throw new Error('資料筆數為 0');
      }
      // 自動刷新：URL 載入 / 切股 / 切時框 都會走進這裡 → 統一啟動 polling
      // 不同 interval 走不同頻率（分 K 30s-3min，日/週/月 K 由 getPollingInterval 決定）
      // 歷史回放（targetDate < today）由 startPolling 內部 guard 自動跳過
      get().startPolling();
    } catch (err) {
      set({ isLoadingStock: false });
      throw err;
    }
  },

  // ── Polling（盤中自動刷新） ──────────────────────────────
  startPolling: () => {
    const { currentStock, currentInterval, targetDate } = get();
    if (!currentStock || currentStock.ticker === 'DEMO') return;

    // 場外基金：單位淨值一天才定盤一次，盤中沒有即時報價可 poll（且 /api/stock/quote
    // 是股票端點，對 .OF 無資料）→ 直接不啟動 polling。
    if (isFundSymbol(currentStock.ticker)) return;

    // 歷史 scan 模式不要 poll：targetDate 是過去日，盤中報價跟它無關，
    // 而 polling 每 30s 重抓+全量 precomputeMarkers 很貴，純浪費
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
    if (targetDate && targetDate < today) return;

    // 先清除舊 timer
    if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }

    const intervalMs = getPollingInterval(currentInterval);
    if (intervalMs <= 0) return; // 未知 interval（getPollingInterval default = 0）才不 poll；日/週/月K 都 60s

    set({ isPolling: true });
    const symbol = currentStock.ticker.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    // 指數(000001.SS)裸碼後會撞個股(000001=平安銀行)→日K 報價/今日 bar 注入一律用完整代號
    // （/api/stock/quote 是 suffix-aware：000001.SS→4083、000001→10.99；個股帶不帶後綴結果相同）
    const quoteSymbol = currentStock.ticker;
    const interval = currentInterval;
    const isMinuteInterval = ['1m', '5m', '15m', '30m', '60m'].includes(interval);
    const defaultPeriod: Record<string, string> = {
      '1m': '5d', '5m': '60d', '15m': '60d', '30m': '60d', '60m': '6mo',
      '1d': '2y', '1wk': '5y', '1mo': '10y',
    };
    const period = defaultPeriod[interval] ?? '2y';

    pollingTimer = setInterval(async () => {
      try {
        if (isMinuteInterval) {
          // 分K：重抓完整分鐘資料（Fugle intraday）
          const res = await fetch(
            `/api/stock?symbol=${encodeURIComponent(quoteSymbol)}&interval=${interval}&period=${period}`
          );
          if (!res.ok) return;
          const json = await res.json();
          const candles = computeIndicators(json.candles);
          if (candles.length === 0) return;
          const { currentIndex, allCandles, account } = get();
          const wasAtEnd = currentIndex >= allCandles.length - 1;
          const newIndex = wasAtEnd ? candles.length - 1 : currentIndex;
          precomputeMarkers(candles);
          set({ allCandles: candles, currentIndex: newIndex, ...buildState(candles, newIndex, account) });
        } else {
          // 日K/週K/月K：只更新今日最後一根 bar，避免重讀 2 年 L1 觸發 bulk preload
          const res = await fetch(`/api/stock/quote?symbol=${encodeURIComponent(quoteSymbol)}`);
          if (!res.ok) return;
          const q = await res.json();
          if (!q.close || q.close <= 0) return;

          const { currentIndex, allCandles, account, targetDate } = get();
          if (allCandles.length === 0) return;

          const ticker = currentStock?.ticker ?? symbol;
          // suffix 權威：.SS/.SZ → CN；.TW/.TWO → TW；無 suffix 用位數判斷（4-5 位 TW、6 位 CN）
          const hasCnSuffix = /\.(SS|SZ)$/i.test(ticker);
          const hasTwSuffix = /\.(TW|TWO)$/i.test(ticker);
          const pure = ticker.replace(/\.(TW|TWO|SS|SZ)$/i, '');
          const isCN = hasCnSuffix || (!hasTwSuffix && /^\d{6}$/.test(pure));
          const isTW = !isCN;
          const tz = isTW ? 'Asia/Taipei' : 'Asia/Shanghai';
          const market: 'TW' | 'CN' = isTW ? 'TW' : 'CN';
          const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
          const lastCandle = allCandles[allCandles.length - 1];
          const updatedCandles = [...allCandles];

          // 非交易日（週末/假日）quote API 會回最近一個交易日的收盤價，
          // 不要拿這個值來偽造一根「今日 bar」造成 04-24/04-25 重複
          const todayIsTradingDay = isTradingDay(today, market);

          // 2026-06-12（QA 提案 #9）：交易日 00:00～開盤前，quote 端點回的是昨收殘值，
          // 會偽造一根 O=H=L=C、漲跌 0.00 的扁平「今日」bar（凌晨看盤誤導、三色 asOf 連坐）
          // → 開盤前（TW <09:00 / CN <09:30 當地時間）不新增今日 bar；已存在的今日 bar 照常覆蓋。
          const hm = new Intl.DateTimeFormat('en-GB', {
            timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
          }).format(new Date());
          const marketOpened = hm >= (isTW ? '09:00' : '09:30');

          // quote.date 比 lastCandle.date 早 → 是舊資料（如 INDEX L1 fallback 回昨天的 K）
          // 必須拒絕，否則會把 /api/stock?local=1 注入好的今日 bar 蓋成「昨天 OHLCV + 今日 high」混合。
          if (q.date && q.date < lastCandle.date) {
            return;
          }
          if (lastCandle.date === today) {
            // 覆蓋今日 bar
            updatedCandles[updatedCandles.length - 1] = {
              ...lastCandle,
              open: q.open || lastCandle.open,
              high: Math.max(q.high || 0, lastCandle.high),
              low: q.low > 0 ? Math.min(q.low, lastCandle.low) : lastCandle.low,
              close: q.close,
              volume: q.volume || lastCandle.volume,
            };
          } else if (lastCandle.date < today && todayIsTradingDay && marketOpened) {
            // 新增今日 bar（只在交易日且已開盤才加，避免週末/假日/凌晨把昨收殘值當今日 bar）
            updatedCandles.push({
              date: today,
              open: q.open || q.close,
              high: q.high || q.close,
              low: q.low || q.close,
              close: q.close,
              volume: q.volume || 0,
            });
          } else {
            return; // 歷史回放模式 / 非交易日，不覆蓋不新增
          }

          const candles = computeIndicators(updatedCandles.map(c => ({
            date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
          })));
          const wasAtEnd = currentIndex >= allCandles.length - 1;
          let newIndex: number;
          if (wasAtEnd && targetDate) {
            // 掃描模式：保持在 targetDate bar，不因新增今日 bar 而跳走
            const tIdx = candles.findIndex(c => c.date.slice(0, 10) === targetDate);
            newIndex = tIdx !== -1 ? tIdx : candles.length - 1;
          } else {
            newIndex = wasAtEnd ? candles.length - 1 : currentIndex;
          }
          precomputeMarkers(candles);
          set({ allCandles: candles, currentIndex: newIndex, ...buildState(candles, newIndex, account) });
        }
      } catch {
        // polling 失敗不影響用戶體驗，靜默忽略
      }
    }, intervalMs);
  },

  stopPolling: () => {
    if (pollingTimer) {
      clearInterval(pollingTimer);
      pollingTimer = null;
    }
    set({ isPolling: false });
  },

  // ── Replay controls ───────────────────────────────────────
  nextCandle: () => {
    const { allCandles, currentIndex, account, sixConditions } = get();
    const next = Math.min(currentIndex + 1, allCandles.length - 1);
    if (next === currentIndex) return;
    set({ currentIndex: next, prevSixConditions: sixConditions, ...buildState(allCandles, next, account) });
  },

  prevCandle: () => {
    const { allCandles, currentIndex, account, sixConditions } = get();
    const prev = Math.max(currentIndex - 1, 0);
    if (prev === currentIndex) return;
    set({ currentIndex: prev, prevSixConditions: sixConditions, ...buildState(allCandles, prev, account) });
  },

  jumpToIndex: (index: number) => {
    const { allCandles, account, sixConditions } = get();
    const clamped = Math.max(0, Math.min(index, allCandles.length - 1));
    set({ currentIndex: clamped, isPlaying: false, prevSixConditions: sixConditions, ...buildState(allCandles, clamped, account) });
  },

  jumpToNextBuySignal: () => {
    const { allCandles, currentIndex } = get();
    const currentDate = allCandles[currentIndex]?.date ?? '';
    const markers = getCachedMarkers();
    const next = markers.find(m =>
      m.date > currentDate && (m.type === 'BUY' || m.type === 'ADD')
    );
    if (next) {
      const idx = allCandles.findIndex(c => c.date === next.date);
      if (idx !== -1) get().jumpToIndex(idx);
    }
  },

  jumpToPrevBuySignal: () => {
    const { allCandles, currentIndex } = get();
    const currentDate = allCandles[currentIndex]?.date ?? '';
    const markers = getCachedMarkers();
    const prev = [...markers].reverse().find(m =>
      m.date < currentDate && (m.type === 'BUY' || m.type === 'ADD')
    );
    if (prev) {
      const idx = allCandles.findIndex(c => c.date === prev.date);
      if (idx !== -1) get().jumpToIndex(idx);
    }
  },

  startPlay: () => set({ isPlaying: true }),
  stopPlay:  () => set({ isPlaying: false }),
  setPlaySpeed: (ms) => set({ playSpeed: ms }),

  resetReplay: () => {
    const { allCandles, targetDate } = get();
    // 歷史 scan 模式下 reset 應該回到 scanDate 那根，而不是跳到 allCandles 末端（= 今天）
    // 否則 chart 切到 scanDate、但 signals/sixConditions 跑到今天，導致兩邊不同步
    let index = calcStartIndex(allCandles);
    if (targetDate) {
      const dateOf = (d: string) => d.slice(0, 10);
      const tIdx = allCandles.findIndex(c => dateOf(c.date) === targetDate);
      if (tIdx !== -1) index = tIdx;
    }
    const account = createAccount(INITIAL_CAPITAL);
    set({
      currentIndex: index,
      account,
      isPlaying: false,
      ...buildState(allCandles, index, account),
    });
  },

  // ── Trade actions ─────────────────────────────────────────
  buy: (shares) => {
    const { allCandles, currentIndex, account } = get();
    const price = allCandles[currentIndex]?.close ?? 0;
    const date  = allCandles[currentIndex]?.date ?? '';
    const newAccount = executeBuy(account, price, shares, date);
    if (!newAccount) return;
    set({ account: newAccount, ...buildState(allCandles, currentIndex, newAccount) });
  },

  sell: (shares) => {
    const { allCandles, currentIndex, account } = get();
    const price = allCandles[currentIndex]?.close ?? 0;
    const date  = allCandles[currentIndex]?.date ?? '';
    const newAccount = executeSell(account, price, shares, date);
    if (!newAccount) return;
    set({ account: newAccount, ...buildState(allCandles, currentIndex, newAccount) });
  },

  buyPercent: (percent) => {
    const { metrics, allCandles, currentIndex } = get();
    const price = allCandles[currentIndex]?.close ?? 0;
    if (price <= 0) return;
    const shares = sharesFromPercent(metrics.cash, price, percent);
    if (shares > 0) get().buy(shares);
  },

  sellPercent: (percent) => {
    const { account } = get();
    const shares = Math.floor(account.shares * percent);
    if (shares > 0) get().sell(shares);
  },

  setSignalStrengthMin: (min) => {
    _setStrengthMin(min);
    const { allCandles, currentIndex, account } = get();
    if (allCandles.length > 0) {
      precomputeMarkers(allCandles);
      set({
        signalStrengthMin: min,
        ...buildState(allCandles, currentIndex, account),
      });
    } else {
      set({ signalStrengthMin: min });
    }
  },
}));
