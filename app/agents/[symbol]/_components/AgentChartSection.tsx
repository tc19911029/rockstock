'use client';

/**
 * AgentChartSection — `/agents/[symbol]` 統一股票詳細頁的內嵌走圖區
 *
 * Stage 5：把走圖內嵌到決策視角頁，使用者不必跳轉到 `/?load=` 即可看 K 線。
 *
 * 設計：
 *   - 預設展開（collapsible，可摺起）
 *   - 內部 own 所有 toggle state（不外露 props 給 page）
 *   - 用 useReplayStore.loadStock(symbol) 拉資料，與首頁/replay 共用同一個 store
 *   - 走圖元件用 StockChartView（與首頁、/youtube/replay 同一套）
 *
 * 跟首頁的差異：
 *   - 無 mobile fullscreen modal
 *   - 無 chartSplit localStorage 持久化（agent 頁是研究情境，不必跨頁記住比例）
 *   - 無鍵盤快捷鍵（不搶 page-level focus）
 *   - 副圖預設只開成交量 / KD / MACD（不開籌碼，籌碼有專屬 ChipDetail 區塊）
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useReplayStore } from '@/store/replayStore';
import { useV12HistoricalMarkers } from '@/lib/hooks/useV12HistoricalMarkers';
import { useLockedPattern } from '@/lib/hooks/useLockedPattern';
import { detectTrend } from '@/lib/analysis/trendAnalysis';
import { StockChartView } from '@/components/shared';
import ChartToolbar from '@/components/ChartToolbar';
import { toast } from 'sonner';
import { ChevronDown, ChevronUp } from 'lucide-react';

interface AgentChartSectionProps {
  symbol: string;
  scanDate?: string;
}

export function AgentChartSection({ symbol, scanDate }: AgentChartSectionProps) {
  const [expanded, setExpanded] = useState(true);

  const {
    visibleCandles, currentSignals, chartMarkers,
    isLoadingStock, allCandles, currentIndex,
    loadStock, currentStock,
    signalStrengthMin, setSignalStrengthMin,
    metrics, nextCandle, prevCandle, isPlaying, resetReplay, targetDate,
  } = useReplayStore();

  // 載入該股 K 線（symbol 改變或 scanDate 改變時重載）
  useEffect(() => {
    if (!symbol) return;
    loadStock(symbol, '1d', '2y', scanDate).catch((err: Error) => {
      toast.error(`載入 ${symbol} K 線失敗：${err.message || '請稍後再試'}`);
    });
  }, [symbol, scanDate, loadStock]);

  // v12 markers + locked pattern（與首頁同一套）
  const v12Markers = useV12HistoricalMarkers(allCandles, currentStock?.ticker ?? '', true);
  const mergedMarkers = useMemo(
    () => [...chartMarkers, ...v12Markers],
    [chartMarkers, v12Markers],
  );
  const { lockedPattern } = useLockedPattern(currentStock?.ticker);
  const currentTrend = useMemo(
    () => allCandles.length > 0 && currentIndex >= 20 ? detectTrend(allCandles, currentIndex) : null,
    [allCandles, currentIndex],
  );

  // 走圖內所有 toggle state（與首頁同一套，但 indicator 預設只開三個）
  const [hoverCandle, setHoverCandle] = useState<typeof allCandles[0] | null>(null);
  const [showMarkers, setShowMarkers] = useState(false);
  const [showPivots, setShowPivots] = useState(true);
  const [showSupportResistance, setShowSupportResistance] = useState(false);
  // K 棒三層支撐/壓力標線（最近一根長紅/長黑：最高/1半/最低），預設關
  const [showCandleSR, setShowCandleSR] = useState(false);
  const [showNeckline, setShowNeckline] = useState(false);
  const [showPattern, setShowPattern] = useState(false);
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
  const [maToggles, setMaToggles] = useState({ ma5: true, ma10: true, ma20: true, ma60: true, ma120: false, ma240: false });
  // 月線（20MA）預設打開（書本 CH3-03），但使用者可手動開關
  const handleMaToggle = useCallback((key: keyof typeof maToggles) => {
    setMaToggles(p => ({ ...p, [key]: !p[key] }));
  }, []);
  const [showBollinger, setShowBollinger] = useState(false);
  // 副圖：成交量 / KD / MACD 預設開（agent 頁不需要籌碼疊圖，已有專屬區塊）
  const [indicators, setIndicators] = useState({
    macd: true, kd: true, volume: true, rsi: false,
    foreign: false, trust: false, dealer: false, retail: false,
    h400: false, h1000: false,
    cnMain: false, cnRetail: false,
    mainForce: false, season: false,
  });
  // 「籌碼」合併鈕：一鍵開關法人四（TW）+ CN 主力/散戶副圖
  const toggleChipGroup = (next: boolean) =>
    setIndicators(p => ({ ...p, foreign: next, trust: next, dealer: next, retail: next, cnMain: next, cnRetail: next }));
  const [showIndicators, setShowIndicators] = useState(true);
  const [chartSplit, setChartSplit] = useState(0.65);

  const displayCandle = hoverCandle ?? allCandles[currentIndex];
  const prev = hoverCandle
    ? allCandles[allCandles.findIndex(c => c.date === hoverCandle.date) - 1]
    : allCandles[currentIndex - 1];

  return (
    <div className="border border-cyan-700/40 bg-slate-900 rounded-lg overflow-hidden">
      {/* Section header — collapse toggle */}
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-4 py-2 border-b border-cyan-700/30 hover:bg-cyan-900/20 transition-colors"
      >
        <div className="flex items-center gap-2 text-xs font-semibold tracking-wider text-cyan-400">
          <span>▸ 走圖</span>
          <span className="text-muted-foreground font-normal">— K 線 + 副圖（與首頁同步）</span>
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-cyan-400" /> : <ChevronDown className="w-4 h-4 text-cyan-400" />}
      </button>

      {/* Chart body（collapsed 時不渲染，省 K 線初始化開銷） */}
      {expanded && (
        <div className="h-[640px] flex p-2">
          <StockChartView
            isLoading={isLoadingStock}
            loadingOverlay={
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-card/90">
                <div className="flex items-center gap-2">
                  <div className="w-5 h-5 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
                  <p className="text-sm text-muted-foreground">載入 K 線資料中...</p>
                </div>
              </div>
            }
            toolbarSlot={displayCandle && (
              <ChartToolbar
                candle={displayCandle}
                prevCandle={prev}
                isHover={!!hoverCandle}
                stockName={currentStock?.name}
                trend={currentTrend}
                maToggles={maToggles}
                onMaToggle={handleMaToggle}
                showBollinger={showBollinger}
                onBollingerToggle={() => setShowBollinger(v => !v)}
                indicators={indicators}
                onIndicatorToggle={key => setIndicators(p => ({ ...p, [key]: !p[key] }))}
                onChipGroupToggle={toggleChipGroup}
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
                ticker={currentStock?.ticker}
              />
            )}
            chartProps={{
              candles: visibleCandles,
              signals: currentSignals,
              chartMarkers: showMarkers ? mergedMarkers : [],
              avgCost: metrics.shares > 0 ? metrics.avgCost : undefined,
              onCrosshairMove: setHoverCandle,
              onDoubleClick: (candle) => {
                const idx = allCandles.findIndex(c => c.date === candle.date);
                if (idx >= 0) useReplayStore.getState().jumpToIndex(idx);
              },
              maToggles,
              showBollinger,
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
            }}
            indicatorProps={{
              candles: visibleCandles,
              hoverCandle,
              indicators,
              ticker: currentStock?.ticker,
              chips: null,
              chipsLoading: false,
            }}
            showIndicators={showIndicators}
            onToggleIndicators={() => setShowIndicators(v => !v)}
            chartSplit={chartSplit}
            onChartSplitChange={setChartSplit}
          />
        </div>
      )}
    </div>
  );
}
