'use client';

/**
 * YoutubePanel — 首頁右側「YouTube 提及」分頁的外框，內含台股內容與陸股節目雷達：
 *   - 總結   ：YoutubeDailySummary（每日節目總結報告：每集摘要 + 必看標記 + 持倉提醒）
 *   - 提及   ：YoutubeStocksPanel（今日節目提及的股票 + N 日漲跌追蹤）
 *   - 老師排行：TeacherLeaderboard（誰講得準，原 /youtube/teachers）
 *   - 抓取狀態：YoutubeTab（來源紅綠燈 / 影片表 / Audit，原 /health?tab=youtube）
 *   - 陸股   ：CnMediaDashboard（第一財經節目共識、股票提及與來源狀態）
 *
 * 各區性質不同（內容 vs 績效 vs 後台監控），用子分頁分開放、互不擠壓。
 * 老師排行 / 抓取狀態原本是整頁寬版面，嵌進 600px 窄面板時各自包 overflow-auto
 * 容器（橫向 + 縱向可捲），不改動原元件。/youtube/teachers 與 /health 兩個獨立頁
 * 仍沿用同一份元件、照常運作。
 */

import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Activity,
  ChartNoAxesCombined,
  CirclePlay,
  FileText,
  GraduationCap,
  type LucideIcon,
} from 'lucide-react';
import { YoutubeDailySummary } from './YoutubeDailySummary';
import { YoutubeStocksPanel } from './YoutubeStocksPanel';
import { TeacherLeaderboard } from './TeacherLeaderboard';
import { YoutubeTab } from '@/app/health/tabs/YoutubeTab';
import { CnMediaDashboard } from '@/components/cn-media/CnMediaDashboard';

type MediaMarket = 'tw' | 'cn';
type SubTab = 'summary' | 'mentions' | 'teachers' | 'health';

interface Props {
  date: string;
  onDateChange?: (date: string) => void;
  onSelectStock?: (code: string) => void;
  selectedCode?: string | null;
}

const TW_SUBTABS: Array<{ key: SubTab; label: string; icon: LucideIcon; title: string }> = [
  { key: 'summary',  label: '總結',     icon: FileText,      title: '每日節目總結報告（每集摘要 + 必看標記 + 持倉提醒）' },
  { key: 'mentions', label: '提及',     icon: CirclePlay,    title: '今日節目提及的股票 + N 日漲跌追蹤' },
  { key: 'teachers', label: '老師排行', icon: GraduationCap, title: '老師推薦績效排行榜（誰講得準）' },
  { key: 'health',   label: '抓取狀態', icon: Activity,      title: 'YouTube 來源抓取／掃描健康狀態' },
];

const CN_SUBTABS = TW_SUBTABS.filter(tab => tab.key !== 'teachers').map(tab => ({
  ...tab,
  title: tab.key === 'summary'
    ? '陸股每日節目總結報告'
    : tab.key === 'mentions' ? '陸股節目提及股票' : '陸股節目來源與逐字稿狀態',
}));

function isMediaMarket(value: string | null): value is MediaMarket {
  return value === 'tw' || value === 'cn';
}

function isSubTab(value: string | null): value is SubTab {
  return TW_SUBTABS.some(tab => tab.key === value);
}

export function YoutubePanel({ date, onDateChange, onSelectStock, selectedCode }: Props) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const requestedMarket = searchParams.get('ytMarket');
  const requestedSub = searchParams.get('ytSub');
  const legacyCnLink = requestedSub === 'cn';
  const [selectedMarket, setSelectedMarket] = useState<MediaMarket | null>(null);
  const [selectedSub, setSelectedSub] = useState<SubTab | null>(null);
  const mediaMarket = selectedMarket ?? (legacyCnLink ? 'cn' : isMediaMarket(requestedMarket) ? requestedMarket : 'tw');
  const availableTabs = mediaMarket === 'cn' ? CN_SUBTABS : TW_SUBTABS;
  const requestedValidSub = isSubTab(requestedSub) && availableTabs.some(tab => tab.key === requestedSub)
    ? requestedSub
    : 'summary';
  const sub = selectedSub && availableTabs.some(tab => tab.key === selectedSub) ? selectedSub : requestedValidSub;

  const replaceMediaUrl = (market: MediaMarket, nextSub: SubTab) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', 'youtube');
    params.set('ytMarket', market);
    params.set('ytSub', nextSub);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const selectMarket = (nextMarket: MediaMarket) => {
    setSelectedMarket(nextMarket);
    setSelectedSub('summary');
    replaceMediaUrl(nextMarket, 'summary');
  };

  const selectSub = (next: SubTab) => {
    setSelectedSub(next);
    replaceMediaUrl(mediaMarket, next);
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 子分頁切換 */}
      <div className="shrink-0 flex items-stretch overflow-x-auto border-b border-border bg-secondary/20 whitespace-nowrap">
        <div role="tablist" aria-label="節目市場" className="flex items-stretch border-r border-border/70">
          {(['tw', 'cn'] as const).map(market => (
            <button
              key={market}
              type="button"
              role="tab"
              aria-selected={mediaMarket === market}
              onClick={() => selectMarket(market)}
              className={`flex min-h-11 cursor-pointer items-center gap-1 px-2.5 text-[11px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                mediaMarket === market ? 'bg-card/80 text-sky-400' : 'text-muted-foreground hover:bg-card/40 hover:text-foreground'
              }`}
            >
              {market === 'cn' && <ChartNoAxesCombined className="size-3.5" aria-hidden="true" />}
              {market === 'tw' ? '台股' : '陸股'}
            </button>
          ))}
        </div>
        <div role="tablist" aria-label={`${mediaMarket === 'tw' ? '台股' : '陸股'}節目子分頁`} className="flex items-stretch">
          {availableTabs.map(t => {
            const Icon = t.icon;
            return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={sub === t.key}
              onClick={() => selectSub(t.key)}
              title={t.title}
              className={`flex min-h-11 cursor-pointer items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                sub === t.key
                  ? 'text-foreground border-b-2 border-purple-500 -mb-px bg-card/60'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon className="size-3.5" aria-hidden="true" />
              <span>{t.label}</span>
            </button>
          )})}
        </div>
      </div>

      {/* 子分頁內容 */}
      <div className="flex-1 min-h-0">
        {mediaMarket === 'tw' && sub === 'summary' && (
          <YoutubeDailySummary
            date={date}
            onDateChange={onDateChange}
            onSelectStock={onSelectStock}
            selectedCode={selectedCode}
          />
        )}
        {mediaMarket === 'tw' && sub === 'mentions' && (
          <YoutubeStocksPanel
            date={date}
            onDateChange={onDateChange}
            onSelectStock={onSelectStock}
            selectedCode={selectedCode}
          />
        )}
        {mediaMarket === 'tw' && sub === 'teachers' && (
          <div className="h-full overflow-auto p-2">
            <TeacherLeaderboard compact />
          </div>
        )}
        {mediaMarket === 'tw' && sub === 'health' && (
          <div className="h-full overflow-auto p-2">
            <YoutubeTab />
          </div>
        )}
        {mediaMarket === 'cn' && (
          <CnMediaDashboard
            initialDate={date}
            onDateChange={onDateChange}
            onSelectStock={onSelectStock}
            selectedCode={selectedCode}
            view={sub === 'mentions' ? 'stocks' : sub === 'health' ? 'sources' : 'summary'}
            compact
          />
        )}
      </div>
    </div>
  );
}
