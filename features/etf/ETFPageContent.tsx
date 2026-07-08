'use client';

import { useETFStore, type ETFTab } from '@/store/etfStore';
import { PageShell, PageHeader } from '@/components/shared';
import { ETFPerformanceTab } from './components/ETFPerformanceTab';
import { ETFChangesTab } from './components/ETFChangesTab';
import { ETFConsensusTab } from './components/ETFConsensusTab';
import { ETFTrackingTab } from './components/ETFTrackingTab';
import { ETFDiagnosticsTab } from './components/ETFDiagnosticsTab';
import { ETFTrendCheckBanner } from './components/ETFTrendCheckBanner';

const TABS: Array<{ value: ETFTab; label: string }> = [
  { value: 'performance', label: '績效排行' },
  { value: 'changes', label: '持股異動' },
  { value: 'consensus', label: '共識買榜' },
  { value: 'tracking', label: '被納入後表現' },
  { value: 'diagnostics', label: 'ETF 體檢' },
];

/**
 * ETFPanel — 免外框版面，給首頁右側「ETF 追蹤」tab 用（600px 面板內）。
 * 版型對齊「題材分類」分頁（SectorsPanel）：p-4 space-y-3 外框 + 分段式 pill 切換，
 * 不用 shadcn Tabs（避免跟其他面板長得不一樣）。不含 PageShell / PageHeader / max-w-7xl。
 */
export function ETFPanel() {
  const { activeTab, setActiveTab } = useETFStore();

  return (
    <div className="p-4 space-y-3 h-full overflow-y-auto">
      <ETFTrendCheckBanner />
      <div className="flex flex-wrap items-stretch gap-2">
        <div className="inline-flex items-center rounded-lg border border-border bg-secondary/30 p-0.5 text-sm max-w-full overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.value}
              onClick={() => setActiveTab(t.value)}
              className={`px-3 py-1.5 rounded-md whitespace-nowrap transition-colors ${
                activeTab === t.value
                  ? 'bg-card text-foreground shadow-sm font-medium'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'performance' && <ETFPerformanceTab />}
      {activeTab === 'changes' && <ETFChangesTab />}
      {activeTab === 'consensus' && <ETFConsensusTab />}
      {activeTab === 'tracking' && <ETFTrackingTab />}
      {activeTab === 'diagnostics' && <ETFDiagnosticsTab />}
    </div>
  );
}

export function ETFPageContent() {
  const header = <PageHeader title="📈 ETF 追蹤" backButton />;

  return (
    <PageShell headerSlot={header}>
      <div className="max-w-7xl mx-auto">
        <ETFPanel />
      </div>
    </PageShell>
  );
}
