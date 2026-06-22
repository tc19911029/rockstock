'use client';

/**
 * YoutubePanel — 首頁右側「YouTube 提及」分頁的外框，內含三個子分頁：
 *   - 提及   ：YoutubeStocksPanel（今日節目提及的股票 + N 日漲跌追蹤）
 *   - 老師排行：TeacherLeaderboard（誰講得準，原 /youtube/teachers）
 *   - 抓取狀態：YoutubeTab（來源紅綠燈 / 影片表 / Audit，原 /health?tab=youtube）
 *
 * 三者性質不同（內容 vs 績效 vs 後台監控），用子分頁分開放、互不擠壓。
 * 老師排行 / 抓取狀態原本是整頁寬版面，嵌進 600px 窄面板時各自包 overflow-auto
 * 容器（橫向 + 縱向可捲），不改動原元件。/youtube/teachers 與 /health 兩個獨立頁
 * 仍沿用同一份元件、照常運作。
 */

import { useState } from 'react';
import { YoutubeStocksPanel } from './YoutubeStocksPanel';
import { TeacherLeaderboard } from './TeacherLeaderboard';
import { YoutubeTab } from '@/app/health/tabs/YoutubeTab';

type SubTab = 'mentions' | 'teachers' | 'health';

interface Props {
  date: string;
  onDateChange?: (date: string) => void;
  onSelectStock?: (code: string) => void;
  selectedCode?: string | null;
}

const SUBTABS: Array<{ key: SubTab; label: string; icon: string; title: string }> = [
  { key: 'mentions', label: '提及',     icon: '📺', title: '今日節目提及的股票 + N 日漲跌追蹤' },
  { key: 'teachers', label: '老師排行', icon: '🎓', title: '老師推薦績效排行榜（誰講得準）' },
  { key: 'health',   label: '抓取狀態', icon: '🩺', title: 'YouTube 來源抓取／掃描健康狀態' },
];

export function YoutubePanel({ date, onDateChange, onSelectStock, selectedCode }: Props) {
  const [sub, setSub] = useState<SubTab>('mentions');

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 子分頁切換 */}
      <div role="tablist" aria-label="YouTube 子分頁" className="shrink-0 flex items-stretch border-b border-border bg-secondary/20 whitespace-nowrap">
        {SUBTABS.map(t => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={sub === t.key}
            onClick={() => setSub(t.key)}
            title={t.title}
            className={`flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${
              sub === t.key
                ? 'text-foreground border-b-2 border-purple-500 -mb-px bg-card/60'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <span aria-hidden="true">{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* 子分頁內容 */}
      <div className="flex-1 min-h-0">
        {sub === 'mentions' && (
          <YoutubeStocksPanel
            date={date}
            onDateChange={onDateChange}
            onSelectStock={onSelectStock}
            selectedCode={selectedCode}
          />
        )}
        {sub === 'teachers' && (
          <div className="h-full overflow-auto p-2">
            <TeacherLeaderboard compact />
          </div>
        )}
        {sub === 'health' && (
          <div className="h-full overflow-auto p-2">
            <YoutubeTab />
          </div>
        )}
      </div>
    </div>
  );
}
