'use client';

/**
 * useThemeHeatMap — 前端 display-layer join：把「今日最熱題材」拉成
 * `Map<裸碼, ThemeRef[]>`（refs[0] = 今日最熱），給各策略掃描頁的
 * 台股／陸股「🔥今日市場題材熱度」排序 + 卡片標籤用。
 *
 * 走既有 `/api/theme-sanse/hot?market=&date=`（TW=市場題材；CN=概念板塊）。
 * 只在 market/date 變時抓一次（route 端按 (market,date) 快取，反覆切頁不重算）。
 *
 * ⚠ 純展示/排序用途：不灌進掃描資料流、不改選股分數（§0 隔離、鐵則 #5）。
 *   陸股「最熱概念」回測是反指標 → 面板顯示時自帶「只供觀察別追高」提醒。
 */

import { useEffect, useState } from 'react';
import type { ThemeRef } from '@/lib/theme-sanse/types';

export function useThemeHeatMap(
  market: string | undefined,
  date: string | undefined,
): Map<string, ThemeRef[]> {
  const [map, setMap] = useState<Map<string, ThemeRef[]>>(() => new Map());

  useEffect(() => {
    if ((market !== 'TW' && market !== 'CN') || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setMap(new Map());
      return;
    }
    const ac = new AbortController();
    fetch(`/api/theme-sanse/hot?market=${market}&date=${date}`, { signal: ac.signal })
      .then((r) => (r.ok ? (r.json() as Promise<{ ok?: boolean; byCode?: Record<string, ThemeRef[]> }>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => {
        if (ac.signal.aborted) return;
        setMap(j.ok && j.byCode ? new Map(Object.entries(j.byCode)) : new Map());
      })
      .catch(() => {
        if (!ac.signal.aborted) setMap(new Map()); // 熱度取不到不致命 — 排序退回無題材
      });
    return () => ac.abort();
  }, [market, date]);

  return map;
}
