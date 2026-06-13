/**
 * hard_score_v0 — 純硬數據複合分事件產生器（P2）
 *
 * 在 P3 總決策（skill 語意層）上線前先開始累積績效時序：候選池組裝 →
 * 5 個程式 source 子分（漲停結構/龍虎榜/主力資金/人氣/板塊）→
 * computeCnTotalScore 缺值重加權（policy/theme/technical/risk/emotion 傳 null）→
 * tier 分層 + v0 操作模式 → 事件落地 data/cn-agents/events/{date}.json。
 *
 * 設計決議：
 *   - emotion 子分「全市場當日同值」對排序零貢獻，刻意不入（缺值重加權吸收）
 *   - tier：veto（名含 ST/退）→ C；分數排序 top10 且 ≥60 → A；
 *     其餘 top40 → B；score<40 → C。每日事件 cap 60（top40 + veto'd cap 20）
 *   - mode v0 規則簡化版（P3 tacticClassifier 細化）：今日漲停非一字 → daban、
 *     一字 → watch（買不進機率高）、炸板池 → dixi（博反包）、
 *     僅龍虎榜/主力流入來源 → swing、僅人氣榜 → watch、tier C 一律 watch
 *   - C 類也入事件 — 驗證「避開」是否真的該避（排行榜聚合時 win 語意=跌）
 *
 * 「模式×情緒階段」交叉表的 phase 取自 breadth/{date}.json 的 cycle.stage
 * （決策當下凍結，不隨後續重算漂移 — 但注意 CYCLE_RULES_VERSION 升版重算
 * breadth 後，舊事件的 sentimentPhase 仍是舊版凍結值，分析時要知道）。
 */

import { CN_AGENTS_SCHEMA_VERSION, type CnBoardKind, type CnRecoMode, type CnTier } from './types';
import type { BoardEntry, LimitUpEntry, BrokenEntry, LhbStockEntry } from './types';
import { computeCnTotalScore, type CnSubScores } from './scoring';
import {
  scoreLimitStructure,
  scoreLhb,
  scoreMainFlow,
  scoreHeat,
  scoreSector,
} from './subScores';
import { classifyCnBoard, isStName } from './cnBoard';
import {
  readLimitUpPoolDay,
  readLhbDaily,
  readHotnessDay,
  readBoardsDay,
  readBreadthDay,
  readBreadthIndex,
  saveRecoEvents,
} from './storage';
import type { CnRecoEvent, CnRecoEventsFile } from './backtest/recoTypes';

/** 每日事件上限（top 40 計分 + veto 名單 cap 20） */
const SCORED_CAP = 40;
const VETO_CAP = 20;
const TIER_A_MIN_SCORE = 60;
const TIER_A_TOP_N = 10;
/** tier A 最少可用子分數（單一訊號重加權虛胖防呆） */
const TIER_A_MIN_SIGNALS = 3;
const TIER_C_SCORE_BELOW = 40;
/** 主力資金「連續淨流入」判定回看天數 */
const FLOW_LOOKBACK_DAYS = 3;
/** 近 N 個交易日有漲停 → limitStructure 非漲停分支 base 55 */
const RECENT_LIMITUP_LOOKBACK = 5;

function toSymbol(code: string, board: CnBoardKind): string {
  if (board === 'BJ') return `${code}.BJ`;
  return `${code}.${board === 'SH-main' || board === 'STAR' ? 'SS' : 'SZ'}`;
}

interface CandidateRaw {
  code: string;
  name: string;
  board: CnBoardKind;
  /** 候選來源（mode v0 推導用） */
  sources: Set<'limitup' | 'broken' | 'lhb' | 'flow' | 'hot'>;
  limitUpEntry: LimitUpEntry | null;
  brokenEntry: BrokenEntry | null;
  lhbEntry: LhbStockEntry | null;
  mainNetCny: number | null;
  industry: string | null;
  todayPct: number | null;
}

/** lhb 同股多 reason 上榜 → 取 |netAmt| 最大那筆當評分代表 */
function pickLhbEntry(entries: LhbStockEntry[]): LhbStockEntry {
  return entries.reduce((a, b) => (Math.abs(b.netAmt ?? 0) > Math.abs(a.netAmt ?? 0) ? b : a));
}

export async function buildHardScoreEvents(date: string): Promise<CnRecoEventsFile> {
  const [pool, lhb, hotness, boards, breadthDay, index] = await Promise.all([
    readLimitUpPoolDay(date),
    readLhbDaily(date),
    readHotnessDay(date),
    readBoardsDay(date),
    readBreadthDay(date),
    readBreadthIndex(),
  ]);
  if (!pool) {
    throw new Error(`[cn-agents] buildHardScoreEvents(${date})：limitup-pool 檔缺 — 先跑 cn-agents-eod`);
  }

  // 近 5 個交易日序列（從 breadth index 取，免假日表推算）
  const priorDates = (index?.days ?? [])
    .map((d) => d.date)
    .filter((d) => d < date)
    .slice(-RECENT_LIMITUP_LOOKBACK);

  const priorPools = await Promise.all(priorDates.map((d) => readLimitUpPoolDay(d)));
  /** symbol → 近 5 日漲停日期列表 */
  const recentLimitUpBySymbol = new Map<string, string[]>();
  for (const p of priorPools) {
    if (!p) continue;
    for (const e of p.limitUp) {
      const arr = recentLimitUpBySymbol.get(e.symbol) ?? [];
      arr.push(p.date);
      recentLimitUpBySymbol.set(e.symbol, arr);
    }
  }
  const yesterdayPool = priorPools.length > 0 ? priorPools[priorPools.length - 1] : null;
  const yesterdayBrokenSet = new Set((yesterdayPool?.broken ?? []).map((b) => b.symbol));

  // 主力資金（既有 17:30 cn-flow cron 落地檔）+ 連續淨流入天數
  const { readCapitalFlowCN } = await import('@/lib/storage/capitalFlowStorage');
  const flowToday = (await readCapitalFlowCN(date)) ?? [];
  const flowBySymbol = new Map(flowToday.map((r) => [r.symbol, r.mainNet]));
  const flowPrior = await Promise.all(
    priorDates.slice(-(FLOW_LOOKBACK_DAYS - 1)).map((d) => readCapitalFlowCN(d)),
  );
  const consecInflow = (code: string): number => {
    if (!((flowBySymbol.get(code) ?? 0) > 0)) return 0;
    let n = 1;
    for (let i = flowPrior.length - 1; i >= 0; i--) {
      const rec = flowPrior[i]?.find((r) => r.symbol === code);
      if (rec && rec.mainNet > 0) n++;
      else break;
    }
    return n;
  };

  // 行業名 → 當日行業板塊 entry（sector 子分）
  const industryBoardByName = new Map<string, BoardEntry>();
  for (const b of boards?.industries ?? []) industryBoardByName.set(b.name, b);

  // 人氣榜 symbol → entry
  const hotBySymbol = new Map((hotness?.emRank ?? []).map((e) => [e.symbol, e]));

  // 主板行業 fallback：cn_stocklist.json
  let stocklistIndustry = new Map<string, string>();
  let stocklistName = new Map<string, string>();
  try {
    const path = await import('path');
    const { promises: fs } = await import('fs');
    const raw = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'data', 'cn_stocklist.json'), 'utf-8'),
    ) as Array<{ symbol: string; name: string; industry?: string | null }>;
    stocklistIndustry = new Map(raw.map((r) => [r.symbol.split('.')[0], r.industry ?? '']));
    stocklistName = new Map(raw.map((r) => [r.symbol.split('.')[0], r.name]));
  } catch { /* 清單缺 → industry/name fallback 不可用，候選仍可組 */ }

  // ── 候選池組裝（漲停 ∪ 炸板 ∪ 龍虎榜淨買>0 ∪ 主力流入 top50 ∪ 人氣 top50）──
  const candidates = new Map<string, CandidateRaw>();
  const upsert = (code: string, patch: Partial<CandidateRaw> & { source: CandidateRaw['sources'] extends Set<infer S> ? S : never }): CandidateRaw => {
    let c = candidates.get(code);
    if (!c) {
      const name = patch.name ?? stocklistName.get(code) ?? code;
      c = {
        code,
        name,
        board: patch.board ?? classifyCnBoard(code),
        sources: new Set(),
        limitUpEntry: null,
        brokenEntry: null,
        lhbEntry: null,
        mainNetCny: flowBySymbol.get(code) ?? null,
        industry: stocklistIndustry.get(code) || null,
        todayPct: null,
      };
      candidates.set(code, c);
    }
    c.sources.add(patch.source);
    if (patch.name) c.name = patch.name;
    if (patch.limitUpEntry) c.limitUpEntry = patch.limitUpEntry;
    if (patch.brokenEntry) c.brokenEntry = patch.brokenEntry;
    if (patch.lhbEntry) c.lhbEntry = patch.lhbEntry;
    if (patch.industry) c.industry = patch.industry;
    if (patch.todayPct !== undefined) c.todayPct = patch.todayPct;
    return c;
  };

  for (const e of pool.limitUp) {
    upsert(e.symbol, { source: 'limitup', name: e.name, board: e.board, limitUpEntry: e, industry: e.industry ?? undefined, todayPct: e.pct });
  }
  for (const e of pool.broken) {
    upsert(e.symbol, { source: 'broken', name: e.name, board: e.board, brokenEntry: e, industry: e.industry ?? undefined, todayPct: e.pct });
  }
  if (lhb) {
    const byCode = new Map<string, LhbStockEntry[]>();
    for (const s of lhb.stocks) {
      const arr = byCode.get(s.code) ?? [];
      arr.push(s);
      byCode.set(s.code, arr);
    }
    for (const [code, entries] of byCode) {
      const rep = pickLhbEntry(entries);
      if ((rep.netAmt ?? 0) <= 0) continue; // 只收淨買
      upsert(code, { source: 'lhb', name: rep.name, board: rep.board, lhbEntry: rep, todayPct: rep.changeRate ?? undefined });
    }
  }
  const flowTop = [...flowToday].filter((r) => r.mainNet > 0).sort((a, b) => b.mainNet - a.mainNet).slice(0, 50);
  for (const r of flowTop) upsert(r.symbol, { source: 'flow' });
  for (const e of (hotness?.emRank ?? []).slice(0, 50)) {
    // 人氣榜含創業/科創 — 名稱用榜上自帶（stocklist 只有主板）
    upsert(e.symbol, { source: 'hot', name: e.name ?? undefined });
  }

  // ── 評分 ──────────────────────────────────────────────────────────────────
  interface Scored {
    c: CandidateRaw;
    totalScore: number;
    breakdown: Record<string, number | null>;
    reasons: string[];
    veto: boolean;
  }
  const scored: Scored[] = [];
  for (const c of candidates.values()) {
    const veto = isStName(c.name);
    if (veto) {
      scored.push({ c, totalScore: 0, breakdown: {}, reasons: [`風險否決：名稱含 ST/退（${c.name}）`], veto: true });
      continue;
    }
    const limitRes = scoreLimitStructure({
      todayLimitUp: c.limitUpEntry,
      todayBroken: c.brokenEntry,
      recentLimitUpDates: recentLimitUpBySymbol.get(c.code) ?? [],
      yesterdayBroken: yesterdayBrokenSet.has(c.code),
      todayPct: c.todayPct,
    });
    const lhbRes = scoreLhb(c.lhbEntry);
    const flowRes = scoreMainFlow({
      mainNetCny: c.mainNetCny,
      freeMarketCapCny: c.lhbEntry?.freeMarketCap ?? c.limitUpEntry?.floatMvCny ?? null,
      consecutiveInflowDays: c.mainNetCny !== null ? consecInflow(c.code) : null,
      isLimitUpToday: c.limitUpEntry !== null,
    });
    const heatRes = scoreHeat(hotBySymbol.get(c.code) ?? null);
    const sectorRes = scoreSector({ board: c.industry ? industryBoardByName.get(c.industry) ?? null : null });

    const sub: CnSubScores = {
      emotion: null, // 全市場同值，對排序零貢獻，刻意缺值重加權
      policy: null,
      theme: null,
      technical: null,
      risk: null,
      limitStructure: limitRes?.score ?? null,
      lhb: lhbRes?.score ?? null,
      mainFlow: flowRes?.score ?? null,
      heat: heatRes.score,
      sector: sectorRes?.score ?? null,
    };
    const total = computeCnTotalScore(sub);
    const reasons = [
      ...(limitRes?.reasons ?? []),
      ...(lhbRes?.reasons ?? []),
      ...(flowRes?.reasons ?? []),
      ...heatRes.reasons,
      ...(sectorRes?.reasons ?? []),
    ].slice(0, 6);
    scored.push({
      c,
      totalScore: total.totalScore,
      breakdown: {
        limitStructure: sub.limitStructure ?? null,
        lhb: sub.lhb ?? null,
        mainFlow: sub.mainFlow ?? null,
        heat: sub.heat ?? null,
        sector: sub.sector ?? null,
      },
      reasons,
      veto: false,
    });
  }

  // ── tier / mode / 事件組裝 ─────────────────────────────────────────────────
  const ranked = scored.filter((s) => !s.veto).sort((a, b) => b.totalScore - a.totalScore).slice(0, SCORED_CAP);
  const vetoed = scored.filter((s) => s.veto).slice(0, VETO_CAP);
  const phase = breadthDay?.cycle.stage ?? 'repair';

  const deriveMode = (s: Scored, tier: CnTier): CnRecoMode => {
    if (tier === 'C') return 'watch';
    const { c } = s;
    if (c.limitUpEntry) return c.limitUpEntry.isOneWord ? 'watch' : 'daban';
    if (c.brokenEntry) return 'dixi';
    if (c.sources.has('lhb') || c.sources.has('flow')) return 'swing';
    return 'watch';
  };

  /** 可用程式子分數（非 null）— 單一訊號（如只上人氣榜）重加權會虛胖，tier A 要求 ≥3 */
  const availableSignals = (b: Record<string, number | null>): number =>
    Object.values(b).filter((v) => v !== null).length;

  const events: CnRecoEvent[] = [];
  ranked.forEach((s, i) => {
    const tier: CnTier =
      i < TIER_A_TOP_N && s.totalScore >= TIER_A_MIN_SCORE && availableSignals(s.breakdown) >= TIER_A_MIN_SIGNALS ? 'A'
      : s.totalScore < TIER_C_SCORE_BELOW ? 'C'
      : 'B';
    events.push({
      id: `${date}:hard_score_v0:${s.c.code}`,
      date,
      agentSource: 'hard_score_v0',
      code: s.c.code,
      name: s.c.name,
      symbol: toSymbol(s.c.code, s.c.board),
      board: s.c.board,
      tier,
      mode: deriveMode(s, tier),
      totalScore: s.totalScore,
      scoreBreakdown: s.breakdown,
      sentimentPhase: phase,
      reason: s.reasons.join('；'),
      baseline: null,
    });
  });
  for (const s of vetoed) {
    events.push({
      id: `${date}:hard_score_v0:${s.c.code}`,
      date,
      agentSource: 'hard_score_v0',
      code: s.c.code,
      name: s.c.name,
      symbol: toSymbol(s.c.code, s.c.board),
      board: s.c.board,
      tier: 'C',
      mode: 'watch',
      totalScore: 0,
      scoreBreakdown: {},
      sentimentPhase: phase,
      reason: s.reasons.join('；'),
      baseline: null,
    });
  }

  const file: CnRecoEventsFile = {
    schemaVersion: CN_AGENTS_SCHEMA_VERSION,
    date,
    generatedAt: new Date().toISOString(),
    events,
  };
  await saveRecoEvents(file);
  return file;
}
