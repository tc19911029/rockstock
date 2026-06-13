/**
 * 陸股情緒週期八階段 — golden 合約測試（鐵律 #7）
 *
 * v2 校準版（2026-06-12）：fixture 全部按 v2 門檻（24 個月分位數定錨，見 cycle.ts 檔頭）
 * 重新手算設計；新增 crash 支配條款 + 「連續 2 日同 raw」逃生門兩組 case。
 *
 * 釘死三件事：
 *   1. PHASE_PARAMS 凍結 snapshot — 任何參數改動必紅，逼迫同步升 types.ts 的
 *      CYCLE_RULES_VERSION 並有意識地重驗下面的 golden 序列（仿 sanse-params-frozen 凍結哲學）。
 *   2. 手工合成序列 golden — 冰點→修復→啟動→主升→高潮→分歧→退潮→冰點完整一輪，
 *      每天的階段判定都是手算過的預期值（predicate 逐條核過、含 keep-prev 兜底日）。
 *   3. hysteresis 不變量 —
 *        (b) 噪音日（raw 非法後繼且 |Δ分| < 15、raw 未連續 2 日同判）擋跳階、維持原階段；
 *        (c) 極端日（|Δ分| ≥ 15，冰點期千股漲停）放行直跳；
 *        (d) 殺跌從任何階段可直入（crash 是全階段合法後繼，不吃 hysteresis）；
 *        (e) 全部輸出序列（含 200 天偽隨機 fuzz）每步轉移 ∈ 合法圖 ∪ 劇變放行 ∪
 *            連 2 日同 raw 放行；
 *        (f) crash 支配條款 — 跌停 ≥20 家但「沒壓過」漲停 → 不觸發 crash（v2 新增）；
 *        (g) 連續 2 日同 raw 逃生門 — 殺跌期連 2 日 raw=高潮且每日 |Δ分| < 15 →
 *            第 1 日被擋、第 2 日放行（v1 缺此門 crash 會永遠卡住，v2 新增）。
 *
 * 全部純 fixture、零網路、零磁碟。
 */
import {
  PHASE_PARAMS,
  LEGAL_TRANSITIONS,
  deriveCycleDay,
  classifyEmotionCycle,
  computeEmotionScore,
} from '@/lib/cn-agents/cycle';
import { CYCLE_RULES_VERSION, STAGE_LABELS } from '@/lib/cn-agents/types';
import type { MarketBreadthDay, EmotionStage, EmotionCycleDay } from '@/lib/cn-agents/types';

// ────────────────────────────────────────────────────────────────────────────
// fixture helpers
// ────────────────────────────────────────────────────────────────────────────

/** 連續日期產生器（YYYY-MM-DD，i=0 → 2026-01-01） */
const d = (i: number) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);

/** 合成一天市場寬度（未覆寫欄位給中性預設值） */
function day(date: string, over: Partial<MarketBreadthDay>): MarketBreadthDay {
  return {
    date,
    limitUpCount: 30,
    limitDownCount: 3,
    oneWordCount: 5,
    zhabanCount: 10,
    zhabanRate: 0.25,
    maxBoardHeight: 3,
    board2PlusCount: 10,
    promotionRate1to2: 0.4,
    promotionRateHigh: 0.4,
    yestLimitUpAvgReturn: 1,
    yestZhabanAvgReturn: -1,
    upCount: 2500,
    downCount: 2500,
    totalTurnover: 1.5e12,
    turnoverRatio5d: 1,
    shIndexChangePct: 0,
    ...over,
  };
}

const ALL_STAGES: EmotionStage[] = [
  'frozen', 'repair', 'launch', 'main_rise', 'climax', 'divergence', 'retreat', 'crash',
];

/**
 * (e) 不變量：每步轉移在合法圖內，或兩道 hysteresis 放行條款之一：
 *   (1) 情緒分單日劇變 ≥ scoreJumpMin；
 *   (2) 連續 2 日 raw 同判（今日 rawStage === 昨日 rawStage，且 stage 取了 raw）。
 */
function assertTransitionsValid(out: EmotionCycleDay[]) {
  for (let i = 1; i < out.length; i++) {
    const legal = LEGAL_TRANSITIONS[out[i - 1].stage].includes(out[i].stage);
    if (!legal) {
      const delta = Math.abs(out[i].emotionScore - out[i - 1].emotionScore);
      const rawRepeat = out[i].rawStage === out[i - 1].rawStage && out[i].stage === out[i].rawStage;
      expect(delta >= PHASE_PARAMS.hysteresis.scoreJumpMin || rawRepeat).toBe(true);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 1) PHASE_PARAMS 凍結
// ────────────────────────────────────────────────────────────────────────────

// 由 npx tsx -e 'JSON.stringify(PHASE_PARAMS)' 抓下的凍結值（v2，2026-06-12 校準）— 改參數必紅
const FROZEN_PHASE_PARAMS =
  '{"score":{"nullScore":50,"weights":{"limitUp":0.25,"seal":0.2,"yestReturn":0.2,"promotion":0.15,"height":0.1,"breadth":0.1},"limitUpAnchors":[10,40,100],"yestReturnAnchors":[-5,0,5],"heightAnchors":[1,3,6],"upRatioAnchors":[0.3,0.5,0.8]},"predicates":{"crash":{"limitDownMin":20,"yestAvgBelow":-5},"frozen":{"limitUpBelow":30,"zhabanAbove":0.4,"yestAvgBelow":0.5,"maxHeightMax":4},"climax":{"limitUpAbove":110,"maxHeightMin":6,"board2PlusNewHighLookback":10},"mainRise":{"limitUpMin":50,"limitUpMax":110,"maxHeightMin":4,"promotionHighMin":0.5,"yestAvgMin":3},"launch":{"limitUpMin":40,"promotion1to2Min":0.25,"maxHeightMin":3,"yestAvgAbove":1},"divergence":{"zhabanAbove":0.3,"yestAvgBelow":0,"limitUpMin":40},"repair":{"limitUpMin":20,"limitUpMax":60,"yestAvgAbove":-1},"retreat":{"promotion1to2Below":0.3,"heightLookback":5,"heightDropMin":2,"yestAvgBelow":-0.5}},"hysteresis":{"scoreJumpMin":15,"rawRepeatDays":2},"noPrevScoreCuts":{"frozen":25,"repair":45,"launch":65,"mainRise":80},"playbook":{"frozen":{"strategies":["observe"],"positionPct":[0,10]},"repair":{"strategies":["dixi"],"positionPct":[20,30]},"launch":{"strategies":["daban","banlu"],"positionPct":[40,60]},"main_rise":{"strategies":["daban","banlu"],"positionPct":[60,80]},"climax":{"strategies":["banlu"],"positionPct":[40,70]},"divergence":{"strategies":["banlu","dixi"],"positionPct":[30,40]},"retreat":{"strategies":["observe"],"positionPct":[0,20]},"crash":{"strategies":["observe"],"positionPct":[0,0]}}}';

describe('情緒週期 — PHASE_PARAMS 凍結', () => {
  test('參數 snapshot 不變（改動必同步升 CYCLE_RULES_VERSION + 重驗 golden）', () => {
    expect(JSON.stringify(PHASE_PARAMS)).toBe(FROZEN_PHASE_PARAMS);
    expect(CYCLE_RULES_VERSION).toBe('v2');
  });

  test('LEGAL_TRANSITIONS：8 階段齊全、各含自環、crash 是全階段合法後繼', () => {
    for (const s of ALL_STAGES) {
      expect(LEGAL_TRANSITIONS[s]).toContain(s);       // 自環（停留永遠合法）
      expect(LEGAL_TRANSITIONS[s]).toContain('crash'); // 殺跌可從任何階段直入
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// (a) 完整一輪 golden
// ────────────────────────────────────────────────────────────────────────────

describe('(a) 完整一輪 golden：冰點→修復→啟動→主升→高潮→分歧→退潮→冰點', () => {
  const series: MarketBreadthDay[] = [
    // D01-D02 冰點：漲停稀少、炸板高、虧錢效應、無連板高度
    day(d(0), { limitUpCount: 8, limitDownCount: 5, zhabanRate: 0.55, yestLimitUpAvgReturn: -3.5, maxBoardHeight: 1, board2PlusCount: 0, promotionRate1to2: 0, promotionRateHigh: null, upCount: 1200, downCount: 3800 }),
    day(d(1), { limitUpCount: 12, zhabanRate: 0.5, yestLimitUpAvgReturn: -2.5, maxBoardHeight: 2, board2PlusCount: 1, promotionRate1to2: 0.1, promotionRateHigh: null, upCount: 1800, downCount: 3200 }),
    // D03 修復：prev=frozen、炸板率較昨日收斂（0.35 < 0.5）、虧錢效應收斂
    day(d(2), { limitUpCount: 28, zhabanRate: 0.35, yestLimitUpAvgReturn: 0.5, maxBoardHeight: 2, board2PlusCount: 3, promotionRate1to2: 0.35, promotionRateHigh: null, upCount: 2800, downCount: 2200 }),
    // D04 修復（keep-prev 兜底：repair 是 prev-gated、prev 已是 repair → 無條件命中 → 維持）
    day(d(3), { limitUpCount: 32, zhabanRate: 0.3, yestLimitUpAvgReturn: 1.5, maxBoardHeight: 2, board2PlusCount: 4, promotionRate1to2: 0.45, promotionRateHigh: 0.2, upCount: 3000, downCount: 2000 }),
    // D05-D06 啟動：漲停 ≥40、一進二 ≥0.25（v2 校準 p80）、最高 ≥3 板、賺錢效應轉正
    day(d(4), { limitUpCount: 45, zhabanRate: 0.25, yestLimitUpAvgReturn: 2.5, maxBoardHeight: 3, board2PlusCount: 8, promotionRate1to2: 0.55, promotionRateHigh: 0.3, upCount: 3300, downCount: 1700 }),
    day(d(5), { limitUpCount: 48, zhabanRate: 0.22, yestLimitUpAvgReturn: 2, maxBoardHeight: 3, board2PlusCount: 10, promotionRate1to2: 0.6, promotionRateHigh: 0.4, upCount: 3400, downCount: 1600 }),
    // D07-D08 主升：漲停 ∈[50,110]、最高 ≥4 板、高位晉級率 ≥0.5、賺錢效應 ≥3%
    day(d(6), { limitUpCount: 65, zhabanRate: 0.2, yestLimitUpAvgReturn: 3.5, maxBoardHeight: 4, board2PlusCount: 15, promotionRate1to2: 0.5, promotionRateHigh: 0.55, upCount: 3800, downCount: 1200 }),
    day(d(7), { limitUpCount: 80, zhabanRate: 0.18, yestLimitUpAvgReturn: 4, maxBoardHeight: 5, board2PlusCount: 22, promotionRate1to2: 0.55, promotionRateHigh: 0.6, upCount: 4000, downCount: 1000 }),
    // D09-D10 高潮：漲停 >110
    day(d(8), { limitUpCount: 120, zhabanRate: 0.2, yestLimitUpAvgReturn: 5, maxBoardHeight: 6, board2PlusCount: 35, promotionRate1to2: 0.6, promotionRateHigh: 0.65, upCount: 4300, downCount: 700 }),
    day(d(9), { limitUpCount: 115, zhabanRate: 0.25, yestLimitUpAvgReturn: 4.5, maxBoardHeight: 7, board2PlusCount: 40, promotionRate1to2: 0.55, promotionRateHigh: 0.5, upCount: 4200, downCount: 800 }),
    // D11 分歧：prev=climax、炸板率 >0.3、賺錢效應轉負、漲停仍 ≥40
    day(d(10), { limitUpCount: 70, zhabanRate: 0.45, yestLimitUpAvgReturn: -2, maxBoardHeight: 5, board2PlusCount: 20, promotionRate1to2: 0.3, promotionRateHigh: 0.3, upCount: 2000, downCount: 3000 }),
    // D12 分歧（keep-prev 兜底：divergence 是 prev-gated、prev 已是 divergence）
    day(d(11), { limitUpCount: 50, zhabanRate: 0.35, yestLimitUpAvgReturn: 0.5, maxBoardHeight: 5, board2PlusCount: 15, promotionRate1to2: 0.35, promotionRateHigh: 0.3, upCount: 2600, downCount: 2400 }),
    // D13-D14 退潮：晉級率 <0.3、連板高度自近 5 日最高（7 板）回落 ≥2、虧錢效應 <−0.5%
    // （兩日漲停皆 ≥30 — v2 frozen limitUpBelow 升到 30，漲停壓太低會先命中冰點）
    day(d(12), { limitUpCount: 35, limitDownCount: 8, zhabanRate: 0.4, yestLimitUpAvgReturn: -4, maxBoardHeight: 4, board2PlusCount: 8, promotionRate1to2: 0.2, promotionRateHigh: 0.1, upCount: 1500, downCount: 3500 }),
    day(d(13), { limitUpCount: 32, zhabanRate: 0.45, yestLimitUpAvgReturn: -3.5, maxBoardHeight: 3, board2PlusCount: 5, promotionRate1to2: 0.15, promotionRateHigh: null, upCount: 1700, downCount: 3300 }),
    // D15-D16 回到冰點
    day(d(14), { limitUpCount: 10, limitDownCount: 6, zhabanRate: 0.5, yestLimitUpAvgReturn: -4.5, maxBoardHeight: 2, board2PlusCount: 1, promotionRate1to2: 0, promotionRateHigh: null, upCount: 1100, downCount: 3900 }),
    day(d(15), { limitUpCount: 9, limitDownCount: 4, zhabanRate: 0.45, yestLimitUpAvgReturn: -2.5, maxBoardHeight: 1, board2PlusCount: 0, promotionRate1to2: 0.05, promotionRateHigh: null, upCount: 1600, downCount: 3400 }),
  ];
  const expected: EmotionStage[] = [
    'frozen', 'frozen',
    'repair', 'repair',
    'launch', 'launch',
    'main_rise', 'main_rise',
    'climax', 'climax',
    'divergence', 'divergence',
    'retreat', 'retreat',
    'frozen', 'frozen',
  ];
  const out = classifyEmotionCycle(series);

  test('16 天階段逐日相符', () => {
    expect(out.map((o) => o.stage)).toEqual(expected);
  });

  test('rawStage 與 stage 一致（全程合法轉移，無 hysteresis 修正）', () => {
    expect(out.map((o) => o.rawStage)).toEqual(expected);
  });

  test('keep-prev 兜底日有「維持」reason（D04 修復、D12 分歧）', () => {
    expect(out[3].reasons.join('')).toContain('維持');
    expect(out[11].reasons.join('')).toContain('維持');
    // 非兜底日不應出現 hysteresis 擋跳階字樣
    expect(out[2].reasons.join('')).not.toContain('合法後繼');
  });

  test('策略/倉位映射 + stageLabel', () => {
    expect(out[0].strategies).toEqual(['observe']);
    expect(out[0].positionPct).toEqual([0, 10]);
    expect(out[0].strategyLabel).toBe('觀望');
    expect(out[0].stageLabel).toBe('冰點');
    expect(out[2].strategies).toEqual(['dixi']);
    expect(out[2].positionPct).toEqual([20, 30]);
    expect(out[4].strategies).toEqual(['daban', 'banlu']);
    expect(out[4].positionPct).toEqual([40, 60]);
    expect(out[6].positionPct).toEqual([60, 80]);
    expect(out[6].strategyLabel).toBe('打板+半路');
    expect(out[8].strategies).toEqual(['banlu']);       // 高潮：持有不加、卡位擇強
    expect(out[8].positionPct).toEqual([40, 70]);
    expect(out[10].strategies).toEqual(['banlu', 'dixi']);
    expect(out[10].strategyLabel).toBe('半路+低吸');
    expect(out[12].positionPct).toEqual([0, 20]);
  });

  test('emotionScore 錨點抽查（D01 冰點 ≈ 12.0）', () => {
    // 0.25×0 + 0.20×45 + 0.20×15 + 0.15×0 + 0.10×0 + 0.10×0 = 12.0（手算）
    expect(out[0].emotionScore).toBeCloseTo(12.0, 1);
  });

  test('(e) 全序列轉移合法', () => {
    assertTransitionsValid(out);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// (b) hysteresis：噪音日擋跳階
// ────────────────────────────────────────────────────────────────────────────

describe('(b) hysteresis：主升期單日轉差但情緒分變動 <15 → 維持主升', () => {
  // B1 主升（首日取 raw）：刻意壓低分數（炸板率 0.6、一進二 0.1、寬度弱）讓 B2 的 Δ <15
  const series: MarketBreadthDay[] = [
    day(d(0), { limitUpCount: 50, zhabanRate: 0.6, yestLimitUpAvgReturn: 3, maxBoardHeight: 4, board2PlusCount: 12, promotionRate1to2: 0.1, promotionRateHigh: 0.5, upCount: 1500, downCount: 3500 }),
    // B2 raw=retreat（晉級率 0.25、高度 4→2 回落 2、yest −3.2；漲停 35 <40 讓 divergence 不中）
    day(d(1), { limitUpCount: 35, zhabanRate: 0.5, yestLimitUpAvgReturn: -3.2, maxBoardHeight: 2, board2PlusCount: 5, promotionRate1to2: 0.25, promotionRateHigh: 0.2, upCount: 2200, downCount: 2800 }),
  ];
  const out = classifyEmotionCycle(series);

  test('day1 主升、day2 raw=retreat 但被擋 → 維持主升', () => {
    expect(out[0].stage).toBe('main_rise');
    expect(out[1].rawStage).toBe('retreat');         // retreat ∉ main_rise 合法後繼
    expect(out[1].stage).toBe('main_rise');          // Δ <15 → 擋下
    expect(out[1].reasons.join('')).toContain('維持');
  });

  test('前提自證：Δ情緒分確實 < 15（fixture 失準時此測先紅，好除錯）', () => {
    const delta = Math.abs(computeEmotionScore(series[1]) - computeEmotionScore(series[0]));
    expect(delta).toBeLessThan(PHASE_PARAMS.hysteresis.scoreJumpMin);
  });

  test('(e) 轉移合法（被擋 → main_rise→main_rise 自環）', () => {
    assertTransitionsValid(out);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// (c) hysteresis：極端日放行跳階
// ────────────────────────────────────────────────────────────────────────────

describe('(c) 極端跳階：冰點期千股漲停（Δ分 ≥15）→ 允許直跳高潮', () => {
  const series: MarketBreadthDay[] = [
    day(d(0), { limitUpCount: 8, limitDownCount: 5, zhabanRate: 0.55, yestLimitUpAvgReturn: -3.5, maxBoardHeight: 1, board2PlusCount: 0, promotionRate1to2: 0, promotionRateHigh: null, upCount: 1200, downCount: 3800 }),
    day(d(1), { limitUpCount: 1000, limitDownCount: 0, zhabanRate: 0.05, yestLimitUpAvgReturn: 6, maxBoardHeight: 5, board2PlusCount: 200, promotionRate1to2: 0.9, promotionRateHigh: 0.8, upCount: 4800, downCount: 200 }),
  ];
  const out = classifyEmotionCycle(series);

  test('day1 冰點、day2 直跳高潮（climax ∉ frozen 合法後繼，靠劇變放行）', () => {
    expect(out[0].stage).toBe('frozen');
    expect(out[1].rawStage).toBe('climax');
    expect(out[1].stage).toBe('climax');
    expect(out[1].reasons.join('')).toContain('劇變');
  });

  test('前提自證：Δ情緒分確實 ≥ 15', () => {
    const delta = Math.abs(computeEmotionScore(series[1]) - computeEmotionScore(series[0]));
    expect(delta).toBeGreaterThanOrEqual(PHASE_PARAMS.hysteresis.scoreJumpMin);
  });

  test('(e) 轉移合法（非法邊靠劇變條款放行）', () => {
    assertTransitionsValid(out);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// (d) 殺跌從任何階段可直入
// ────────────────────────────────────────────────────────────────────────────

describe('(d) crash 從任何階段直入（不吃 hysteresis、不需分數劇變）', () => {
  // 跌停 30 家 ≥ 20 → crash；prevScore 故意設成與當日分數接近（Δ <15）證明 crash 不靠劇變條款
  const crashDay = day(d(1), { limitUpCount: 3, limitDownCount: 30, zhabanRate: 0.8, yestLimitUpAvgReturn: -8, maxBoardHeight: 1, board2PlusCount: 0, promotionRate1to2: 0.05, promotionRateHigh: null, upCount: 200, downCount: 4800 });

  test.each(ALL_STAGES)('prevStage=%s → crash', (prev) => {
    const r = deriveCycleDay(crashDay, [], prev, 10);
    expect(r.rawStage).toBe('crash');
    expect(r.stage).toBe('crash');
    expect(r.strategies).toEqual(['observe']);
    expect(r.positionPct).toEqual([0, 0]);
    expect(r.stageLabel).toBe(STAGE_LABELS.crash);
  });

  test('crash 第二觸發路徑：跌停多於漲停且昨日漲停重挫 <−5%', () => {
    const day2 = day(d(1), { limitUpCount: 5, limitDownCount: 15, yestLimitUpAvgReturn: -6, zhabanRate: 0.5, maxBoardHeight: 3 });
    const r = deriveCycleDay(day2, [], 'climax', 80);
    expect(r.stage).toBe('crash');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// (f) crash 支配條款（v2 新增）：跌停 ≥20 家但沒壓過漲停 → 不觸發 crash
// ────────────────────────────────────────────────────────────────────────────

describe('(f) crash 支配條款：跌停 25 家 ≥ 門檻 20，但漲停 80 家壓過 → 非殺跌', () => {
  // 活躍分化日：漲停 80 / 跌停 25 — v1 絕對門檻會誤標 crash，v2 要求跌停 > 漲停
  const activeDay = day(d(1), {
    limitUpCount: 80, limitDownCount: 25, zhabanRate: 0.2, yestLimitUpAvgReturn: 3.5,
    maxBoardHeight: 5, board2PlusCount: 20, promotionRate1to2: 0.4, promotionRateHigh: 0.6,
    upCount: 3500, downCount: 1500,
  });

  test('raw 判主升（mainRise predicate 全中），不是 crash', () => {
    const r = deriveCycleDay(activeDay, [], 'main_rise', 50);
    expect(r.rawStage).toBe('main_rise');
    expect(r.stage).toBe('main_rise');
    expect(r.reasons.join('')).not.toContain('恐慌殺跌');
  });

  test('對照組：同樣跌停 25 家、但漲停僅 10 家（跌停壓過漲停）→ crash', () => {
    const panicDay = day(d(1), {
      limitUpCount: 10, limitDownCount: 25, zhabanRate: 0.5, yestLimitUpAvgReturn: -6,
      maxBoardHeight: 2, board2PlusCount: 1, promotionRate1to2: 0.1, promotionRateHigh: null,
      upCount: 800, downCount: 4200,
    });
    const r = deriveCycleDay(panicDay, [], 'main_rise', 50);
    expect(r.rawStage).toBe('crash');
    expect(r.stage).toBe('crash');
    expect(r.reasons.join('')).toContain('壓過漲停');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// (g) 連續 2 日同 raw 逃生門（v2 新增）：殺跌期連 2 日 raw=高潮 → 第 2 日放行
// ────────────────────────────────────────────────────────────────────────────

describe('(g) 逃生門：crash 被困（climax ∉ 合法後繼、Δ分 <15）→ 連 2 日 raw 同判才放行', () => {
  // 手算分數：G1=15.5、G2=27.6（Δ=12.1 <15）、G3=32.1（Δ=4.5 <15）
  // G2/G3 走 climax 第二路徑（最高 ≥6 板 + 二板以上家數創近 10 日新高）；
  // 兩日皆因最高 6 板 > frozen.maxHeightMax=4 不會先命中冰點。
  const series: MarketBreadthDay[] = [
    // G1 殺跌：跌停 25 ≥ 20 且壓過漲停 10
    day(d(0), { limitUpCount: 10, limitDownCount: 25, zhabanRate: 0.5, yestLimitUpAvgReturn: -6, maxBoardHeight: 2, board2PlusCount: 0, promotionRate1to2: 0.2, promotionRateHigh: null, upCount: 1500, downCount: 3500 }),
    // G2 raw=climax（6 板 + 二板 12 家創新高）但 Δ=12.1 <15 且昨日 raw=crash → 擋下維持殺跌
    day(d(1), { limitUpCount: 15, limitDownCount: 5, zhabanRate: 0.6, yestLimitUpAvgReturn: -2, maxBoardHeight: 6, board2PlusCount: 12, promotionRate1to2: 0.1, promotionRateHigh: null, upCount: 1000, downCount: 4000 }),
    // G3 raw=climax 第二日（二板 15 家再創新高）、Δ=4.5 <15 → 靠「連 2 日同 raw」放行
    day(d(2), { limitUpCount: 18, limitDownCount: 4, zhabanRate: 0.55, yestLimitUpAvgReturn: -1, maxBoardHeight: 6, board2PlusCount: 15, promotionRate1to2: 0.12, promotionRateHigh: null, upCount: 1200, downCount: 3800 }),
  ];
  const out = classifyEmotionCycle(series);

  test('G1 殺跌、G2 raw=climax 被擋（首日同判不放行）、G3 連 2 日同 raw 放行', () => {
    expect(out[0].stage).toBe('crash');
    expect(out[1].rawStage).toBe('climax');
    expect(out[1].stage).toBe('crash');                  // 第 1 日：prevRaw=crash ≠ climax → 擋
    expect(out[1].reasons.join('')).toContain('維持');
    expect(out[2].rawStage).toBe('climax');
    expect(out[2].stage).toBe('climax');                 // 第 2 日：prevRaw=climax === raw → 放行
    expect(out[2].reasons.join('')).toContain('連續 2 日 raw 同判');
  });

  test('前提自證：兩日 Δ情緒分都 < 15（逃生門不是靠劇變條款放行）', () => {
    const s0 = computeEmotionScore(series[0]);
    const s1 = computeEmotionScore(series[1]);
    const s2 = computeEmotionScore(series[2]);
    expect(Math.abs(s1 - s0)).toBeLessThan(PHASE_PARAMS.hysteresis.scoreJumpMin);
    expect(Math.abs(s2 - s1)).toBeLessThan(PHASE_PARAMS.hysteresis.scoreJumpMin);
  });

  test('(e) 轉移合法（G3 非法邊靠連 2 日同 raw 條款放行）', () => {
    assertTransitionsValid(out);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// (e) 轉移合法性 — 200 天偽隨機 fuzz
// ────────────────────────────────────────────────────────────────────────────

describe('(e) 轉移合法性：200 天偽隨機序列每步轉移 ∈ 合法圖 ∪ 劇變放行 ∪ 連 2 日同 raw 放行', () => {
  // 決定性 LCG（Numerical Recipes 係數）— 同 seed 必同序列，golden 可重現
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  const rnd = lcg(20260612);
  const series: MarketBreadthDay[] = [];
  for (let i = 0; i < 200; i++) {
    const up = Math.floor(rnd() * 5000);
    series.push(
      day(d(i), {
        limitUpCount: Math.floor(rnd() * 150),
        limitDownCount: Math.floor(rnd() * 45),
        zhabanRate: rnd() < 0.1 ? null : +(rnd() * 0.8).toFixed(2),
        maxBoardHeight: 1 + Math.floor(rnd() * 7),
        board2PlusCount: Math.floor(rnd() * 50),
        promotionRate1to2: rnd() < 0.1 ? null : +rnd().toFixed(2),
        promotionRateHigh: rnd() < 0.2 ? null : +rnd().toFixed(2),
        yestLimitUpAvgReturn: rnd() < 0.1 ? null : +(rnd() * 16 - 8).toFixed(1),
        upCount: up,
        downCount: 5000 - up,
      }),
    );
  }
  const out = classifyEmotionCycle(series);

  test('每步轉移合法或劇變放行', () => {
    expect(out).toHaveLength(200);
    assertTransitionsValid(out);
  });

  test('輸出形狀不變量：stage/label/策略/倉位/分數全在值域內', () => {
    for (const o of out) {
      expect(ALL_STAGES).toContain(o.stage);
      expect(ALL_STAGES).toContain(o.rawStage);
      expect(o.stageLabel).toBe(STAGE_LABELS[o.stage]);
      expect(o.strategies.length).toBeGreaterThanOrEqual(1);
      expect(o.strategyLabel.length).toBeGreaterThan(0);
      expect(o.positionPct[0]).toBeGreaterThanOrEqual(0);
      expect(o.positionPct[1]).toBeLessThanOrEqual(100);
      expect(o.positionPct[0]).toBeLessThanOrEqual(o.positionPct[1]);
      expect(o.emotionScore).toBeGreaterThanOrEqual(0);
      expect(o.emotionScore).toBeLessThanOrEqual(100);
      expect(o.reasons.length).toBeGreaterThanOrEqual(2);
    }
  });

  test('決定性：同 fixture 重跑 classifyEmotionCycle 結果逐位元相同（回測可重現）', () => {
    expect(classifyEmotionCycle(series)).toEqual(out);
  });
});
