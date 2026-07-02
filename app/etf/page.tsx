'use client';

/**
 * /etf — 已合併到首頁右側「ETF 追蹤」tab（2026-06-21）。
 *
 * 內容全部抽進 features/etf 的 ETFPanel（首頁右側 tab 也用同一支）。
 * 此頁保留 URL 但只做 client-side redirect（bookmark / 內部連結相容）。
 */

import { useEffect } from 'react';

export default function ETFRedirectPage() {
  useEffect(() => {
    // Full reload 確保 HomePage mount-time 邏輯能讀到 ?tab=
    window.location.replace('/?tab=etf');
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
      正在跳轉到首頁 ETF 追蹤…
    </div>
  );
}
