/**
 * 檔案橋接 — 產出 cn-agents 政策/題材分析的 question payload（P3）
 *
 * 同 youtube-analysis pattern：程式把當日所有「乾淨資料」整理成一份 question.json
 * 寫到 $TMPDIR，使用者開對話跑 /cn-agents-analysis skill 讀它做語意分析（政策→題材
 * 映射、題材聚類階段、個股 theme/position），成本走訂閱不打 API。
 *
 * Payload 預算（youtube 超時教訓）：目標 <300KB、硬上限 400KB。超限按 caps 裁切，
 * 並在 meta.truncated 標記。所有橫斷都是 D 當日盤後快照，無 look-ahead。
 *
 * 候選池 = hard_score_v0 events 的 top 60（已含程式子分）；skill 對這 60 檔填語意。
 */

import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import {
  readLimitUpPoolDay, readBoardsDay, readHotnessDay, readBreadthDay,
  readBreadthIndex, readLhbDaily, readNewsDigest, readAnalysis, readRecoEvents,
} from '../storage';
import { buildHardScoreEvents } from '../hardScore';
import type { CnRecoEvent } from '../backtest/recoTypes';
import type { BoardEntry } from '../types';

const CAPS = { ztPool: 120, broken: 40, limitDown: 20, sectors: 30, sectorsBottom: 10, lhb: 60, hot: 50, news: 80, candidates: 60, miniDays: 10 };
const HARD_LIMIT_BYTES = 400_000;

export function questionDir(): string {
  return path.join(os.tmpdir(), 'rockstock-cn-agents');
}
export function questionPath(date: string): string {
  return path.join(questionDir(), `${date}-question.json`);
}

const yi = (v: number | null | undefined): number | null => (v == null ? null : +(v / 1e8).toFixed(2));

/** 組裝並寫出 question.json，回 { path, bytes, truncated, candidateCount }。 */
export async function buildQuestion(date: string): Promise<{ path: string; bytes: number; truncated: boolean; candidateCount: number }> {
  const [pool, boards, hotness, breadthDay, index, lhb, news, prevAnalysisRaw] = await Promise.all([
    readLimitUpPoolDay(date), readBoardsDay(date), readHotnessDay(date),
    readBreadthDay(date), readBreadthIndex(), readLhbDaily(date), readNewsDigest(date),
    readPrevAnalysis(date),
  ]);
  if (!pool || !breadthDay) {
    throw new Error(`[cn-agents] buildQuestion(${date})：limitup-pool / breadth 檔缺，先跑 cn-agents-eod`);
  }

  // 候選（hard_score events；缺則建）
  let events = (await readRecoEvents(date))?.events ?? null;
  if (!events) events = (await buildHardScoreEvents(date)).events;
  const candidates = events
    .filter((e) => e.tier !== 'C')
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, CAPS.candidates)
    .map((e: CnRecoEvent) => ({
      code: e.code, name: e.name, board: e.board, mode: e.mode,
      boards: pool.limitUp.find((l) => l.symbol === e.code)?.consecBoards ?? 0,
      industry: pool.limitUp.find((l) => l.symbol === e.code)?.industry ?? null,
      totalScore: e.totalScore, subScores: e.scoreBreakdown,
    }));

  const miniSeries = (index?.days ?? []).slice(-CAPS.miniDays).map((d) => ({
    date: d.date, stage: d.cycle.stage, score: d.cycle.emotionScore,
    limitUp: d.breadth.limitUpCount, yest: d.breadth.yestLimitUpAvgReturn,
  }));

  const sectorBrief = (arr: BoardEntry[] | undefined, n: number) =>
    (arr ?? []).slice(0, n).map((b) => ({ name: b.name, pct: b.pct, limitUps: b.limitUpCount, mainNetYi: yi(b.mainNetCny), leader: b.leaderName }));
  const sectorBottom = (arr: BoardEntry[] | undefined, n: number) =>
    (arr ?? []).slice(-n).map((b) => ({ name: b.name, pct: b.pct }));

  const payload = {
    meta: {
      schemaVersion: 1, date, generatedAt: new Date().toISOString(),
      outputPath: `data/cn-agents/analysis/${date}.json`,
      reportPath: `data/cn-agents/reports/${date}.md`,
      truncated: false,
      instructions: '對 candidates 每檔填 stock_semantics（theme_id/position/policy_score/theme_score）；題材聚類 themes；政策映射 policy_events。symbol 必須來自 candidates，不可自創。',
    },
    market: {
      stage: breadthDay.cycle.stage, stageLabel: breadthDay.cycle.stageLabel,
      strategyLabel: breadthDay.cycle.strategyLabel, emotionScore: breadthDay.cycle.emotionScore,
      breadth: breadthDay.breadth, miniSeries,
    },
    zt_pool: pool.limitUp.slice(0, CAPS.ztPool).map((e) => ({
      code: e.symbol, name: e.name, boards: e.consecBoards, board: e.board,
      firstSealTime: e.firstSealTime, brokenTimes: e.brokenTimes, sealAmtYi: yi(e.sealAmountCny),
      industry: e.industry, isOneWord: e.isOneWord, pct: e.pct,
    })),
    broken: pool.broken.slice(0, CAPS.broken).map((e) => ({ code: e.symbol, name: e.name, pct: e.pct, industry: e.industry })),
    limit_down: pool.limitDown.slice(0, CAPS.limitDown).map((e) => ({ code: e.symbol, name: e.name, pct: e.pct })),
    sectors: {
      industryTop: sectorBrief(boards?.industries, CAPS.sectors),
      industryBottom: sectorBottom(boards?.industries, CAPS.sectorsBottom),
      conceptTop: sectorBrief(boards?.concepts, CAPS.sectors),
      conceptBottom: sectorBottom(boards?.concepts, CAPS.sectorsBottom),
    },
    lhb: (lhb?.stocks ?? []).slice(0, CAPS.lhb).map((s) => ({
      code: s.code, name: s.name, netYi: yi(s.netAmt), reason: s.reason.slice(0, 24),
      topSeats: s.seats.buy.slice(0, 5).map((t) => ({ name: t.label ?? t.deptName, type: t.type })),
    })),
    hot_rank: (hotness?.emRank ?? []).slice(0, CAPS.hot).map((h) => ({ code: h.symbol, name: h.name, rank: h.rank, rankChange: h.rankChange })),
    news: (news?.items ?? [])
      .slice()
      .sort((a, b) => Number(b.policyCandidate) - Number(a.policyCandidate))
      .slice(0, CAPS.news)
      .map((i) => ({ title: i.title.slice(0, 80), policy: i.policyCandidate })),
    prev_themes: prevAnalysisRaw,
    candidates,
  };

  let json = JSON.stringify(payload);
  let truncated = false;
  if (Buffer.byteLength(json, 'utf8') > HARD_LIMIT_BYTES) {
    // 超限：砍 news / sectors / broken 等次要區塊
    payload.news = payload.news.slice(0, 30);
    payload.broken = payload.broken.slice(0, 15);
    payload.zt_pool = payload.zt_pool.slice(0, 80);
    payload.meta.truncated = true;
    truncated = true;
    json = JSON.stringify(payload);
  }

  await fs.mkdir(questionDir(), { recursive: true });
  const p = questionPath(date);
  await fs.writeFile(p, json, 'utf8');
  return { path: p, bytes: Buffer.byteLength(json, 'utf8'), truncated, candidateCount: candidates.length };
}

/** 前一交易日的 analysis themes 壓縮摘要（題材延續性判斷用） */
async function readPrevAnalysis(date: string): Promise<Array<{ id: string; name: string; stage: string }> | null> {
  const index = await readBreadthIndex();
  const prevDate = (index?.days ?? []).map((d) => d.date).filter((d) => d < date).pop();
  if (!prevDate) return null;
  const a = await readAnalysis(prevDate);
  if (!a) return null;
  return a.themes.slice(0, 15).map((t) => ({ id: t.id, name: t.name, stage: t.stage }));
}
