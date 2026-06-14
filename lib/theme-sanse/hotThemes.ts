// ============================================================
// 題材×三色 — 熱門題材排名（market 派發）。Server-only（讀本地檔）。
//
// TW：reuse buildSectorRanking（25 題材，由 L1 重算，回測可深）。
// CN：漲停池 industry 分組（always，2024-06+ 可回測）＋ analysis 題材（live 才有，
//     概念/政策成分）；板塊/人氣/龍虎榜 enrich。boards 缺（歷史日）→ degraded。
//
// 熱度合成 HEAT_WEIGHTS 單一事實：各分項做當日 rank-percentile，只對「有值的權重」
// 重正規化（缺項不歸零）。degraded 由「來源」決定（TW sector / CN live = false；
// CN 重建 = true），不因 blend 差異誤標 TW。
// ============================================================

import {
  buildSectorRanking,
  readSectorRanking,
  type ThemeRank,
} from '@/lib/themes/sectorRanking';
import {
  readAnalysis,
  readBoardsDay,
  readHotnessDay,
  readLhbDaily,
  readLimitUpPoolDay,
} from '@/lib/cn-agents/storage';
import type { BoardEntry } from '@/lib/cn-agents/types';
import { THEME_STAGE_LABELS } from '@/lib/cn-agents/types';
import { cnSymbolFromCode } from './codes';
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

const mean = (xs: number[]): number | null =>
  xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

// ── TW ──────────────────────────────────────────────────────────────────────

function twRawFromThemeRank(tr: ThemeRank): RawTheme {
  const members: HotThemeMember[] = tr.members
    .map((m) => ({
      code: m.code,
      name: m.name,
      symbol: `${m.code}.TW`, // loader 缺檔 fallback .TWO
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

// ── CN ──────────────────────────────────────────────────────────────────────

async function rankCnHotThemes(date: string): Promise<HotTheme[]> {
  const [pool, boards, hotness, analysis, lhb] = await Promise.all([
    readLimitUpPoolDay(date),
    readBoardsDay(date),
    readHotnessDay(date),
    readAnalysis(date),
    readLhbDaily(date),
  ]);
  if (!pool && !analysis) return [];

  const live = boards != null;

  // 輔助索引（裸碼 → 名稱 / 連板 / 人氣 / 龍虎榜淨買）
  const nameByCode = new Map<string, string>();
  const consecByCode = new Map<string, number>();
  const limitUpCodes = new Set<string>();
  if (pool) {
    for (const e of [...pool.limitUp, ...pool.broken, ...pool.limitDown]) nameByCode.set(e.symbol, e.name);
    for (const e of pool.limitUp) {
      consecByCode.set(e.symbol, e.consecBoards);
      limitUpCodes.add(e.symbol);
    }
  }
  const popByCode = new Map<string, number>();
  if (hotness) {
    for (const h of hotness.emRank) {
      if (h.name) nameByCode.set(h.symbol, h.name);
      popByCode.set(h.symbol, h.rankChange ?? 101 - h.rank); // higher=hotter
    }
  }
  const lhbByCode = new Map<string, number>();
  if (lhb) {
    for (const s of lhb.stocks) {
      nameByCode.set(s.code, s.name);
      lhbByCode.set(s.code, (lhbByCode.get(s.code) ?? 0) + (s.netAmt ?? 0));
    }
  }
  const boardByName = new Map<string, BoardEntry>();
  if (boards) for (const b of boards.industries) boardByName.set(b.name, b);

  const popOf = (codes: string[]): number | null => {
    const vs = codes.map((c) => popByCode.get(c)).filter((v): v is number => v != null);
    return vs.length > 0 ? Math.max(...vs) : null;
  };
  const lhbOf = (codes: string[]): number | null => {
    const vs = codes.map((c) => lhbByCode.get(c)).filter((v): v is number => v != null);
    return vs.length > 0 ? vs.reduce((a, b) => a + b, 0) : null;
  };

  const raws: RawTheme[] = [];

  // A. 行業題材（漲停池 industry 分組；always — 回測 backbone）
  if (pool) {
    const byInd = new Map<string, typeof pool.limitUp>();
    for (const e of pool.limitUp) {
      if (e.isST || !e.industry) continue;
      const arr = byInd.get(e.industry) ?? [];
      arr.push(e);
      byInd.set(e.industry, arr);
    }
    for (const [ind, entries] of byInd) {
      const members: HotThemeMember[] = entries
        .map((e) => ({ code: e.symbol, name: e.name, symbol: cnSymbolFromCode(e.symbol), score: e.consecBoards }))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const codes = members.map((m) => m.code);
      const board = boardByName.get(ind);
      const breadth =
        board && board.upCount != null && board.downCount != null && board.upCount + board.downCount > 0
          ? board.upCount / (board.upCount + board.downCount)
          : null;
      raws.push({
        id: `industry:${ind}`,
        name: ind,
        kind: 'cn_industry',
        source: live ? 'cn_live' : 'cn_limitup_bt',
        degraded: !live,
        why: {
          avgRet: board?.pct ?? mean(entries.map((e) => e.pct)),
          limitUpCount: entries.length,
          maxConsecBoard: Math.max(...entries.map((e) => e.consecBoards)),
          volExpansion: board?.turnoverCny ?? null,
          mainNetInflow: board?.mainNetCny ?? null,
          popularity: popOf(codes),
          lhbNetBuy: lhbOf(codes),
          breadth,
        },
        members,
        leaderCode: board?.leaderSymbol ?? members[0]?.code ?? null,
      });
    }
  }

  // B. analysis 題材（live：概念/政策成分，member_symbols 是最佳成分來源）
  if (analysis) {
    for (const th of analysis.themes) {
      const codes = th.member_symbols;
      const members: HotThemeMember[] = codes.map((c) => ({
        code: c,
        name: nameByCode.get(c) ?? c,
        symbol: cnSymbolFromCode(c),
        score: consecByCode.get(c) ?? null,
      }));
      const inPoolCodes = codes.filter((c) => limitUpCodes.has(c));
      const consecVals = codes.map((c) => consecByCode.get(c)).filter((v): v is number => v != null);
      raws.push({
        id: th.id,
        name: th.name,
        kind: 'cn_analysis',
        source: 'cn_live',
        degraded: false,
        why: {
          avgRet: null,
          limitUpCount: inPoolCodes.length > 0 ? inPoolCodes.length : null,
          maxConsecBoard: consecVals.length > 0 ? Math.max(...consecVals) : null,
          volExpansion: null,
          mainNetInflow: null,
          popularity: popOf(codes),
          lhbNetBuy: lhbOf(codes),
          breadth: null,
        },
        members,
        leaderCode: th.leader_symbol,
        stageLabel: THEME_STAGE_LABELS[th.stage],
        catalyst: th.policy_link
          ? `政策催化：${th.policy_link.event}｜${th.logic_summary.slice(0, 60)}`
          : th.logic_summary.slice(0, 80),
      });
    }
  }

  return finalize(raws);
}

/** 熱門題材排名（market 派發）。回 heatScore desc，heatRank 1-based。 */
export async function rankHotThemes(market: TsMarket, date: string): Promise<HotTheme[]> {
  return market === 'TW' ? rankTwHotThemes(date) : rankCnHotThemes(date);
}
