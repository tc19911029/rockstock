'use client';

/**
 * /agents — 多代理決策中心（獨立頁）。
 *
 * 2026-06-19：首頁右側分頁瘦身成四入口（策略掃描／YouTube／題材分類／法人報告），
 * 多代理移出首頁但功能保留 → 改回獨立頁，URL 仍可進。點股票跳回首頁走圖。
 */

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { PageShell, PageHeader } from '@/components/shared';
import { MultiAgentTopPanel } from '@/components/MultiAgentTopPanel';

export default function AgentsPage() {
  const router = useRouter();
  const onSelectStock = useCallback((symbol: string) => {
    router.push(`/?load=${encodeURIComponent(symbol)}`);
  }, [router]);

  return (
    <PageShell
      headerSlot={<PageHeader title="🤖 多代理決策" subtitle="4 階段：分析師 → 風控 → 多空 → 決策" backButton />}
    >
      <MultiAgentTopPanel onSelectStock={onSelectStock} />
    </PageShell>
  );
}
