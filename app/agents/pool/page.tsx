'use client';

/**
 * /agents/pool — 多源候選股票池（獨立頁）。
 *
 * 2026-06-19：首頁右側分頁瘦身成四入口，候選池移出首頁但功能保留 → 改回獨立頁，URL 仍可進。
 * 點股票跳回首頁走圖。
 */

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { PageShell, PageHeader } from '@/components/shared';
import { CandidatesPoolPanel } from '@/components/CandidatesPoolPanel';

export default function AgentsPoolPage() {
  const router = useRouter();
  const onSelectStock = useCallback((symbol: string) => {
    router.push(`/?load=${encodeURIComponent(symbol)}`);
  }, [router]);

  return (
    <PageShell
      headerSlot={<PageHeader title="🗂 候選池" subtitle="多源候選股票池（技術／籌碼／基本面／YouTube）" backButton />}
    >
      <CandidatesPoolPanel onSelectStock={onSelectStock} />
    </PageShell>
  );
}
