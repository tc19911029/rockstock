// ============================================================
// 題材×三色 — 裸碼 → 所屬熱門題材 refs。
//
// 由 rankHotThemes 反推（單一成分來源 → heatRank 與 hotThemes 一致，交叉 join 不會錯位）。
// 同股可屬多題材（TW 一檔多題材、CN 行業∪概念）。
// ============================================================

import { rankHotThemes } from './hotThemes';
import type { HotTheme, ThemeRef, TsMarket } from './types';

/** 從一批 hotThemes 反推 code → ThemeRef[]（依 heatRank 升冪）。純函式。 */
export function invertHotThemes(hotThemes: HotTheme[]): Map<string, ThemeRef[]> {
  const map = new Map<string, ThemeRef[]>();
  for (const t of hotThemes) {
    const ref: ThemeRef = { themeId: t.id, themeName: t.name, heatRank: t.heatRank };
    for (const m of t.members) {
      const arr = map.get(m.code) ?? [];
      arr.push(ref);
      map.set(m.code, arr);
    }
  }
  for (const arr of map.values()) arr.sort((a, b) => a.heatRank - b.heatRank);
  return map;
}

export async function buildCodeToThemes(market: TsMarket, date: string): Promise<Map<string, ThemeRef[]>> {
  return invertHotThemes(await rankHotThemes(market, date));
}
