'use client';

import { useETFStore, type ETFTab } from '@/store/etfStore';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { PageShell, PageHeader } from '@/components/shared';
import { ETFPerformanceTab } from './components/ETFPerformanceTab';
import { ETFChangesTab } from './components/ETFChangesTab';
import { ETFConsensusTab } from './components/ETFConsensusTab';
import { ETFTrackingTab } from './components/ETFTrackingTab';

const TABS: Array<{ value: ETFTab; label: string }> = [
  { value: 'performance', label: '績效排行' },
  { value: 'changes', label: '持股異動' },
  { value: 'consensus', label: '共識買榜' },
  { value: 'tracking', label: '被納入後表現' },
];

export function ETFPageContent() {
  const { activeTab, setActiveTab } = useETFStore();

  const header = <PageHeader title="📈 ETF 追蹤" backButton />;

  return (
    <PageShell headerSlot={header}>
      <div className="px-4 py-4 max-w-7xl mx-auto">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as ETFTab)}>
          <TabsList>
            {TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>{t.label}</TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="performance"><ETFPerformanceTab /></TabsContent>
          <TabsContent value="changes"><ETFChangesTab /></TabsContent>
          <TabsContent value="consensus"><ETFConsensusTab /></TabsContent>
          <TabsContent value="tracking"><ETFTrackingTab /></TabsContent>
        </Tabs>
      </div>
    </PageShell>
  );
}
