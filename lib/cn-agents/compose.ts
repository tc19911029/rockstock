/**
 * 每日總決策合成（P3）— 程式硬分 + skill 語意分 → daily/{date}.json + master_decision 事件
 *
 * 流程：
 *   1. hard_score events（程式 5 子分：漲停結構/龍虎榜/主力/熱度/板塊）為底
 *   2. skill analysis（stock_semantics）補 policy/theme 兩個語意子分
 *   3. computeCnTotalScore 重算（缺值重加權）→ 精算 tier/mode
 *   4. tacticClassifier 用日K特徵 + 情緒階段 + 題材地位 → 精細操作分類
 *   5. 寫 daily/{date}.json（UI 用）+ master_decision 事件（reco 追蹤；與 hard_score_v0 並行對照）
 *
 * analysis 缺席（skill 還沒跑）→ policy/theme 留 null、自動重加權，analysisPresent=false，
 * 照樣產出 daily（degraded）。冪等：同日重跑覆寫。
 */

import {
  readBreadthDay, readLimitUpPoolDay, readAnalysis, readRecoEvents,
  saveDaily, saveRecoEvents,
} from './storage';
import { buildHardScoreEvents } from './hardScore';
import { validateAnalysis } from './bridge/validateAnalysis';
import { computeCnTotalScore, cnScoreToLight, type CnSubScores } from './scoring';
import { phaseModeEdge, applyPhaseModeEdge } from './phaseModeEdge';
import { classifyTactic, computeTechFeatures } from './tacticClassifier';
import { loadCandlesForEvent } from './backtest/recoPipeline';
import { buildCnRedFlagInput } from '@/lib/redflags/cnRedFlagData';
import { computeRedFlags, summarizeRedFlags } from '@/lib/redflags/compute';
import { CN_AGENTS_SCHEMA_VERSION, CYCLE_RULES_VERSION, STAGE_LABELS } from './types';
import { CN_SCORING_VERSION } from './scoring';
import type {
  CnDailyFile, DailyCandidate, StockSemantics, CnRecoMode, CnTier, EmotionStage,
} from './types';
import type { CnRecoEvent, CnRecoEventsFile } from './backtest/recoTypes';

const DAILY_CAP = 150;
const TACTIC_CANDLE_CAP = 50; // 只對 top N 載 K 線跑 tacticClassifier（其餘用 mode fallback）
const REDFLAG_ENRICH_CAP = 30; // 紅旗避雷只查 top N（逐檔串行打 EastMoney，限速防 502）
const TIER_A_TOP_N = 10;
const TIER_A_MIN_SCORE = 60;
const TIER_C_BELOW = 40;

const ymd8 = (iso: string): string => iso.replaceAll('-', '');

/** tactic enum → reco mode（事件用簡化 5 值） */
function tacticToMode(t: string): CnRecoMode {
  if (t === 'daban') return 'daban';
  if (t === 'banlu') return 'banlu';
  if (t === 'dixi' || t === 'fanbao' || t === 'weakToStrong') return 'dixi';
  if (t === 'trend' || t === 'swing' || t === 'buchang') return 'swing';
  return 'watch';
}

export interface ComposeResult {
  date: string;
  analysisPresent: boolean;
  candidates: number;
  tierCounts: Record<CnTier, number>;
}

export async function composeDaily(date: string): Promise<ComposeResult> {
  const [breadthDay, pool] = await Promise.all([readBreadthDay(date), readLimitUpPoolDay(date)]);
  if (!breadthDay || !pool) throw new Error(`[cn-agents] composeDaily(${date})：breadth / pool 檔缺`);

  // hard_score events（程式分）
  let events = (await readRecoEvents(date))?.events.filter((e) => e.agentSource === 'hard_score_v0') ?? null;
  if (!events || events.length === 0) {
    events = (await buildHardScoreEvents(date)).events;
  }

  // skill 語意分（過 validateAnalysis；壞的當缺席走 degraded，不污染 daily）
  const rawAnalysis = await readAnalysis(date);
  let analysis = rawAnalysis;
  if (rawAnalysis) {
    const candidateCodes = new Set(events.map((e) => e.code));
    const v = validateAnalysis(rawAnalysis, candidateCodes);
    if (!v.ok) {
      console.warn(`[cn-agents] composeDaily(${date}) analysis 校驗失敗，走重加權：${v.errors.slice(0, 3).join('；')}`);
      analysis = null;
    }
  }
  const analysisPresent = !!analysis;
  const semBySymbol = new Map<string, StockSemantics>((analysis?.stock_semantics ?? []).map((s) => [s.symbol, s]));
  const themeNameById = new Map((analysis?.themes ?? []).map((t) => [t.id, t.name]));
  const themeLeaderBoardsById = new Map<string, number>();
  for (const t of analysis?.themes ?? []) {
    const lead = t.leader_symbol ? pool.limitUp.find((l) => l.symbol === t.leader_symbol) : null;
    if (t.leader_symbol) themeLeaderBoardsById.set(t.id, lead?.consecBoards ?? 0);
  }

  const phase: EmotionStage = breadthDay.cycle.stage;
  const poolBySymbol = new Map(pool.limitUp.map((l) => [l.symbol, l]));
  const brokenSet = new Set(pool.broken.map((b) => b.symbol));

  // 取需要精算 tactic 的 top N（按 hard score 排序）
  const ranked = [...events].sort((a, b) => b.totalScore - a.totalScore);
  const tacticTargets = new Set(ranked.slice(0, TACTIC_CANDLE_CAP).map((e) => e.code));
  const todayYmd8 = ymd8(new Date().toISOString().slice(0, 10));

  const dailyCandidates: DailyCandidate[] = [];
  for (const e of ranked.slice(0, DAILY_CAP)) {
    const sem = semBySymbol.get(e.code) ?? null;
    // 合 10 子分：程式 5 + skill policy/theme + emotion（全市場同值不入排序，留 null）
    const sub: CnSubScores = {
      emotion: null,
      policy: sem?.policy_score ?? null,
      theme: sem?.theme_score ?? null,
      sector: e.scoreBreakdown.sector ?? null,
      limitStructure: e.scoreBreakdown.limitStructure ?? null,
      lhb: e.scoreBreakdown.lhb ?? null,
      mainFlow: e.scoreBreakdown.mainFlow ?? null,
      heat: e.scoreBreakdown.heat ?? null,
      technical: null,
      risk: null,
    };
    const scored = computeCnTotalScore(sub);

    // tactic（top N 載 K 線；其餘用 hard_score mode）
    const lu = poolBySymbol.get(e.code) ?? null;
    let tacticPrimary = e.mode as string;
    let tacticReasons: string[] = [];
    if (tacticTargets.has(e.code)) {
      const candles = await loadCandlesForEvent(e.symbol, e.board, todayYmd8);
      const tech = computeTechFeatures(candles);
      const tr = classifyTactic({
        boards: lu?.consecBoards ?? 0,
        isLimitUpToday: !!lu,
        isOneWord: lu?.isOneWord,
        todayPct: lu?.pct ?? null,
        yesterdayBroken: brokenSet.has(e.code),
        cycleStage: phase,
        themePosition: sem?.position ?? null,
        themeLeaderBoards: sem?.theme_id ? themeLeaderBoardsById.get(sem.theme_id) ?? null : null,
        ...tech,
      });
      tacticPrimary = tr.primary;
      tacticReasons = tr.reasons;
    }

    // P5：套 phase×mode edge（回測 train/test 驗證：打板熱階段扣分、低吸啟動/主升/殺跌加分）
    const mode = tacticToMode(tacticPrimary);
    const edge = phaseModeEdge(mode, phase);
    const adjScore = applyPhaseModeEdge(scored.totalScore, mode, phase);
    const edgeReason = edge !== 0 ? [`情緒階段校準 ${edge > 0 ? '+' : ''}${edge}（${mode}×${STAGE_LABELS[phase]}）`] : [];

    dailyCandidates.push({
      code: e.code, name: e.name, symbol: e.symbol, board: e.board,
      rank: 0, totalScore: adjScore, light: cnScoreToLight(adjScore), confidence: scored.confidence,
      tier: 'B', mode,
      subScores: sub as Record<string, number | null>,
      available: scored.dataStatus.available, missing: scored.dataStatus.missing,
      themeId: sem?.theme_id ?? null, position: sem?.position ?? null,
      reasons: [...tacticReasons, ...edgeReason, ...(e.reason ? [e.reason] : [])].slice(0, 5),
    });
  }

  // 重排 + tier
  dailyCandidates.sort((a, b) => b.totalScore - a.totalScore);
  dailyCandidates.forEach((c, i) => {
    c.rank = i + 1;
    c.tier = i < TIER_A_TOP_N && c.totalScore >= TIER_A_MIN_SCORE && c.available.length >= 3 ? 'A'
      : c.totalScore < TIER_C_BELOW ? 'C' : 'B';
  });

  // veto 名單（ST/退）：從 hard_score 的 C 類 veto 事件帶出
  const vetoEvents = (await readRecoEvents(date))?.events.filter((e) => e.agentSource === 'hard_score_v0' && e.totalScore === 0 && e.reason.includes('ST')) ?? [];

  // 買進前紅旗避雷（2026-06-13）：top N 逐檔串行查 EastMoney 基本面/籌碼/治理，
  // 掛 c.redFlags（只標示、不改 totalScore/tier）；shouldAvoid 的併入 avoidList。
  // 全段 best-effort：單檔失敗略過、整段失敗不阻斷 compose。
  const redFlagAvoids: { symbol: string; name: string; reason: string }[] = [];
  for (const c of dailyCandidates.slice(0, REDFLAG_ENRICH_CAP)) {
    try {
      const flags = computeRedFlags(await buildCnRedFlagInput(c.symbol));
      if (flags.length === 0) continue;
      c.redFlags = flags;
      const s = summarizeRedFlags(flags);
      if (s.shouldAvoid && s.avoidReason) {
        redFlagAvoids.push({ symbol: c.code, name: c.name, reason: `紅旗｜${s.avoidReason}` });
      }
    } catch (err) {
      console.warn(`[cn-agents] redflag enrich ${c.code} 略過：${(err as Error).message}`);
    }
  }

  const top10 = dailyCandidates.slice(0, 10).map((c) => c.code);
  const actionList = dailyCandidates.filter((c) => c.tier === 'A').slice(0, 5).map((c) => ({
    symbol: c.code, name: c.name, tier: c.tier, mode: c.mode,
    note: c.reasons[0] ?? '',
  }));
  // 避開名單 = ST/退 veto + 紅旗 shouldAvoid（去重，同 symbol 以 veto 為先）
  const vetoBase = vetoEvents.slice(0, 20).map((e) => ({ symbol: e.code, name: e.name, reason: e.reason }));
  const vetoSymbols = new Set(vetoBase.map((v) => v.symbol));
  const avoidList = [...vetoBase, ...redFlagAvoids.filter((r) => !vetoSymbols.has(r.symbol))];

  const daily: CnDailyFile = {
    schemaVersion: CN_AGENTS_SCHEMA_VERSION,
    scoringVersion: CN_SCORING_VERSION,
    cycleRulesVersion: CYCLE_RULES_VERSION,
    date,
    generatedAt: new Date().toISOString(),
    analysisPresent,
    marketMood: {
      stage: phase, stageLabel: breadthDay.cycle.stageLabel,
      emotionScore: breadthDay.cycle.emotionScore, strategyLabel: breadthDay.cycle.strategyLabel,
      positionPct: breadthDay.cycle.positionPct,
      narrative: analysis?.market_narrative ?? null,
    },
    themes: analysis?.themes ?? [],
    candidates: dailyCandidates,
    top10,
    actionList,
    avoidList,
    reportMdKey: analysis?.report_written ? `cn-agents/reports/${date}.md` : null,
  };
  await saveDaily(daily);

  // master_decision 事件（與 hard_score_v0 並行；merge 進同檔，保留 hard_score_v0）
  await writeMasterDecisionEvents(date, phase, dailyCandidates);

  const tierCounts: Record<CnTier, number> = { A: 0, B: 0, C: 0 };
  for (const c of dailyCandidates) tierCounts[c.tier]++;
  return { date, analysisPresent, candidates: dailyCandidates.length, tierCounts };
}

async function writeMasterDecisionEvents(date: string, phase: EmotionStage, candidates: DailyCandidate[]): Promise<void> {
  const existing = await readRecoEvents(date);
  const kept = (existing?.events ?? []).filter((e) => e.agentSource !== 'master_decision');
  const mdEvents: CnRecoEvent[] = candidates.map((c) => ({
    id: `${date}:master_decision:${c.code}`,
    date, agentSource: 'master_decision',
    code: c.code, name: c.name, symbol: c.symbol, board: c.board,
    tier: c.tier, mode: c.mode, totalScore: c.totalScore,
    scoreBreakdown: c.subScores, sentimentPhase: phase,
    reason: c.reasons.join('；'), baseline: null,
  }));
  const file: CnRecoEventsFile = {
    schemaVersion: CN_AGENTS_SCHEMA_VERSION,
    date,
    generatedAt: new Date().toISOString(),
    events: [...kept, ...mdEvents],
  };
  await saveRecoEvents(file);
}
