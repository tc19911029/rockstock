'use client';

/**
 * /youtube — 已合併到首頁 YouTube tab
 *
 * Stage 7 後，首頁右側 panel 加了「YouTube 提及」tab，
 * 包含跨節目共識 + 提及股票表（與此頁 100% 重複）。此頁保留 URL 但只做 client-side redirect。
 *
 * 為什麼不刪：保留外部 bookmark / 內部連結相容性。
 * 跨日趨勢與個股歷史仍保留 /youtube/trends 與 /youtube/stocks/[code]，可由首頁連到。
 */

import { Suspense, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';

export default function YoutubeRedirectPage() {
  return <Suspense fallback={null}><YoutubeRedirect /></Suspense>;
}

function YoutubeRedirect() {
  const searchParams = useSearchParams();

  useEffect(() => {
    const date = searchParams.get('date');
    const target = date && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? `/?tab=youtube&date=${date}`
      : '/?tab=youtube';
    // Full reload 確保 HomePage mount-time 邏輯能讀到 ?tab= 與 ?date=
    window.location.replace(target);
  }, [searchParams]);

  return (
    <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
      正在跳轉到首頁 YouTube 提及…
    </div>
  );
}
