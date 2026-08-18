'use client';

import { useEffect, useState } from 'react';
import {
  getLegacyBookAchievementRate,
  isTopPatternType,
  type PatternPivotSnapshot,
} from '@/lib/analysis/patternCatalog';
import {
  inferPatternMarket,
  selectLatestLockedPattern,
} from '@/lib/scanner/lockedPatternSelection';
import type { MarketId } from '@/lib/scanner/types';

export interface LockedPattern {
  patternType: string;
  necklinePrice: number;
  targetPrice: number;
  stopPrice?: number;
  achievementRate?: number;
  kind: 'bottom' | 'top';
  pivots?: PatternPivotSnapshot[];
  triggeredDate?: string;
}

interface LockwatchRecordShape {
  symbol: string;
  patternType?: string;
  /** N 訊號：頸線價（即 LockWatchRecord.triggerPrice） */
  triggerPrice?: number;
  patternTargetPrice?: number;
  /** F 訊號：V 底，可作為結構失效價 */
  vBottom?: number;
  patternAchievementRate?: number;
  triggerSignal?: string;
  /** 紀錄階段 — 結構失效/已撤銷的紀錄不可作為走圖鎖定來源 */
  currentStage?: string;
  triggeredDate?: string;
  market?: MarketId;
  patternPivots?: PatternPivotSnapshot[];
}

interface LockwatchApiResponse {
  ok?: boolean;
  snapshot?: { records?: LockwatchRecordShape[] } | null;
}

/**
 * 鎖股觀察紀錄 → 走圖型態 chip 的穩定資料源。
 * 只要 symbol 變動就重抓；走圖前後切時間軸不會重算。
 *
 * 為什麼存在：app/page.tsx 跟 ScanChartPanel 都要把 lockedPattern 傳進 CandleChart，
 * 兩處原本各自實作會漂移；統一抽 hook 並補掃描側 wiring，型態/頸線就不會跟著時間軸跳動。
 */
export function useLockedPattern(symbol: string | null | undefined, marketHint?: MarketId): {
  lockedPattern: LockedPattern | null;
  loading: boolean;
} {
  const [lockedPattern, setLockedPattern] = useState<LockedPattern | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!symbol) {
      setLockedPattern(null);
      return;
    }
    const market = inferPatternMarket(symbol, marketHint);
    let cancelled = false;
    setLoading(true);
    fetch(`/api/lockwatch?market=${market}`)
      .then((r) => r.json() as Promise<LockwatchApiResponse>)
      .then((j) => {
        if (cancelled) return;
        if (!j.ok || !j.snapshot) {
          setLockedPattern(null);
          return;
        }
        const rec = selectLatestLockedPattern(j.snapshot.records ?? [], symbol);
        if (!rec || !rec.patternType || rec.triggerPrice == null || rec.patternTargetPrice == null) {
          setLockedPattern(null);
          return;
        }
        setLockedPattern({
          patternType: rec.patternType,
          necklinePrice: rec.triggerPrice,
          targetPrice: rec.patternTargetPrice,
          stopPrice: rec.vBottom,  // F 才有；N 由 CandleChart 依底/頂方向套用頸線 ±3% fallback
          // 舊資料可能存過自行估算的 N=75% 或頂部對稱值；只從 canonical 舊書表取可核對數字。
          achievementRate: getLegacyBookAchievementRate(rec.patternType),
          kind: isTopPatternType(rec.patternType) ? 'top' : 'bottom',
          pivots: rec.patternPivots,
          triggeredDate: rec.triggeredDate,
        });
      })
      .catch(() => {
        if (!cancelled) setLockedPattern(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, marketHint]);

  return { lockedPattern, loading };
}
