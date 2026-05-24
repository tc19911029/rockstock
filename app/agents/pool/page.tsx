'use client';

/**
 * /agents/pool → redirect to /?tab=pool
 *
 * 此頁已整合進首頁右側 tab「候選池」（components/CandidatesPoolPanel）。
 * 保留路由為了向下相容：舊 deep link 自動轉到首頁對應 tab。
 *
 * 原始功能完整版仍可從 git history 拉回（commit 之前的 git log -- app/agents/pool/page.tsx）。
 */

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function AgentsPoolRedirect() {
  const router = useRouter();
  const sp = useSearchParams();

  useEffect(() => {
    const params = new URLSearchParams();
    params.set('tab', 'pool');
    const date = sp.get('date');
    if (date) params.set('date', date);
    router.replace(`/?${params.toString()}`);
  }, [router, sp]);

  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
      候選池已整合進首頁 → 轉跳中…
    </div>
  );
}
