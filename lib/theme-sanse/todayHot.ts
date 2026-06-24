// ============================================================
// 題材×三色 — 「今日最熱題材」反查（裸碼 → 所屬熱門題材 refs）。Server-only（讀本地檔 / 抓 EM）。
//
// 用途：給全站策略掃描頁的「🔥今日題材熱度」排序用 —— 哪檔屬於「今天漲幅最強的題材/概念」就排前面。
// 熱度依據＝**今日漲幅**（使用者 2026-06-24 決議），不是 5 日合成（後者見 hotThemes.rankHotThemes，
// 那條留給已回測的 cross-selection 事件流，這裡不動它）。
//
// 兩市場單一事實：
//   TW：reuse buildSectorRanking 的 38 題材，按 avgD1（今日題材平均漲幅）排名。
//   CN：reuse cn-agents 概念板塊（data/cn-agents/boards/{date}.json），filterThemeConcepts 濾掉
//       風格/大盤/盤口板塊後按今日 pct 排，取前 N 個概念，即時 fetchBoardMembers 抓成分股反查。
//       ⚠️ 陸股「最熱概念」回測是反指標（最熱之後反而最弱）→ 顯示層標清楚「只供觀察別追高」。
//
// 結果按 (market,date) module 快取（盤後封存日資料穩定；面板每封存日只抓一次）。
// ============================================================

import { readSectorRanking, buildSectorRanking, type ThemeRank } from '@/lib/themes/sectorRanking';
import { readBoardsDay } from '@/lib/cn-agents/storage';
import { filterThemeConcepts } from '@/lib/cn-agents/boardRanking';
import { fetchBoardMembers } from '@/lib/cn-agents/datasource/emBoards';
import type { ThemeRef, TsMarket } from './types';

/** CN：即時抓成分股的熱門概念數上限（控制 fetchBoardMembers 次數 / route 時間）。 */
const CN_TOP_CONCEPTS = 20;
/** CN：fetchBoardMembers 併發上限（EM clist 同 IP 過量併發會被限流）。 */
const CN_FETCH_CONCURRENCY = 4;

/** 一個熱門題材的輕量表示（heatRank 1 = 今日最熱）。 */
interface TodayThemeLite {
  id: string;
  name: string;
  heatRank: number;
  /** 成分股裸碼。 */
  memberCodes: string[];
}

/** 把一批今日熱門題材反推成 code → ThemeRef[]（依 heatRank 升冪）。 */
function invert(themes: TodayThemeLite[]): Map<string, ThemeRef[]> {
  const map = new Map<string, ThemeRef[]>();
  for (const t of themes) {
    const ref: ThemeRef = { themeId: t.id, themeName: t.name, heatRank: t.heatRank };
    for (const code of t.memberCodes) {
      const arr = map.get(code) ?? [];
      arr.push(ref);
      map.set(code, arr);
    }
  }
  for (const arr of map.values()) arr.sort((a, b) => a.heatRank - b.heatRank);
  return map;
}

// ── TW：38 題材按 avgD1（今日題材平均漲幅）排 ───────────────────────────────────
async function twTodayThemes(date: string): Promise<TodayThemeLite[]> {
  const file = (await readSectorRanking(date)) ?? (await buildSectorRanking(date));
  const todayRet = (t: ThemeRank) => t.avgD1 ?? null;
  const ranked = [...file.themes].sort((a, b) => (todayRet(b) ?? -Infinity) - (todayRet(a) ?? -Infinity));
  return ranked.map((t, i) => ({
    id: t.theme,
    name: t.theme,
    heatRank: i + 1,
    memberCodes: t.members.map((m) => m.code),
  }));
}

// ── CN：概念板塊按今日 pct 排，取前 N 個即時抓成分股 ─────────────────────────────
async function cnTodayThemes(date: string): Promise<TodayThemeLite[]> {
  const day = await readBoardsDay(date);
  if (!day) return [];
  // filterThemeConcepts：濾掉風格/大盤/盤口板塊 + 依今日漲幅重排 rank（1-based）
  const concepts = filterThemeConcepts(day.concepts).slice(0, CN_TOP_CONCEPTS);

  const out: TodayThemeLite[] = [];
  for (let i = 0; i < concepts.length; i += CN_FETCH_CONCURRENCY) {
    const batch = concepts.slice(i, i + CN_FETCH_CONCURRENCY);
    const settled = await Promise.all(
      batch.map(async (b) => {
        try {
          const members = await fetchBoardMembers(b.code);
          return { id: b.code, name: b.name, heatRank: b.rank, memberCodes: members.map((m) => m.code) } as TodayThemeLite;
        } catch {
          return null; // 單一板塊抓失敗不致命（少一個熱門概念，其餘照排）
        }
      }),
    );
    for (const t of settled) if (t) out.push(t);
  }
  return out;
}

// ── 快取 + 對外 ────────────────────────────────────────────────────────────────
const cache = new Map<string, Map<string, ThemeRef[]>>();

/**
 * 裸碼 → 今日所屬熱門題材 refs（依今日漲幅；refs[0] = 最熱）。
 * 陸股題材分類已於 2026-06-21 從 hotThemes 移除（5 日合成路線）；此處改走 cn-agents 概念板塊
 * 即時反查，重新支援陸股，但語意＝「今天哪個概念在燒」（反指標、僅觀察）。
 */
export async function rankCodeToThemesToday(market: TsMarket, date: string): Promise<Map<string, ThemeRef[]>> {
  const key = `${market}:${date}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const themes = market === 'TW' ? await twTodayThemes(date) : await cnTodayThemes(date);
  const map = invert(themes);
  cache.set(key, map);
  return map;
}
