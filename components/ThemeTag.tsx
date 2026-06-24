'use client';

/**
 * ThemeTag — 個股「所屬題材/概念」標籤（全策略掃描列共用）。
 *
 * 顯示一檔股票是什麼題材/概念：
 *   - 台股：lib/themes/themeMap 的 38 題材（themesOf，靜態完整；不限今日熱門）。
 *   - 陸股：今日熱門概念板塊反查（hotMap，來自 /api/theme-sanse/hot；冷門概念退回個股行業 fallback）。
 *   - 兩市場：若該題材今日在熱榜前段（heatRank ≤ HOT_RANK）→ 加 🔥 + 名次標「今天在燒」。
 *
 * 純展示：不進選股 gate、不改分數（鐵則 #5）。一檔多題材時顯示主題材 + 「+N」，hover 看全部。
 */

import { cn } from '@/lib/utils';
import { themesOf } from '@/lib/themes/themeMap';
import type { ThemeRef } from '@/lib/theme-sanse/types';

/** heatRank ≤ 此值才算「今日熱門」加 🔥 + 名次；其餘只是平常的題材歸屬。 */
const HOT_RANK = 10;

interface ThemeTagProps {
  /** 'TW' | 'CN'（其他/undefined 視為無題材） */
  market?: string;
  /** 裸代號（無市場後綴） */
  code: string;
  /** /api/theme-sanse/hot 的 byCode（裸碼 → 今日熱門題材 refs，已按名次升冪） */
  hotMap: Map<string, ThemeRef[]>;
  /** 無題材命中時退回顯示的字（通常傳個股行業 industry）；不給則不渲染 */
  fallback?: string | null;
  className?: string;
}

export function ThemeTag({ market, code, hotMap, fallback, className }: ThemeTagProps) {
  const refs = hotMap.get(code) ?? [];

  // 題材名清單（含今日名次）：優先用 hotMap；台股 hotMap 缺（排名檔還沒生）退回靜態 themesOf
  let names: { name: string; rank: number | null }[];
  if (refs.length > 0) {
    names = refs.map((r) => ({ name: r.themeName, rank: r.heatRank }));
  } else if (market === 'TW') {
    names = themesOf(code).map((n) => ({ name: n, rank: null }));
  } else {
    names = [];
  }

  if (names.length === 0) {
    return fallback ? <span className={cn('text-muted-foreground truncate', className)} title={fallback}>{fallback}</span> : null;
  }

  const primary = names[0];
  const isHot = primary.rank != null && primary.rank <= HOT_RANK;
  const title = names.map((n) => (n.rank != null ? `${n.name}（今日第 ${n.rank} 名）` : n.name)).join('、');

  return (
    <span
      title={isHot ? `🔥 今日熱門題材\n${title}` : `所屬題材／概念\n${title}`}
      className={cn('truncate', isHot ? 'text-amber-400/90' : 'text-sky-300/80', className)}
    >
      {isHot ? '🔥' : ''}{primary.name}{isHot && primary.rank != null ? ` #${primary.rank}` : ''}
      {names.length > 1 && <span className="text-muted-foreground"> +{names.length - 1}</span>}
    </span>
  );
}
