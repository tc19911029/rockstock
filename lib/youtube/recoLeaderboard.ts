/**
 * 老師/節目排行榜聚合 — pure，無 I/O。重用 unifiedLeaderboard 的 selStats。
 *
 * 統計口徑：
 *   - 老師表只收 teacher_kind='person'；節目表收全部（含 program_fallback），
 *     且按 (stock_code, date) 去重避免同節目多老師重複計。
 *   - 主統計樣本 = cohort='scored' 且 baseline='filled' 且非 conflict
 *   - 偏空 cohort 另計（win 定義 = 報酬 < 0），目前只回 bearish_events 數，
 *     細統計待樣本累積（23 天偏空樣本太少）。
 */

import { selStats } from '@/lib/backtest/unifiedLeaderboard';
import type {
  ExtremeEvent, ProgramRow, RecoEventWithReturns, RecoHorizon, RecoHorizonStats, StockAggRow, TeacherRow,
} from './recoTypes';
import { RECO_HORIZONS } from './recoTypes';

const round2 = (x: number): number => +x.toFixed(2);

function horizonStats(events: RecoEventWithReturns[], h: RecoHorizon): RecoHorizonStats {
  const base = selStats(events.map(e => e.returns?.[h]));
  const ex = events
    .map(e => e.returns?.excess?.[h])
    .filter((x): x is number => x != null && Number.isFinite(x));
  return {
    ...base,
    excessAvgPct: ex.length > 0 ? round2(ex.reduce((a, b) => a + b, 0) / ex.length) : null,
  };
}

/** D20 賺賠比 = avg(贏家) / |avg(輸家)|；樣本 <3 或無輸家 → null */
function payoffRatioD20(events: RecoEventWithReturns[]): number | null {
  const vals = events
    .map(e => e.returns?.d20)
    .filter((x): x is number => x != null && Number.isFinite(x));
  if (vals.length < 3) return null;
  const wins = vals.filter(v => v > 0);
  const losses = vals.filter(v => v < 0);
  if (wins.length === 0 || losses.length === 0) return null;
  const avgWin = wins.reduce((a, b) => a + b, 0) / wins.length;
  const avgLoss = losses.reduce((a, b) => a + b, 0) / losses.length;
  return round2(avgWin / Math.abs(avgLoss));
}

/** 挑最佳 / 最雷一檔：D20 為準，資料太新（全部 D20 未到期）時退 D5。 */
function extremePick(events: RecoEventWithReturns[], dir: 'best' | 'worst'): TeacherRow['bestPick'] {
  const metric = (e: RecoEventWithReturns): number | null => e.returns?.d20 ?? null;
  const fallback = (e: RecoEventWithReturns): number | null => e.returns?.d5 ?? null;
  const useFallback = !events.some(e => metric(e) != null);
  const valOf = useFallback ? fallback : metric;
  let pick: RecoEventWithReturns | null = null;
  let pickVal = dir === 'best' ? -Infinity : Infinity;
  for (const e of events) {
    const v = valOf(e);
    if (v == null) continue;
    if (dir === 'best' ? v > pickVal : v < pickVal) { pick = e; pickVal = v; }
  }
  if (!pick) return null;
  return {
    date: pick.date,
    stock_code: pick.stock_code,
    stock_name: pick.stock_name,
    d20: pick.returns?.d20 ?? null,
    d5: pick.returns?.d5 ?? null,
  };
}

function avgOf(values: Array<number | null | undefined>): number | null {
  const v = values.filter((x): x is number => x != null && Number.isFinite(x));
  return v.length > 0 ? round2(v.reduce((a, b) => a + b, 0) / v.length) : null;
}

/** 進主統計的 scored 樣本（filled + 非 conflict） */
function scoredOf(events: RecoEventWithReturns[]): RecoEventWithReturns[] {
  return events.filter(
    e => e.cohort === 'scored' && !e.conflict && e.baseline.status === 'filled',
  );
}

function buildStatBlock(all: RecoEventWithReturns[]) {
  const scored = scoredOf(all);
  const byHorizon = {} as Record<RecoHorizon, RecoHorizonStats>;
  for (const h of RECO_HORIZONS) byHorizon[h] = horizonStats(scored, h);
  return {
    scored,
    byHorizon,
    payoffRatio: payoffRatioD20(scored),
    bestPick: extremePick(scored, 'best'),
    worstPick: extremePick(scored, 'worst'),
    unfillable: all.filter(e => e.baseline.status === 'no_fill').length,
    no_data: all.filter(e => e.baseline.status === 'no_data').length,
    open_events: scored.filter(e => e.returns?.isOpen).length,
  };
}

/** source_id → display_name 的解析函式（API 層注入 sources registry） */
export type DisplayNameResolver = (sourceId: string) => string;

export function buildTeacherRows(
  events: RecoEventWithReturns[],
  resolveDisplayName: DisplayNameResolver,
  recentN = 5,
): TeacherRow[] {
  const byTeacher = new Map<string, RecoEventWithReturns[]>();
  for (const e of events) {
    if (e.teacher_kind !== 'person') continue;
    const arr = byTeacher.get(e.teacher) ?? [];
    arr.push(e);
    byTeacher.set(e.teacher, arr);
  }

  const rows: TeacherRow[] = [];
  for (const [teacher, evs] of byTeacher) {
    const block = buildStatBlock(evs);
    const programIds = [...new Set(evs.flatMap(e => e.videos.map(v => v.source_id)))];
    rows.push({
      teacher,
      programs: programIds.map(id => ({ source_id: id, display_name: resolveDisplayName(id) })),
      total_events: evs.length,
      scored_events: block.scored.length,
      watch_events: evs.filter(e => e.cohort === 'watch').length,
      bearish_events: evs.filter(e => e.cohort === 'bearish').length,
      unfillable: block.unfillable,
      no_data: block.no_data,
      open_events: block.open_events,
      byHorizon: block.byHorizon,
      payoffRatio: block.payoffRatio,
      mfeAvgPct: avgOf(block.scored.map(e => e.returns?.mfe)),
      maeAvgPct: avgOf(block.scored.map(e => e.returns?.mae)),
      bestPick: block.bestPick,
      worstPick: block.worstPick,
      recentEvents: [...evs]
        .sort((a, b) => b.date.localeCompare(a.date) || a.stock_code.localeCompare(b.stock_code))
        .slice(0, recentN),
    });
  }

  // 預設排序：scored 樣本數 → D20 平均
  return rows.sort(
    (a, b) => b.scored_events - a.scored_events
      || (b.byHorizon.d20.avgPct - a.byHorizon.d20.avgPct),
  );
}

/** 題材查詢函式（route 注入 themeMap.themesOf，保持本檔 pure 可測） */
export type ThemesResolver = (stockCode: string) => string[];

/**
 * 按股票聚合（scored+filled 事件）→ StockAggRow[]。
 * 共識股 / 最多節目提到 / 共識地雷股 都用這份，只是排序/篩選不同（由 route 決定）。
 */
export function buildStockAggRows(
  events: RecoEventWithReturns[],
  resolveDisplayName: DisplayNameResolver,
  resolveThemes: ThemesResolver,
): StockAggRow[] {
  const byStock = new Map<string, RecoEventWithReturns[]>();
  for (const e of scoredOf(events)) {
    const arr = byStock.get(e.stock_code) ?? [];
    arr.push(e);
    byStock.set(e.stock_code, arr);
  }
  const rows: StockAggRow[] = [];
  for (const [code, evs] of byStock) {
    const teachers = [...new Set(evs.filter(e => e.teacher_kind === 'person').map(e => e.teacher))];
    const programs = [...new Set(evs.flatMap(e => e.videos.map(v => v.source_id)))];
    const dates = evs.map(e => e.date).sort();
    const byHorizon = {} as Record<RecoHorizon, RecoHorizonStats>;
    for (const h of RECO_HORIZONS) byHorizon[h] = horizonStats(evs, h);
    rows.push({
      stock_code: code,
      stock_name: evs[0].stock_name,
      teacherCount: teachers.length,
      programCount: programs.length,
      totalMentions: evs.length,
      teachers,
      programs: programs.map(resolveDisplayName),
      firstDate: dates[0],
      lastDate: dates[dates.length - 1],
      themes: resolveThemes(code),
      byHorizon,
      mfeAvgPct: avgOf(evs.map(e => e.returns?.mfe)),
      maeAvgPct: avgOf(evs.map(e => e.returns?.mae)),
      avgHold: avgOf(evs.map(e => e.returns?.holdReturn)),
    });
  }
  return rows;
}

/** 每個橫斷取「漲最多」或「跌最多」的前 topN 筆事件 */
export function buildExtremes(
  events: RecoEventWithReturns[],
  resolveDisplayName: DisplayNameResolver,
  resolveThemes: ThemesResolver,
  dir: 'gain' | 'loss',
  topN = 5,
): Record<RecoHorizon, ExtremeEvent[]> {
  const out = {} as Record<RecoHorizon, ExtremeEvent[]>;
  const scored = scoredOf(events);
  for (const h of RECO_HORIZONS) {
    const cands = scored
      .map(e => ({ e, ret: e.returns?.[h] ?? null }))
      .filter((x): x is { e: RecoEventWithReturns; ret: number } => x.ret != null)
      .sort((a, b) => (dir === 'gain' ? b.ret - a.ret : a.ret - b.ret))
      .slice(0, topN);
    out[h] = cands.map(({ e, ret }) => ({
      horizon: h,
      stock_code: e.stock_code,
      stock_name: e.stock_name,
      teacher: e.teacher,
      programs: [...new Set(e.videos.map(v => resolveDisplayName(v.source_id)))],
      date: e.date,
      entry_open: e.baseline.entry_open,
      ret,
      themes: resolveThemes(e.stock_code),
    }));
  }
  return out;
}

export function buildProgramRows(
  events: RecoEventWithReturns[],
  resolveDisplayName: DisplayNameResolver,
): ProgramRow[] {
  // 先把事件展開到節目（一事件可能跨節目 — 取 videos 的 source_id union），
  // 同節目內按 (stock_code, date) 去重（兩位老師同日同股只算一次）
  const byProgram = new Map<string, Map<string, RecoEventWithReturns>>();
  // 講師名單從「去重前」全部事件 union（去重後同股同日只剩一位老師，名單會漏人）
  const teachersByProgram = new Map<string, Set<string>>();
  for (const e of events) {
    const sourceIds = [...new Set(e.videos.map(v => v.source_id))];
    for (const sid of sourceIds) {
      let m = byProgram.get(sid);
      if (!m) { m = new Map(); byProgram.set(sid, m); }
      if (e.teacher_kind === 'person') {
        let ts = teachersByProgram.get(sid);
        if (!ts) { ts = new Set(); teachersByProgram.set(sid, ts); }
        ts.add(e.teacher);
      }
      const key = `${e.date}:${e.stock_code}`;
      const prev = m.get(key);
      // 同 (date, stock) 多老師 → 保留 person 優先（資訊較完整），其次先到先得
      if (!prev || (prev.teacher_kind === 'program_fallback' && e.teacher_kind === 'person')) {
        m.set(key, e);
      }
    }
  }

  const rows: ProgramRow[] = [];
  for (const [sourceId, m] of byProgram) {
    const evs = [...m.values()];
    const block = buildStatBlock(evs);
    rows.push({
      source_id: sourceId,
      display_name: resolveDisplayName(sourceId),
      teachers: [...(teachersByProgram.get(sourceId) ?? [])],
      total_events: evs.length,
      scored_events: block.scored.length,
      unfillable: block.unfillable,
      open_events: block.open_events,
      byHorizon: block.byHorizon,
      payoffRatio: block.payoffRatio,
      mfeAvgPct: avgOf(block.scored.map(e => e.returns?.mfe)),
      maeAvgPct: avgOf(block.scored.map(e => e.returns?.mae)),
      bestPick: block.bestPick,
      worstPick: block.worstPick,
    });
  }

  return rows.sort(
    (a, b) => b.scored_events - a.scored_events
      || (b.byHorizon.d20.avgPct - a.byHorizon.d20.avgPct),
  );
}
