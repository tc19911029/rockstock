'use client';

/**
 * /today → redirect to /#today-briefing
 *
 * 「今日決策中心」已整合進主頁 TodayBriefing 區塊（走圖下方）。
 * 保留路由為了向下相容：舊 deep link 自動轉到主頁並 scroll 到 briefing。
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function TodayRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/#today-briefing');
  }, [router]);
  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
      今日決策中心已整合進主頁 → 轉跳中…
    </div>
  );
}
