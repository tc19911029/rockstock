/**
 * 陸股情緒週期八階段狀態機（P1 智力核心）
 *
 * 把「市場寬度日線」(MarketBreadthDay) 分類成八階段
 * （冰點→修復→啟動→主升→高潮→分歧→退潮→殺跌），純函式、零 IO，
 * 同輸入必同輸出 → 可逐日回放回測。
 *
 * 三層架構：
 *   1. emotionScore（0-100）— 固定錨點線性內插合成，刻意「不用」rolling 統計
 *      （rolling 會讓同一天的分數隨資料窗長度漂移，回測不可重現）。
 *      null 欄位一律取中性 50，不讓缺資料日被單邊拉爆。
 *   2. raw 階段 — predicate 優先序 crash → frozen → climax → main_rise →
 *      launch → divergence → repair → retreat → 兜底（維持 prev / 首日分數映射）。
 *      null 欄位一律視為「不滿足該子條件」（資料缺漏寧可保守不觸發）。
 *   3. hysteresis 轉移約束 — 合法轉移圖（LEGAL_TRANSITIONS）外的跳階，
 *      情緒分單日變動 ≥ hysteresis.scoreJumpMin 放行（千股漲停/跌停
 *      這種極端日分數必然劇變所以放得過）；或「連續 rawRepeatDays 日 raw 同判
 *      同一階段」也放行（市場結構已持續證明，非單日噪音）；否則維持 prev。
 *      crash 是每個階段的合法後繼 → 殺跌從任何階段可直入，永不被 hysteresis 擋。
 *
 * 📐 v2 校準（2026-06-12）：24 個月全量回填（2024-06-03 ~ 2026-06-12，492 交易日）
 *   驗出 v1 嚴重失準 — 殺跌 194 天(39.4%) 但其隔日接力報酬 1.92% 與修復 1.82% 無異
 *   （大量誤標）、啟動/冰點 0 天（launch 的 promotion1to2Min=0.5 幾乎永遠不可達：
 *   真實 p50=0.16/p90=0.29；frozen 的 yestAvgBelow=-2 在 p5=-1.35 之下不可達；
 *   maxHeightMax=2 在 p5=3 之下不可達）。v2 全部門檻改用真實分位數定錨：
 *   frozen（limitUpBelow 20→30、yestAvgBelow -2→0.5、maxHeightMax 2→4）、
 *   launch（promotion1to2Min 0.5→0.25 ≈ p80）、repair（limitUpMax 45→60 ≈ p50+）、
 *   retreat（yestAvgBelow -3→-0.5）；crash 第一條件加「跌停 > 漲停」支配條款
 *   （「跌停≥20 且 跌停>漲停」真實僅 18 天 3.7% vs 絕對門檻 65 天 — 恐慌的本質
 *   是跌停壓過漲停）；hysteresis 加「連續 2 日同 raw」逃生門（v1 crash 一觸發
 *   即被困住：合法後繼只有 frozen/repair，raw=climax/main_rise 非法且 Δ分<15
 *   → 永遠卡住，實例 2026-06-09 漲停 129 家 raw=climax 仍標殺跌）。
 *
 * ⚠️ 陷阱備忘：
 *   - 改 PHASE_PARAMS 任何數字必升 types.ts 的 CYCLE_RULES_VERSION，
 *     且 __tests__/contracts/cn-sentiment-phase-golden.test.ts 的凍結 snapshot 會紅
 *     （仿 lib/cn-sanse/params.ts 的凍結哲學：參數改動必須是有意識的）。
 *   - divergence / repair 是「prev-gated」predicate（依賴前一階段），自身無法
 *     連續自我維持；連續分歧/修復日靠「都不中 → 維持 prevStage」兜底，刻意設計。
 *   - climax 的「二板以上家數創近 10 日新高」在歷史不足時 vacuous true
 *     （冷啟動若同時 maxHeight ≥ 6 視為高潮 — 與其漏報寧可早報，文件級決議）。
 *   - history 參數 = today「之前」的序列（舊→新、不含 today）；deriveCycleDay
 *     內部有 date < today.date 防呆過濾，避免呼叫端誤塞 today 害「昨日炸板率」比到自己。
 *   - 本檔是自創因子（情緒週期），鏡像 lib/cn-sanse/ 隔離先例，
 *     完全不進台股書本選股鏈路（鐵則 #5 不受影響）。
 */

import type { MarketBreadthDay, EmotionCycleDay, EmotionStage, DailyTactic } from './types';
import { STAGE_LABELS, TACTIC_LABELS } from './types';

// ────────────────────────────────────────────────────────────────────────────
// 參數凍結區 — 所有魔術數字集中於此（改動必升 CYCLE_RULES_VERSION）
// ────────────────────────────────────────────────────────────────────────────

export const PHASE_PARAMS = {
  /** 第一層：emotionScore 固定錨點（anchors = [lo, mid, hi] → 0 / 50 / 100 線性內插） */
  score: {
    /** 缺值（null / 分母 0）一律取中性 50 */
    nullScore: 50,
    weights: {
      limitUp: 0.25,    // 漲停家數
      seal: 0.2,        // 封板品質 =（1 − 炸板率）×100
      yestReturn: 0.2,  // 昨日漲停今日平均（接力賺錢效應）
      promotion: 0.15,  // 一進二晉級率
      height: 0.1,      // 最高連板高度
      breadth: 0.1,     // 上漲家數佔比 up/(up+down)
    },
    limitUpAnchors: [10, 40, 100],
    yestReturnAnchors: [-5, 0, 5],
    heightAnchors: [1, 3, 6],
    upRatioAnchors: [0.3, 0.5, 0.8],
  },
  /** 第二層：raw 階段 predicate 門檻（判定順序見 classifyRawStage；v2 分位數定錨，見檔頭） */
  predicates: {
    crash:      { limitDownMin: 20, yestAvgBelow: -5 },
    frozen:     { limitUpBelow: 30, zhabanAbove: 0.40, yestAvgBelow: 0.5, maxHeightMax: 4 },
    climax:     { limitUpAbove: 110, maxHeightMin: 6, board2PlusNewHighLookback: 10 },
    mainRise:   { limitUpMin: 50, limitUpMax: 110, maxHeightMin: 4, promotionHighMin: 0.5, yestAvgMin: 3 },
    launch:     { limitUpMin: 40, promotion1to2Min: 0.25, maxHeightMin: 3, yestAvgAbove: 1 },
    divergence: { zhabanAbove: 0.3, yestAvgBelow: 0, limitUpMin: 40 },
    repair:     { limitUpMin: 20, limitUpMax: 60, yestAvgAbove: -1 },
    retreat:    { promotion1to2Below: 0.3, heightLookback: 5, heightDropMin: 2, yestAvgBelow: -0.5 },
  },
  /**
   * 第三層：hysteresis — 非法轉移的兩道放行條款：
   *   (1) 情緒分單日變動 ≥ scoreJumpMin（極端日劇變）
   *   (2) 連續 rawRepeatDays 日 raw 同判同一階段（市場結構持續證明，逃生門防卡死）
   */
  hysteresis: { scoreJumpMin: 15, rawRepeatDays: 2 },
  /** 首日無 prev 且 predicate 都不中 → 依情緒分分段映射（<25/<45/<65/<80/其餘） */
  noPrevScoreCuts: { frozen: 25, repair: 45, launch: 65, mainRise: 80 },
  /** 階段 → 策略/倉位映射 */
  playbook: {
    frozen:     { strategies: ['observe'],        positionPct: [0, 10] },
    repair:     { strategies: ['dixi'],           positionPct: [20, 30] },
    launch:     { strategies: ['daban', 'banlu'], positionPct: [40, 60] },
    main_rise:  { strategies: ['daban', 'banlu'], positionPct: [60, 80] },
    climax:     { strategies: ['banlu'],          positionPct: [40, 70] }, // 高潮：持有不加、卡位擇強
    divergence: { strategies: ['banlu', 'dixi'],  positionPct: [30, 40] },
    retreat:    { strategies: ['observe'],        positionPct: [0, 20] },
    crash:      { strategies: ['observe'],        positionPct: [0, 0] },
  },
} as const;

// 編譯期防呆：playbook 必須覆蓋全部 8 階段且策略字串 ∈ DailyTactic
const _playbookComplete: Record<
  EmotionStage,
  { strategies: readonly DailyTactic[]; positionPct: readonly [number, number] }
> = PHASE_PARAMS.playbook;
void _playbookComplete;

/** 合法轉移圖（含自環）；crash 是所有階段的合法後繼（殺跌可從任何階段直入） */
export const LEGAL_TRANSITIONS: Record<EmotionStage, readonly EmotionStage[]> = {
  frozen:     ['frozen', 'repair', 'crash'],
  repair:     ['repair', 'launch', 'frozen', 'crash'],
  launch:     ['launch', 'main_rise', 'divergence', 'retreat', 'crash'],
  main_rise:  ['main_rise', 'climax', 'divergence', 'crash'],
  climax:     ['climax', 'divergence', 'crash'],
  divergence: ['divergence', 'main_rise', 'retreat', 'crash'],
  retreat:    ['retreat', 'repair', 'frozen', 'crash'],
  crash:      ['crash', 'frozen', 'repair'],
};

// ────────────────────────────────────────────────────────────────────────────
// 第一層：emotionScore
// ────────────────────────────────────────────────────────────────────────────

type Anchor3 = readonly [number, number, number];

/** 三錨點線性內插：≤lo→0、mid→50、≥hi→100 */
function norm3(v: number, [lo, mid, hi]: Anchor3): number {
  if (v <= lo) return 0;
  if (v >= hi) return 100;
  if (v <= mid) return ((v - lo) / (mid - lo)) * 50;
  return 50 + ((v - mid) / (hi - mid)) * 50;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 0-100 連續情緒分（四捨五入到 0.1；null 欄位一律取中性 nullScore） */
export function computeEmotionScore(b: MarketBreadthDay): number {
  const P = PHASE_PARAMS.score;
  const sLimitUp = norm3(b.limitUpCount, P.limitUpAnchors);
  const sSeal = b.zhabanRate === null ? P.nullScore : clamp((1 - b.zhabanRate) * 100, 0, 100);
  const sYest =
    b.yestLimitUpAvgReturn === null ? P.nullScore : norm3(b.yestLimitUpAvgReturn, P.yestReturnAnchors);
  const sPromo =
    b.promotionRate1to2 === null ? P.nullScore : clamp(b.promotionRate1to2, 0, 1) * 100;
  const sHeight = norm3(b.maxBoardHeight, P.heightAnchors);
  const denom = b.upCount + b.downCount;
  const sBreadth = denom <= 0 ? P.nullScore : norm3(b.upCount / denom, P.upRatioAnchors);
  const w = P.weights;
  const total =
    w.limitUp * sLimitUp +
    w.seal * sSeal +
    w.yestReturn * sYest +
    w.promotion * sPromo +
    w.height * sHeight +
    w.breadth * sBreadth;
  return Math.round(total * 10) / 10;
}

// ────────────────────────────────────────────────────────────────────────────
// 第二層：raw 階段 predicate（優先序固定）
// ────────────────────────────────────────────────────────────────────────────

const fmtRate = (v: number) => `${Math.round(v * 100)}%`;
const fmtRateOrDash = (v: number | null) => (v === null ? '—' : fmtRate(v));
const fmtRet = (v: number) => `${v.toFixed(1)}%`;
const fmtRetOrDash = (v: number | null) => (v === null ? '—' : fmtRet(v));

/** 每日固定第一條 reason：當日寬度概況（不論判到哪一階段都附上） */
function summaryLine(b: MarketBreadthDay): string {
  return (
    `漲停 ${b.limitUpCount} 家、跌停 ${b.limitDownCount} 家、最高 ${b.maxBoardHeight} 板、` +
    `炸板率 ${fmtRateOrDash(b.zhabanRate)}、一進二晉級率 ${fmtRateOrDash(b.promotionRate1to2)}、` +
    `昨日漲停今日平均 ${fmtRetOrDash(b.yestLimitUpAvgReturn)}`
  );
}

/** 二板以上家數是否創「近 N 日」新高（窗含今日 → 與前 N−1 日嚴格比大；歷史不足 vacuous true） */
function isBoard2PlusNewHigh(b: MarketBreadthDay, history: MarketBreadthDay[]): boolean {
  const win = history.slice(-(PHASE_PARAMS.predicates.climax.board2PlusNewHighLookback - 1));
  return win.every((d) => b.board2PlusCount > d.board2PlusCount);
}

function classifyRawStage(
  b: MarketBreadthDay,
  history: MarketBreadthDay[],
  prevStage: EmotionStage | null,
  emotionScore: number,
): { stage: EmotionStage; reason: string } {
  const P = PHASE_PARAMS.predicates;
  const yest = b.yestLimitUpAvgReturn;
  const zb = b.zhabanRate;
  const prevDay = history.length > 0 ? history[history.length - 1] : null;

  // 1) 殺跌（最高優先：恐慌日其他訊號都不可信）
  //    v2 加支配條款：跌停還要「壓過」漲停才算恐慌 — 漲停百家的活躍日就算
  //    跌停 20+ 家也只是分化，不是殺跌（v1 缺此條款造成 39% 天數誤標）。
  if (b.limitDownCount >= P.crash.limitDownMin && b.limitDownCount > b.limitUpCount) {
    return {
      stage: 'crash',
      reason: `跌停 ${b.limitDownCount} 家 ≥ ${P.crash.limitDownMin} 家門檻，且壓過漲停 ${b.limitUpCount} 家，恐慌殺跌`,
    };
  }
  if (b.limitDownCount > b.limitUpCount && yest !== null && yest < P.crash.yestAvgBelow) {
    return {
      stage: 'crash',
      reason: `跌停 ${b.limitDownCount} 家多於漲停 ${b.limitUpCount} 家，且昨日漲停今日平均 ${fmtRet(yest)} 重挫，恐慌殺跌`,
    };
  }

  // 2) 冰點
  if (
    b.limitUpCount < P.frozen.limitUpBelow &&
    zb !== null && zb > P.frozen.zhabanAbove &&
    yest !== null && yest < P.frozen.yestAvgBelow &&
    b.maxBoardHeight <= P.frozen.maxHeightMax
  ) {
    return {
      stage: 'frozen',
      reason: `漲停僅 ${b.limitUpCount} 家、炸板率 ${fmtRate(zb)}、昨日漲停今日平均 ${fmtRet(yest)}、最高 ${b.maxBoardHeight} 板，情緒冰點`,
    };
  }

  // 3) 高潮
  if (b.limitUpCount > P.climax.limitUpAbove) {
    return {
      stage: 'climax',
      reason: `漲停 ${b.limitUpCount} 家 > ${P.climax.limitUpAbove} 家，情緒高潮`,
    };
  }
  if (b.maxBoardHeight >= P.climax.maxHeightMin && isBoard2PlusNewHigh(b, history)) {
    return {
      stage: 'climax',
      reason: `最高 ${b.maxBoardHeight} 板，且二板以上 ${b.board2PlusCount} 家創近 ${P.climax.board2PlusNewHighLookback} 日新高，情緒高潮`,
    };
  }

  // 4) 主升
  if (
    b.limitUpCount >= P.mainRise.limitUpMin &&
    b.limitUpCount <= P.mainRise.limitUpMax &&
    b.maxBoardHeight >= P.mainRise.maxHeightMin &&
    b.promotionRateHigh !== null && b.promotionRateHigh >= P.mainRise.promotionHighMin &&
    yest !== null && yest >= P.mainRise.yestAvgMin
  ) {
    return {
      stage: 'main_rise',
      reason: `漲停 ${b.limitUpCount} 家、最高 ${b.maxBoardHeight} 板、高位晉級率 ${fmtRate(b.promotionRateHigh)}、昨日漲停今日平均 ${fmtRet(yest)}，主升加速`,
    };
  }

  // 5) 啟動
  if (
    b.limitUpCount >= P.launch.limitUpMin &&
    b.promotionRate1to2 !== null && b.promotionRate1to2 >= P.launch.promotion1to2Min &&
    b.maxBoardHeight >= P.launch.maxHeightMin &&
    yest !== null && yest > P.launch.yestAvgAbove
  ) {
    return {
      stage: 'launch',
      reason: `漲停 ${b.limitUpCount} 家、一進二晉級率 ${fmtRate(b.promotionRate1to2)}、最高 ${b.maxBoardHeight} 板，行情啟動`,
    };
  }

  // 6) 分歧（prev-gated：只接在主升/高潮之後）
  if (
    (prevStage === 'main_rise' || prevStage === 'climax') &&
    zb !== null && zb > P.divergence.zhabanAbove &&
    yest !== null && yest < P.divergence.yestAvgBelow &&
    b.limitUpCount >= P.divergence.limitUpMin
  ) {
    return {
      stage: 'divergence',
      reason: `高位後炸板率升至 ${fmtRate(zb)}、昨日漲停今日平均 ${fmtRet(yest)} 轉負、漲停仍有 ${b.limitUpCount} 家，多空分歧`,
    };
  }

  // 7) 修復（prev-gated：只接在冰點/殺跌/退潮之後，且炸板率較昨日收斂）
  if (
    (prevStage === 'frozen' || prevStage === 'crash' || prevStage === 'retreat') &&
    b.limitUpCount >= P.repair.limitUpMin &&
    b.limitUpCount <= P.repair.limitUpMax &&
    zb !== null && prevDay !== null && prevDay.zhabanRate !== null && zb < prevDay.zhabanRate &&
    yest !== null && yest > P.repair.yestAvgAbove
  ) {
    return {
      stage: 'repair',
      reason: `漲停回到 ${b.limitUpCount} 家、炸板率 ${fmtRate(zb)} 較昨日 ${fmtRate(prevDay.zhabanRate)} 收斂、昨日漲停今日平均 ${fmtRet(yest)}，情緒修復`,
    };
  }

  // 8) 退潮（兜底之一：晉級率走弱 + 連板高度自近 5 日高點回落 + 虧錢效應）
  const recent = history.slice(-P.retreat.heightLookback);
  const recentMaxHeight = recent.length > 0 ? Math.max(...recent.map((d) => d.maxBoardHeight)) : null;
  if (
    b.promotionRate1to2 !== null && b.promotionRate1to2 < P.retreat.promotion1to2Below &&
    recentMaxHeight !== null && recentMaxHeight - b.maxBoardHeight >= P.retreat.heightDropMin &&
    yest !== null && yest < P.retreat.yestAvgBelow
  ) {
    return {
      stage: 'retreat',
      reason: `一進二晉級率 ${fmtRate(b.promotionRate1to2)} 走弱、連板高度自近 ${P.retreat.heightLookback} 日最高 ${recentMaxHeight} 板回落至 ${b.maxBoardHeight} 板、昨日漲停今日平均 ${fmtRet(yest)}，退潮`,
    };
  }

  // 9) 都不中 → 維持 prev；首日無 prev → 情緒分分段映射
  if (prevStage !== null) {
    return { stage: prevStage, reason: `無階段條件命中，維持「${STAGE_LABELS[prevStage]}」` };
  }
  const cuts = PHASE_PARAMS.noPrevScoreCuts;
  const mapped: EmotionStage =
    emotionScore < cuts.frozen ? 'frozen'
    : emotionScore < cuts.repair ? 'repair'
    : emotionScore < cuts.launch ? 'launch'
    : emotionScore < cuts.mainRise ? 'main_rise'
    : 'climax';
  return {
    stage: mapped,
    reason: `首日無前一階段且無條件命中，依情緒分 ${emotionScore} 映射為「${STAGE_LABELS[mapped]}」`,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 第三層：hysteresis + 組裝
// ────────────────────────────────────────────────────────────────────────────

/**
 * 單日推導。
 *
 * @param today              今日寬度
 * @param history            today「之前」的序列（舊→新、不含 today；內部會再防呆過濾）
 * @param prevStage          前一交易日 EmotionCycleDay.stage（首日傳 null）
 * @param prevEmotionScore   前一交易日 EmotionCycleDay.emotionScore（首日傳 null）
 * @param prevRawStage       前一交易日 EmotionCycleDay.rawStage（首日/缺檔傳 null）
 *
 * hysteresis 規則：raw 不在 prevStage 的合法後繼 → 兩道放行條款：
 *   (1) |Δ情緒分| ≥ scoreJumpMin（極端日劇變）；
 *   (2) prevRawStage === 今日 raw（連續 rawRepeatDays=2 日 raw 同判，逃生門 —
 *       v1 缺此條款時 crash 一觸發即被困住，見檔頭 v2 校準記錄）。
 * 兩道都不中 → 維持 prevStage。prevStage 有值但 prevEmotionScore 缺（理論上
 * 不該發生）→ 視為變動不可知，只剩逃生門可放行。第一天無 prev 直接取 raw。
 */
export function deriveCycleDay(
  today: MarketBreadthDay,
  history: MarketBreadthDay[],
  prevStage: EmotionStage | null,
  prevEmotionScore: number | null,
  prevRawStage: EmotionStage | null = null,
): EmotionCycleDay {
  // 防呆：丟掉 date >= today 的列（呼叫端誤把 today 塞進 history 時，避免「昨日炸板率」比到自己）
  const past = history.filter((h) => h.date < today.date);

  const emotionScore = computeEmotionScore(today);
  const raw = classifyRawStage(today, past, prevStage, emotionScore);
  const reasons: string[] = [summaryLine(today), raw.reason];

  let stage: EmotionStage = raw.stage;
  if (prevStage !== null && raw.stage !== prevStage && !LEGAL_TRANSITIONS[prevStage].includes(raw.stage)) {
    const jumpMin = PHASE_PARAMS.hysteresis.scoreJumpMin;
    const delta = prevEmotionScore === null ? null : Math.abs(emotionScore - prevEmotionScore);
    if (delta !== null && delta >= jumpMin) {
      reasons.push(
        `情緒分單日劇變 ${delta.toFixed(1)} ≥ ${jumpMin}，放行自「${STAGE_LABELS[prevStage]}」直跳「${STAGE_LABELS[raw.stage]}」`,
      );
    } else if (prevRawStage !== null && prevRawStage === raw.stage) {
      // 逃生門：連續 rawRepeatDays 日 raw 同判同一階段 = 市場結構已持續證明，放行轉移
      reasons.push(
        `連續 ${PHASE_PARAMS.hysteresis.rawRepeatDays} 日 raw 同判「${STAGE_LABELS[raw.stage]}」，確認轉移`,
      );
    } else {
      reasons.push(
        `raw 判定「${STAGE_LABELS[raw.stage]}」非「${STAGE_LABELS[prevStage]}」合法後繼，情緒分變動 ${delta === null ? '不可知' : delta.toFixed(1)} < ${jumpMin}，維持「${STAGE_LABELS[prevStage]}」`,
      );
      stage = prevStage;
    }
  }

  const pb = PHASE_PARAMS.playbook[stage];
  const strategies: DailyTactic[] = [...pb.strategies];
  return {
    date: today.date,
    stage,
    stageLabel: STAGE_LABELS[stage],
    emotionScore,
    strategies,
    strategyLabel: strategies.map((t) => TACTIC_LABELS[t]).join('+'),
    positionPct: [pb.positionPct[0], pb.positionPct[1]],
    reasons,
    rawStage: raw.stage,
  };
}

/**
 * 整段序列分類：迭代餵 prevStage / prevEmotionScore / prevRawStage。
 * series 應為升冪（舊→新）；內部會按 date 防呆排序（YYYY-MM-DD 字串序 = 時序）。
 */
export function classifyEmotionCycle(series: MarketBreadthDay[]): EmotionCycleDay[] {
  const sorted = [...series].sort((a, b) => a.date.localeCompare(b.date));
  const out: EmotionCycleDay[] = [];
  let prevStage: EmotionStage | null = null;
  let prevScore: number | null = null;
  let prevRaw: EmotionStage | null = null;
  for (let i = 0; i < sorted.length; i++) {
    const day = deriveCycleDay(sorted[i], sorted.slice(0, i), prevStage, prevScore, prevRaw);
    out.push(day);
    prevStage = day.stage;
    prevScore = day.emotionScore;
    prevRaw = day.rawStage;
  }
  return out;
}
