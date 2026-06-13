/**
 * 陸股 AI 選股 Agent — 盤後 EOD pipeline（P1 四步驟編排層）
 *
 * 職責：把 datasource（漲停池/寬度/板塊/人氣榜）→ 純函式組裝（breadth.ts/cycle.ts）
 * → 持久化（storage.ts）串成一條盤後流水線。本檔只做「編排 + 跨日 join + IO」，
 * 不放任何計算邏輯 — 計算一律在純函式層，確保可回測重放。
 *
 * 四步驟（每步獨立 try/catch，一步掛不擋後面；結果集進 CnAgentsStepHealth[]）：
 *   1. pools        — 三池 + 昨日漲停表現 + 全市場概況 → LimitUpPoolDay 落地
 *   2. breadth-cycle — pool → MarketBreadthDay → 情緒週期狀態機 → BreadthDayFile + index
 *   3. boards       — 行業/概念板塊快照 + 漲停池 industry join + pct5d 跨日自算
 *   4. hotness      — 東財人氣榜 top100 + 昨日檔 join（rankYesterday/daysInTop100）
 *
 * 「即時 vs 歷史日」分流（isLive = date === getLastTradingDay('CN')）：
 *   EM clist 板塊 / 人氣榜 / 全市場家數快照都是「當下即時」端點，沒有歷史 date 參數 —
 *   歷史日回補時硬抓會把「今天的快照」mislabel 成歷史日期（本 repo 鐵則級禁忌，
 *   同 ETF disclosureDate 教訓）。故歷史日：
 *     - overview → upCount/downCount/flatCount 全 0 + note degraded（漲停池統計仍完整）
 *     - 昨炸板股今日報價 → 跳過填 null（騰訊即時報價無歷史模式）
 *     - boards / hotness → 整步 skip（ok=true + note，不算失敗）
 *   用 getLastTradingDay 而非「日曆今天」比對：跨夜補跑（00:xx）時 EM 快照仍是
 *   最後收盤日的數據，歸屬 getLastTradingDay 才正確。
 *
 * 跨日 join 鐵則：昨日檔一律取「前一交易日」單日，檔缺就 null/缺欄 —
 * 不可往前多走一天硬湊（隔兩天的晉級率/排名變化語意是錯的）。
 *
 * ⚠️ 陷阱備忘：
 *   - getTencentRealtime 的 parseTencentLine 只保留主板代碼（00[0-3]/60[0135]），
 *     昨炸板名單裡的創業板(30x)/科創板(68x)股拿不到報價 → 自然被
 *     computeBrokenAvgPctFromQuotes 跳過，樣本縮小但不污染（缺資料 ≠ 0）。
 *   - fetchEastMoneyStockList 的清單不含 ST/創業板/科創板 → 人氣榜名稱補不到時
 *     退昨日檔的 name，再缺就 null（前端顯示代號即可，不可編造）。
 *   - upsertBreadthIndex 是 read-merge-write 無鎖（見 storage.ts 檔頭）—
 *     本 pipeline 必須由單一序列化 cron 呼叫，不可多路並行。
 *   - 同日重跑 idempotent：所有 save* 都是覆寫；盤後資料只會更新得更完整。
 */

import type {
  BoardEntry,
  BoardsDay,
  CnAgentsDataSource,
  CnAgentsStepHealth,
  EmotionCycleDay,
  HotRankEntry,
  LimitUpPoolDay,
  MarketOverview,
} from './types';
import { CN_AGENTS_SCHEMA_VERSION, CYCLE_RULES_VERSION } from './types';
import { buildLimitUpPoolDay, buildMarketBreadthDay, computeBrokenAvgPctFromQuotes } from './breadth';
import { deriveCycleDay } from './cycle';
import {
  readBoardsDay,
  readBreadthIndex,
  readHotnessDay,
  readLimitUpPoolDay,
  saveBoardsDay,
  saveBreadthDay,
  saveCnAgentsHealth,
  saveHotnessDay,
  saveLimitUpPoolDay,
  upsertBreadthIndex,
} from './storage';
import { fetchPools, fetchYesterdayPoolPerformance } from './datasource/emLimitUpPool';
import { fetchMarketOverview } from './datasource/cnMarketBreadth';
import { fetchBoardSnapshot } from './datasource/emBoards';
import { fetchEmHotRankTop100 } from './datasource/emHotRank';
import { getTencentRealtime } from '@/lib/datasource/TencentRealtime';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { fetchEastMoneyStockList } from '@/lib/scanner/eastMoneyApi';

/** 步驟間節流（EM 對突發連發限流，沿用 datasource 層 250ms 慣例） */
const STEP_GAP_MS = 250;
/** 往回找前一交易日的日曆日安全上限（長假 + 假日曆缺漏餘裕） */
const PREV_DAY_SEARCH_LIMIT = 15;
/** turnoverRatio5d 需要 4 個前置交易日的成交額（buildMarketBreadthDay 內門檻） */
const TURNOVER_HISTORY_DAYS = 4;
/** pct5d = 今日 + 前 4 個交易日板塊檔 */
const PCT5D_PRIOR_DAYS = 4;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ── 交易日工具（CN；isTradingDay 無 CN 假日曆時退化為跳週末，與全 repo 一致）──

/** date 的前一交易日；往回走 PREV_DAY_SEARCH_LIMIT 個日曆日都不是交易日 → null */
function prevTradingDay(date: string): string | null {
  const d = new Date(`${date}T12:00:00`); // 正午錨點避開 DST/時區邊界
  for (let i = 0; i < PREV_DAY_SEARCH_LIMIT; i++) {
    d.setDate(d.getDate() - 1);
    const s = d.toISOString().slice(0, 10);
    if (isTradingDay(s, 'CN')) return s;
  }
  return null;
}

/** date 之前最近 n 個交易日（新→舊） */
function prevTradingDays(date: string, n: number): string[] {
  const out: string[] = [];
  let cur: string | null = date;
  for (let i = 0; i < n; i++) {
    cur = prevTradingDay(cur);
    if (!cur) break;
    out.push(cur);
  }
  return out;
}

// ── Step 1：漲停池 ────────────────────────────────────────────────────────────

async function runPoolsStep(
  date: string,
  isLive: boolean,
): Promise<{ health: CnAgentsStepHealth; poolDay: LimitUpPoolDay | null }> {
  const notes: string[] = [];
  try {
    const pools = await fetchPools(date);

    // 昨日漲停股今日平均（接力賺錢效應）— 獨立 catch：yzt 池掛不犧牲整個 pools step
    let yesterdayLimitUpAvgPct: number | null = null;
    try {
      await sleep(STEP_GAP_MS);
      const perf = await fetchYesterdayPoolPerformance(date);
      yesterdayLimitUpAvgPct = perf.avgPct;
      if (perf.source === 'akshare') notes.push('昨日漲停池走 akshare 備援');
    } catch (err) {
      notes.push(`昨日漲停表現抓取失敗（${errMsg(err)}），yesterdayLimitUpAvgPct=null`);
    }

    // 全市場概況 — 即時端點，僅 isLive 可抓；歷史日填 0 並標 degraded（見檔頭）
    let overview: MarketOverview;
    if (isLive) {
      try {
        const r = await fetchMarketOverview();
        overview = r.overview;
        if (r.source === 'em-push2ex' && overview.upCount + overview.downCount === 0) {
          notes.push('漲跌家數退化全 0（akshare 掛，只剩 EM 量能）');
        }
      } catch (err) {
        overview = { upCount: 0, downCount: 0, flatCount: 0, turnoverShSzCny: null, shIndexPct: null };
        notes.push(`全市場概況兩源全掛（${errMsg(err)}），家數/量能 degraded`);
      }
    } else {
      overview = { upCount: 0, downCount: 0, flatCount: 0, turnoverShSzCny: null, shIndexPct: null };
      notes.push('歷史日回補：無當日家數/量能快照，upCount/downCount=0（degraded）');
    }

    // 昨日 pool 檔（晉級率 + 昨炸板名單）— 嚴格取前一交易日，檔缺 → null
    const yDate = prevTradingDay(date);
    const yesterdayPool = yDate ? await readLimitUpPoolDay(yDate) : null;
    if (!yesterdayPool) notes.push(`昨日 pool 檔缺（${yDate ?? '無前一交易日'}），晉級率/虧錢效應=null`);

    // 昨炸板股今日平均（虧錢效應）— 騰訊即時報價，僅 isLive；主板外名單拿不到報價（見檔頭）
    let yesterdayBrokenAvgPct: number | null = null;
    if (isLive && yesterdayPool && yesterdayPool.broken.length > 0) {
      try {
        const quotes = await getTencentRealtime(yesterdayPool.broken.map((b) => b.symbol));
        const pctBySymbol = new Map<string, number>();
        for (const [code, q] of quotes) {
          if (q.prevClose != null && q.prevClose > 0) {
            pctBySymbol.set(code, ((q.close - q.prevClose) / q.prevClose) * 100);
          }
        }
        yesterdayBrokenAvgPct = computeBrokenAvgPctFromQuotes(yesterdayPool.broken, pctBySymbol);
      } catch (err) {
        notes.push(`昨炸板股報價抓取失敗（${errMsg(err)}），yesterdayBrokenAvgPct=null`);
      }
    }

    const poolDay = buildLimitUpPoolDay({
      date,
      fetchedAt: new Date().toISOString(),
      source: pools.source,
      limitUp: pools.limitUp,
      broken: pools.broken,
      limitDown: pools.limitDown,
      breadth: overview,
      yesterdayPool,
      yesterdayLimitUpAvgPct,
      yesterdayBrokenAvgPct,
    });
    await saveLimitUpPoolDay(poolDay); // 退化資料守門在 storage 層，守門 throw → 本步 fail

    return {
      health: {
        step: 'pools',
        ok: true,
        source: pools.source,
        note: notes.length > 0 ? notes.join('；') : undefined,
        finishedAt: new Date().toISOString(),
      },
      poolDay,
    };
  } catch (err) {
    // 抓取/守門失敗：嘗試讀既存當日檔（先前成功跑過的話），讓後續步驟仍可用
    const existing = await readLimitUpPoolDay(date).catch(() => null);
    return {
      health: {
        step: 'pools',
        ok: false,
        note: existing ? '抓取失敗但既存當日 pool 檔可用，後續步驟沿用' : undefined,
        error: errMsg(err),
        finishedAt: new Date().toISOString(),
      },
      poolDay: existing,
    };
  }
}

// ── Step 2：寬度 + 情緒週期 ───────────────────────────────────────────────────

async function runBreadthCycleStep(
  date: string,
  poolDay: LimitUpPoolDay | null,
): Promise<{ health: CnAgentsStepHealth; cycle: EmotionCycleDay | null }> {
  if (!poolDay) {
    return {
      health: {
        step: 'breadth-cycle',
        ok: false,
        error: 'pools step 失敗且無既存當日 pool 檔，寬度/情緒週期跳過',
        finishedAt: new Date().toISOString(),
      },
      cycle: null,
    };
  }
  try {
    // 近 5 日成交額（不含今日）：嚴格按前置交易日讀 pool 檔，檔缺 → turnover=null
    // （buildMarketBreadthDay 需 ≥4 筆有效值才算 turnoverRatio5d，缺料自然回 null）
    const turnoverHistory: Array<{ date: string; turnover: number | null }> = [];
    for (const d of prevTradingDays(date, TURNOVER_HISTORY_DAYS)) {
      const p = await readLimitUpPoolDay(d);
      turnoverHistory.push({ date: d, turnover: p?.breadth.turnoverShSzCny ?? null });
    }
    const breadthDay = buildMarketBreadthDay({ pool: poolDay, turnoverHistory });

    // 狀態機歷史 + prev：一律從 breadth index 取（單一序列來源，回補時間序也正確）
    const index = await readBreadthIndex();
    const pastDays = (index?.days ?? []).filter((d) => d.date < date); // index 本身升冪
    const prev = pastDays.length > 0 ? pastDays[pastDays.length - 1] : null;
    const cycle = deriveCycleDay(
      breadthDay,
      pastDays.map((d) => d.breadth),
      prev?.cycle.stage ?? null,
      prev?.cycle.emotionScore ?? null,
      prev?.cycle.rawStage ?? null, // 「連續 2 日同 raw」逃生門需要前一日 raw 判定
    );

    await saveBreadthDay({
      schemaVersion: CN_AGENTS_SCHEMA_VERSION,
      date,
      generatedAt: new Date().toISOString(),
      cycleRulesVersion: CYCLE_RULES_VERSION,
      breadth: breadthDay,
      cycle,
    });
    await upsertBreadthIndex({ date, breadth: breadthDay, cycle });

    return {
      health: {
        step: 'breadth-cycle',
        ok: true,
        note: `stage=${cycle.stage} score=${cycle.emotionScore}${prev ? '' : '（index 無前日，冷啟動首日）'}`,
        finishedAt: new Date().toISOString(),
      },
      cycle,
    };
  } catch (err) {
    return {
      health: { step: 'breadth-cycle', ok: false, error: errMsg(err), finishedAt: new Date().toISOString() },
      cycle: null,
    };
  }
}

// ── Step 3：板塊快照 ──────────────────────────────────────────────────────────

/** pct5d = 今日 + 前 4 交易日複利累計 %（任一日缺該板塊 → null，不可拿不足天數硬算） */
function fillPct5d(entries: BoardEntry[], priorPctByCode: Array<Map<string, number>>): void {
  for (const e of entries) {
    if (priorPctByCode.length < PCT5D_PRIOR_DAYS) continue; // 留 null
    const pcts: number[] = [e.pct];
    for (const dayMap of priorPctByCode) {
      const p = dayMap.get(e.code);
      if (p === undefined) {
        pcts.length = 0;
        break;
      }
      pcts.push(p);
    }
    if (pcts.length === PCT5D_PRIOR_DAYS + 1) {
      const cum = (pcts.reduce((acc, p) => acc * (1 + p / 100), 1) - 1) * 100;
      e.pct5d = Math.round(cum * 100) / 100;
    }
  }
}

async function runBoardsStep(
  date: string,
  isLive: boolean,
  poolDay: LimitUpPoolDay | null,
): Promise<CnAgentsStepHealth> {
  if (!isLive) {
    // 刻意 skip 而非硬抓：EM clist 是即時端點，歷史日抓到的是「今天」的板塊（mislabel）
    return {
      step: 'boards',
      ok: true,
      note: 'skipped：歷史日回補無當日板塊快照（EM clist 僅即時，硬抓會 mislabel）',
      finishedAt: new Date().toISOString(),
    };
  }
  try {
    const ind = await fetchBoardSnapshot('industry');
    await sleep(STEP_GAP_MS);
    const con = await fetchBoardSnapshot('concept');
    const notes: string[] = [];

    // 行業 limitUpCount：join 當日漲停池 industry（EM 池 hybk 與行業板塊同名系）
    // 概念版 P2 前維持 null（datasource 已填）；pool 缺 → 行業也留 null（缺資料 ≠ 0）
    if (poolDay) {
      const counts = new Map<string, number>();
      for (const e of poolDay.limitUp) {
        if (e.industry) counts.set(e.industry, (counts.get(e.industry) ?? 0) + 1);
      }
      for (const b of ind.entries) b.limitUpCount = counts.get(b.name) ?? 0;
    } else {
      notes.push('當日 pool 缺，行業 limitUpCount 維持 null');
    }

    // pct5d：讀前 4 交易日 boards 檔（行業/概念混建 code→pct map，BK 代碼全域唯一）
    const priorPctByCode: Array<Map<string, number>> = [];
    for (const d of prevTradingDays(date, PCT5D_PRIOR_DAYS)) {
      const f: BoardsDay | null = await readBoardsDay(d);
      if (!f) break; // 連續性斷掉就不湊（pct5d 留 null）
      const m = new Map<string, number>();
      for (const e of [...f.industries, ...f.concepts]) m.set(e.code, e.pct);
      priorPctByCode.push(m);
    }
    if (priorPctByCode.length < PCT5D_PRIOR_DAYS) {
      notes.push(`前置 boards 檔僅 ${priorPctByCode.length}/${PCT5D_PRIOR_DAYS} 日，pct5d=null`);
    }
    fillPct5d(ind.entries, priorPctByCode);
    fillPct5d(con.entries, priorPctByCode);

    const source: CnAgentsDataSource =
      ind.source === 'akshare' || con.source === 'akshare' ? 'akshare' : 'em-push2ex';
    await saveBoardsDay({
      schemaVersion: CN_AGENTS_SCHEMA_VERSION,
      date,
      fetchedAt: new Date().toISOString(),
      source,
      industries: ind.entries,
      concepts: con.entries,
    });

    return {
      step: 'boards',
      ok: true,
      source,
      note: notes.length > 0 ? notes.join('；') : undefined,
      finishedAt: new Date().toISOString(),
    };
  } catch (err) {
    return { step: 'boards', ok: false, error: errMsg(err), finishedAt: new Date().toISOString() };
  }
}

// ── Step 4：人氣熱度 ──────────────────────────────────────────────────────────

async function runHotnessStep(date: string, isLive: boolean): Promise<CnAgentsStepHealth> {
  if (!isLive) {
    return {
      step: 'hotness',
      ok: true,
      note: 'skipped：歷史日回補無當日人氣榜（EM emappdata 僅即時，硬抓會 mislabel）',
      finishedAt: new Date().toISOString(),
    };
  }
  try {
    const { entries, source } = await fetchEmHotRankTop100();

    // 名稱補齊：EM 股票清單（7 天快取；不含 ST/創業/科創）→ 昨日檔 name → null
    const nameBySymbol = new Map<string, string>();
    try {
      for (const s of await fetchEastMoneyStockList()) {
        nameBySymbol.set(s.symbol.split('.')[0], s.name);
      }
    } catch {
      /* 名稱清單掛 → 全退昨日檔/null，不擋主流程 */
    }

    // 昨日檔 join（嚴格前一交易日；檔缺 → rankYesterday=null、daysInTop100 從 1 重計）
    const yDate = prevTradingDay(date);
    const yHot = yDate ? await readHotnessDay(yDate) : null;
    const yBySymbol = new Map((yHot?.emRank ?? []).map((e) => [e.symbol, e]));

    const emRank: HotRankEntry[] = entries.map(({ symbol, rank }) => {
      const y = yBySymbol.get(symbol);
      return {
        symbol,
        name: nameBySymbol.get(symbol) ?? y?.name ?? null,
        rank,
        rankYesterday: y?.rank ?? null,
        // 正 = 上升（昨 50 → 今 10 = +40），與 types.ts 註解對齊
        rankChange: y ? y.rank - rank : null,
        daysInTop100: (y?.daysInTop100 ?? 0) + 1,
      };
    });

    await saveHotnessDay({
      schemaVersion: CN_AGENTS_SCHEMA_VERSION,
      date,
      fetchedAt: new Date().toISOString(),
      source,
      emRank,
    });

    return {
      step: 'hotness',
      ok: true,
      source,
      note: yHot ? undefined : `昨日 hotness 檔缺（${yDate ?? '無前一交易日'}），rankYesterday=null、daysInTop100 重計`,
      finishedAt: new Date().toISOString(),
    };
  } catch (err) {
    return { step: 'hotness', ok: false, error: errMsg(err), finishedAt: new Date().toISOString() };
  }
}

// ── Pipeline 入口 ─────────────────────────────────────────────────────────────

/**
 * 盤後 EOD 主流程。date 預設最後交易日（CN，15:00 收盤後即當日）；
 * 同日重跑 idempotent（全部覆寫）。force 目前由 route 層用於跳過交易日檢查，
 * pipeline 本身不分流（保留參數位供未來步驟級跳過用）。
 *
 * 回傳 steps = 四步驟健康紀錄（同步寫進 data/cn-agents/_health/{date}.json），
 * cycle = 當日情緒週期判定（breadth-cycle 步失敗 → null）。
 */
export async function runCnAgentsEod(opts: {
  date?: string;
  force?: boolean;
}): Promise<{ date: string; steps: CnAgentsStepHealth[]; cycle: EmotionCycleDay | null }> {
  const date = opts.date ?? getLastTradingDay('CN');
  // 即時快照（家數/騰訊報價/板塊/人氣榜）只在「date = 最後收盤日」時可信（見檔頭）
  const isLive = date === getLastTradingDay('CN');
  const steps: CnAgentsStepHealth[] = [];

  const pools = await runPoolsStep(date, isLive);
  steps.push(pools.health);

  const breadthCycle = await runBreadthCycleStep(date, pools.poolDay);
  steps.push(breadthCycle.health);

  await sleep(STEP_GAP_MS);
  steps.push(await runBoardsStep(date, isLive, pools.poolDay));

  await sleep(STEP_GAP_MS);
  steps.push(await runHotnessStep(date, isLive));

  // 健康紀錄落地失敗不可吞掉整輪結果（steps 已在手上，照樣回給 caller）
  try {
    await saveCnAgentsHealth({ schemaVersion: CN_AGENTS_SCHEMA_VERSION, date, steps });
  } catch (err) {
    console.error(`[cn-agents] ${date} 健康紀錄寫入失敗：${errMsg(err)}`);
  }

  return { date, steps, cycle: breadthCycle.cycle };
}
