'use client';

/**
 * /youtube/replay — 已合併到首頁 YouTube tab
 *
 * Stage 7 後，首頁右側 panel 加了「YouTube 提及」tab，
 * 功能與此頁 100% 重複。此頁保留 URL 但只做 client-side redirect。
 *
 * 為什麼不刪：保留外部 bookmark / 內部連結相容性。
 */

import { Suspense, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';

export default function YoutubeReplayRedirectPage() {
  return <Suspense fallback={null}><YoutubeReplayRedirect /></Suspense>;
}

function YoutubeReplayRedirect() {
  const searchParams = useSearchParams();

  useEffect(() => {
    const date = searchParams.get('date');
    const target = date && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? `/?tab=youtube&date=${date}`
      : '/?tab=youtube';
    // 用 window.location.replace 強制 full reload，
    // 確保 HomePage 的 mount-time URL 讀取邏輯能正確吸收 ?tab= 與 ?date=
    window.location.replace(target);
  }, [searchParams]);

  return (
    <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
      正在跳轉到首頁 YouTube 提及…
    </div>
  );
}
