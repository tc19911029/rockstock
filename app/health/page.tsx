'use client';

/**
 * 資料健康總覽（Stage 3 後）
 *
 * 從「一頁紙」改成「水平 tab + 子內容」總覽中心：
 *   - 行情：L1 / L2 / L4（原 /health 內容，搬到 MarketDataTab）
 *   - YouTube 節目：紅綠燈 / 來源卡 / 影片表 / Audit（從 /youtube 主頁搬過來）
 *   - 技術策略 / Agent 分析 / 系統任務：先骨架，後續 stage 補
 *
 * URL `?tab=youtube` 持久化 tab 選擇。
 */

import { useEffect, useState } from 'react';
import { PageShell } from '@/components/shared';
import { MarketDataTab } from './tabs/MarketDataTab';
import { YoutubeTab } from './tabs/YoutubeTab';
import { PlaceholderTab } from './tabs/PlaceholderTab';

type TabKey = 'market' | 'youtube' | 'technical' | 'agent' | 'system';

const TABS: Array<{ key: TabKey; label: string; icon: string }> = [
  { key: 'market',    label: '行情資料',     icon: '📈' },
  { key: 'youtube',   label: 'YouTube 節目', icon: '📺' },
  { key: 'technical', label: '技術策略',     icon: '⚙️' },
  { key: 'agent',     label: 'Agent 分析',   icon: '🤖' },
  { key: 'system',    label: '系統任務',     icon: '🛠️' },
];

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei',
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false,
    });
  } catch { return '—'; }
}

export default function HealthPage() {
  const [tab, setTab] = useState<TabKey>('market');
  // hydration-safe：SSR 與 client 第一次 render 都是 null，CSR 才補時間
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  // URL ?tab= 持久化（hydration 後再吸收 query，避免 SSR mismatch）
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    const q = sp.get('tab') as TabKey | null;
    if (q && TABS.some(t => t.key === q)) {
      setTab(q);
    }
    setRefreshedAt(new Date());
  }, []);

  // tab 切換時改寫 URL
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    if (tab === 'market') sp.delete('tab');
    else sp.set('tab', tab);
    const qs = sp.toString();
    const next = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    if (next !== window.location.pathname + window.location.search) {
      window.history.replaceState(null, '', next);
    }
  }, [tab]);

  return (
    <PageShell>
      <div className="max-w-6xl mx-auto p-4 space-y-4">
        <div className="flex items-baseline justify-between">
          <h1 className="text-2xl font-bold">資料健康狀態</h1>
          <div className="text-xs text-muted-foreground">
            {refreshedAt ? `最近更新 ${fmtTime(refreshedAt.toISOString())}` : '載入中…'}
          </div>
        </div>

        {/* Tab nav */}
        <div role="tablist" aria-label="資料健康分頁" className="flex flex-wrap gap-1 border-b border-border">
          {TABS.map(t => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-2 text-sm rounded-t-md transition-colors border-b-2 -mb-px ${
                tab === t.key
                  ? 'border-sky-500 text-sky-400 bg-sky-500/10'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-secondary/40'
              }`}
            >
              <span className="mr-1.5">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="pt-2">
          {tab === 'market' && <MarketDataTab />}
          {tab === 'youtube' && <YoutubeTab />}
          {tab === 'technical' && (
            <PlaceholderTab
              title="技術策略資料"
              description="顯示各策略今日掃描狀態 / 落後檔數 / Step 0 大盤過濾結果。"
              comingSoon={[
                '14 個買法字母（B/C/D/E/F/J/K/L/M/N/O/P/Q/R）的今日掃描狀態',
                '每個字母的命中支數 + 落後 cron',
                '三軌（bullish / reversal / system）的批次跑步狀態',
                'limit-up consistency 紅綠燈',
              ]}
            />
          )}
          {tab === 'agent' && (
            <PlaceholderTab
              title="Agent 分析資料"
              description="顯示今日 Candidates Pool 規模 / 4 source 跑成功狀態 / Multi-Agent decisions 數。"
              comingSoon={[
                'Candidates Pool 4 個 source 是否成功（technical / youtube / chip / fundamental）',
                '今日 pool 規模（總候選 / 4 源 / 3 源 / 2 源 / 1 源 分布）',
                'Multi-Agent decisions 已完成數 / 待跑數',
                'Portfolio mini-agent review 今日完成度',
              ]}
            />
          )}
          {tab === 'system' && (
            <PlaceholderTab
              title="系統任務"
              description="顯示 launchd 與 Vercel cron 排程狀態、最後執行時間、失敗次數。"
              comingSoon={[
                'YouTube cron（scan / transcript / prepare-analysis）launchd 狀態',
                'Vercel cron 今日跑成功 / 失敗清單',
                'L1 invariant audit 每日跑況',
                '健康快照寫入紀錄',
              ]}
            />
          )}
        </div>
      </div>
    </PageShell>
  );
}
