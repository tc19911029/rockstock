'use client';

/**
 * /youtube/trends → redirect to /?tab=youtube
 *
 * 此頁已整合進首頁右側 tab「YouTube 提及」（components/youtube/YoutubeStocksPanel）。
 * 保留路由為了向下相容：舊 deep link 自動轉到首頁對應 tab。
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function YoutubeTrendsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/?tab=youtube');
  }, [router]);
  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
      跨日趨勢已整合進首頁 → 轉跳中…
    </div>
  );
}
