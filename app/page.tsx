'use client';

/**
 * V2 走圖頁 — 乾淨版
 *
 * 左側：K 線圖（大）+ 播放控制
 * 右側：2 個 tab（條件 / 訊號）
 *
 * 移除的東西：
 * - OHLCV bar 的 MA/BB/指標切換按鈕 → 預設全開
 * - 籌碼 tab → 移到掃描頁
 * - 問老師 tab → 移除
 * - 底部回測面板 → 移到掃描頁
 * - 趨勢狀態欄 → 整合進條件 tab
 */

import { Suspense, useEffect, useCallback, useState, useRef, useMemo } from 'react';
import nextDynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { isSameStockSymbol } from '@/lib/navigation/stockUrl';
import { useReplayStore } from '@/store/replayStore';
import { findBuyPoints, prevBuyPointIndex, nextBuyPointIndex } from '@/lib/analysis/findBuyPoints';
import { detectTrend } from '@/lib/analysis/trendAnalysis';
import { evaluateAt as smEvaluateAt } from '@/lib/smartmoney/signal';
import { evaluateAt as instEvaluateAt } from '@/lib/instdip/signal';
import { evaluateAt as stealEvaluateAt } from '@/lib/inststeal/signal';
import { computeChipAvoidSignals } from '@/lib/avoidance/chipAvoidSignals';
import { useChartListNavCapture, navigateStockList } from '@/lib/chartListNav';
import StockSelector from '@/components/StockSelector';
import { PageShell, EmptyState, BackButton, StockChartView } from '@/components/shared';
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import SignalSummaryCard from '@/components/SignalSummaryCard';
import { useV12HistoricalMarkers } from '@/lib/hooks/useV12HistoricalMarkers';
import { useBlowoffMarkers } from '@/lib/hooks/useBlowoffMarkers';
import { useLockedPattern } from '@/lib/hooks/useLockedPattern';
import SixConditionsPanel from '@/components/SixConditionsPanel';
import BuyMethodConditionsPanel from '@/components/BuyMethodConditionsPanel';
import { SanSeConditionsPanel } from '@/components/cn-sanse/SanSeConditionsPanel';
import { SanSeSignalsPanel } from '@/components/cn-sanse/SanSeSignalsPanel';
import type { ConditionReport } from '@/lib/cn-sanse/conditions';
import type { CatchCrossTrigger } from '@/lib/cn-sanse/crossTrigger';
import ChipDetailPanel from '@/components/ChipDetailPanel';
import ChipRawTables, { type ChipRawTablesProps } from '@/components/chart/ChipRawTables';
import { FundamentalSidebarPanel } from '@/components/FundamentalSidebarPanel';
import CnChipPanel from '@/components/cn/CnChipPanel';
import CnFundamentalPanel from '@/components/cn/CnFundamentalPanel';
import { FundamentalScoreSummary } from '@/components/analysis/FundamentalScoreSummary';
import { ErrorBoundary, SectionBoundary } from '@/components/ErrorBoundary';
import BottomPanel from '@/components/BottomPanel';
import { ScanPanelVertical } from '@/features/scan';
import { DataHealthBadge } from '@/features/scan/components/DataHealthBadge';
import type { SelectedStock } from '@/features/scan';
import type { SanSeChartPayload } from '@/components/cn-sanse/SanSeChart';
import { YoutubePanel } from '@/components/youtube/YoutubePanel';
import { BrokerReportsPanel } from '@/components/broker/BrokerReportsPanel';
import { SectorsPanel } from '@/components/sectors/SectorsPanel';
import { ETFPanel } from '@/features/etf';
import { lastBusinessDayYmd } from '@/lib/dateDefaults';
import { getABCDisplayStructure } from '@/lib/analysis/abcBreakoutEntry';
import { shouldFetchExactConcentration } from '@/lib/chips/concentrationFetchPolicy';
import { assessExactConcentration } from '@/lib/chips/concentrationAvailability';
import { findRecentPriceDiscontinuity } from '@/lib/scanner/priceContinuityGuard';
import { useBacktestStore } from '@/store/backtestStore';
import { useSettingsStore } from '@/store/settingsStore';
import { ChevronDown, Search, Video, Flame, Landmark, LineChart } from 'lucide-react';
import { toast } from 'sonner';
import ChartToolbar, { type ChartIndicatorPreset } from '@/components/ChartToolbar';

// Mobile fullscreen 仍直接使用 CandleChart / IndicatorCharts（StockChartView 抽出範圍只到 desktop 主視窗）
const CandleChart = nextDynamic(() => import('@/components/CandleChart'), {
  ssr: false,
  loading: () => (
    <div className="w-full bg-card flex items-center justify-center" style={{ height: 460 }}>
      <span className="text-muted-foreground text-sm animate-pulse">載入K線圖中...</span>
    </div>
  ),
});

const IndicatorCharts = nextDynamic(() => import('@/components/IndicatorCharts'), { ssr: false });

type SideTab = 'conditions' | 'signals' | 'chip' | 'fundamental';
type RightTab = 'scan' | 'youtube' | 'sectors' | 'broker' | 'etf';
const RIGHT_TABS: RightTab[] = ['scan', 'youtube', 'sectors', 'broker', 'etf'];

/** 像六條件那種「每條件一列、●綠紅燈 + 數值」的檢查清單（隨走圖游標跑）*/
export type CondRow = { icon: string; name: string; value: string; pass: boolean; tip?: string };
export type CondList = { date: string; rows: CondRow[]; passCount: number; total: number; hit: boolean } | null;

function CondChecklist({ data, hitText, missText }: { data: CondList; hitText: string; missText: string }) {
  if (!data) return <div className="px-3 py-2 text-[11px] text-muted-foreground/60">此日無足夠籌碼資料</div>;
  return (
    <div>
      <div className="flex items-center justify-between px-3 py-1.5 text-[11px]">
        <span className="text-muted-foreground/70">當天（{data.date}）</span>
        <span className={data.hit ? 'text-green-400 font-bold' : 'text-muted-foreground'}>{data.passCount}/{data.total}</span>
      </div>
      <div className="border-t border-border/40">
        {data.rows.map(r => (
          <div key={r.icon} className="flex items-center gap-2 px-3 py-1.5 border-b border-border/30 last:border-0 text-[11px]">
            <span className={r.pass ? 'text-green-400' : 'text-red-400'}>●</span>
            <span className="text-muted-foreground/70 w-3 font-mono">{r.icon}</span>
            <span className="font-medium text-foreground/90" title={r.tip}>{r.name}</span>
            <span className="flex-1" />
            <span className={`font-mono px-1.5 py-0.5 rounded ${r.pass ? 'bg-green-900/40 text-green-300' : 'bg-muted text-muted-foreground'}`}>{r.value}</span>
          </div>
        ))}
      </div>
      <div className={`px-3 py-1.5 text-[11px] ${data.hit ? 'text-green-400' : 'text-muted-foreground/70'}`}>
        {data.hit ? hitText : missText}
      </div>
    </div>
  );
}

/** 根據 activeBuyMethod 切換渲染：A 走六條件，其他走買法條件面板。
 *  v11 G/H/I 自動轉 v12 J/L/K（用戶 0512 決議只留 v12） */
function ConditionsPanelSwitch({ wConds, xConds, yConds, chipTables }: {
  wConds?: CondList; xConds?: CondList; yConds?: CondList;
  chipTables: ChipRawTablesProps;
}) {
  const method = useBacktestStore(s => s.activeBuyMethod);
  if (method === 'A') return <SixConditionsPanel />;
  // A30：同一套六條件，盤中每 30 分掃一次、名單累加（13:30 那次為當天最終；快照近似）
  if (method === 'A30') return (
    <div>
      <div className="px-3 pt-2 text-[10px] text-amber-300/80 leading-relaxed">
        六條件（30分K）· 盤中每 30 分更新、名單累加 · 13:30 為當天最終 · 快照近似值
      </div>
      <SixConditionsPanel />
    </div>
  );
  // R 機械軌純排名，無 detector 條件可顯示 — 簡單說明即可
  if (method === 'R') {
    return (
      <div className="p-3 text-[11px] text-muted-foreground space-y-1">
        <div className="font-semibold text-cyan-300/80">機械軌（R · 乖離率）</div>
        <div>純排名策略，不過六條件、不過戒律、不過 Step 0 大盤過濾。</div>
        <div>做多取成交額前 500 中 MA20 乖離率最負 top 10；做空取最正 top 10。</div>
      </div>
    );
  }
  // W 大戶偷買軌純籌碼（refined），無 detector 條件可顯示 — 說明 + 看盤要追蹤的指標
  if (method === 'W') {
    return (
      <div className="text-[11px] text-muted-foreground">
        <div className="px-3 pt-2 pb-1 space-y-0.5">
          <div className="font-semibold text-emerald-300/80">大戶偷買（W · 主力分點集中度）</div>
          <div>主力分點（前15大券商）剛開始默默吃貨，4 道濾網全過才入選。隨走圖看當天：</div>
        </div>
        <CondChecklist data={wConds ?? null}
          hitText="✅ 四道全過 — 這天符合大戶偷買" missText="○ 未全過（這天非進場日）" />
        <div className="px-3 py-1.5 text-amber-400/70 border-t border-border/40">
          ⚠️ 回測無穩定贏大盤的本事（refined 比粗版好但 &lt;50%）— 當參考、不是明牌。
        </div>
      </div>
    );
  }
  // X 法人接刀軌（2026-06-14）：grid 唯一兩年都正的買方向。
  if (method === 'X') {
    return (
      <div className="text-[11px] text-muted-foreground">
        <div className="px-3 pt-2 pb-1 space-y-0.5">
          <div className="font-semibold text-teal-300/80">法人接刀（X）</div>
          <div>股價在跌/長黑、法人逆勢買、避開大戶持股超高。隨走圖看當天 3 道：</div>
        </div>
        <CondChecklist data={xConds ?? null}
          hitText="✅ 三道全過 — 這天符合法人接刀" missText="○ 未全過（這天非進場日）" />
        <div className="px-3 py-1.5 space-y-0.5 border-t border-border/40">
          <div className="text-emerald-400/90">📈 回測：買進後約1個月 64% 會漲、平均 +10.4%（多頭那年）。</div>
          <div className="text-amber-400/70">⚠️ 弱市那年只 +2%、約36% 會賠。部位別重、停損守好。</div>
        </div>
      </div>
    );
  }
  // Y 法人偷買(原)軌：跌 + 5日籌碼集中度在增加 + 法人連買，三個同時成立（單一事實 lib/inststeal）
  if (method === 'Y') {
    return (
      <div className="text-[11px] text-muted-foreground">
        <div className="px-3 pt-2 pb-1 space-y-0.5">
          <div className="font-semibold text-amber-300/80">大戶法人偷買（Y）</div>
          <div>股價在跌、籌碼5日集中度慢慢在爬、法人連續買 — 三個同時成立。隨走圖看當天 3 道：</div>
        </div>
        <CondChecklist data={yConds ?? null}
          hitText="✅ 三道全過 — 這天符合大戶法人偷買" missText="○ 未全過（這天非進場日）" />
        <ChipRawTables {...chipTables} />
      </div>
    );
  }
  const v12Method = method === 'G' ? 'J' : method === 'H' ? 'L' : method === 'I' ? 'K' : method;
  return <BuyMethodConditionsPanel method={v12Method} />;
}

// Next 16 client component + useSearchParams 需 Suspense 包(否則 build 失敗)
// dev mode 可能出現 hydration mismatch(Recoverable Error),不擋使用 — Next 16 quirk
export default function HomePageWrapper() {
  return <Suspense fallback={null}><HomePage /></Suspense>;
}

function HomePage() {
  const {
    visibleCandles, currentSignals, chartMarkers,
    isLoadingStock, allCandles, currentIndex, dataGaps,
    nextCandle, prevCandle, isPlaying, startPlay, stopPlay, metrics,
    loadStock, currentStock, currentInterval,
    signalStrengthMin, setSignalStrengthMin,
    resetReplay, targetDate,
  } = useReplayStore();

  // v12 歷史 markers（M/N/O/P/Q/F）— 在現有 chartMarkers 之上疊加
  const v12Markers = useV12HistoricalMarkers(allCandles, currentStock?.ticker ?? '', true);
  // 分鐘級 K 才會跑 blowoff 偵測（爆量長黑/長紅/末升段/MA5 跌破）
  const blowoffMarkers = useBlowoffMarkers(
    allCandles,
    currentStock?.ticker,
    currentInterval,
    metrics.shares > 0,
  );
  // chartMarkers + v12Markers 由「訊號」toggle 控制；blowoff 在分鐘 K 永遠顯示
  // 因為爆量長黑/末升段是即時警示，不能藏在 toggle 後面（朱書精神：見高就警覺）
  const mergedMarkers = useMemo(
    () => [...chartMarkers, ...v12Markers],
    [chartMarkers, v12Markers],
  );

  // 買點索引（對齊生產掃描規則：六條件+戒律+淘汰法）
  const buyPointIndices = useMemo(
    () => (allCandles.length > 60 ? findBuyPoints(allCandles) : []),
    [allCandles]
  );
  const jumpToBuyPoint = useCallback((direction: 'prev' | 'next') => {
    const finder = direction === 'prev' ? prevBuyPointIndex : nextBuyPointIndex;
    const target = finder(buyPointIndices, currentIndex);
    if (target != null) useReplayStore.getState().jumpToIndex(target);
  }, [buyPointIndices, currentIndex]);
  const canPrevBuyPoint = buyPointIndices.length > 0 && buyPointIndices[0] < currentIndex;
  const canNextBuyPoint = buyPointIndices.length > 0 && buyPointIndices[buyPointIndices.length - 1] > currentIndex;

  const currentTrend = useMemo(
    () => allCandles.length > 0 && currentIndex >= 20 ? detectTrend(allCandles, currentIndex) : null,
    [allCandles, currentIndex],
  );

  // 鎖股觀察紀錄 → 走圖型態 chip 穩定來源（hooks/useLockedPattern）
  const { lockedPattern } = useLockedPattern(currentStock?.ticker);

  // ↑↓ 跳股票：記住「最後點到的股票」屬於哪個清單（題材/掃描/候選池），鍵盤上下鍵據此換股
  useChartListNavCapture();

  // URL 與各資料面板共用狀態必須在讀取它們的 effects/callbacks 之前宣告。
  const [rightTab, setRightTab] = useState<RightTab>('scan');
  const [youtubeDate, setYoutubeDate] = useState(lastBusinessDayYmd);
  const [brokerDate, setBrokerDate] = useState(lastBusinessDayYmd);
  const [mobileChartFullscreen, setMobileChartFullscreen] = useState(false);
  const selectRightTab = useCallback((nextTab: RightTab) => {
    setRightTab(nextTab);
    const params = new URLSearchParams(window.location.search);
    params.set('tab', nextTab);
    // 面板日期各自保存，避免 YouTube / 法人互相改掉日期；舊的 `date` 只保留給
    // `?load=...&date=...` 歷史走圖，不能再兼作研究面板日期。
    if (nextTab === 'youtube') params.set('ytDate', youtubeDate);
    if (nextTab === 'broker') params.set('brokerDate', brokerDate);
    if (!params.has('load') && !params.has('symbol')) params.delete('date');
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
  }, [youtubeDate, brokerDate]);
  const changeYoutubeDate = useCallback((nextDate: string) => {
    setYoutubeDate(nextDate);
    const params = new URLSearchParams(window.location.search);
    params.set('ytDate', nextDate);
    if (!params.has('load') && !params.has('symbol')) params.delete('date');
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
  }, []);
  const changeBrokerDate = useCallback((nextDate: string) => {
    setBrokerDate(nextDate);
    const params = new URLSearchParams(window.location.search);
    params.set('brokerDate', nextDate);
    if (!params.has('load') && !params.has('symbol')) params.delete('date');
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
  }, []);

  // 大盤指數預設：TW→加權指數 ^TWII，CN→上證指數 000001.SS
  const market = useBacktestStore(s => s.market);
  const scanDate = useBacktestStore(s => s.scanDate);
  const getMarketIndex = useCallback(
    (m: 'TW' | 'CN'): { symbol: string; name: string } => m === 'TW'
      ? { symbol: '^TWII', name: '加權指數' }
      : { symbol: '000001.SS', name: '上證指數' },
    [],
  );

  // Handle ?load=SYMBOL&date=YYYY-MM-DD&tab=...&tf=...
  // 用 useSearchParams 監聽 URL 變化（Link 點擊 / router.replace 都會 trigger）
  // 用 lastLoadedRef 防止重複 load 同一檔（避免 hydration race + market-change race）
  const [loadError, setLoadError] = useState<string | null>(null);
  const [failedLoadRequest, setFailedLoadRequest] = useState<{ symbol: string; tf: string; date?: string } | null>(null);
  const searchParams = useSearchParams();
  const lastLoadedRef = useRef<string>('');
  useEffect(() => {
    const sym = searchParams.get('load') ?? searchParams.get('symbol');
    const legacyDate = searchParams.get('date');
    const urlTab = searchParams.get('tab');
    const tfParam = searchParams.get('tf');
    if (urlTab === 'youtube' || urlTab === 'scan' || urlTab === 'sectors' || urlTab === 'broker' || urlTab === 'etf') {
      setRightTab(urlTab);
    }
    const validDate = (value: string | null): value is string => !!value && /^\d{4}-\d{2}-\d{2}$/.test(value);
    const ytDate = searchParams.get('ytDate');
    const reportDate = searchParams.get('brokerDate');
    if (validDate(ytDate)) setYoutubeDate(ytDate);
    else if (!sym && urlTab === 'youtube' && validDate(legacyDate)) setYoutubeDate(legacyDate);
    if (validDate(reportDate)) setBrokerDate(reportDate);
    else if (!sym && urlTab === 'broker' && validDate(legacyDate)) setBrokerDate(legacyDate);
    const chartDate = sym && validDate(legacyDate) ? legacyDate : null;
    const validTfs = ['1m', '5m', '15m', '30m', '60m', '1d', '1wk', '1mo'];
    const tf = tfParam && validTfs.includes(tfParam) ? tfParam : '1d';
    if (sym) {
      // dedup：同 sym+tf+date 不重 load（避免 searchParams 變化但內容相同）
      const key = `${sym}|${tf}|${chartDate ?? ''}`;
      if (lastLoadedRef.current === key) return;
      // StockSelector 已完成載入後才把 URL 正規化；若目前 store 就是同一檔、
      // 同週期且沒有歷史日期，不要因 replaceState 再下載一次。
      const loaded = useReplayStore.getState();
      if (
        !chartDate
        && loaded.currentStock?.ticker
        && isSameStockSymbol(loaded.currentStock.ticker, sym)
        && loaded.currentInterval === tf
        && !loaded.targetDate
      ) {
        lastLoadedRef.current = key;
        setLoadError(null);
        return;
      }
      lastLoadedRef.current = key;
      loadStock(sym, tf, undefined, chartDate ?? undefined)
        .then(() => { setLoadError(null); setFailedLoadRequest(null); }) // 成功載入 → 清掉先前冷啟動 race 的失敗 banner
        .catch((e: Error) => {
          const msg = `載入 ${sym} 失敗：${e.message || '請稍後再試'}`;
          setLoadError(msg);
          setFailedLoadRequest({ symbol: sym, tf, date: chartDate ?? undefined });
          toast.error(msg);
        });
    } else if (lastLoadedRef.current === '') {
      // 首次 mount 沒帶 ?load → 載大盤指數（覆蓋 initData 的 DEMO 範例）
      lastLoadedRef.current = `_market_${market}`;
      loadStock(getMarketIndex(market).symbol, '1d', '2y').catch(() => {});
    }
  }, [searchParams, loadStock, getMarketIndex, market]);

  // 切換市場時自動切到該市場大盤指數
  // 用 ref 鎖住「上一次的 market」，hydration 把 market 從 'TW' 改成 'CN' 也會 trigger（這正是我們想要的）
  const lastMarketRef = useRef<'TW' | 'CN'>(market);
  useEffect(() => {
    if (lastMarketRef.current === market) return;
    lastMarketRef.current = market;
    // DU1：只有「當前走圖是大盤指數（或尚未載入）」時才跟著切到新市場指數；
    // 使用者已載入個股則保留個股圖、不覆蓋（切掃描市場 ≠ 丟失走圖）。
    // hydration 初始 chart 仍是指數，故 TW→CN 照常切到 000001.SS。
    const INDEX_TICKERS = new Set(['^TWII', '^TWOII', '000001.SS', '000300.SS']);
    const cur = currentStock?.ticker ?? '';
    if (cur && !INDEX_TICKERS.has(cur)) return;
    const { symbol } = getMarketIndex(market);
    loadStock(symbol, '1d', '2y').catch(() => {});
  }, [market, loadStock, getMarketIndex, currentStock]);

  // P1-2: remember last tab per interval (declared before handleKey to avoid TDZ errors)
  const [sideTabPerInterval, setSideTabPerInterval] = useState<Record<string, SideTab>>({});
  const sideTab: SideTab = sideTabPerInterval[currentInterval] ?? 'conditions';
  const setSideTab = useCallback(
    (tab: SideTab) => setSideTabPerInterval(prev => ({ ...prev, [currentInterval]: tab })),
    [currentInterval],
  );
  // 副圖（成交量/KD/MACD/籌碼）預設展開：成交量是書本核心訊息（量1.5×/過大量黑K），不該被視窗寬度藏起來
  const [showIndicators, setShowIndicators] = useState(true);
  // 三色資金圖層（陸股）：雙B戰法疊主圖（像 BB）；主力狀態/捕撈季節是副圖（像 MACD/KD）
  const [showShuangB, setShowShuangB] = useState(false);
  const [showHolderLine, setShowHolderLine] = useState(false);
  // P1-5: keyboard shortcut help overlay
  const [showHelp, setShowHelp] = useState(false);
  // Scanner bottom panel — v12 預設展開讓用戶一進來就看到新功能（14 字母 tabs/Step 0 banner/LockWatch panel/警示徽章）
  const [scannerOpen, setScannerOpen] = useState(true);
  // YouTube tab 內點股票 → loadStock + 跳左側 K 線（mobile inline 切全螢幕，避免 hoisting）
  const handleYoutubeSelectStock = useCallback((code: string) => {
    setLoadError(null);
    // YouTube source 都是 TW 股，補 .TW suffix
    const symbol = /\.(TW|TWO|SS|SZ)$/i.test(code) ? code : `${code}.TW`;
    // 點股票看圖一律載「即時」（不傳 tabDate）：tabDate 預設是上個工作日，
    // 當 as-of 傳入會把 K 線凍在那天、不注入今日 bar、不輪詢（見 replayStore startPolling guard）
    loadStock(symbol, '1d', '2y').catch((e: Error) => {
      toast.error(`載入 ${code} 失敗：${e.message || '請稍後再試'}`);
    });
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setMobileChartFullscreen(true);
      setScannerOpen(false);
      try { window.history.pushState({ chartFullscreen: true }, ''); } catch { /* noop */ }
    }
  }, [loadStock]);

  // 題材分類 tab 點股票 → loadStock。台股裸碼補 .TW；陸股已帶 .SS/.SZ/.BJ 後綴照用
  const handleSectorSelectStock = useCallback((codeOrSymbol: string) => {
    setLoadError(null);
    const symbol = /\.(TW|TWO|SS|SZ|BJ)$/i.test(codeOrSymbol) ? codeOrSymbol : `${codeOrSymbol}.TW`;
    // 點股票看圖一律載「即時」（不傳 tabDate）：題材是盤中即時清單，點進去理應看即時 K 線
    loadStock(symbol, '1d', '2y').catch((e: Error) => {
      toast.error(`載入 ${codeOrSymbol} 失敗：${e.message || '請稍後再試'}`);
    });
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setMobileChartFullscreen(true);
      setScannerOpen(false);
      try { window.history.pushState({ chartFullscreen: true }, ''); } catch { /* noop */ }
    }
  }, [loadStock]);
  // 手機點「走圖」→ 全螢幕 K 線視圖
  const openMobileChart = useCallback(() => {
    setMobileChartFullscreen(true);
    setScannerOpen(false);
    try { window.history.pushState({ chartFullscreen: true }, ''); } catch { /* noop */ }
  }, [setMobileChartFullscreen, setScannerOpen]);
  const closeMobileChart = useCallback(() => {
    setMobileChartFullscreen(false);
    setScannerOpen(true);
  }, [setMobileChartFullscreen, setScannerOpen]);
  useEffect(() => {
    if (!mobileChartFullscreen) return;
    const onPop = () => setMobileChartFullscreen(false);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [mobileChartFullscreen]);

  // Keyboard: ← → Space B S Q
  const handleKey = useCallback((e: KeyboardEvent) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) return;
    if (e.key === 'ArrowRight' && e.shiftKey) { e.preventDefault(); jumpToBuyPoint('next'); }
    else if (e.key === 'ArrowLeft' && e.shiftKey) { e.preventDefault(); jumpToBuyPoint('prev'); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); nextCandle(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prevCandle(); }
    // ↑↓：在「題材成分股 / 掃描結果 / 候選池」清單裡跳上一檔/下一檔並載圖。
    // 沒有作用中的清單（沒點過、或清單已切走）→ navigateStockList 回 false，讓上下鍵照常捲動頁面。
    else if (e.key === 'ArrowDown') {
      if (navigateStockList(1, useReplayStore.getState().currentStock?.ticker ?? null)) e.preventDefault();
    }
    else if (e.key === 'ArrowUp') {
      if (navigateStockList(-1, useReplayStore.getState().currentStock?.ticker ?? null)) e.preventDefault();
    }
    else if (e.key === ' ') { e.preventDefault(); if (isPlaying) stopPlay(); else startPlay(); }
    // P2-3: tab switching
    else if (e.key === '1') { e.preventDefault(); setSideTab('conditions'); }
    else if (e.key === '2') { e.preventDefault(); setSideTab('signals'); }
    else if (e.key === '3') { e.preventDefault(); setSideTab('chip'); }
    else if (e.key === '4') { e.preventDefault(); setSideTab('fundamental'); }
    else if (e.key === '5') { e.preventDefault(); setScannerOpen(true); }
    // P2-3: indicator toggle
    else if (e.key === 'i' || e.key === 'I') { e.preventDefault(); setShowIndicators(v => !v); }
    // P1-5: help overlay
    else if (e.key === '?') { e.preventDefault(); setShowHelp(h => !h); }
    // 買賣快捷鍵
    else if (e.key === 'b' || e.key === 'B') {
      e.preventDefault();
      useReplayStore.getState().buyPercent(100);
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      useReplayStore.getState().sellPercent(50);
    } else if (e.key === 'q' || e.key === 'Q') {
      e.preventDefault();
      const { metrics } = useReplayStore.getState();
      if (metrics.shares > 0) useReplayStore.getState().sell(metrics.shares);
    }
  }, [nextCandle, prevCandle, isPlaying, startPlay, stopPlay, setSideTab, setScannerOpen, setShowIndicators, setShowHelp, jumpToBuyPoint]);

  useEffect(() => {
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleKey]);

  const [hoverCandle, setHoverCandle] = useState<typeof allCandles[0] | null>(null);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const [showMarkers, setShowMarkers] = useState(false);  // 訊號 markers 預設關（M/N/O/P/Q/F 歷史觸發日）— 用戶偏好
  const [showPivots, setShowPivots] = useState(true);     // 頭底標記預設開 — 用戶偏好
  const [showSupportResistance, setShowSupportResistance] = useState(false);
  // K 棒三層支撐/壓力標線（最近一根長紅/長黑：最高/1半/最低），預設關
  const [showCandleSR, setShowCandleSR] = useState(false);
  const [showAscendingTrendline, setShowAscendingTrendline] = useState(false);
  const [showDescendingTrendline, setShowDescendingTrendline] = useState(false);
  const [showAscendingChannel, setShowAscendingChannel] = useState(false);
  const [showDescendingChannel, setShowDescendingChannel] = useState(false);
  // 上升線/下降線：切線 + 軌道整合成單一開關（一鍵同開同關）
  const toggleAscendingLine = () => {
    const next = !(showAscendingTrendline || showAscendingChannel);
    setShowAscendingTrendline(next);
    setShowAscendingChannel(next);
  };
  const toggleDescendingLine = () => {
    const next = !(showDescendingTrendline || showDescendingChannel);
    setShowDescendingTrendline(next);
    setShowDescendingChannel(next);
  };
  const [showConsolidationLines, setShowConsolidationLines] = useState(false);
  const [showNeckline, setShowNeckline] = useState(false);  // 形態頸線 + 目標價 + 結構失效價
  const [showPattern, setShowPattern] = useState(false);    // 形態 ABCDE 關鍵點與連線
  const [maToggles, setMaToggles] = useState({ ma5: true, ma10: true, ma20: true, ma60: true, ma120: false, ma240: false });
  // 月線（20MA）預設打開（書本 CH3-03 做多核心防線），但使用者可手動開關
  const handleMaToggle = useCallback((key: keyof typeof maToggles) => {
    setMaToggles(p => ({ ...p, [key]: !p[key] }));
  }, []);
  const [showBollinger, setShowBollinger] = useState(false);
  const [showYangEma, setShowYangEma] = useState(false);
  const [indicators, setIndicators] = useState({
    macd: true, kd: true, volume: true, rsi: false,
    foreign: false, trust: false, dealer: false, retail: false,
    h400: false, h1000: false,
    cnMain: false, cnRetail: false,
    mainForce: false, season: false, // 三色資金副圖（陸股）：主力狀態F / 捕撈季節
  });
  // 指標套組一鍵切換（ChartToolbar tab）：技術面（MA+量+KD+MACD+頭底）⇄ 三色資金（雙B+主力狀態+捕撈季節）
  // 只動核心指標家族；籌碼面（法人/大戶/CN主力）與訊號 markers 保留不變
  const applyChartPreset = useCallback((preset: ChartIndicatorPreset) => {
    // 三套組「副圖」互斥：每套都把另外兩套的副圖明確關掉，切換＝整批換掉（不殘留）。
    // 籌碼鍵（foreign/trust/dealer/retail + cnMain/cnRetail）由 IndicatorCharts 依市場 gate，
    // 兩市場一起設無副作用：TW 只畫法人四、CN 只畫主力/散戶。
    const chipOff = { foreign: false, trust: false, dealer: false, retail: false, cnMain: false, cnRetail: false };
    const chipOn = { foreign: true, trust: true, dealer: true, retail: true, cnMain: true, cnRetail: true };
    if (preset === 'technical') {
      setMaToggles({ ma5: true, ma10: true, ma20: true, ma60: true, ma120: false, ma240: false });
      setShowBollinger(false);
      setShowShuangB(false);
      setIndicators(p => ({ ...p, ...chipOff, volume: true, kd: true, rsi: false, macd: true, mainForce: false, season: false }));
      setShowPivots(true);
    } else if (preset === 'chip') {
      // 籌碼套組：價＋均線主圖沿用技術設定，副圖全換成法人/主力資金；量/KD/MACD/三色副圖全關
      setMaToggles({ ma5: true, ma10: true, ma20: true, ma60: true, ma120: false, ma240: false });
      setShowBollinger(false);
      setShowShuangB(false);
      setIndicators(p => ({ ...p, ...chipOn, volume: false, kd: false, rsi: false, macd: false, mainForce: false, season: false }));
      setShowPivots(true);
    } else {
      // 三色套組：均線全清空讓出主圖給雙B（含月線 20MA；使用者要看可手動打開）
      setMaToggles({ ma5: false, ma10: false, ma20: false, ma60: false, ma120: false, ma240: false });
      setShowBollinger(false);
      setShowShuangB(true);
      setIndicators(p => ({ ...p, ...chipOff, volume: false, kd: false, rsi: false, macd: false, mainForce: true, season: true }));
      setShowPivots(false);
    }
  }, []);
  // 「籌碼」合併鈕：一鍵開關法人四（TW 外資/投信/自營/散戶）+ CN 主力/散戶副圖
  const toggleChipGroup = useCallback((next: boolean) => {
    setIndicators(p => ({ ...p, foreign: next, trust: next, dealer: next, retail: next, cnMain: next, cnRetail: next }));
  }, []);
  // ── 籌碼面資料（TW 法人/大戶 + CN 主力資金） ────────────────────────────────
  // 優化：用 ticker + 「是否需要籌碼」字串 key 當依賴；同一 key 不會 refetch
  // 大戶持股趨勢線（showHolderLine）也需要 tdcc 資料 → 一併納入觸發條件。
  const anyTwChipOn = indicators.foreign || indicators.trust || indicators.dealer
    || indicators.retail || indicators.h400 || indicators.h1000 || showHolderLine;
  const anyCnChipOn = indicators.cnMain || indicators.cnRetail;
  const ticker = currentStock?.ticker ?? '';
  const priceContinuityIssue = useMemo(
    () => currentInterval === '1d'
      ? findRecentPriceDiscontinuity(allCandles.slice(0, currentIndex + 1))
      : null,
    [allCandles, currentIndex, currentInterval],
  );
  const isTwTicker = /\.(TW|TWO)$/i.test(ticker) || /^\d{4,5}$/.test(ticker);
  const isCnTicker = /\.(SS|SZ)$/i.test(ticker) || /^\d{6}$/.test(ticker);
  // 三色資金（雙B/主力/捕撈）台股+陸股皆可；台股指數比照陸股指數也可（指數三色為退化值但版面一致）
  const sanseEnabled = isCnTicker || isTwTicker || ticker === '^TWII' || ticker === '^TWOII';
  // 中間「條件/訊號」面板跟著掃描面板選的策略換：
  //   三色 level（CN 自創策略）被選中 → 顯示三色面板；否則 → 書本買法面板（含陸股）。
  // sanseLevel 為單一事實來源（store），由掃描面板「三色(嚴格/中等/寬鬆)」按鈕設定、選任何書本買法時自動清空。
  const sanseLevel = useBacktestStore(s => s.sanseLevel);
  // 三色模式（台股+陸股）：選了 level 且當前股票屬三色可用市場 → 中間條件/訊號改顯示 SanSe 面板
  const showSanseView = sanseEnabled && sanseLevel != null;
  // 載入台股個股一律抓籌碼 → 讓「買進前避雷檢查」恆常跑（賠少第一線）。^TWII 指數不算 isTwTicker 不受影響。
  const wantChips = (isTwTicker && (anyTwChipOn || !!currentStock)) || (isCnTicker && anyCnChipOn);
  // 把 fetch trigger 編成單一 string key，dep 比較穩定
  const chipFetchKey = wantChips ? ticker : '';
  type ChipData = {
    inst: Array<{ date: string; foreign: number; trust: number; dealer: number; total: number }>;
    tdcc: Array<{ date: string; holder100Pct?: number; holder400Pct: number; holder1000Pct: number; holderCount?: number }>;
    broker?: Array<{ date: string; netDifference: number }>;
    cnFlow?: Array<{ date: string; mainNet: number; superLargeNet: number; largeNet: number; mediumNet: number; smallNet: number }>;
    divergence?: { type: 'bullish' | 'bearish'; priceChangePct: number; volumeChangePct: number; strength: 0|1|2|3; detail: string } | null;
  };
  const [chipsResult, setChipsResult] = useState<{ sourceSymbol: string; data: ChipData } | null>(null);
  const chips = chipsResult?.sourceSymbol === chipFetchKey ? chipsResult.data : null;
  const [chipsLoading, setChipsLoading] = useState(false);
  const [chipsError, setChipsError] = useState<string | null>(null);
  const [chipsRetry, setChipsRetry] = useState(0);
  useEffect(() => {
    if (!chipFetchKey) {
      setChipsLoading(false);
      setChipsError(null);
      return;
    }
    const ctrl = new AbortController();
    setChipsLoading(true);
    setChipsError(null);
    fetch(`/api/stock/chips?symbol=${encodeURIComponent(chipFetchKey)}&days=500`, { signal: ctrl.signal })
      .then(async r => {
        const json = await r.json();
        if (!r.ok || !json.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
        return json;
      })
      .then(json => {
        setChipsResult({ sourceSymbol: chipFetchKey, data: {
          inst: json.inst ?? [], tdcc: json.tdcc ?? [], broker: json.broker ?? [],
          cnFlow: json.cnFlow ?? [], divergence: json.divergence ?? null,
        } });
      })
      .catch(err => {
        if (err.name !== 'AbortError') {
          console.warn('[chips] load failed:', err);
          setChipsError(err instanceof Error ? err.message : '籌碼資料載入失敗');
        }
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setChipsLoading(false);
      });
    return () => ctrl.abort();
  }, [chipFetchKey, chipsRetry]);

  // 主力分點集中度「跟看盤 app 對齊版」（最近數日 5日/20日，FinMind 全分點彙總算正式公式）。
  // 與 /api/stock/chips 分開 lazy fetch（全分點多視窗抓取較慢，不阻塞籌碼面板其餘三表）。
  type ConcRow = { date: string; c5: number | null; c20: number | null; net: number | null };
  type ConcState = {
    sourceSymbol: string;
    status: 'loading' | 'ready' | 'partial' | 'unavailable' | 'error';
    rows: ConcRow[];
    error?: string;
  };
  const [concResult, setConcResult] = useState<ConcState | null>(null);
  const [concRetry, setConcRetry] = useState(0);
  const concentrationBuyMethod = useBacktestStore(s => s.activeBuyMethod);
  const needsExactConcentration = shouldFetchExactConcentration({
    sideTab,
    activeBuyMethod: concentrationBuyMethod,
    ticker: chipFetchKey,
  });
  const activeConcResult = concResult?.sourceSymbol === chipFetchKey ? concResult : null;
  const concExact = useMemo(
    () => activeConcResult?.status === 'ready' || activeConcResult?.status === 'partial'
      ? activeConcResult.rows
      : [],
    [activeConcResult],
  );
  const concentrationStatus = !needsExactConcentration
    ? 'idle' as const
    : activeConcResult?.status ?? 'loading';
  useEffect(() => {
    if (!needsExactConcentration || !chipFetchKey) return;
    const ctrl = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; ctrl.abort(); }, 15_000);
    setConcResult({ sourceSymbol: chipFetchKey, status: 'loading', rows: [] });
    fetch(`/api/stock/concentration?symbol=${encodeURIComponent(chipFetchKey)}&recentN=10`, { signal: ctrl.signal })
      .then(async r => {
        const json = await r.json();
        if (!r.ok || !json.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
        return json;
      })
      .then(json => {
        const rows = (json.conc ?? []) as ConcRow[];
        const assessment = assessExactConcentration(rows);
        const coverage = `${assessment.exactDateCount}/${assessment.totalCount}`;
        const sourceStatus = json.sourceStatus as { kind?: string; message?: string } | null | undefined;
        const permissionDenied = sourceStatus?.kind === 'permission_denied';
        setConcResult({
          sourceSymbol: chipFetchKey,
          status: permissionDenied ? 'unavailable' : assessment.status,
          rows,
          error: permissionDenied
            ? `${sourceStatus?.message ?? 'FinMind 方案權限不足'}；正式集中度已停用無效重試，目前只顯示近似值。`
            : assessment.status === 'unavailable'
            ? '正式分點來源本次未回傳可用的 5／20 日數值；目前顯示已儲存的近似值。'
            : assessment.status === 'partial'
              ? `正式分點僅覆蓋 ${coverage} 個日期，最新日期尚未完整；其餘顯示近似值。`
              : undefined,
        });
      })
      .catch(err => {
        if (ctrl.signal.aborted && !timedOut) return;
        console.warn('[concentration] load failed:', err);
        setConcResult({
          sourceSymbol: chipFetchKey,
          status: 'error',
          rows: [],
          error: timedOut ? '正式集中度計算逾時，表格暫用近似值。' : (err instanceof Error ? err.message : '正式集中度載入失敗'),
        });
      })
      .finally(() => clearTimeout(timeout));
    return () => { clearTimeout(timeout); ctrl.abort(); };
  }, [chipFetchKey, needsExactConcentration, concRetry]);

  // ── 三色資金圖層資料（雙B疊加 + 主力狀態/捕撈季節副圖 + 條件報告）──────────────
  // 陸股走 /cn-sanse、台股走 /tw-sanse（同一份 SanSeChartPayload 形狀）：圖層由各 toggle 控制。
  // conditions 兩市場都寫（三色模式時中間條件/訊號 tab 用，由 showSanseView 控制）。
  // 走圖步進：日K 時帶 asOf=當前可見最後一根日期 → 標記/條件/訊號跟著步進的位置重算（練習器核心）。
  const sanseLastBar = sanseEnabled && currentInterval === '1d' && visibleCandles.length
    ? visibleCandles[visibleCandles.length - 1]
    : null;
  const sanseAsOf = sanseLastBar ? sanseLastBar.date : '';
  // 盤中即時更新：主圖每 ~60s 輪詢會就地更新「今日那根」的 close（日期不變）。把 close 折進 fetchKey，
  // 今日價一動就連帶重抓三色（後端 tw-/cn-sanse/chart 讀最新 L2 快照重算雙B/主力狀態/捕撈季節）；
  // 否則 key 只看 ticker@date、盤中永遠不變 → 三色凍在載入當下。收盤後主圖停輪詢→close 不再變→自動停抓；
  // 歷史步進時 asOf 本來就會變，不受影響。
  const sanseFetchKey = sanseEnabled ? `${ticker}@${sanseAsOf}@${sanseLastBar?.close ?? ''}` : '';
  const [sanse, setSanse] = useState<SanSeChartPayload | null>(null);
  const [sanseConditions, setSanseConditions] = useState<ConditionReport | null>(null);
  const [sanseCatchTrigger, setSanseCatchTrigger] = useState<CatchCrossTrigger | null>(null);
  // 暫時性失敗自動重試計數。為什麼非要不可：sanse fetch 只在 sanseFetchKey(=ticker@asOf@close) 變動時才重發，
  // 但「漲停/停牌/盤後/薄量」時 close 凍住 → key 凍住 → 不再重抓。若首抓正好遇上 server 開盤瞬間高負載失敗
  // （Fugle quote timeout / L1 檔正被 cron 寫到一半 / route 404），就會永遠卡「載入三色訊號…」直到換股 —
  // 即使 endpoint 幾秒後就恢復。退避重試讓 key 凍住的情況也能自我復原。換 key 時歸零（給全新重試額度）。
  const [sanseRetry, setSanseRetry] = useState(0);
  useEffect(() => { setSanseRetry(0); }, [sanseFetchKey]);
  useEffect(() => {
    if (!sanseEnabled || !ticker) { setSanse(null); setSanseConditions(null); setSanseCatchTrigger(null); return; }
    const ctrl = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const base = isCnTicker ? '/api/cn-sanse/chart' : '/api/tw-sanse/chart';
    const url = `${base}/${encodeURIComponent(ticker)}${sanseAsOf ? `?asOf=${sanseAsOf}` : ''}`;
    // 暫時性失敗 → 退避重試（最多 4 次：2s/4s/6s/8s，共 ~20s）。server 開盤負載通常幾秒內就恢復。
    const scheduleRetry = () => {
      if (sanseRetry >= 4) return;
      retryTimer = setTimeout(() => setSanseRetry((n) => n + 1), 2000 * (sanseRetry + 1));
    };
    fetch(url, { signal: ctrl.signal })
      .then(r => r.json())
      .then(j => {
        if (j.ok && j.chart) setSanse(j.chart as SanSeChartPayload);
        // 失敗/無 chart 要清掉，否則上一檔的三色疊圖會殘留、畫在新股票 K 線上
        // （如 301205 不在掃描宇宙、無本地 L1 → cn-sanse/chart 404 → 智能/黃/紅/多空線停在前一檔 ~4000）
        else setSanse(null);
        // 條件報告兩市場都寫（三色模式時中間條件/訊號 tab 用）
        if (j.ok && j.conditions) setSanseConditions(j.conditions as ConditionReport);
        else { setSanseConditions(null); if (!j.ok) scheduleRetry(); }  // ok:false=暫時性失敗 → 重試
        setSanseCatchTrigger(j.ok && j.catchTrigger ? (j.catchTrigger as CatchCrossTrigger) : null);
      })
      .catch(err => { if (err.name !== 'AbortError') { console.warn('[sanse] load failed:', err); scheduleRetry(); } });
    return () => { ctrl.abort(); if (retryTimer) clearTimeout(retryTimer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sanseFetchKey, sanseRetry]);

  const handleScanSelectStock = useCallback((stock: SelectedStock) => {
    // 點卡片時同步掃描面板市場（避免 market=CN 卻點到 TW 卡片 → 面板/下一次三色 fetch 仍停在 CN）
    if (stock.market && useBacktestStore.getState().market !== stock.market) {
      useBacktestStore.getState().setMarket(stock.market);
    }
    // 優先用該股自帶的掃描日（三色資金帶 cn-sanse 固化日），否則回退書本掃描日 → K 線停在掃描日而非最新
    const fallbackDate = useBacktestStore.getState().scanDate;
    const date = stock.date ?? fallbackDate ?? undefined;
    setLoadError(null);
    // 點三色資金結果 → 自動打開雙B疊加（主圖直接看到雙B線與買賣點）；走圖仍是原本主圖
    if (stock.chartTab === 'shuangb') setShowShuangB(true);
    loadStock(stock.symbol, '1d', '2y', date).catch((e: Error) => {
      toast.error(`載入 ${stock.name} 失敗：${e.message || '請稍後再試'}`);
    });
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      openMobileChart();
    }
  }, [loadStock, openMobileChart]);

  // 切換走圖週期（1m/5m/.../1d/1wk/1mo）— ChartToolbar timeframe pills 點擊
  // 重抓會自動 stop/start polling（loadStock 內部會處理），呼叫端不必處理
  const handleIntervalChange = useCallback((newInterval: string) => {
    if (!currentStock) return;
    if (newInterval === currentInterval) return;
    // 三色指標只有日線版本（主力狀態要 ~507 根日K、捕撈季節要日換手率），套在分鐘線上會壞：
    // 副圖空白 + 主圖被日線 sanse overlay 帶歪到舊窗格。切到分鐘線且目前在三色套組 →
    // 自動回退技術套組（MA/量/KD/MACD），確保分鐘線指標正常顯示。
    const isIntraday = ['1m', '5m', '15m', '30m', '60m'].includes(newInterval);
    if (isIntraday && (indicators.mainForce || indicators.season || showShuangB)) {
      applyChartPreset('technical');
    }
    // 用完整 ticker（含後綴）重載：指數 000001.SS 去後綴會撞同碼個股 000001(平安銀行)。
    // currentStock.ticker 本就是 loadStock 當初成功載入的代號，原樣帶回必然同解析。
    const symbol = currentStock.ticker;
    setLoadError(null);
    useReplayStore.getState().stopPolling();
    loadStock(symbol, newInterval, undefined, targetDate ?? undefined)
      .then(() => useReplayStore.getState().startPolling())
      .catch((e: Error) => {
        toast.error(`切換 ${newInterval} 失敗：${e.message || '請稍後再試'}`);
      });
  }, [currentStock, currentInterval, targetDate, loadStock, indicators, showShuangB, applyChartPreset]);

  // 楊氏EMA濾網開關：打開＝清空主圖其他線/標記(MA/BB/三色/頭底)只留楊濾網+訊號箭頭 + 自動切 30 分K(楊法週期)；
  //              關閉＝回技術套組 + 切回日K
  const handleYangEmaToggle = useCallback(() => {
    const next = !showYangEma;
    setShowYangEma(next);
    if (next) {
      setMaToggles({ ma5: false, ma10: false, ma20: false, ma60: false, ma120: false, ma240: false });
      setShowBollinger(false);
      setShowShuangB(false);
      setShowPivots(false);
      handleIntervalChange('30m');
    } else {
      applyChartPreset('technical');
      handleIntervalChange('1d');
    }
  }, [showYangEma, applyChartPreset, handleIntervalChange]);

  // 三色指標（主力狀態/捕撈季節/雙B）只有日線版本 → 只要落到「分鐘線 + 三色指標開著」就回退技術，
  // 確保分鐘線一定有指標可看（量/KD/MACD），不會出現「請開啟至少一個指標面板」的空副圖。
  // 涵蓋所有入口：切換到分鐘線、載入時就在分鐘線、在分鐘線「手動點三色 / 開三色副圖」。
  useEffect(() => {
    const isIntraday = ['1m', '5m', '15m', '30m', '60m'].includes(currentInterval);
    if (isIntraday && (indicators.mainForce || indicators.season || showShuangB)) {
      applyChartPreset('technical');
    }
  }, [currentInterval, indicators.mainForce, indicators.season, showShuangB, applyChartPreset]);

  // P1-5: 可拖拽分隔條 — K 線圖 vs 副圖指標
  // 預設 0.55（主圖 55% / 副圖 45%，副圖整區較高）；mount 後再從 localStorage 讀取，避免 SSR hydration mismatch
  // key 升 v2：舊的 'chartSplit'（多為 0.65）忽略，讓新預設生效；之後拖曳會寫進 v2
  const [chartSplit, setChartSplit] = useState(0.55);
  useEffect(() => {
    const saved = localStorage.getItem('chartSplit-v2');
    // 接受拖曳範圍內的值（0.2~0.85）；太極端才回新預設
    if (saved && parseFloat(saved) >= 0.2 && parseFloat(saved) <= 0.85) setChartSplit(parseFloat(saved));
    else localStorage.removeItem('chartSplit-v2');
  }, []);
  // chartSplit 持久化：mouseup 才寫，避免每次拖動 100+ 次寫盤
  const handleChartSplitCommit = useCallback((split: number) => {
    try { localStorage.setItem('chartSplit-v2', String(split)); } catch {}
  }, []);

  // P3-8: Sound alert when a new signal appears during replay
  const [soundEnabled, _setSoundEnabled] = useState(true);
  const prevSignalCountRef = useRef(0);
  const soundEnabledRef = useRef(true);
  useEffect(() => { soundEnabledRef.current = soundEnabled; }, [soundEnabled]);
  useEffect(() => {
    const prev = prevSignalCountRef.current;
    const curr = currentSignals.length;
    if (isPlaying && curr > prev && soundEnabledRef.current) {
      try {
        const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.3);
      } catch { /* AudioContext not available */ }
    }
    prevSignalCountRef.current = curr;
  }, [currentSignals, isPlaying]);

  const displayCandle = hoverCandle ?? allCandles[currentIndex];
  const prev = hoverCandle
    ? allCandles[allCandles.findIndex(c => c.date === hoverCandle.date) - 1]
    : allCandles[currentIndex - 1];
  const stopLossPct = useSettingsStore(s => s.stopLossPercent);

  // Stop-loss line
  const currentCandle = allCandles[currentIndex];
  const ma5StopLoss = metrics.shares > 0 ? (currentCandle?.ma5 ?? null) : null;
  const costStopLoss = metrics.shares > 0 && metrics.avgCost > 0 ? metrics.avgCost * (1 - stopLossPct / 100) : null;
  const stopLossPrice = ma5StopLoss != null && costStopLoss != null
    ? Math.max(ma5StopLoss, costStopLoss)
    : (ma5StopLoss ?? costStopLoss ?? undefined);

  const currentDate = allCandles[currentIndex]?.date;

  const SIDE_TABS: Array<{ key: SideTab; label: string }> = [
    { key: 'conditions',  label: '條件' },
    { key: 'signals',     label: '訊號' },
    { key: 'chip',        label: '籌碼' },
    { key: 'fundamental', label: '基本面' },
  ];

  const sidebarTabs = (
    <div className="shrink-0 flex items-center gap-1">
      <div role="tablist" aria-label="分析面板" className="flex flex-1 rounded-lg overflow-hidden border border-border/60 text-xs">
        {SIDE_TABS.map(t => (
          <button key={t.key} role="tab" id={`tab-${t.key}`} aria-selected={sideTab === t.key} aria-controls={`panel-${t.key}`}
            tabIndex={sideTab === t.key ? 0 : -1}
            onClick={() => setSideTab(t.key)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
              event.preventDefault();
              const current = SIDE_TABS.findIndex(item => item.key === t.key);
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? SIDE_TABS.length - 1 : event.key === 'ArrowRight'
                ? (current + 1) % SIDE_TABS.length : (current - 1 + SIDE_TABS.length) % SIDE_TABS.length;
              setSideTab(SIDE_TABS[next].key);
              requestAnimationFrame(() => document.getElementById(`tab-${SIDE_TABS[next].key}`)?.focus());
            }}
            className={`flex-1 min-h-11 px-2 text-sm font-medium transition-colors ${
              sideTab === t.key ? 'bg-blue-600 text-foreground shadow-[0_0_8px_rgba(37,99,235,0.3)]' : 'bg-secondary/60 text-muted-foreground hover:bg-muted hover:text-foreground/80'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );

  // 選中的買法（abcOverlay / wLive / holderTier 共用）
  const activeBuyMethod = useBacktestStore(s => s.activeBuyMethod);

  // 大戶持股趨勢線級距 — 依股價自動挑：高價股(世芯3661)看千張無意義（1000張=幾十億），改看低級距。
  // 便宜股<50→千張、50~250→400張、≥250→百張（capital 約當 ~數千萬大戶）。
  const holderTier = useMemo(() => {
    const px = visibleCandles.length ? visibleCandles[visibleCandles.length - 1].close : 0;
    if (px >= 250) return { key: 'holder100Pct' as const, label: '百張大戶' };
    if (px >= 50) return { key: 'holder400Pct' as const, label: '400張大戶' };
    return { key: 'holder1000Pct' as const, label: '千張大戶' };
  }, [visibleCandles]);

  // 買進前避雷檢查（賠少第一線）— 台股個股恆常跑，用已載入的籌碼資料即時算 3 個 grid 驗證的紅旗。
  const chipAvoid = useMemo(() => {
    if (market !== 'TW' || !chips || visibleCandles.length < 21) return null;
    const brokerByDate = new Map((chips.broker ?? []).map(d => [d.date, d.netDifference]));
    const instByDate = new Map((chips.inst ?? []).map(d => [d.date, d.total]));
    if (brokerByDate.size === 0 && instByDate.size === 0 && (chips.tdcc ?? []).length === 0) return null;
    const price = visibleCandles[visibleCandles.length - 1].close;
    const { flags } = computeChipAvoidSignals({
      price,
      candles: visibleCandles.map(c => ({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })),
      holderRows: chips.tdcc ?? [],
      brokerByDate, instByDate,
    });
    return flags.length ? flags : null;
  }, [market, chips, visibleCandles]);

  // W 大戶偷買 4 道濾網（隨走圖游標）— 委派 lib/smartmoney 單一事實
  const wConds = useMemo<CondList>(() => {
    if (market !== 'TW' || !chips?.broker?.length || !allCandles.length) return null;
    const idx = Math.min(Math.max(currentIndex, 0), allCandles.length - 1);
    const brokerByDate = new Map(chips.broker.map(d => [d.date, d.netDifference]));
    const ev = smEvaluateAt(allCandles, brokerByDate, idx);
    if (!ev) return null;
    const c1 = ev.conc20 > 0 && ev.conc20prev <= 0, c2 = ev.conc20 >= 1 && ev.conc20 <= 5, c3 = ev.conc5 < 8, c4 = ev.volRatio < 1.8;
    const rows: CondRow[] = [
      { icon: '①', name: '20日由負轉正', value: `${ev.conc20prev.toFixed(1)}→${ev.conc20.toFixed(1)}%`, pass: c1, tip: '主力分點20日集中度從≤0翻正＝剛開始吃貨' },
      { icon: '②', name: '落在1~5%', value: `${ev.conc20.toFixed(1)}%`, pass: c2, tip: '太高＝已吃完' },
      { icon: '③', name: '5日濾隔日沖', value: `${ev.conc5.toFixed(1)}%`, pass: c3, tip: '5日<8%才非隔日沖假象' },
      { icon: '④', name: '不爆量', value: `${ev.volRatio.toFixed(2)}x`, pass: c4, tip: '量比<1.8' },
    ];
    return { date: allCandles[idx].date, rows, passCount: rows.filter(r => r.pass).length, total: 4, hit: ev.isHit };
  }, [market, chips, currentIndex, allCandles]);

  // X 法人接刀 3 道（隨走圖游標）— 委派 lib/instdip + 大戶超高避雷
  const xConds = useMemo<CondList>(() => {
    if (market !== 'TW' || !chips?.inst?.length || !allCandles.length) return null;
    const idx = Math.min(Math.max(currentIndex, 0), allCandles.length - 1);
    const instByDate = new Map(chips.inst.map(d => [d.date, d.total]));
    const ev = instEvaluateAt(allCandles, instByDate, idx);
    if (!ev) return null;
    const price = allCandles[idx].close, date = allCandles[idx].date;
    const tdcc = (chips.tdcc ?? []).filter(r => r.date <= date).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    const last = tdcc[tdcc.length - 1];
    let hl: number | null = null, th = 80, tierName = '千張';
    if (price >= 250) { hl = last?.holder100Pct ?? null; th = 88; tierName = '百張'; }
    else if (price >= 50) { hl = last?.holder400Pct ?? null; th = 86; tierName = '400張'; }
    else { hl = last?.holder1000Pct ?? null; }
    const tooHigh = hl != null && hl > th;
    const c1 = ev.isWeak, c2 = ev.instBuy, c3 = !tooHigh;
    const rows: CondRow[] = [
      { icon: '①', name: '在跌/長黑',
        value: ev.todayChg < -3 && !(ev.drop5 < -3)
          ? `長黑${ev.todayChg.toFixed(1)}%`                              // 靠「今日長黑」入選 → 顯示收/開跌幅
          : `近5日${ev.drop5 >= 0 ? '+' : ''}${ev.drop5.toFixed(1)}%`,   // 否則顯示近5日漲跌（按正負，不再寫死「跌」）
        pass: c1, tip: '近5日跌>3%（在跌）或 今日收<開>3%（長黑）＝買恐慌' },
      { icon: '②', name: '法人逆勢買', value: `${ev.inst5K > 0 ? '+' : ''}${ev.inst5K.toLocaleString()}張`, pass: c2, tip: '法人5日淨買超>0＝聰明錢接刀' },
      { icon: '③', name: '非大戶超高', value: hl != null ? `${tierName}${hl.toFixed(0)}%` : '—', pass: c3, tip: '大戶持股太高＝流通量少陷阱' },
    ];
    return { date, rows, passCount: rows.filter(r => r.pass).length, total: 3, hit: ev.isHit && c3 };
  }, [market, chips, currentIndex, allCandles]);

  // Y 法人偷買(原) 3 道（隨走圖游標）— 委派 lib/inststeal 單一事實：跌 + 5日集中度在爬 + 法人連買
  const yConds = useMemo<CondList>(() => {
    if (market !== 'TW' || !chips?.broker?.length || !chips?.inst?.length || !allCandles.length) return null;
    const idx = Math.min(Math.max(currentIndex, 0), allCandles.length - 1);
    const brokerByDate = new Map(chips.broker.map(d => [d.date, d.netDifference]));
    const instByDate = new Map(chips.inst.map(d => [d.date, d.total]));
    // 集中度跟看盤 app + 顯示表統一：用 FinMind 正式公式（concExact）；該日沒載到才退回簡化版
    const conc5ByDate = new Map(concExact.map(p => [p.date, p.c5]));
    const ev = stealEvaluateAt(allCandles, brokerByDate, instByDate, idx, undefined, conc5ByDate);
    if (!ev) return null;
    const rows: CondRow[] = [
      { icon: '①', name: '股價在跌', value: `近5日${ev.drop5 >= 0 ? '+' : ''}${ev.drop5.toFixed(1)}%`, pass: ev.isDropping, tip: '近5日在回檔（跌幅夠）才是「偷買」場景' },
      { icon: '②', name: '集中度在爬', value: `${ev.conc5prev.toFixed(1)}→${ev.conc5.toFixed(1)}%${ev.concHighWarn ? ' ⚠️過高' : ''}${ev.volumeWarn ? ' ⚠️爆量' : ''}`, pass: ev.isConcRising, tip: '5日主力分點集中度比5日前高（回升中，含還沒翻正）＝慢慢集中。⚠️爆量(≥2倍量)/集中度過高(>12%隔日沖鎖股)現在只警示、不剔除' },
      { icon: '③', name: '法人連買', value: `${ev.instConsecDays}天 ${ev.instSumK > 0 ? '+' : ''}${ev.instSumK.toLocaleString()}張`, pass: ev.isInstBuying, tip: '三大法人合計連買≥2天且近5日淨買超>0' },
    ];
    return { date: allCandles[idx].date, rows, passCount: rows.filter(r => r.pass).length, total: 3, hit: ev.isHit };
  }, [market, chips, currentIndex, allCandles, concExact]);

  // 走圖游標當天日期（三張共用 CMoney 籌碼表的高亮基準 + 持股分布取週）
  const cursorDate = allCandles.length
    ? allCandles[Math.min(Math.max(currentIndex, 0), allCandles.length - 1)].date
    : null;
  // CMoney 風格三張籌碼表（主力分點集中度 / 三大法人 / 集保持股分布）共用 props
  const chipTables: ChipRawTablesProps = {
    broker: chips?.broker,
    inst: chips?.inst,
    tdcc: chips?.tdcc,
    candles: allCandles,
    cursorDate,
    concExact,
    concentrationStatus,
    concentrationError: activeConcResult?.error,
    onRetryConcentration: () => setConcRetry(value => value + 1),
  };

  const sidebarContent = (
    <div
      id={`panel-${sideTab}`}
      role="tabpanel"
      className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-0.5"
    >
      {sideTab === 'conditions' && (
        <SectionBoundary section="買法條件" resetKey={`${currentStock?.ticker ?? 'none'}:${currentDate ?? 'none'}:conditions`}>
          {priceContinuityIssue
            ? <div role="alert" className="rounded border border-amber-500/35 bg-amber-500/10 p-3 text-[11px] leading-relaxed text-amber-100">近期價格序列在 {priceContinuityIssue.date} 出現 {(priceContinuityIssue.changeRatio * 100).toFixed(1)}% 斷層，可能是股票分割、面額變更或未還原公司行動。六條件暫停判讀，避免均線與型態產生假訊號。</div>
            : showSanseView ? <SanSeConditionsPanel report={sanseConditions} /> : <ConditionsPanelSwitch wConds={wConds} xConds={xConds} yConds={yConds} chipTables={chipTables} />}
        </SectionBoundary>
      )}
      {sideTab === 'signals' && (
        <SectionBoundary section="訊號分析" resetKey={`${currentStock?.ticker ?? 'none'}:${currentDate ?? 'none'}:signals`}>
          {priceContinuityIssue
            ? <div role="alert" className="rounded border border-amber-500/35 bg-amber-500/10 p-3 text-[11px] leading-relaxed text-amber-100">技術訊號已暫停：{priceContinuityIssue.date} 的價格斷層會污染 MA、K 線型態與趨勢。待資料完成還原或斷層離開近期技術視窗後再判讀。</div>
            : showSanseView ? <SanSeSignalsPanel report={sanseConditions} market={isCnTicker ? 'CN' : 'TW'} catchTrigger={sanseCatchTrigger} /> : <SignalSummaryCard />}
        </SectionBoundary>
      )}
      {sideTab === 'chip' && (
        currentStock ? (
          <SectionBoundary section="籌碼分析" resetKey={`${currentStock.ticker}:chip`}>
            {isCnTicker
              ? <CnChipPanel symbol={currentStock.ticker} />
              : (
                  <>
                    <ChipDetailPanel symbol={currentStock.ticker} date={currentDate} />
                    {chipsLoading && !chips && (
                      <div role="status" className="mx-2 rounded border border-border/50 bg-secondary/30 px-3 py-2 text-[11px] text-muted-foreground animate-pulse">載入這檔股票的籌碼資料…</div>
                    )}
                    {chipsError && !chipsLoading && (
                      <div role="alert" className="mx-2 flex items-center justify-between gap-2 rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">
                        <span>籌碼資料載入失敗：{chipsError}</span>
                        <button type="button" onClick={() => setChipsRetry(value => value + 1)} className="min-h-9 shrink-0 rounded border border-rose-400/40 px-2 font-medium hover:bg-rose-500/15">重試</button>
                      </div>
                    )}
                    <ChipRawTables {...chipTables} />
                  </>
                )}
          </SectionBoundary>
        ) : (
          <EmptyState
            variant="compact"
            icon="📋"
            title="尚未載入股票"
            description="請先選擇一檔股票以查看籌碼資料"
          />
        )
      )}
      {sideTab === 'fundamental' && (
        currentStock ? (
          <SectionBoundary section="基本面分析" resetKey={`${currentStock.ticker}:fundamental`}>
            {isCnTicker
              ? <CnFundamentalPanel
                  symbol={currentStock.ticker}
                  currentPrice={allCandles[currentIndex]?.close}
                  date={currentIndex < allCandles.length - 1 ? (currentDate ?? undefined) : undefined}
                  isHistorical={currentIndex < allCandles.length - 1}
                />
              : (
                <>
                  <FundamentalScoreSummary
                    key={`fund-score-${currentStock.ticker}`}
                    symbol={currentStock.ticker}
                    currentPrice={allCandles[currentIndex]?.close}
                    date={currentIndex < allCandles.length - 1 ? (currentDate ?? undefined) : undefined}
                  />
                  <FundamentalSidebarPanel
                    key={`fund-panel-${currentStock.ticker}`}
                    symbol={currentStock.ticker}
                    date={currentIndex < allCandles.length - 1 ? (currentDate ?? undefined) : undefined}
                    currentPrice={allCandles[currentIndex]?.close}
                    isHistorical={currentIndex < allCandles.length - 1}
                  />
                </>
              )}
          </SectionBoundary>
        ) : (
          <EmptyState
            variant="compact"
            icon="📊"
            title="尚未載入股票"
            description="請先選擇一檔股票以查看基本面分析"
          />
        )
      )}
    </div>
  );

  // 雙B戰法主圖疊加資料（價格線 + 買賣點）— 只有開關開 + 陸股/台股 + 抓到資料才畫。
  // 三色 overlay/副圖只有日線版本 → 加 currentInterval==='1d' 閘，分鐘線一律不渲染
  //（否則日線 sanse 資料疊到分鐘線會把主圖帶歪、副圖空白錯位）。
  // 歷史走圖換日後，新的 sanse request 回來前不可沿用上一個日期的 payload。
  // 舊 payload 的未來 markers/series 配上已縮短的 candles，會踩 lightweight-charts 的
  // time-scale compaction bug（`Value is null`）。
  const sansePayloadDate = sanse?.candles.at(-1)?.time ?? '';
  const visibleSanse = sanse && (!sanseAsOf || sansePayloadDate === sanseAsOf) ? sanse : null;
  const shuangBOverlay = showShuangB && sanseEnabled && visibleSanse && currentInterval === '1d' ? {
    zhineng: visibleSanse.zhineng, zb4: visibleSanse.zb4, zb5: visibleSanse.zb5, duokong: visibleSanse.duokong,
    markers: visibleSanse.mainMarkers,
  } : null;
  // 副圖（主力狀態F / 捕撈季節）資料 — 對齊主圖 candle 由 IndicatorCharts 自行 map
  // 台股無換手率 → xysTiers 為 undefined（4 級彩柱不畫），金叉/動能柱照常
  const sanseZhuli = sanseEnabled && indicators.mainForce && currentInterval === '1d' ? visibleSanse?.zhuli ?? null : null;
  const sanseXys = sanseEnabled && indicators.season && visibleSanse && currentInterval === '1d' ? {
    xys0: visibleSanse.xys0, xys1: visibleSanse.xys1, xys2: visibleSanse.xys2,
    subMarkers: visibleSanse.subMarkers, xysTiers: visibleSanse.xysTiers ?? null,
  } : null;
  const chartResetKey = `${currentStock?.ticker ?? 'empty'}:${currentInterval}:${visibleCandles.length}:${sanseAsOf}:${sansePayloadDate}`;

  // ABC 偵測器腳位疊加（除錯/驗證）— 選「ABC 突破」買法(J，舊代號 G)且非三色視圖時，
  // 把 detectABCBreakout 實際選的 A/B/C 腳 + 它的下降切線畫到走圖（用走圖游標 currentIndex 對齊面板）。
  const abcOverlay = useMemo(() => {
    const isAbcMethod = activeBuyMethod === 'J' || activeBuyMethod === 'G';
    if (showSanseView || !isAbcMethod) return null;
    if (!allCandles.length || currentIndex < 0) return null;
    const disp = getABCDisplayStructure(allCandles, currentIndex);
    if (!disp) return null;
    const dateAt = (i: number) => allCandles[i]?.date;
    const mk = (i: number, label: string, position: 'aboveBar' | 'belowBar') => {
      const time = dateAt(i);
      return time ? { time, label, position } : null;
    };
    const markers = [
      mk(disp.legAHighIdx, 'A峰', 'aboveBar'),
      mk(disp.legALowIdx, 'A底', 'belowBar'),
      mk(disp.legBHighIdx, 'B峰', 'aboveBar'),
      mk(disp.legCLowIdx, 'C底', 'belowBar'),
    ].filter((m): m is { time: string; label: string; position: 'aboveBar' | 'belowBar' } => m != null);
    const aTime = dateAt(disp.legAHighIdx);
    const todayTime = dateAt(currentIndex);
    if (!aTime || !todayTime) return null;
    // 切線 2 點（A峰 → 今日延伸值）即 A峰→B峰 連線外推，B峰共線故 2 點足夠
    return {
      markers,
      trendline: [
        { time: aTime, value: disp.legAHigh },
        { time: todayTime, value: disp.trendlineValue },
      ],
      broke: disp.brokeTrendline,
    };
  }, [showSanseView, activeBuyMethod, allCandles, currentIndex]);

  // 大戶持股趨勢線 — 只有開關開 + 台股 + 日線才畫。集保是週資料，forward-fill 到每根 K 棒（時間軸對齊），
  // 用 useMemo 穩定 reference 免得每次 hover 重設線。純「格局強弱」參考、不發訊號。
  const holderLineOverlay = useMemo(() => {
    if (!showHolderLine || market !== 'TW' || currentInterval !== '1d') return null;
    const key = holderTier.key;
    const rows = (chips?.tdcc ?? [])
      .filter(r => typeof r[key] === 'number')
      .slice()
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    if (rows.length === 0 || visibleCandles.length === 0) return null;
    const out: { time: string; value: number }[] = [];
    let j = 0;
    for (const c of visibleCandles) {
      while (j + 1 < rows.length && rows[j + 1].date <= c.date) j++;
      if (rows[j].date <= c.date) out.push({ time: c.date, value: rows[j][key]! });
    }
    return out.length ? out : null;
  }, [showHolderLine, market, currentInterval, chips?.tdcc, visibleCandles, holderTier]);

  return (
    // fullViewport=false 永遠允許整頁 vertical scroll（避免 ^TWII 時整頁鎖死無法捲動）
    // chart 區填滿到視窗底（header 49px + py-2 8px = 57px 上方位移 → 扣 58px 讓排底貼齊視窗底、今日簡報退到摺疊線下）
    <PageShell fullViewport={false} headerSlot={<StockSelector />}>
      <h1 className="sr-only">Rockstock 股票決策工作台</h1>
      <div className="flex-1 flex flex-col px-3 py-2 gap-3">
        <div className="flex flex-col min-[1440px]:flex-row gap-3 min-[1440px]:h-[calc(100vh-70px)] min-[1440px]:overflow-hidden">

        {/* Left: Chart */}
        <div className="w-full min-[1440px]:flex-1 min-[1440px]:min-w-[480px] flex flex-col min-w-0 min-h-[60vh] min-[1440px]:min-h-0 gap-1.5">
          <StockChartView
            resetKey={chartResetKey}
            isLoading={isLoadingStock}
            loadingOverlay={
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-card/90">
                <div className="w-3/4 max-w-md space-y-2 mb-4">
                  {/* Skeleton chart lines */}
                  <div className="flex items-end gap-[2px] h-24 justify-center">
                    {Array.from({ length: 30 }).map((_, i) => (
                      <div key={i} className="w-1.5 bg-muted/60 rounded-sm animate-pulse"
                        style={{ height: `${20 + Math.sin(i * 0.4) * 40 + 10}%`, animationDelay: `${i * 30}ms` }} />
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-5 h-5 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
                  <p className="text-sm text-muted-foreground">載入資料中...</p>
                </div>
              </div>
            }
            topAlertSlot={
              <>
                {priceContinuityIssue && (
                  <div role="alert" className="shrink-0 border-b border-amber-500/35 bg-amber-500/10 px-3 py-2 text-[11px] leading-snug text-amber-100">
                    <span className="font-semibold">價格連續性警示：</span>
                    {priceContinuityIssue.date} 收盤由 {priceContinuityIssue.previousClose.toFixed(2)} 變為 {priceContinuityIssue.close.toFixed(2)}（{(priceContinuityIssue.changeRatio * 100).toFixed(1)}%）。技術條件與訊號已暫停，籌碼與基本面仍可查看。
                  </div>
                )}
                {chipAvoid && currentInterval === '1d' && (
                  <div className="shrink-0 px-3 py-1.5 bg-red-900/25 border-b border-red-700/50 text-[11px]">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-bold text-red-300">🚩 買進前避雷</span>
                      {chipAvoid.map(f => (
                        <span key={f.key} className="px-1.5 py-0.5 rounded bg-red-800/50 text-red-200 font-medium" title={f.detail}>
                          {f.label}
                        </span>
                      ))}
                      <span className="text-muted-foreground/70">— 只示警不擋，回測這幾個事後系統性偏弱</span>
                    </div>
                  </div>
                )}
                {loadError && (
                  <div role="alert" className="shrink-0 flex items-center gap-2 px-3 py-2 bg-red-900/30 border-b border-red-700/50 text-xs">
                    <span className="text-red-400">{loadError}</span>
                    {failedLoadRequest && (
                      <button
                        type="button"
                        onClick={() => {
                          setLoadError(null);
                          loadStock(failedLoadRequest.symbol, failedLoadRequest.tf, undefined, failedLoadRequest.date)
                            .then(() => { setLoadError(null); setFailedLoadRequest(null); })
                            .catch((e: Error) => setLoadError(`載入 ${failedLoadRequest.symbol} 失敗：${e.message || '請稍後再試'}`));
                        }}
                        className="min-h-9 shrink-0 text-sky-400 hover:text-sky-300 underline"
                      >重試同一檔</button>
                    )}
                  </div>
                )}
                {dataGaps.length > 0 && currentInterval === '1d' && (() => {
                  const halts = dataGaps.filter((g) => g.kind === 'halt');
                  const stale = dataGaps.find((g) => g.kind === 'stale');
                  return (
                    <div className="shrink-0 px-3 py-1.5 bg-yellow-500/10 border-b border-yellow-500/30 text-yellow-400 text-xs flex items-center justify-between gap-2">
                      <span>
                        {halts.length > 0 && (
                          <>停牌 {halts.map((g) => `${g.fromDate} → ${g.toDate}（${g.calendarDays}天無交易）`).join('、')}</>
                        )}
                        {halts.length > 0 && stale && <span className="mx-1">·</span>}
                        {stale && (
                          <>資料 {stale.calendarDays} 天未更新（{stale.fromDate} 起）</>
                        )}
                      </span>
                      {stale && (
                        <button
                          onClick={() => { if (!currentStock) return; loadStock(currentStock.ticker.replace(/\.(TW|TWO|SS|SZ)$/i, ''), '1d', '2y').catch(() => {}); }}
                          className="text-yellow-300 hover:text-yellow-200 underline ml-2 whitespace-nowrap">
                          重新下載
                        </button>
                      )}
                    </div>
                  );
                })()}
              </>
            }
            toolbarSlot={displayCandle && (
              <ChartToolbar
                candle={displayCandle}
                prevCandle={prev}
                isHover={!!hoverCandle}
                stockName={currentStock?.name}
                trend={currentTrend}
                currentInterval={currentInterval}
                onIntervalChange={handleIntervalChange}
                maToggles={maToggles}
                onMaToggle={handleMaToggle}
                showBollinger={showBollinger}
                onBollingerToggle={() => setShowBollinger(v => !v)}
                showYangEma={showYangEma}
                onYangEmaToggle={handleYangEmaToggle}
                indicators={indicators}
                onIndicatorToggle={key => setIndicators(p => ({ ...p, [key]: !p[key] }))}
                onChipGroupToggle={toggleChipGroup}
                onApplyPreset={applyChartPreset}
                showShuangB={showShuangB}
                onShuangBToggle={() => setShowShuangB(v => !v)}
                showHolderLine={showHolderLine}
                onHolderLineToggle={() => setShowHolderLine(v => !v)}
                showMarkers={showMarkers}
                onMarkersToggle={() => setShowMarkers(v => !v)}
                signalStrengthMin={signalStrengthMin}
                onSignalStrengthChange={setSignalStrengthMin}
                showPivots={showPivots}
                onPivotsToggle={() => setShowPivots(v => !v)}
                showSupportResistance={showSupportResistance}
                onSupportResistanceToggle={() => setShowSupportResistance(v => !v)}
                showCandleSR={showCandleSR}
                onCandleSRToggle={() => setShowCandleSR(v => !v)}
                showNeckline={showNeckline}
                onNecklineToggle={() => setShowNeckline(v => !v)}
                showPattern={showPattern}
                onPatternToggle={() => setShowPattern(v => !v)}
                showAscendingLine={showAscendingTrendline || showAscendingChannel}
                onAscendingLineToggle={toggleAscendingLine}
                showDescendingLine={showDescendingTrendline || showDescendingChannel}
                onDescendingLineToggle={toggleDescendingLine}
                showConsolidationLines={showConsolidationLines}
                onConsolidationLinesToggle={() => setShowConsolidationLines(v => !v)}
                avgCost={metrics.avgCost}
                shares={metrics.shares}
                onPrev={prevCandle}
                onNext={nextCandle}
                onReset={resetReplay}
                canPrev={currentIndex > 0 && !isPlaying}
                canNext={currentIndex < allCandles.length - 1 && !isPlaying}
                onPrevBuyPoint={() => jumpToBuyPoint('prev')}
                onNextBuyPoint={() => jumpToBuyPoint('next')}
                canPrevBuyPoint={canPrevBuyPoint && !isPlaying}
                canNextBuyPoint={canNextBuyPoint && !isPlaying}
                ticker={currentStock?.ticker}
                market={market}
                scanDate={scanDate ?? null}
              />
            )}
            chartProps={{
              candles: visibleCandles,
              signals: priceContinuityIssue ? [] : currentSignals,
              chartMarkers: priceContinuityIssue
                ? []
                : [...(showMarkers ? mergedMarkers : []), ...blowoffMarkers],
              avgCost: metrics.shares > 0 ? metrics.avgCost : undefined,
              stopLossPrice,
              onCrosshairMove: setHoverCandle,
              onDoubleClick: (candle) => {
                const idx = allCandles.findIndex(c => c.date === candle.date);
                if (idx >= 0) useReplayStore.getState().jumpToIndex(idx);
              },
              maToggles,
              showBollinger,
              showYangEma,
              showPivots,
              showSupportResistance,
              showCandleSR,
              showAscendingTrendline,
              showDescendingTrendline,
              showAscendingChannel,
              showDescendingChannel,
              showConsolidationLines,
              showNeckline,
              showPattern,
              highlightDate: targetDate ?? undefined,
              lockedPattern,
              shuangB: shuangBOverlay,
              abcOverlay,
              holderLine: holderLineOverlay,
              holderLineLabel: holderTier.label,
            }}
            indicatorProps={{
              candles: visibleCandles,
              hoverCandle,
              indicators,
              ticker: currentStock?.ticker,
              chips,
              chipsLoading,
              sanseZhuli,
              sanseXys,
            }}
            showIndicators={showIndicators}
            onToggleIndicators={() => setShowIndicators(v => !v)}
            chartSplit={chartSplit}
            onChartSplitChange={setChartSplit}
            onChartSplitCommit={handleChartSplitCommit}
          />
        </div>

        {/* Middle: Sidebar */}
        <div className="w-full min-[1440px]:w-72 2xl:w-80 shrink-0 flex flex-col min-h-0 gap-2">
          {/* Mobile: Sheet drawer */}
          <div className="min-[1440px]:hidden">
            <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
              <SheetTrigger className="flex min-h-11 items-center justify-between w-full px-3 py-2 bg-secondary rounded-lg text-sm text-foreground/80 border border-border">
                <span>分析面板</span>
                <span className={`transition-transform ${mobileSheetOpen ? 'rotate-180' : ''}`}>&#9660;</span>
              </SheetTrigger>
              <SheetContent side="bottom" className="h-[85vh] flex flex-col p-0">
                <SheetHeader className="px-4 pt-4 pb-2 shrink-0">
                  <SheetTitle className="text-sm">分析面板</SheetTitle>
                </SheetHeader>
                <div className="flex-1 flex flex-col min-h-0 px-3 pb-3 gap-2">
                  {sidebarTabs}
                  {sidebarContent}
                </div>
              </SheetContent>
            </Sheet>
          </div>

          {/* Desktop: inline sidebar */}
          <div id="analysis-sidebar" className="hidden min-[1440px]:flex flex-col min-h-0 gap-2">
            {sidebarTabs}
            {sidebarContent}
          </div>

          {/* 自選股 / 持倉 摺疊面板 */}
          <BottomPanel onSelectHolding={() => setSideTab('signals')} />

          {/* 數據健康度 L1-L4 */}
          <div className="shrink-0 px-2 py-1.5">
            <DataHealthBadge market={useBacktestStore(s => s.market)} forceDown />
          </div>
        </div>

        {/* ── Right: 多源候選 panel（tab：策略掃描 / YouTube 提及） ── */}
        <div className={`shrink-0 flex flex-col min-h-0 ring-1 ring-foreground/10 bg-card/80 rounded-xl overflow-hidden transition-all duration-300 ${
          scannerOpen
            ? 'w-full min-[1440px]:w-[min(38vw,600px)] min-h-[50vh] min-[1440px]:min-h-0'
            : 'w-full min-[1440px]:w-11 h-11 min-[1440px]:h-auto'
        }`}>
          {scannerOpen ? (
            <>
              {/* Panel header：tab 切換 + close button（mobile 用 icon + 短名，desktop 用完整名）*/}
              <div
                role="tablist"
                aria-label="右側資料來源"
                className="shrink-0 flex items-stretch overflow-x-auto border-b border-border bg-secondary/30 whitespace-nowrap"
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
                  const current = RIGHT_TABS.findIndex(key => key === rightTab);
                  const next = event.key === 'Home' ? 0 : event.key === 'End' ? RIGHT_TABS.length - 1 : event.key === 'ArrowRight'
                    ? (current + 1) % RIGHT_TABS.length : (current - 1 + RIGHT_TABS.length) % RIGHT_TABS.length;
                  event.preventDefault();
                  selectRightTab(RIGHT_TABS[next]);
                  requestAnimationFrame(() => document.getElementById(`source-tab-${RIGHT_TABS[next]}`)?.focus());
                }}
              >
                <button
                  type="button"
                  role="tab"
                  id="source-tab-scan"
                  aria-selected={rightTab === 'scan'}
                  aria-controls="source-panel-scan"
                  tabIndex={rightTab === 'scan' ? 0 : -1}
                  onClick={() => selectRightTab('scan')}
                  className={`flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 px-1.5 2xl:px-3 text-sm font-semibold transition-colors ${
                    rightTab === 'scan'
                      ? 'text-foreground border-b-2 border-sky-500 -mb-px bg-card/60'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  title="朱老師策略掃描"
                >
                  <Search className="w-3 h-3" />
                  <span>策略掃描</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  id="source-tab-youtube"
                  aria-selected={rightTab === 'youtube'}
                  aria-controls="source-panel-youtube"
                  tabIndex={rightTab === 'youtube' ? 0 : -1}
                  onClick={() => selectRightTab('youtube')}
                  className={`flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 px-1.5 2xl:px-3 text-sm font-semibold transition-colors ${
                    rightTab === 'youtube'
                      ? 'text-foreground border-b-2 border-purple-500 -mb-px bg-card/60'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  title="YouTube 節目提及股票"
                >
                  <Video className="size-4" aria-hidden="true" />
                  <span>YouTube</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  id="source-tab-sectors"
                  aria-selected={rightTab === 'sectors'}
                  aria-controls="source-panel-sectors"
                  tabIndex={rightTab === 'sectors' ? 0 : -1}
                  onClick={() => selectRightTab('sectors')}
                  className={`flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 px-1.5 2xl:px-3 text-sm font-semibold transition-colors ${
                    rightTab === 'sectors'
                      ? 'text-foreground border-b-2 border-teal-500 -mb-px bg-card/60'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  title="題材分類：題材熱度／資金流入／法人買賣超／排名變化"
                >
                  <Flame className="size-4" aria-hidden="true" />
                  <span>題材</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  id="source-tab-broker"
                  aria-selected={rightTab === 'broker'}
                  aria-controls="source-panel-broker"
                  tabIndex={rightTab === 'broker' ? 0 : -1}
                  onClick={() => selectRightTab('broker')}
                  className={`flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 px-1.5 2xl:px-3 text-sm font-semibold transition-colors ${
                    rightTab === 'broker'
                      ? 'text-foreground border-b-2 border-rose-500 -mb-px bg-card/60'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  title="法人報告：報告後漲跌幅 + 目標價達成度"
                >
                  <Landmark className="size-4" aria-hidden="true" />
                  <span>法人</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  id="source-tab-etf"
                  aria-selected={rightTab === 'etf'}
                  aria-controls="source-panel-etf"
                  tabIndex={rightTab === 'etf' ? 0 : -1}
                  onClick={() => selectRightTab('etf')}
                  className={`flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 px-1.5 2xl:px-3 text-sm font-semibold transition-colors ${
                    rightTab === 'etf'
                      ? 'text-foreground border-b-2 border-emerald-500 -mb-px bg-card/60'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  title="台股 ETF 追蹤：績效排行／持股異動／共識買榜／被納入後表現"
                >
                  <LineChart className="size-4" aria-hidden="true" />
                  <span>台股 ETF</span>
                </button>
                <button onClick={() => setScannerOpen(false)} aria-label="收起研究面板"
                  className="min-w-11 min-h-11 px-2 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  title="收起面板"
                >
                  <ChevronDown className="w-3.5 h-3.5 rotate-90" />
                </button>
              </div>

              {/* Tab content */}
              <div id={`source-panel-${rightTab}`} role="tabpanel" aria-labelledby={`source-tab-${rightTab}`} className="animate-fade-in flex-1 min-h-0">
                {rightTab === 'scan' && (
                  <ScanPanelVertical onSelectStock={handleScanSelectStock} />
                )}
                {rightTab === 'youtube' && (
                  <YoutubePanel
                    date={youtubeDate}
                    onDateChange={changeYoutubeDate}
                    onSelectStock={handleYoutubeSelectStock}
                    // 統一以「現在看的股票」為準，4 個 tab 之間 highlight 同步
                    selectedCode={currentStock?.ticker?.replace(/\.(TW|TWO|SS|SZ)$/i, '') ?? null}
                  />
                )}
                {rightTab === 'sectors' && (
                  <SectorsPanel
                    onSelectStock={handleSectorSelectStock}
                    selectedCode={currentStock?.ticker?.replace(/\.(TW|TWO|SS|SZ|BJ)$/i, '') ?? null}
                  />
                )}
                {rightTab === 'broker' && (
                  <BrokerReportsPanel
                    date={brokerDate}
                    onDateChange={changeBrokerDate}
                    onSelectStock={handleYoutubeSelectStock}
                    selectedCode={currentStock?.ticker?.replace(/\.(TW|TWO|SS|SZ)$/i, '') ?? null}
                  />
                )}
                {rightTab === 'etf' && (
                  <ETFPanel />
                )}
              </div>
            </>
          ) : (
            /* Collapsed: horizontal bar on mobile, vertical label on desktop */
            <button
              onClick={() => setScannerOpen(true)}
              className="flex-1 min-h-11 flex flex-row min-[1440px]:flex-col items-center justify-center gap-2 hover:bg-muted/50 transition-colors group"
              title="掃描"
            >
              <Search className="w-3.5 h-3.5 text-muted-foreground group-hover:text-blue-400 transition-colors" />
              <span className="text-sm text-muted-foreground group-hover:text-foreground transition-colors min-[1440px]:[writing-mode:vertical-rl]">研究工具</span>
            </button>
          )}
        </div>

        </div>{/* end 3-col flex */}

      </div>
      {/* P1-5: Keyboard shortcut help overlay */}
      {showHelp && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setShowHelp(false)}
        >
          <div
            className="bg-card ring-1 ring-foreground/10 rounded-xl shadow-2xl p-5 w-80 max-w-[90vw]"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold text-foreground">鍵盤快捷鍵</h2>
              <button onClick={() => setShowHelp(false)} aria-label="關閉" className="text-muted-foreground hover:text-foreground text-lg leading-none">×</button>
            </div>
            <div className="space-y-1 text-xs">
              {([
                ['←  /  →', '前一根 / 下一根 K 棒'],
                ['空白鍵', '播放 / 暫停'],
                ['I', '展開 / 收起副圖指標'],
                ['1', '切換至「條件」面板'],
                ['2', '切換至「訊號」面板'],
                ['3', '切換至「籌碼」面板'],
                ['4', '切換至「基本面」面板'],
                ['5', '展開 / 收起掃描面板'],
                ['B', '買入（全倉）'],
                ['S', '賣出（半倉）'],
                ['Q', '全部賣出'],
                ['?', '顯示 / 關閉本說明'],
              ] as [string, string][]).map(([key, desc]) => (
                <div key={key} className="flex items-center gap-3 py-1 border-b border-border/50 last:border-0">
                  <kbd className="shrink-0 w-24 text-center px-2 py-0.5 rounded bg-secondary text-foreground/80 font-mono text-[10px]">{key}</kbd>
                  <span className="text-muted-foreground">{desc}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 手機走圖全螢幕視圖 */}
      {mobileChartFullscreen && (
        <div className="md:hidden fixed inset-0 z-[100] bg-background flex flex-col">
          <div className="shrink-0 flex items-center gap-2 px-2 py-2 border-b border-border bg-card">
            <BackButton
              onClick={closeMobileChart}
              label="返回掃描清單"
              className="shrink-0 p-1.5 rounded hover:bg-muted text-foreground"
            />
            <div className="flex-1 min-w-0">
              <StockSelector />
            </div>
          </div>

          {displayCandle && (
            <div className="shrink-0">
              <ChartToolbar
                candle={displayCandle}
                prevCandle={prev}
                isHover={!!hoverCandle}
                stockName={currentStock?.name}
                trend={currentTrend}
                currentInterval={currentInterval}
                onIntervalChange={handleIntervalChange}
                maToggles={maToggles}
                onMaToggle={handleMaToggle}
                showBollinger={showBollinger}
                onBollingerToggle={() => setShowBollinger(v => !v)}
                showYangEma={showYangEma}
                onYangEmaToggle={handleYangEmaToggle}
                indicators={indicators}
                onIndicatorToggle={key => setIndicators(p => ({ ...p, [key]: !p[key] }))}
                onChipGroupToggle={toggleChipGroup}
                onApplyPreset={applyChartPreset}
                showShuangB={showShuangB}
                onShuangBToggle={() => setShowShuangB(v => !v)}
                showHolderLine={showHolderLine}
                onHolderLineToggle={() => setShowHolderLine(v => !v)}
                showMarkers={showMarkers}
                onMarkersToggle={() => setShowMarkers(v => !v)}
                signalStrengthMin={signalStrengthMin}
                onSignalStrengthChange={setSignalStrengthMin}
                showPivots={showPivots}
                onPivotsToggle={() => setShowPivots(v => !v)}
                showSupportResistance={showSupportResistance}
                onSupportResistanceToggle={() => setShowSupportResistance(v => !v)}
                showCandleSR={showCandleSR}
                onCandleSRToggle={() => setShowCandleSR(v => !v)}
                showNeckline={showNeckline}
                onNecklineToggle={() => setShowNeckline(v => !v)}
                showPattern={showPattern}
                onPatternToggle={() => setShowPattern(v => !v)}
                showAscendingLine={showAscendingTrendline || showAscendingChannel}
                onAscendingLineToggle={toggleAscendingLine}
                showDescendingLine={showDescendingTrendline || showDescendingChannel}
                onDescendingLineToggle={toggleDescendingLine}
                showConsolidationLines={showConsolidationLines}
                onConsolidationLinesToggle={() => setShowConsolidationLines(v => !v)}
                avgCost={metrics.avgCost}
                shares={metrics.shares}
                onPrev={prevCandle}
                onNext={nextCandle}
                onReset={resetReplay}
                canPrev={currentIndex > 0 && !isPlaying}
                canNext={currentIndex < allCandles.length - 1 && !isPlaying}
                onPrevBuyPoint={() => jumpToBuyPoint('prev')}
                onNextBuyPoint={() => jumpToBuyPoint('next')}
                canPrevBuyPoint={canPrevBuyPoint && !isPlaying}
                canNextBuyPoint={canNextBuyPoint && !isPlaying}
                ticker={currentStock?.ticker}
                market={market}
                scanDate={scanDate ?? null}
              />
            </div>
          )}

          <div className="flex-1 min-h-0 flex flex-col">
            {isLoadingStock ? (
              <div className="flex-1 flex items-center justify-center">
                <span className="w-5 h-5 border-2 border-sky-500 border-t-transparent rounded-full animate-spin mr-2" />
                <span className="text-sm text-muted-foreground">載入中…</span>
              </div>
            ) : (
              <>
                <div className="flex-[3] min-h-0">
                  <ErrorBoundary section="K線圖" resetKey={`${chartResetKey}:mobile-main`}>
                    <CandleChart
                      candles={visibleCandles}
                      signals={priceContinuityIssue ? [] : currentSignals}
                      chartMarkers={priceContinuityIssue ? [] : (showMarkers ? mergedMarkers : [])}
                      avgCost={metrics.shares > 0 ? metrics.avgCost : undefined}
                      stopLossPrice={stopLossPrice}
                      onCrosshairMove={setHoverCandle}
                      fillContainer
                      maToggles={maToggles}
                      showBollinger={showBollinger}
                      showYangEma={showYangEma}
                      showPivots={showPivots}
                      showSupportResistance={showSupportResistance}
                      showCandleSR={showCandleSR}
                      showAscendingTrendline={showAscendingTrendline}
                      showDescendingTrendline={showDescendingTrendline}
                      showAscendingChannel={showAscendingChannel}
                      showDescendingChannel={showDescendingChannel}
                      showConsolidationLines={showConsolidationLines}
                      showNeckline={showNeckline}
                      showPattern={showPattern}
                      highlightDate={targetDate ?? undefined}
                      lockedPattern={lockedPattern}
                      shuangB={shuangBOverlay}
                      abcOverlay={abcOverlay}
                      holderLine={holderLineOverlay}
                      holderLineLabel={holderTier.label}
                    />
                  </ErrorBoundary>
                </div>
                {showIndicators && (
                  <div className="flex-[2] min-h-0 border-t border-border">
                    <ErrorBoundary section="副圖" resetKey={`${chartResetKey}:mobile-indicators`}>
                      <IndicatorCharts candles={visibleCandles} hoverCandle={hoverCandle} indicators={indicators} ticker={currentStock?.ticker} chips={chips} chipsLoading={chipsLoading} sanseZhuli={sanseZhuli} sanseXys={sanseXys} />
                    </ErrorBoundary>
                  </div>
                )}
                <button
                  onClick={() => setShowIndicators(v => !v)}
                  className="shrink-0 py-1 text-[10px] text-muted-foreground hover:text-foreground bg-secondary/60 border-t border-border"
                >
                  {showIndicators ? '▼ 收起副圖' : '▲ 展開副圖'}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </PageShell>
  );
}
