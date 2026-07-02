'use client';

/**
 * YouTubeMentionBadge — 在策略掃描列／候選池每檔股票旁併呈的「YouTube 提及」小徽章。
 *
 * 紫色＝消息面 source 色（與候選池既有「消」chip 一致）。點擊 → 個股時間軸頁。
 * 純展示，不影響選股分數/排序。
 *
 * resonanceTags() 產生「共振綜合標記」— 同樣是 display-only 標籤（書本鐵則：技術才是
 * 進場依據；候選池不加雙來源 bonus），只給「一眼醒目」用，不改任何排序/分數。
 */

import type { YouTubeMentionSummary } from '@/lib/hooks/useYouTubeMentionMap';

const SENTIMENT_TEXT: Record<string, string> = {
  bullish: '看多',
  bearish: '看空',
  mixed: '多空分歧',
  neutral: '中性',
};

export interface ResonanceTag {
  label: string;
  title: string;
  cls: string;
}

/**
 * display-only 共振標記 — 不改分數/排序，只給「一眼醒目」。
 * 刻意收緊讓它稀有：「策略＋消息共振」只在「策略命中 + 近 30 天 ≥2 個不同節目討論」才標
 * （跨來源＋跨節目才算共振；單一節目的零星提及只留 badge、不標共振）。
 */
export function resonanceTags(summary?: YouTubeMentionSummary): ResonanceTag[] {
  if (!summary || summary.count30d <= 0) return [];
  const tags: ResonanceTag[] = [];
  if (summary.programsCount >= 2) {
    tags.push({
      label: '策略＋消息共振',
      title: `策略已掃到，且近 30 天有 ${summary.programsCount} 個不同節目討論（跨節目共振）`,
      cls: 'bg-fuchsia-700/40 text-fuchsia-200 border-fuchsia-500/50',
    });
  }
  if (summary.count7d >= 2 && summary.count7d / summary.count30d >= 0.5) {
    tags.push({
      label: '討論升溫',
      title: `近 7 天 ${summary.count7d} 次，佔近 30 天 ${summary.count30d} 次多數 — 討論度上升`,
      cls: 'bg-rose-700/40 text-rose-200 border-rose-500/50',
    });
  }
  return tags;
}

export function YouTubeMentionBadge({
  summary,
  bareCode,
  size = 'sm',
}: {
  summary?: YouTubeMentionSummary;
  bareCode: string;
  size?: 'xs' | 'sm';
}) {
  const textSize = size === 'xs' ? 'text-[8px]' : 'text-[10px]';

  if (!summary || summary.count30d <= 0) {
    return <span className={`inline-flex items-center ${textSize} text-muted-foreground/50`}>未提及</span>;
  }

  const sentiment = SENTIMENT_TEXT[summary.sentiment] ?? '—';
  const title =
    `YouTube 提及：近 7 天 ${summary.count7d} 次 · 近 30 天 ${summary.count30d} 次\n` +
    `${summary.programsCount} 個節目 · 傾向 ${sentiment} · 最近 ${summary.lastDate || '—'}\n` +
    `另開分頁看完整時間軸 →`;

  return (
    <a
      href={`/youtube/stocks/${bareCode}`}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={title}
      className={`inline-flex items-center gap-0.5 px-1 py-px rounded border ${textSize} bg-purple-700/40 text-purple-200 border-purple-500/50 hover:bg-purple-600/50 transition-colors whitespace-nowrap`}
    >
      <span className="tabular-nums">7天{summary.count7d}次·30天{summary.count30d}次</span>
    </a>
  );
}
