'use client';

/**
 * StockChartView — 統一的左側 K 線主視窗 layout 容器
 *
 * 抽出首頁 (/)、/youtube/replay、未來 /agents/[symbol] 共用的「左側 chart 主視窗」結構：
 *   ─────────────────────────────────────
 *   [ topAlertSlot   ]  ← dataGaps / loadError 警告
 *   [ toolbarSlot    ]  ← ChartToolbar (OHLCV bar + 指標切換)
 *   [ CandleChart    ]  ← 主圖 (height = chartSplit%)
 *   [ 分隔條 + 副圖按鈕 ]
 *   [ IndicatorCharts ]  ← 副圖 (height = (1 - chartSplit)%)
 *   ─────────────────────────────────────
 *
 * 不負責的事：
 * - 右側 sidebar / scan panel（呼叫端自由組）
 * - toggle state（maToggles / showBollinger 等）— 全部從父層 props 傳入
 * - chartSplit 持久化（呼叫端決定要不要寫 localStorage）
 * - 鍵盤快捷鍵（呼叫端各自註冊）
 *
 * 共用範圍只到「視覺與互動 layout」，業務邏輯仍在頁面層。
 */

import { type ReactNode, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import type { ComponentProps } from 'react';

const CandleChart = dynamic(() => import('@/components/CandleChart'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full bg-card flex items-center justify-center">
      <span className="text-muted-foreground text-sm animate-pulse">載入K線圖中...</span>
    </div>
  ),
});

const IndicatorCharts = dynamic(() => import('@/components/IndicatorCharts'), { ssr: false });

// 取原始元件的 props type（不含 fillContainer / height — 由本元件統一管控）
type CandleChartOwnProps = Omit<ComponentProps<typeof CandleChart>, 'fillContainer' | 'height'>;
type IndicatorChartsProps = ComponentProps<typeof IndicatorCharts>;

export interface StockChartViewProps {
  /** 頂部警告列：dataGaps / loadError 等（顯示在 toolbar 上方）*/
  topAlertSlot?: ReactNode;

  /** 工具列：ChartToolbar（OHLCV bar + 指標切換）— 呼叫端自組 */
  toolbarSlot?: ReactNode;

  /** K 線主圖 props（不含 fillContainer / height，自動套用） */
  chartProps: CandleChartOwnProps;

  /** 副圖指標 props（傳 null 等於不渲染副圖，但仍會顯示「展開副圖」按鈕） */
  indicatorProps: IndicatorChartsProps | null;

  /** 副圖開關 */
  showIndicators: boolean;
  onToggleIndicators: () => void;

  /** 主圖 / 副圖比例（0.2 ~ 0.85） */
  chartSplit: number;
  onChartSplitChange: (split: number) => void;
  /** 拖拽放開時呼叫一次（呼叫端可在此持久化 chartSplit；不傳則無 commit hook） */
  onChartSplitCommit?: (split: number) => void;

  /** 全頁載入狀態（套半透明 + pointer-events-none） */
  isLoading?: boolean;

  /** 載入時的 overlay 內容（呼叫端決定要 skeleton 還是 spinner） */
  loadingOverlay?: ReactNode;

  /** 外層 className（呼叫端可加自訂 padding / gap） */
  className?: string;

  /** 股票／週期／走圖日期組成的錯誤邊界重置鍵。 */
  resetKey?: string;
}

/**
 * 拖拽分隔條 — 共用邏輯抽出來
 * 呼叫端只負責 chartSplit state + onChartSplitChange
 */
function useChartSplitDrag(
  containerRef: React.RefObject<HTMLDivElement | null>,
  onChartSplitChange: (split: number) => void,
  onChartSplitCommit?: (split: number) => void,
) {
  const draggingRef = useRef(false);

  return useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    let latestSplit: number | null = null;

    const handleMove = (me: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const newSplit = Math.min(Math.max((me.clientY - rect.top) / rect.height, 0.2), 0.85);
      onChartSplitChange(newSplit);
      latestSplit = newSplit;
    };

    const handleUp = () => {
      draggingRef.current = false;
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      if (latestSplit !== null && onChartSplitCommit) {
        onChartSplitCommit(latestSplit);
      }
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [containerRef, onChartSplitChange, onChartSplitCommit]);
}

export function StockChartView({
  topAlertSlot,
  toolbarSlot,
  chartProps,
  indicatorProps,
  showIndicators,
  onToggleIndicators,
  chartSplit,
  onChartSplitChange,
  onChartSplitCommit,
  isLoading,
  loadingOverlay,
  className,
  resetKey,
}: StockChartViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const startSplitDrag = useChartSplitDrag(containerRef, onChartSplitChange, onChartSplitCommit);
  const setSplit = useCallback((value: number) => {
    const next = Math.min(Math.max(value, 0.2), 0.85);
    onChartSplitChange(next);
    onChartSplitCommit?.(next);
  }, [onChartSplitChange, onChartSplitCommit]);
  const lastCandleDate = chartProps.candles.at(-1)?.date ?? 'empty';
  const chartBoundaryKey = resetKey ?? `${indicatorProps?.ticker ?? 'unknown'}:${lastCandleDate}:${chartProps.candles.length}`;
  const sanseDataDate = indicatorProps?.sanseXys?.xys0.at(-1)?.time ?? 'no-sanse';

  return (
    <div
      ref={containerRef}
      className={`relative flex flex-col flex-1 rounded-xl ring-1 ring-foreground/10 overflow-hidden bg-card transition-opacity animate-fade-in ${
        isLoading ? 'opacity-40 pointer-events-none' : ''
      } ${className ?? ''}`}
    >
      {isLoading && loadingOverlay}

      {topAlertSlot}

      {toolbarSlot}

      {/* Chart area: flex-1 確保比例算的是「chart 區」而不是「整個 panel」
          避免 toolbar wrap 多行時副圖被擠成 0 高度 */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* K 線主圖 */}
        <div
          className={showIndicators ? 'shrink-0' : 'flex-1 min-h-0'}
          style={showIndicators ? { height: `${+(chartSplit * 100).toFixed(2)}%` } : undefined}
        >
          <ErrorBoundary section="K線圖" resetKey={`${chartBoundaryKey}:main`}>
            <CandleChart {...chartProps} fillContainer />
          </ErrorBoundary>
        </div>

        {/* 分隔條 + 副圖展開按鈕 */}
        <div className="shrink-0 flex items-center">
          {showIndicators ? (
            <div
              role="separator"
              tabIndex={0}
              aria-orientation="horizontal"
              aria-label="調整 K 線圖與副圖高度比例"
              aria-valuemin={20}
              aria-valuemax={85}
              aria-valuenow={Math.round(chartSplit * 100)}
              aria-valuetext={`K 線圖占 ${Math.round(chartSplit * 100)}%`}
              className="flex-1 h-6 bg-border/60 hover:bg-blue-500/40 cursor-row-resize flex items-center justify-center group select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400"
              onMouseDown={startSplitDrag}
              onKeyDown={(event) => {
                if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); setSplit(chartSplit - 0.05); }
                if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); setSplit(chartSplit + 0.05); }
                if (event.key === 'Home') { event.preventDefault(); setSplit(0.2); }
                if (event.key === 'End') { event.preventDefault(); setSplit(0.85); }
              }}
              title="拖曳或使用方向鍵調整 K 線與副圖比例"
            >
              <div className="w-12 h-1 bg-muted-foreground/50 group-hover:bg-blue-400 rounded-full transition-colors" />
            </div>
          ) : (
            <div className="flex-1 h-px bg-border" />
          )}
          <button
            onClick={onToggleIndicators}
            aria-label={showIndicators ? '收起副圖指標' : '展開副圖指標'}
            aria-expanded={showIndicators}
            className="shrink-0 min-h-11 px-3 text-sm text-muted-foreground hover:text-foreground bg-secondary/60 hover:bg-secondary rounded transition-colors"
          >
            {showIndicators ? '▼ 副圖' : '▲ 副圖'}
          </button>
        </div>

        {/* 副圖指標 */}
        {showIndicators && indicatorProps && (
          <div className="flex-1 min-h-0 overflow-hidden">
            <ErrorBoundary section="副圖" resetKey={`${chartBoundaryKey}:${sanseDataDate}:indicators`}>
              <IndicatorCharts {...indicatorProps} />
            </ErrorBoundary>
          </div>
        )}
      </div>
    </div>
  );
}
