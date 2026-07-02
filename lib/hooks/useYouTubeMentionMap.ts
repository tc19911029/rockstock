'use client';

/**
 * useYouTubeMentionMap — 前端 display-layer join：把 YouTube 提及紀錄拉成
 * `Map<bareCode, YouTubeMentionSummary>`，給策略掃描列／候選池在 UI 旁邊
 * 併呈「這檔最近有沒有被節目討論」。
 *
 * ⚠ 純展示用途：不把 YouTube 灌進掃描資料流、不改選股分數/排序（CLAUDE.md
 *   規則 #4/#6 + §0 隔離；「UI 整合不代表 source 混合」）。
 *
 * 資料來源全部重用既有 `/api/youtube/trends`（aggregateStockTrends）。
 * 為了讓「近 7 天 / 近 30 天提及次數」單位一致（都是 mention 次數，非天數），
 * 一次平行抓 7d + 30d 兩個視窗，各取該視窗的 total_mentions。
 *
 * endDate = 掃描/候選池當日 → 看歷史掃描時顯示「截至當日」的提及，不會穿越未來。
 */

import { useEffect, useState } from 'react';
import type { StockTrendRow } from '@/lib/youtube/historicalAggregator';

export interface YouTubeMentionSummary {
  /** 裸代號（如 "2330"）*/
  code: string;
  name: string;
  /** 近 7 天提及次數（同日多節目都算）*/
  count7d: number;
  /** 近 30 天提及次數 */
  count30d: number;
  /** 近 30 天被提到的不同天數 */
  daysMentioned: number;
  /** 最近一次提及日期 YYYY-MM-DD（''=無）*/
  lastDate: string;
  /** 近 30 天提到的不同節目數 */
  programsCount: number;
  /** 近 30 天整體傾向 */
  sentiment: StockTrendRow['sentiment'];
  /** 最近一次評級（若有 scoring）*/
  latestRating: StockTrendRow['latest_rating'];
}

interface TrendsResponse {
  ok?: boolean;
  stocks?: StockTrendRow[];
}

/**
 * @param endDate 截止日 YYYY-MM-DD（通常為掃描/候選池當日）；undefined → 空 map
 */
export function useYouTubeMentionMap(endDate?: string): {
  map: Map<string, YouTubeMentionSummary>;
  loading: boolean;
} {
  const [map, setMap] = useState<Map<string, YouTubeMentionSummary>>(() => new Map());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!endDate || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      setMap(new Map());
      return;
    }
    const ac = new AbortController();
    setLoading(true);

    const fetchRange = (range: '7d' | '30d') =>
      fetch(`/api/youtube/trends?range=${range}&end_date=${endDate}`, { signal: ac.signal })
        .then((r) => (r.ok ? (r.json() as Promise<TrendsResponse>) : Promise.reject(new Error(`HTTP ${r.status}`))));

    Promise.all([fetchRange('30d'), fetchRange('7d')])
      .then(([d30, d7]) => {
        if (ac.signal.aborted) return;
        const count7dByCode = new Map<string, number>();
        for (const s of d7.stocks ?? []) count7dByCode.set(s.stock_code, s.total_mentions);

        const next = new Map<string, YouTubeMentionSummary>();
        for (const s of d30.stocks ?? []) {
          next.set(s.stock_code, {
            code: s.stock_code,
            name: s.stock_name,
            count7d: count7dByCode.get(s.stock_code) ?? 0,
            count30d: s.total_mentions,
            daysMentioned: s.days_mentioned,
            lastDate: s.dates[0] ?? '',
            programsCount: s.source_diversity,
            sentiment: s.sentiment,
            latestRating: s.latest_rating,
          });
        }
        setMap(next);
      })
      .catch(() => {
        if (!ac.signal.aborted) setMap(new Map());
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });

    return () => ac.abort();
  }, [endDate]);

  return { map, loading };
}
