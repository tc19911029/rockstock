'use client';

/**
 * /agents → redirect to /?tab=agent
 *
 * 此頁已整合進首頁右側 tab「多代理」（components/MultiAgentTopPanel）。
 * 保留路由為了向下相容：舊 deep link 自動轉到首頁對應 tab。
 */

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function AgentsRedirectPage() {
  return <Suspense fallback={null}><AgentsRedirect /></Suspense>;
}

function AgentsRedirect() {
  const router = useRouter();
  const sp = useSearchParams();

  useEffect(() => {
    const params = new URLSearchParams();
    params.set('tab', 'agent');
    const date = sp.get('date');
    if (date) params.set('date', date);
    router.replace(`/?${params.toString()}`);
  }, [router, sp]);

  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
      多代理決策中心已整合進首頁 → 轉跳中…
    </div>
  );
}
