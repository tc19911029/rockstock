// ============================================================
// 題材×三色 — 當日選股 → 三組事件（cross/theme/sanse）。Server-only。
//
// selectForDate：rankHotThemes + 三色掃描（saved 優先，缺則 asOf 重算）+ crossSelect。
//   → 同一份結果給「事件」與「每日快照」共用，避免重跑昂貴掃描。
// eventsFromSelection：攤平三組成 ThemeSanseEvent[]（baseline=null，settle 後凍結）。
// mergePreservingBaseline：重建已結算日時保留 filled/no_fill/no_data baseline（不漂移）。
//
// 報酬不持久化（讀時 computeEventReturns derive）。同股可在三組各記一筆（id 含 cohort）。
// ============================================================

import { scanSanSe, type ResonanceRecord } from '@/lib/cn-sanse/scan';
import { loadSanSeScan } from '@/lib/cn-sanse/scanStorage';
import { scanTwSanSe } from '@/lib/tw-sanse/scan';
import { loadTwSanSeScan } from '@/lib/tw-sanse/scanStorage';
import { crossSelect } from './crossSelect';
import { invertHotThemes } from './codeThemes';
import { rankHotThemes } from './hotThemes';
import { readThemeSanseEvents, saveThemeSanseEvents } from './storage';
import {
  DEFAULT_CROSS_THRESHOLDS,
  THEME_SANSE_SCHEMA_VERSION,
  type CohortSelection,
  type CrossThresholds,
  type HotTheme,
  type ThemeSanseEvent,
  type ThemeSanseEventsFile,
  type TsMarket,
} from './types';

export interface SelectionResult {
  hotThemes: HotTheme[];
  selection: CohortSelection;
  sanseUniverse: number;
  readiness: { themeHeat: boolean; sanseScan: boolean };
}

/** 當日選股（熱題材 × 三色）。saved 三色快照優先，缺則 asOf 重算（回測深歷史）。 */
export async function selectForDate(
  market: TsMarket,
  date: string,
  opts?: { thresholds?: CrossThresholds },
): Promise<SelectionResult> {
  const hotThemes = await rankHotThemes(market, date);

  let records: ResonanceRecord[];
  let evaluated: number;
  const saved = market === 'TW' ? await loadTwSanSeScan(date) : await loadSanSeScan(date);
  if (saved && saved.lastDate === date && saved.records?.length) {
    records = saved.records;
    evaluated = saved.evaluated;
  } else {
    const scan = market === 'TW' ? await scanTwSanSe({ asOfDate: date }) : await scanSanSe({ asOfDate: date });
    records = scan.records;
    evaluated = scan.evaluated;
  }

  const codeToThemes = invertHotThemes(hotThemes);
  const selection = crossSelect(market, hotThemes, records, codeToThemes, opts?.thresholds);
  return {
    hotThemes,
    selection,
    sanseUniverse: evaluated,
    readiness: { themeHeat: hotThemes.length > 0, sanseScan: evaluated > 0 },
  };
}

/** 攤平三組 → ThemeSanseEvent[]（baseline=null）。 */
export function eventsFromSelection(
  market: TsMarket,
  date: string,
  selection: CohortSelection,
  thresholds: CrossThresholds,
  now: string,
): ThemeSanseEventsFile {
  const events: ThemeSanseEvent[] = [];

  for (const c of selection.cross) {
    events.push({
      id: `${market}:${date}:cross:${c.code}`,
      market, date, cohort: 'cross',
      code: c.code, symbol: c.symbol, name: c.name,
      themeIds: c.themes.map((t) => t.themeId),
      themeNames: c.themes.map((t) => t.themeName),
      bestThemeRank: c.bestThemeRank,
      namedStrategies: c.namedStrategies,
      sanseState: c.sanseState,
      comboGrade: c.comboGrade,
      verdict: c.verdict,
      verdictReversal: c.verdictReversal,
      reason: c.reason,
      baseline: null,
    });
  }
  for (const c of selection.theme) {
    events.push({
      id: `${market}:${date}:theme:${c.code}`,
      market, date, cohort: 'theme',
      code: c.code, symbol: c.symbol, name: c.name,
      themeIds: [], themeNames: [c.theme], bestThemeRank: c.themeHeatRank,
      namedStrategies: [], sanseState: null, comboGrade: null, verdict: null, verdictReversal: false,
      reason: c.reason,
      baseline: null,
    });
  }
  for (const c of selection.sanse) {
    events.push({
      id: `${market}:${date}:sanse:${c.code}`,
      market, date, cohort: 'sanse',
      code: c.code, symbol: c.symbol, name: c.name,
      themeIds: [], themeNames: [], bestThemeRank: null,
      namedStrategies: c.namedStrategies, sanseState: c.sanseState, comboGrade: c.comboGrade,
      verdict: c.verdict, verdictReversal: false,
      reason: c.reason,
      baseline: null,
    });
  }

  return {
    schemaVersion: THEME_SANSE_SCHEMA_VERSION,
    market, date, generatedAt: now, thresholds, events,
  };
}

/** 重建同日：保留既有已結算 baseline（filled/no_fill/no_data），只刷新註記。 */
export function mergePreservingBaseline(
  old: ThemeSanseEventsFile | null,
  fresh: ThemeSanseEventsFile,
): ThemeSanseEventsFile {
  if (!old) return fresh;
  const oldById = new Map(old.events.map((e) => [e.id, e]));
  return {
    ...fresh,
    events: fresh.events.map((e) => {
      const o = oldById.get(e.id);
      if (o?.baseline && o.baseline.status !== 'pending') return { ...e, baseline: o.baseline };
      return e;
    }),
  };
}

/** 建當日事件並存檔（merge 保留 baseline；事件為空則不存）。回 selection 供每日快照重用。 */
export async function buildThemeSanseEvents(
  market: TsMarket,
  date: string,
  opts?: { thresholds?: CrossThresholds },
): Promise<SelectionResult & { file: ThemeSanseEventsFile; saved: boolean }> {
  const thresholds = opts?.thresholds ?? DEFAULT_CROSS_THRESHOLDS;
  const now = new Date().toISOString();
  const sel = await selectForDate(market, date, { thresholds });
  const fresh = eventsFromSelection(market, date, sel.selection, thresholds, now);
  const existing = await readThemeSanseEvents(market, date);
  const file = mergePreservingBaseline(existing, fresh);
  let saved = false;
  if (file.events.length > 0) {
    await saveThemeSanseEvents(file);
    saved = true;
  }
  return { ...sel, file, saved };
}
