'use client';

/**
 * useTotalCapital — 客戶端 hook，讀「目前總資產」(NT$) 給 sizing UI 顯示金額用
 *
 * 來源優先序：
 *   1. /api/portfolio/growth-status → progress.currentCapital（會即時用 holdings × 最新 K 線 close）
 *   2. fallback: /api/portfolio/account → account.totalCapital（可能是 0）
 *
 * 若兩者皆 0，回 null（UI 改顯示「設定總資產後顯示 NT$」hint）。
 *
 * 用法：
 *   const cap = useTotalCapital();
 *   const amount = cap != null && sizeHintPct > 0
 *     ? formatNT(cap * sizeHintPct / 100)
 *     : null;
 */

import { useEffect, useState } from 'react';

let cached: { value: number | null; ts: number } | null = null;
const TTL_MS = 60_000;

export function useTotalCapital(): number | null {
  const [cap, setCap] = useState<number | null>(() => {
    if (cached && Date.now() - cached.ts < TTL_MS) return cached.value;
    return null;
  });

  useEffect(() => {
    if (cached && Date.now() - cached.ts < TTL_MS) return;
    let canceled = false;
    (async () => {
      try {
        const r = await fetch('/api/portfolio/growth-status');
        const j = await r.json();
        const v: number | null = j?.progress?.currentCapital ?? null;
        if (v && v > 0) {
          cached = { value: v, ts: Date.now() };
          if (!canceled) setCap(v);
          return;
        }
        const r2 = await fetch('/api/portfolio/account');
        const j2 = await r2.json();
        const v2: number | null = j2?.account?.totalCapital ?? null;
        cached = { value: v2 && v2 > 0 ? v2 : null, ts: Date.now() };
        if (!canceled) setCap(cached.value);
      } catch {
        cached = { value: null, ts: Date.now() };
        if (!canceled) setCap(null);
      }
    })();
    return () => { canceled = true; };
  }, []);

  return cap;
}

/** 格式化 NT$ 金額，> 1 萬顯示 K/M 為單位 */
export function formatNT(amount: number): string {
  if (amount >= 1_000_000) return `NT$${(amount / 1_000_000).toFixed(amount >= 10_000_000 ? 1 : 2)}M`;
  if (amount >= 10_000) return `NT$${(amount / 10_000).toFixed(0)}萬`;
  return `NT$${Math.round(amount).toLocaleString()}`;
}
