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

import { Fragment, useEffect, useState } from 'react';
import Link from 'next/link';
import { PageShell } from '@/components/shared';
import { MarketDataTab } from './tabs/MarketDataTab';
import { YoutubeTab } from './tabs/YoutubeTab';
import { CnAgentsTab } from './tabs/CnAgentsTab';
import { PlaceholderTab } from './tabs/PlaceholderTab';
import { SystemTab } from './tabs/SystemTab';

type TabKey = 'market' | 'youtube' | 'cn-agents' | 'technical' | 'agent' | 'system';

const TABS: Array<{ key: TabKey; label: string; icon: string }> = [
  { key: 'market',    label: '行情資料',     icon: '📈' },
  { key: 'youtube',   label: 'YouTube 節目', icon: '📺' },
  { key: 'cn-agents', label: '陸股情緒',     icon: '🌡️' },
  // 技術策略 / 多代理分析 tab 尚未實作（只有施工中佔位），先隱藏避免使用者撞到空頁；
  // 下方 render 區塊與 PlaceholderTab 暫留，待實作後再把這兩行加回 TABS。
  // { key: 'technical', label: '技術策略',     icon: '⚙️' },
  // { key: 'agent',     label: '多代理分析',   icon: '🤖' },
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
      <div className="p-4 space-y-4">
        <div className="flex items-baseline justify-between">
          <h1 className="text-2xl font-bold">資料健康狀態</h1>
          <div className="text-xs text-muted-foreground">
            {refreshedAt ? `最近更新 ${fmtTime(refreshedAt.toISOString())}` : '載入中…'}
          </div>
        </div>

        {/* Tab nav */}
        <div role="tablist" aria-label="資料健康分頁" className="flex flex-wrap gap-1 border-b border-border">
          {TABS.map(t => (
            <Fragment key={t.key}>
              {t.key === 'cn-agents' && (
                <Link
                  href="/daily-pick"
                  className="px-3 py-2 text-sm rounded-t-md transition-colors border-b-2 -mb-px border-transparent text-muted-foreground hover:text-foreground hover:bg-secondary/40"
                >
                  <span className="mr-1.5">🎯</span>
                  每日選股
                </Link>
              )}
              {/* 大戶偷買(/smartmoney) 入口 2026-06-15 從畫面拿掉（頁面與程式留著、可復原） */}
              <button
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
            </Fragment>
          ))}
        </div>

        {/* Tab content */}
        <div className="pt-2">
          {tab === 'market' && <MarketDataTab />}
          {tab === 'youtube' && <YoutubeTab />}
          {tab === 'cn-agents' && <CnAgentsTab />}
          {tab === 'technical' && (
            <PlaceholderTab
              title="技術策略資料"
              description="顯示各買法今日掃描狀態、落後檔數、大盤過濾結果。"
              comingSoon={[
                '14 種買法（回後買上漲、盤整突破、缺口…）的今日掃描狀態',
                '每種買法的命中支數 + 落後排程',
                '三軌（多頭軌／反轉軌／戰法軌）的批次掃描狀態',
                '漲跌停一致性紅綠燈',
              ]}
            />
          )}
          {tab === 'agent' && (
            <PlaceholderTab
              title="多代理分析資料"
              description="顯示今日候選池規模、4 個面向（技術／消息／籌碼／基本面）擷取成功狀態、多代理決策已完成數。"
              comingSoon={[
                '候選池 4 個面向是否成功擷取（技術／消息／籌碼／基本面）',
                '今日候選池規模（總候選 / 四面向共識 / 三面向 / 兩面向 / 單面向 分布）',
                '多代理決策已完成數 / 待跑數',
                '持倉迷你代理 review 今日完成度',
              ]}
            />
          )}
          {tab === 'system' && <SystemTab />}
        </div>
      </div>
    </PageShell>
  );
}
