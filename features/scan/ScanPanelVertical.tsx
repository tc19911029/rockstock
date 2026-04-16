'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useBacktestStore } from '@/store/backtestStore';
import { ScanResultsCompact } from './components/ScanResultsCompact';
import { DabanResultsCompact } from './components/DabanResultsCompact';
import { SectionBoundary } from '@/components/ErrorBoundary';
import type { SelectedStock } from './components/ScanChartPanel';

interface ScanPanelVerticalProps {
  onSelectStock?: (stock: SelectedStock) => void;
}

export function ScanPanelVertical({ onSelectStock }: ScanPanelVerticalProps) {
  const {
    market, scanDate,
    useMultiTimeframe, toggleMultiTimeframe,
    setMarket, setScanDate,
    isScanning, scanProgress, scanningStock, scanningCount, scanError,
    scanResults, isFetchingForward, forwardError,
    clearCurrent,
    setScanOnly,
    scanDirection, setScanDirection,
    marketTrend,
    cancelScan,
    cronDates, fetchCronDates,
    isLoadingCronSession,
    autoLoadLatest,
  } = useBacktestStore();

  const [maxDate] = useState(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date()));

  // 載入歷史日期；市場/方向切換後自動載入最新結果
  const conditionMountedRef = useRef(false);
  useEffect(() => {
    const isInitialMount = !conditionMountedRef.current;
    conditionMountedRef.current = true;

    if (scanDirection === 'daban') {
      fetchCronDates(market, 'long');
      return;
    }
    const dir = scanDirection === 'short' ? 'short' : 'long';
    if (isInitialMount) {
      autoLoadLatest();
    } else {
      fetchCronDates(market, dir).then(() => {
        const dates = useBacktestStore.getState().cronDates.filter(c => c.market === market);
        if (dates.length > 0) {
          const bestDate = dates.find(c => c.resultCount > 0)?.date ?? dates[0].date;
          useBacktestStore.getState().loadCronSession(market, bestDate, { scanOnly: true, direction: dir });
        }
      });
    }

    // Periodic refresh
    const timer = window.setInterval(() => {
      const dir2 = useBacktestStore.getState().scanDirection === 'short' ? 'short' : 'long';
      fetchCronDates(useBacktestStore.getState().market, dir2);
    }, 5 * 60 * 1000);

    return () => window.clearInterval(timer);
  }, [market, scanDirection, fetchCronDates]); // eslint-disable-line react-hooks/exhaustive-deps

  const isBusy = isScanning || isFetchingForward;

  const handleScan = useCallback(() => {
    if (isBusy) return;
    setScanOnly(true);
    setTimeout(() => useBacktestStore.getState().runScan(), 0);
  }, [isBusy, setScanOnly]);

  return (
    <div className="flex flex-col min-h-0 h-full text-foreground text-xs">
      {/* ── Toolbar: vertical stacked ── */}
      <div className="shrink-0 px-2.5 py-2 border-b border-border space-y-1.5">
        {/* Row 1: Market + Direction */}
        <div className="flex items-center gap-1.5">
          <div className="flex rounded overflow-hidden border border-border">
            {(['TW', 'CN'] as const).map(m => (
              <button key={m} onClick={async () => {
                if (m === market) return;
                setMarket(m);
                clearCurrent();
                const dir = scanDirection === 'long' || scanDirection === 'short' ? scanDirection : 'long';
                setScanDirection(dir);
                await fetchCronDates(m, dir);
                const mDates = useBacktestStore.getState().cronDates.filter(c => c.market === m);
                if (mDates.length > 0) {
                  const bestDate = mDates.find(c => c.resultCount > 0)?.date ?? mDates[0].date;
                  useBacktestStore.getState().loadCronSession(m, bestDate, { scanOnly: true, direction: dir });
                }
              }}
                className={`px-2 py-1 text-[11px] font-medium ${market === m ? 'bg-blue-600 text-foreground' : 'bg-secondary text-muted-foreground hover:bg-muted'}`}>
                {m === 'TW' ? '台股' : '陸股'}
              </button>
            ))}
          </div>

          <div className="flex rounded overflow-hidden border border-border">
            <button onClick={() => { setScanDirection('long'); clearCurrent(); }}
              className={`px-2 py-1 text-[11px] font-medium ${scanDirection === 'long' ? 'bg-red-600 text-foreground' : 'bg-secondary text-muted-foreground hover:bg-muted'}`}>多</button>
            <button onClick={() => { setScanDirection('short'); clearCurrent(); }}
              className={`px-2 py-1 text-[11px] font-medium ${scanDirection === 'short' ? 'bg-green-600 text-foreground' : 'bg-secondary text-muted-foreground hover:bg-muted'}`}>空</button>
            {market === 'CN' && (
              <button onClick={() => { setScanDirection('daban'); }}
                className={`px-2 py-1 text-[11px] font-medium ${scanDirection === 'daban' ? 'bg-amber-600 text-foreground' : 'bg-secondary text-muted-foreground hover:bg-muted'}`}>打板</button>
            )}
          </div>

          {/* 長線保護短線 toggle */}
          {scanDirection !== 'daban' && (
            <button onClick={toggleMultiTimeframe}
              className={`px-1.5 py-1 rounded text-[10px] font-medium border ${useMultiTimeframe ? 'bg-blue-700/60 border-blue-600 text-blue-200' : 'bg-secondary border-border text-muted-foreground hover:bg-muted'}`}>
              長線保護短線
            </button>
          )}
        </div>

        {/* Row 2: Date + Scan button */}
        <div className="flex items-center gap-1.5">
          <input type="date" value={scanDate} max={maxDate} min="2020-01-01"
            onChange={e => { setScanDate(e.target.value); clearCurrent(); }}
            className="flex-1 min-w-0 bg-secondary border border-border text-foreground rounded px-1.5 py-1 text-[11px] focus:outline-none focus:border-sky-500"
          />
          <button onClick={handleScan} disabled={isBusy || !scanDate}
            className="shrink-0 px-2.5 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-foreground text-[11px] font-semibold rounded whitespace-nowrap">
            {isScanning ? `${Math.round(scanProgress)}%` : '掃描'}
          </button>
          {isBusy && (
            <button onClick={cancelScan}
              className="shrink-0 px-1.5 py-1 bg-red-700 hover:bg-red-600 text-foreground text-[10px] rounded">
              ✕
            </button>
          )}
        </div>

        {/* Row 3: result count */}
        <div className="flex items-center gap-1.5 text-[10px]">
          {scanResults.length > 0 && !isScanning && scanDirection !== 'daban' && (
            <span className="text-muted-foreground ml-auto">
              <span className="text-amber-400 font-bold">{scanResults.length}</span> 檔
              {marketTrend && (
                <span className={`ml-1 px-1 py-0.5 rounded text-[9px] font-bold ${
                  marketTrend === '多頭' ? 'bg-red-900/50 text-red-300' :
                  marketTrend === '空頭' ? 'bg-green-900/50 text-green-300' :
                  'bg-yellow-900/50 text-yellow-300'
                }`}>{marketTrend}</span>
              )}
            </span>
          )}
        </div>
      </div>

      {/* ── Scrollable content ── */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Date Navigator — vertical pill list */}
        {cronDates.some(c => c.market === market) && (
          <div className="px-2.5 py-1.5 border-b border-border">
            <div className="flex flex-wrap gap-1">
              {cronDates.filter(c => c.market === market)
                .filter((c, i, arr) => arr.findIndex(x => x.date === c.date) === i)
                .slice(0, 20)
                .map(c => {
                  const isActive = c.date === scanDate;
                  return (
                    <button key={c.date}
                      onClick={() => {
                        if (isBusy || isLoadingCronSession) return;
                        if (scanDirection === 'daban') {
                          useBacktestStore.setState({ scanDate: c.date });
                        } else {
                          useBacktestStore.getState().loadCronSession(c.market, c.date, { scanOnly: true, direction: scanDirection });
                        }
                      }}
                      disabled={isBusy || isLoadingCronSession}
                      className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${
                        isActive ? 'bg-sky-700 text-sky-100 font-semibold' : 'bg-secondary/60 text-muted-foreground hover:bg-secondary'
                      } ${isBusy || isLoadingCronSession ? 'opacity-50' : ''}`}
                      title={`${c.date}｜${c.resultCount >= 0 ? c.resultCount + ' 檔' : ''}`}
                    >
                      {c.date.slice(5)}
                      {c.resultCount >= 0 && <span className="ml-0.5 opacity-60">({c.resultCount})</span>}
                    </button>
                  );
                })}
            </div>
          </div>
        )}

        {/* Progress bar */}
        {(isScanning || isFetchingForward) && (
          <div className="px-2.5 py-1.5 border-b border-border">
            <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-0.5">
              <span className="truncate">{isScanning ? (scanningStock || '掃描中…') : '計算績效…'}</span>
              {isScanning && scanningCount && <span className="font-mono shrink-0">{scanningCount}</span>}
            </div>
            <div className="h-1 bg-secondary rounded-full overflow-hidden">
              <div className="h-full bg-sky-500 rounded-full transition-all duration-500"
                style={{ width: isScanning ? `${scanProgress}%` : '100%' }} />
            </div>
          </div>
        )}

        {/* Loading */}
        {isLoadingCronSession && scanResults.length === 0 && (
          <div className="px-3 py-3 text-center text-muted-foreground">
            <span className="inline-block w-3 h-3 border border-sky-500/30 border-t-sky-500 rounded-full animate-spin mr-1.5" />
            <span className="text-[11px]">載入中…</span>
          </div>
        )}

        {/* Error / Warning */}
        {(scanError || forwardError) && (() => {
          const msg = scanError || forwardError || '';
          const isWarning = msg.includes('\u90e8\u5206\u8986\u84cb') || msg.includes('\u8986\u84cb\u7387') || msg.includes('無符合');
          const isInfo = msg.includes('正常現象');
          const colorClass = isInfo
            ? 'bg-blue-950/60 border border-blue-900 text-blue-300'
            : isWarning
              ? 'bg-amber-950/60 border border-amber-900 text-amber-300'
              : 'bg-red-950/60 border border-red-900 text-red-300';
          return (
            <div className={`mx-2.5 my-1.5 px-2.5 py-2 rounded text-[10px] leading-relaxed ${colorClass}`}>
              {msg.split('\n').map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          );
        })()}

        {/* Results — compact card view */}
        <div className="py-1.5">
          {scanDirection === 'daban' ? (
            <SectionBoundary section="打板掃描結果">
              <DabanResultsCompact date={scanDate} onSelectStock={onSelectStock} />
            </SectionBoundary>
          ) : (
            <SectionBoundary section="掃描結果">
              <ScanResultsCompact onSelectStock={onSelectStock} />
            </SectionBoundary>
          )}
        </div>
      </div>
    </div>
  );
}
