'use client';

import { useBacktestStore } from '@/store/backtestStore';

export function DateNavigator() {
  const {
    cronDates, isFetchingCron,
    market, scanDate, scanDirection,
    isLoadingCronSession, isFetchingForward,
    loadCronSession,
  } = useBacktestStore();

  const isBusy = isLoadingCronSession || isFetchingForward;

  // Filter dates for current market (cronDates already filtered by direction from API)
  const dates = cronDates.filter(c => c.market === market);

  if (dates.length === 0 && !isFetchingCron) return null;

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-border bg-secondary/30 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
          掃描紀錄
        </h3>
        <span className="text-[10px] text-muted-foreground/60">
          {dates.length} 個交易日
        </span>
      </div>
      <div className="px-2 py-2 flex flex-wrap gap-1.5 max-h-[120px] overflow-y-auto">
        {isFetchingCron && dates.length === 0 && (
          <span className="text-[10px] text-muted-foreground/60 animate-pulse px-2">載入歷史中…</span>
        )}
        {dates.map(c => {
          const isActive = c.date === scanDate;
          // Show only MM/DD for compactness
          const label = c.date.slice(5); // "03-27"
          return (
            <button
              key={c.date}
              onClick={() => !isBusy && loadCronSession(c.market, c.date, { scanOnly: true, direction: scanDirection === 'daban' ? 'long' : scanDirection })}
              disabled={isBusy}
              className={`px-2 py-1 rounded text-[11px] font-mono transition-colors whitespace-nowrap ${
                isActive
                  ? 'bg-sky-700 text-sky-100 font-semibold'
                  : 'bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground'
              } ${isBusy ? 'opacity-50 cursor-wait' : 'cursor-pointer'}`}
              title={`${c.date}｜${c.resultCount >= 0 ? c.resultCount + ' 檔' : '點擊載入'}`}
            >
              {label}
              {c.resultCount >= 0 && (
                <span className="ml-1 text-[9px] opacity-60">({c.resultCount})</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
