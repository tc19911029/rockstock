'use client';

/**
 * ThemeTag — 個股「官方產業／概念」標籤（全策略掃描列共用）。
 *
 * 顯示一檔股票是什麼題材/概念：
 *   - 台股：TWSE／TPEx 官方產業別（一檔一個正式分類）。
 *   - 陸股：今日熱門概念板塊反查（hotMap，來自 /api/theme-sanse/hot；冷門概念退回個股行業 fallback）。
 *   - 兩市場：若該題材今日在熱榜前段（heatRank ≤ HOT_RANK）→ 加 🔥 + 名次標「今天在燒」。
 *
 * 純展示：不進選股 gate、不改分數（鐵則 #5）。
 */

import { cn } from '@/lib/utils';
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

  // 台股 hotMap 只含交易所官方產業；缺資料時由下方 fallback 顯示掃描結果內的官方產業。
  let names: { name: string; rank: number | null }[];
  if (refs.length > 0) {
    names = refs.map((r) => ({ name: r.themeName, rank: r.heatRank }));
  } else {
    names = [];
  }

  if (names.length === 0) {
    return fallback ? <span className={cn('text-muted-foreground truncate', className)} title={fallback}>{fallback}</span> : null;
  }

  // 主顯示題材 = refs[0]（TW：今日最熱；CN：最專一/最具代表性）。
  // 是否「今天在燒」= 所屬題材中有人進今日前段（min 名次 ≤ HOT_RANK）。
  const primary = names[0];
  const minRank = names.reduce((m, n) => (n.rank != null && n.rank < m ? n.rank : m), Infinity);
  const isHot = minRank <= HOT_RANK;
  // 只有「主顯示題材本身就是今日最熱那個」才在名字後綴 #名次，避免名稱與名次對不上
  const showRank = isHot && primary.rank === minRank;
  const title = names.map((n) => (n.rank != null ? `${n.name}（今日第 ${n.rank} 名）` : n.name)).join('、');
  const categoryLabel = market === 'TW' ? '官方產業' : '題材／概念';

  return (
    <span
      title={isHot ? `🔥 今日熱門${categoryLabel}\n${title}` : `所屬${categoryLabel}\n${title}`}
      className={cn('truncate', isHot ? 'text-amber-400/90' : 'text-sky-300/80', className)}
    >
      {isHot ? '🔥' : ''}{primary.name}{showRank ? ` #${primary.rank}` : ''}
      {names.length > 1 && <span className="text-muted-foreground"> +{names.length - 1}</span>}
    </span>
  );
}
