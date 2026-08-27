// ============================================================
// 題材×三色 — 「今日最熱題材」反查（裸碼 → 所屬熱門題材 refs）。Server-only（讀本地檔 / 抓 EM）。
//
// 用途：給全站策略掃描頁的「🔥今日題材熱度」排序用 —— 哪檔屬於「今天漲幅最強的題材/概念」就排前面。
// 熱度依據＝**今日漲幅**（使用者 2026-06-24 決議），不是 5 日合成（後者見 hotThemes.rankHotThemes，
// 那條留給已回測的 cross-selection 事件流，這裡不動它）。
//
// 兩市場單一事實：
//   TW：reuse buildSectorRanking 的 TWSE／TPEx 官方產業，按 avgD1（今日產業平均漲幅）排名。
//   CN：reuse cn-agents 概念板塊（data/cn-agents/boards/{date}.json），filterThemeConcepts 濾掉
//       風格/大盤/盤口板塊後按今日 pct 排，取前 N 個概念，即時 fetchBoardMembers 抓成分股反查。
//       ⚠️ 陸股「最熱概念」回測是反指標（最熱之後反而最弱）→ 顯示層標清楚「只供觀察別追高」。
//
// 結果按 (market,date) module 快取（盤後封存日資料穩定；面板每封存日只抓一次）。
// ============================================================

import path from 'path';
import { promises as fs } from 'fs';
import { readSectorRanking, buildSectorRanking, type ThemeRank } from '@/lib/themes/sectorRanking';
import { readBoardsDay } from '@/lib/cn-agents/storage';
import { filterThemeConcepts } from '@/lib/cn-agents/boardRanking';
import { fetchBoardMembers } from '@/lib/cn-agents/datasource/emBoards';
import type { ThemeRef, TsMarket } from './types';

/**
 * CN：即時抓成分股的概念數上限（safety；filterThemeConcepts 實際約 390）。
 * 抓「全部真題材概念」反查成分股 → 不論該概念今天熱不熱，個股都標得到它本來的概念
 * （例：永兴材料屬鋰礦概念，今天冷門也要標）。用於個股題材標注 + 今日題材熱度排序。
 */
const CN_MAX_CONCEPTS = 420;
/** 每檔最多顯示幾個概念（取「成分股最少＝最專一」者，最具代表性；外加今日最熱那個供 🔥/排序）。 */
const CN_DISPLAY_REFS = 3;
/** CN：fetchBoardMembers 併發上限（EM clist 同 IP 過量併發會被限流）。 */
const CN_FETCH_CONCURRENCY = 8;
/** CN 概念→成分股反查結果硬碟快取目錄（每日建一次，重啟後不用重抓）。 */
const CN_CACHE_DIR = path.join(process.cwd(), 'data/theme-sanse/CN/today-hot');
/** 快取格式版本（改反查邏輯時 +1，舊快取自動作廢重建）。 */
const CN_CACHE_VERSION = 2;

/** 一個熱門題材的輕量表示（heatRank 1 = 今日最熱）。 */
interface TodayThemeLite {
  id: string;
  name: string;
  heatRank: number;
  /** 成分股裸碼。 */
  memberCodes: string[];
}

/** TW：把官方產業反推成 code → ThemeRef[]（依 heatRank 升冪，refs[0]=今日最熱產業）。 */
function invertTw(themes: TodayThemeLite[]): Map<string, ThemeRef[]> {
  const map = new Map<string, ThemeRef[]>();
  for (const t of themes) {
    const ref: ThemeRef = { themeId: t.id, themeName: t.name, heatRank: t.heatRank };
    for (const code of t.memberCodes) (map.get(code) ?? map.set(code, []).get(code)!).push(ref);
  }
  for (const arr of map.values()) arr.sort((a, b) => a.heatRank - b.heatRank);
  return map;
}

/**
 * CN：把全部概念反推成 code → ThemeRef[]，每檔挑「最具代表性」的概念顯示。
 * A 股一檔常屬十幾個概念 → 取「成分股最少＝最專一」的前 N 個（像鋰礦概念，而非反內捲這種大雜燴），
 * 再確保「今日最熱的那個概念」一定在集合內（供 🔥 標示 + 今日題材熱度排序的 min 名次）。
 * refs[0] = 最專一的概念（顯示主題材）；集合內含今日最熱者（bestHeatRank 取 min 找得到）。
 */
function invertCn(themes: TodayThemeLite[]): Map<string, ThemeRef[]> {
  type Raw = { themeId: string; themeName: string; heatRank: number; size: number };
  const raw = new Map<string, Raw[]>();
  for (const t of themes) {
    const r: Raw = { themeId: t.id, themeName: t.name, heatRank: t.heatRank, size: t.memberCodes.length };
    for (const code of t.memberCodes) (raw.get(code) ?? raw.set(code, []).get(code)!).push(r);
  }
  const out = new Map<string, ThemeRef[]>();
  for (const [code, arr] of raw) {
    const hottest = arr.reduce((a, b) => (b.heatRank < a.heatRank ? b : a));
    const specific = [...arr].sort((a, b) => a.size - b.size).slice(0, CN_DISPLAY_REFS); // 最專一在前
    const picked = [...specific];
    if (!picked.some((r) => r.themeId === hottest.themeId)) picked.push(hottest); // 保證含今日最熱
    out.set(code, picked.map(({ themeId, themeName, heatRank }) => ({ themeId, themeName, heatRank })));
  }
  return out;
}

// ── TW：官方產業按 avgD1（今日產業平均漲幅）排 ─────────────────────────────────
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
  // filterThemeConcepts：濾掉風格/大盤/盤口板塊 + 依今日漲幅重排 rank（1-based）。抓全部（safety cap）。
  const concepts = filterThemeConcepts(day.concepts).slice(0, CN_MAX_CONCEPTS);

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

// ── CN 硬碟快取（每日建一次，避免重啟後重抓 80 個板塊）─────────────────────────
async function readCnCache(date: string): Promise<Map<string, ThemeRef[]> | null> {
  try {
    const j = JSON.parse(await fs.readFile(path.join(CN_CACHE_DIR, `${date}.json`), 'utf8')) as {
      v?: number; byCode?: Record<string, ThemeRef[]>;
    };
    if (j.v !== CN_CACHE_VERSION || !j.byCode) return null; // 舊版格式 → 作廢重建
    return new Map(Object.entries(j.byCode));
  } catch {
    return null;
  }
}

async function writeCnCache(date: string, map: Map<string, ThemeRef[]>): Promise<void> {
  try {
    await fs.mkdir(CN_CACHE_DIR, { recursive: true });
    const byCode = Object.fromEntries(map);
    await fs.writeFile(
      path.join(CN_CACHE_DIR, `${date}.json`),
      JSON.stringify({ v: CN_CACHE_VERSION, generatedAt: new Date().toISOString(), byCode }),
    );
  } catch {
    /* 快取寫失敗不致命（下次重抓） */
  }
}

// ── 快取 + 對外 ────────────────────────────────────────────────────────────────
const memCache = new Map<string, Map<string, ThemeRef[]>>();

/**
 * 裸碼 → 所屬題材/概念 refs（供「今日題材熱度」排序 + 個股題材標注）。
 * TW：refs 依今日漲幅名次升冪（refs[0]=今日最熱官方產業）。
 * CN：refs[0]=最具代表性（最專一）概念；集合內含今日最熱者（bestHeatRank 取 min 找得到）。
 * 陸股題材分類已於 2026-06-21 從 hotThemes 移除（5 日合成路線）；此處改走 cn-agents 概念板塊
 * 即時反查全部概念（一檔都標得到本來的概念），其中「今天哪個概念在燒」當排序＝反指標、僅觀察。
 */
export async function rankCodeToThemesToday(market: TsMarket, date: string): Promise<Map<string, ThemeRef[]>> {
  const key = `${market}:${date}`;
  const mem = memCache.get(key);
  if (mem) return mem;

  let map: Map<string, ThemeRef[]>;
  if (market === 'TW') {
    map = invertTw(await twTodayThemes(date)); // TW 純讀 sectorRanking，快、記憶體快取即可
  } else {
    const cached = await readCnCache(date);
    if (cached) {
      map = cached;
    } else {
      map = invertCn(await cnTodayThemes(date));
      if (map.size > 0) await writeCnCache(date, map); // 抓到才寫（避免把空結果固化）
    }
  }
  memCache.set(key, map);
  return map;
}
