// ============================================================
// 題材×三色 — 熱門題材排名（台股）。Server-only（讀本地檔）。
//
// TW：reuse buildSectorRanking（TWSE／TPEx 官方產業，由 L1 重算，回測可深）。
// （陸股題材分類已於 2026-06-21 移除 → CN 一律回空陣列，三色掃描退回無題材排序。）
//
// 熱度合成 HEAT_WEIGHTS 單一事實：各分項做當日 rank-percentile，只對「有值的權重」
// 重正規化（缺項不歸零）。
// ============================================================

import {
  buildSectorRanking,
  readSectorRanking,
  type ThemeRank,
} from '@/lib/themes/sectorRanking';
import {
  HEAT_WEIGHTS,
  type HeatSignalKey,
  type HotTheme,
  type HotThemeMember,
  type HotThemeWhy,
  type TsMarket,
} from './types';

const round1 = (x: number): number => +x.toFixed(1);

interface RawTheme {
  id: string;
  name: string;
  kind: HotTheme['kind'];
  source: HotTheme['source'];
  degraded: boolean;
  why: HotThemeWhy;
  members: HotThemeMember[];
  leaderCode: string | null;
  stageLabel?: string | null;
  catalyst?: string | null;
}

/** HeatSignalKey → HotThemeWhy 欄位。 */
const WHY_KEY: Record<HeatSignalKey, keyof HotThemeWhy> = {
  avgRet: 'avgRet',
  limitUp: 'limitUpCount',
  consecBoard: 'maxConsecBoard',
  volume: 'volExpansion',
  inflow: 'mainNetInflow',
  popularity: 'popularity',
  lhbNet: 'lhbNetBuy',
};

/** 回傳「value 在 vals 內的百分位」0-1（higher=hotter；含 tie 平均；單一值 → 0.5）。 */
function percentileFn(vals: number[]): (v: number) => number {
  return (v) => {
    if (vals.length === 0) return 0.5;
    let lt = 0;
    let eq = 0;
    for (const x of vals) {
      if (x < v) lt++;
      else if (x === v) eq++;
    }
    return (lt + 0.5 * eq) / vals.length;
  };
}

/** 對一批 raw 題材算 heatScore + heatRank（缺值重加權）。 */
function finalize(raws: RawTheme[]): HotTheme[] {
  const keys = Object.keys(HEAT_WEIGHTS) as HeatSignalKey[];
  const pctFns = {} as Record<HeatSignalKey, (v: number) => number>;
  for (const k of keys) {
    const vals = raws
      .map((r) => r.why[WHY_KEY[k]])
      .filter((v): v is number => v != null);
    pctFns[k] = percentileFn(vals);
  }
  const scored = raws.map((r) => {
    let wsum = 0;
    let acc = 0;
    for (const k of keys) {
      const val = r.why[WHY_KEY[k]];
      if (val == null) continue;
      const w = HEAT_WEIGHTS[k];
      wsum += w;
      acc += w * pctFns[k](val);
    }
    const heatScore = wsum > 0 ? round1((100 * acc) / wsum) : 0;
    const t: HotTheme = { ...r, memberCount: r.members.length, heatScore, heatRank: 0 };
    return t;
  });
  scored.sort((a, b) => b.heatScore - a.heatScore);
  scored.forEach((t, i) => (t.heatRank = i + 1));
  return scored;
}

// ── TW ──────────────────────────────────────────────────────────────────────

function twRawFromThemeRank(tr: ThemeRank): RawTheme {
  const members: HotThemeMember[] = tr.members
    .map((m) => ({
      code: m.code,
      name: m.name,
      symbol: m.symbol,
      score: m.d5 ?? m.d1 ?? null,
    }))
    .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
  return {
    id: tr.theme,
    name: tr.theme,
    kind: 'tw_theme',
    source: 'tw_sector',
    degraded: false,
    why: {
      avgRet: tr.avgD5,
      limitUpCount: null,
      maxConsecBoard: null,
      volExpansion: tr.avgVolRatio,
      mainNetInflow: tr.instNet5,
      popularity: null,
      lhbNetBuy: null,
      breadth: tr.breadth,
    },
    members,
    leaderCode: tr.topStock?.code ?? null,
    stageLabel: tr.stage,
    catalyst: tr.topStock ? `龍頭 ${tr.topStock.name} ${tr.topStock.d1 >= 0 ? '+' : ''}${tr.topStock.d1}%` : null,
  };
}

async function rankTwHotThemes(date: string): Promise<HotTheme[]> {
  const file = (await readSectorRanking(date)) ?? (await buildSectorRanking(date));
  return finalize(file.themes.map(twRawFromThemeRank));
}

/** 熱門題材排名。回 heatScore desc，heatRank 1-based。陸股題材分類已移除 → CN 回空。 */
export async function rankHotThemes(market: TsMarket, date: string): Promise<HotTheme[]> {
  return market === 'TW' ? rankTwHotThemes(date) : [];
}
