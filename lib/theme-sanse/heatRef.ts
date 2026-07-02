// ============================================================
// 題材×三色 — 裸碼/全代號 → 所屬最熱題材名次（純函式，client 安全）。
//
// 與 codeThemes.invertHotThemes 配套：byCode map 已按 heatRank 升冪，refs[0] 即最熱。
// 抽成獨立 pure 檔，讓掃描面板（client）共用同一個「所屬最熱題材名次」邏輯，
// 不重複手刻、不誤 import 到 server-only 的 hotThemes/todayHot。
// ============================================================

import type { ThemeRef } from './types';

/** 去市場後綴拿裸碼（TW 4 位 / CN 6 位）。 */
export const stripCodeSuffix = (s: string): string => s.replace(/\.(TW|TWO|SS|SZ|BJ)$/i, '');

/**
 * 該股所屬題材/概念中「今日最熱」的名次（1 = 今日最熱）；不在任何排名題材 → Infinity（排序時排最後）。
 * 取 refs 內 heatRank 最小者（TW refs 本就升冪；CN refs 以「最專一」排序、非熱度序，故必須取 min）。
 */
export function bestHeatRank(map: Map<string, ThemeRef[]>, symbol: string): number {
  const refs = map.get(stripCodeSuffix(symbol));
  if (!refs || refs.length === 0) return Infinity;
  let min = Infinity;
  for (const r of refs) if (r.heatRank < min) min = r.heatRank;
  return min;
}
