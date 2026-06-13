/**
 * 陸股情緒系統 P2 — 5 個程式 source 子分計分器（純函式、零 IO）
 *
 * hard_score_v0 與 P3 總分（scoring.ts computeCnTotalScore）共用：
 * 每個計分器回 { score, reasons } 或 null —
 *   null = 資料不可得（例：未上龍虎榜），總分層自動重加權；
 *   例外：scoreHeat 未上榜回低分 40 不缺值（「沒人氣」本身就是資訊）。
 * score 一律 clamp 0-100 後四捨五入成整數；reasons 為白話依據
 * （UI / 回測 drill-down 用，繁體中文）。
 *
 * 所有魔術數字集中 SUBSCORE_PARAMS（仿 cycle.ts PHASE_PARAMS 凍結哲學：
 * 參數改動必須是有意識的、code review 一眼可見；同輸入必同輸出 → 可回測重現）。
 */

import type {
  BoardEntry,
  BrokenEntry,
  HotRankEntry,
  LhbStockEntry,
  LimitUpEntry,
} from './types';

/** 子分結果：score 0-100 整數；reasons = 加減分逐項白話依據 */
export interface SubScoreResult {
  score: number;
  reasons: string[];
}

// ────────────────────────────────────────────────────────────────────────────
// 參數凍結區 — 所有魔術數字集中於此
// ────────────────────────────────────────────────────────────────────────────

export const SUBSCORE_PARAMS = {
  /** 漲停結構（CN_EMOTION_SIGNAL_SPECS.limitStructure，權重 0.15、core） */
  limitStructure: {
    /** 首封時間 → base（越早封越強；HH:MM:SS 零填字串可直接字典序比較） */
    sealTimeTiers: [
      { before: '09:40:00', base: 85, label: '早盤秒板' },
      { before: '10:30:00', base: 75, label: '早盤板' },
      { before: '14:30:00', base: 60, label: '午後板' },
    ],
    /** ≥14:30 尾盤板（隔日溢價最不可靠） */
    lateSealBase: 50,
    /** firstSealTime 缺值 → 中性 base（資料缺漏不單邊懲罰） */
    unknownSealBase: 60,
    /** 炸板次數：0 次封死 +10 / 1 次 −5 / ≥2 次反覆開板 −15 */
    brokenAdj: { none: 10, once: -5, multi: -15 },
    /** 封單金額/流通市值：>2% 強封 +10、<0.5% 弱封 −5（任一欄缺 → 不調整） */
    sealRatio: { strongMin: 0.02, strongBonus: 10, weakMax: 0.005, weakPenalty: -5 },
    /** 連板 2-4 每級 +5（2板+5/3板+10/4板+15）；≥5 板高位風險 −10 */
    consec: { bonusMin: 2, bonusMax: 4, perBoard: 5, highMin: 5, highPenalty: -10 },
    /** 一字板固定 60：noFillRisk 買不進，不計封板時間/連板加減分 */
    oneWordScore: 60,
    /** 昨炸板 + 今日紅盤 = 反包雛形 base 55 + 15 */
    fanbao: { base: 55, bonus: 15 },
    /** 今日非漲停但近 5 日有漲停 → 結構仍活躍 base 55 */
    recentLimitUpBase: 55,
    /**
     * 今日炸板未回封（虧錢效應）→ 45。
     * 規格未明列、v0 補的保守分檔：炸板是「最新的失敗結構事件」，
     * 證據新鮮度高於「近 5 日曾漲停」的 55，故壓低且優先判定。
     */
    todayBrokenScore: 45,
  },
  /** 龍虎榜（席位結構；未上榜 → null 重加權） */
  lhb: {
    base: 50,
    /** 機構買：1 席 +15、每多 1 席 +5、上限 +25 */
    instBuy: { first: 15, extra: 5, cap: 25 },
    /** 機構賣 ≥1 席（機構出貨最重訊號之一） */
    instSellPenalty: -12,
    /** 游資買：1 席 +8、≥2 席合力 +12 */
    hotMoney: { one: 8, multi: 12 },
    /** 買一佔買五合計 >0.5 = 一家獨大（隔日接力盤脆弱） */
    dominance: { max: 0.5, penalty: -10 },
    /** 散戶通道（拉薩系）佔買五席「數」比 >30% → 散戶接盤 −15 */
    retailRatio: { max: 0.3, penalty: -15 },
    /** 榜面淨買/當日成交額 >10% → 控盤度高 +10 */
    netToTurnover: { min: 0.1, bonus: 10 },
    /** 量化買 ≥2 席（隔日程式化砸盤風險） */
    quantBuy: { min: 2, penalty: -8 },
    /** 北向通道買 ≥1 席 */
    northboundBonus: 6,
  },
  /** 主力資金（mainNet 缺 → null 重加權） */
  mainFlow: {
    /**
     * 主力淨額/流通市值（%）→ 分數，錨點間線性內插：
     * ≤−3%→20 / −1%→45 / 0→55 / 1%→70 / ≥3%→85
     */
    ratioAnchors: [
      [-3, 20],
      [-1, 45],
      [0, 55],
      [1, 70],
      [3, 85],
    ],
    /** 流通市值缺 → 淨額絕對值粗分檔（reasons 註明粗分檔；嚴格 > 比較） */
    absTiers: [
      { min: 1e8, score: 70 },  // >1 億
      { min: 3e7, score: 60 },  // >3000 萬
      { min: 0, score: 55 },    // >0
      { min: -3e7, score: 45 }, // >−3000 萬
    ],
    absFloor: 30, // ≤−3000 萬
    /** 連續淨流入 ≥3 日 +10（趨勢資金） */
    consecInflow: { daysMin: 3, bonus: 10 },
    /** 漲停但主力淨流出 = 出貨板（拉高出貨嫌疑） */
    limitUpOutflowPenalty: -15,
  },
  /** 人氣熱度（未上榜 → 40 低分處理，刻意不缺值） */
  heat: {
    unrankedScore: 40,
    rankTiers: [
      { max: 10, score: 85 },
      { max: 30, score: 70 },
      { max: 50, score: 60 },
      { max: 100, score: 50 },
    ],
    /** 名次急升 >+20 或新進榜（daysInTop100===1）→ +10（情緒增量） */
    surge: { rankChangeMin: 20, bonus: 10 },
  },
  /** 板塊強弱（個股所屬行業板塊；缺 → null 重加權） */
  sector: {
    base: 50,
    /** 當日板塊漲幅 % × 8，cap ±25 */
    pctMult: 8,
    pctCap: 25,
    /** 板內漲停 ≥3 家 +15（板塊效應確立）、=2 家 +8 */
    limitUp: { strongMin: 3, strongBonus: 15, pairBonus: 8 },
    /** 當日漲幅榜前 5 名 +10 */
    rankTop: { max: 5, bonus: 10 },
    /** 近 5 日累計 >3% 趨勢 +5 */
    pct5d: { min: 3, bonus: 5 },
  },
} as const;

// ────────────────────────────────────────────────────────────────────────────
// 共用小工具
// ────────────────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 收尾：clamp 0-100 + 四捨五入成整數 */
function finalize(score: number, reasons: string[]): SubScoreResult {
  return { score: Math.round(clamp(score, 0, 100)), reasons };
}

/** 錨點間線性內插（pts 依 x 升冪；x 出界 → 取端點 y） */
function lerpPiecewise(x: number, pts: ReadonlyArray<readonly [number, number]>): number {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    if (x <= x1) {
      const [x0, y0] = pts[i - 1];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return pts[pts.length - 1][1];
}

/** 金額白話化（reasons 用） */
function fmtCny(v: number): string {
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1e8) return `${sign}${(a / 1e8).toFixed(2)}億`;
  return `${sign}${(a / 1e4).toFixed(0)}萬`;
}

// ────────────────────────────────────────────────────────────────────────────
// 1. 漲停結構
// ────────────────────────────────────────────────────────────────────────────

/**
 * 漲停結構子分。
 *
 * 今日漲停：base 由首封時間，疊加炸板次數 / 封單強度 / 連板高度；
 * 一字板固定 60（買不進，封板再漂亮也沒有操作意義）。
 * 非漲停：今日炸板 45 → 昨炸板今紅盤反包雛形 70 → 近 5 日有漲停 55，
 * 都沒有 → null（無漲停結構事件 = 缺值，總分層重加權）。
 */
export function scoreLimitStructure(input: {
  todayLimitUp: LimitUpEntry | null;
  todayBroken: BrokenEntry | null;
  /** 近 5 日（不含今日）漲停日期清單 */
  recentLimitUpDates?: string[];
  yesterdayBroken?: boolean;
  /** 今日漲跌幅 %（反包判定用） */
  todayPct?: number | null;
}): SubScoreResult | null {
  const P = SUBSCORE_PARAMS.limitStructure;
  const e = input.todayLimitUp;

  if (e) {
    // 一字板：固定分、不套任何加減分
    if (e.isOneWord) {
      return {
        score: P.oneWordScore,
        reasons: [`一字板固定 ${P.oneWordScore} 分（noFillRisk 買不進，不計封板時間/連板加分）`],
      };
    }

    const reasons: string[] = [];
    let score: number;

    // base：首封時間越早越強
    if (e.firstSealTime) {
      const tier = P.sealTimeTiers.find((t) => e.firstSealTime! < t.before);
      score = tier ? tier.base : P.lateSealBase;
      reasons.push(`首封 ${e.firstSealTime}（${tier ? tier.label : '尾盤板'}）base ${score}`);
    } else {
      score = P.unknownSealBase;
      reasons.push(`首封時間未知，取中性 base ${score}`);
    }

    // 炸板次數（null = 資料缺，不調整）
    if (e.brokenTimes !== null) {
      if (e.brokenTimes === 0) {
        score += P.brokenAdj.none;
        reasons.push(`封死未開板 +${P.brokenAdj.none}`);
      } else if (e.brokenTimes === 1) {
        score += P.brokenAdj.once;
        reasons.push(`炸板 1 次 ${P.brokenAdj.once}`);
      } else {
        score += P.brokenAdj.multi;
        reasons.push(`炸板 ${e.brokenTimes} 次 ${P.brokenAdj.multi}`);
      }
    }

    // 封單強度（封單金額/流通市值）
    if (e.sealAmountCny !== null && e.floatMvCny !== null && e.floatMvCny > 0) {
      const r = e.sealAmountCny / e.floatMvCny;
      if (r > P.sealRatio.strongMin) {
        score += P.sealRatio.strongBonus;
        reasons.push(`封單/流通市值 ${(r * 100).toFixed(1)}% 強封 +${P.sealRatio.strongBonus}`);
      } else if (r < P.sealRatio.weakMax) {
        score += P.sealRatio.weakPenalty;
        reasons.push(`封單/流通市值 ${(r * 100).toFixed(2)}% 弱封 ${P.sealRatio.weakPenalty}`);
      }
    }

    // 連板高度：2-4 板每級 +5、≥5 板高位風險 −10
    if (e.consecBoards >= P.consec.highMin) {
      score += P.consec.highPenalty;
      reasons.push(`${e.consecBoards} 連板高位風險 ${P.consec.highPenalty}`);
    } else if (e.consecBoards >= P.consec.bonusMin) {
      const bonus = (e.consecBoards - 1) * P.consec.perBoard;
      score += bonus;
      reasons.push(`${e.consecBoards} 連板 +${bonus}`);
    }

    return finalize(score, reasons);
  }

  // ── 非漲停 ──
  // 今日炸板未回封 = 最新的失敗結構事件，優先於昨日/近 5 日資訊
  if (input.todayBroken) {
    return finalize(P.todayBrokenScore, [
      `今日炸板未回封（虧錢效應）${P.todayBrokenScore} 分`,
    ]);
  }
  // 昨炸板 + 今日紅盤 = 反包雛形
  if (input.yesterdayBroken && (input.todayPct ?? 0) > 0) {
    return finalize(P.fanbao.base + P.fanbao.bonus, [
      `昨炸板今紅盤（反包雛形）base ${P.fanbao.base}+${P.fanbao.bonus}`,
    ]);
  }
  // 近 5 日有漲停 → 結構仍活躍
  if (input.recentLimitUpDates && input.recentLimitUpDates.length > 0) {
    return finalize(P.recentLimitUpBase, [
      `近 5 日漲停 ${input.recentLimitUpDates.length} 次（結構仍活躍）base ${P.recentLimitUpBase}`,
    ]);
  }
  // 無任何漲停結構事件 → 缺值
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// 2. 龍虎榜
// ────────────────────────────────────────────────────────────────────────────

/**
 * 龍虎榜席位結構子分。未上榜 → null（缺值重加權，不是 0 分）。
 * detailFetched=false（席位空陣列、summary 全 0）時退化成只看榜面淨買比 —
 * 刻意容忍，回填「全榜-only」模式也能出分。
 */
export function scoreLhb(entry: LhbStockEntry | null): SubScoreResult | null {
  if (!entry) return null;
  const P = SUBSCORE_PARAMS.lhb;
  const s = entry.seatSummary;
  const reasons: string[] = [`上榜「${entry.reason}」base ${P.base}`];
  let score = P.base;

  // 機構買席：1 席 +15、每多 1 席 +5、cap +25
  if (s.institutionBuyCount >= 1) {
    const bonus = Math.min(
      P.instBuy.first + (s.institutionBuyCount - 1) * P.instBuy.extra,
      P.instBuy.cap,
    );
    score += bonus;
    reasons.push(`機構買 ${s.institutionBuyCount} 席 +${bonus}`);
  }
  // 機構賣席
  if (s.institutionSellCount >= 1) {
    score += P.instSellPenalty;
    reasons.push(`機構賣 ${s.institutionSellCount} 席 ${P.instSellPenalty}`);
  }
  // 游資買席：1 席 +8、≥2 席合力 +12
  if (s.hotMoneyBuyCount === 1) {
    score += P.hotMoney.one;
    reasons.push(`游資買 1 席 +${P.hotMoney.one}`);
  } else if (s.hotMoneyBuyCount >= 2) {
    score += P.hotMoney.multi;
    reasons.push(`游資買 ${s.hotMoneyBuyCount} 席合力 +${P.hotMoney.multi}`);
  }
  // 一家獨大
  if (s.buyOneDominance !== null && s.buyOneDominance > P.dominance.max) {
    score += P.dominance.penalty;
    reasons.push(`買一佔買五 ${(s.buyOneDominance * 100).toFixed(0)}% 一家獨大 ${P.dominance.penalty}`);
  }
  // 散戶通道佔買五席數比
  const buySeatCount = entry.seats.buy.length;
  if (buySeatCount > 0 && s.retailProxyBuyCount / buySeatCount > P.retailRatio.max) {
    score += P.retailRatio.penalty;
    reasons.push(
      `散戶通道佔買五 ${s.retailProxyBuyCount}/${buySeatCount} 席 ${P.retailRatio.penalty}`,
    );
  }
  // 榜面淨買/當日成交額
  if (
    entry.netAmt !== null &&
    entry.accumAmount !== null &&
    entry.accumAmount > 0 &&
    entry.netAmt / entry.accumAmount > P.netToTurnover.min
  ) {
    score += P.netToTurnover.bonus;
    reasons.push(
      `榜面淨買佔成交額 ${((entry.netAmt / entry.accumAmount) * 100).toFixed(1)}% +${P.netToTurnover.bonus}`,
    );
  }
  // 量化買 ≥2 席（隔日砸風險）
  if (s.quantBuyCount >= P.quantBuy.min) {
    score += P.quantBuy.penalty;
    reasons.push(`量化買 ${s.quantBuyCount} 席（隔日砸風險）${P.quantBuy.penalty}`);
  }
  // 北向通道買
  if (s.northboundBuyCount >= 1) {
    score += P.northboundBonus;
    reasons.push(`北向通道買 ${s.northboundBuyCount} 席 +${P.northboundBonus}`);
  }

  return finalize(score, reasons);
}

// ────────────────────────────────────────────────────────────────────────────
// 3. 主力資金
// ────────────────────────────────────────────────────────────────────────────

/**
 * 主力資金子分。mainNet 缺 → null。
 * 流通市值在 → 比例制（錨點線性內插）；缺 → 絕對值粗分檔（reasons 註明）。
 * 連 3 日淨流入 +10；漲停但主力淨流出 −15（出貨板）。
 */
export function scoreMainFlow(input: {
  mainNetCny: number | null;
  freeMarketCapCny: number | null;
  consecutiveInflowDays?: number | null;
  isLimitUpToday?: boolean;
}): SubScoreResult | null {
  const P = SUBSCORE_PARAMS.mainFlow;
  const { mainNetCny, freeMarketCapCny } = input;
  if (mainNetCny === null) return null;

  const reasons: string[] = [];
  let score: number;

  if (freeMarketCapCny !== null && freeMarketCapCny > 0) {
    const ratioPct = (mainNetCny / freeMarketCapCny) * 100;
    score = lerpPiecewise(ratioPct, P.ratioAnchors);
    reasons.push(`主力淨額/流通市值 ${ratioPct.toFixed(2)}% → ${Math.round(score)}`);
  } else {
    const tier = P.absTiers.find((t) => mainNetCny > t.min);
    score = tier ? tier.score : P.absFloor;
    reasons.push(`流通市值缺值，主力淨額 ${fmtCny(mainNetCny)} → ${score}（絕對值粗分檔）`);
  }

  // 連續淨流入 ≥3 日（趨勢資金）
  if ((input.consecutiveInflowDays ?? 0) >= P.consecInflow.daysMin) {
    score += P.consecInflow.bonus;
    reasons.push(`連 ${input.consecutiveInflowDays} 日淨流入 +${P.consecInflow.bonus}`);
  }
  // 漲停但主力淨流出 = 出貨板
  if (input.isLimitUpToday && mainNetCny < 0) {
    score += P.limitUpOutflowPenalty;
    reasons.push(`漲停但主力淨流出（出貨板）${P.limitUpOutflowPenalty}`);
  }

  return finalize(score, reasons);
}

// ────────────────────────────────────────────────────────────────────────────
// 4. 人氣熱度
// ────────────────────────────────────────────────────────────────────────────

/**
 * 人氣熱度子分。未上榜 → 40（低分處理，刻意不回 null：「沒人氣」是資訊
 * 不是缺值，不該被重加權抹掉）。名次急升 >+20 或新進榜 +10。
 * 回傳型別不含 null，呼叫端可直接放進 CnSubScores。
 */
export function scoreHeat(entry: HotRankEntry | null): SubScoreResult {
  const P = SUBSCORE_PARAMS.heat;
  if (!entry) {
    return { score: P.unrankedScore, reasons: [`未上人氣榜 → ${P.unrankedScore}（低分處理，不缺值）`] };
  }

  const tier = P.rankTiers.find((t) => entry.rank <= t.max);
  let score = tier ? tier.score : P.unrankedScore; // rank >100（防呆）視同未上榜
  const reasons: string[] = [`人氣榜第 ${entry.rank} 名 base ${score}`];

  const surged = entry.rankChange !== null && entry.rankChange > P.surge.rankChangeMin;
  const fresh = entry.daysInTop100 === 1;
  if (surged || fresh) {
    score += P.surge.bonus;
    reasons.push(
      fresh
        ? `新進榜（top100 首日）+${P.surge.bonus}`
        : `名次急升 +${entry.rankChange} +${P.surge.bonus}`,
    );
  }

  return finalize(score, reasons);
}

// ────────────────────────────────────────────────────────────────────────────
// 5. 板塊強弱
// ────────────────────────────────────────────────────────────────────────────

/**
 * 板塊強弱子分（個股所屬行業板塊）。board 缺 → null。
 * base 50 + 當日漲幅×8（cap ±25）+ 板內漲停家數 + 漲幅榜名次 + 5 日趨勢。
 */
export function scoreSector(input: { board: BoardEntry | null }): SubScoreResult | null {
  const b = input.board;
  if (!b) return null;
  const P = SUBSCORE_PARAMS.sector;

  const pctComp = clamp(b.pct * P.pctMult, -P.pctCap, P.pctCap);
  let score = P.base + pctComp;
  const reasons: string[] = [
    `板塊「${b.name}」當日 ${b.pct >= 0 ? '+' : ''}${b.pct.toFixed(2)}% → ${pctComp >= 0 ? '+' : ''}${Math.round(pctComp)}`,
  ];

  // 板內漲停家數（板塊效應）
  if (b.limitUpCount !== null) {
    if (b.limitUpCount >= P.limitUp.strongMin) {
      score += P.limitUp.strongBonus;
      reasons.push(`板內漲停 ${b.limitUpCount} 家（板塊效應確立）+${P.limitUp.strongBonus}`);
    } else if (b.limitUpCount === 2) {
      score += P.limitUp.pairBonus;
      reasons.push(`板內漲停 2 家 +${P.limitUp.pairBonus}`);
    }
  }
  // 當日漲幅榜名次
  if (b.rank <= P.rankTop.max) {
    score += P.rankTop.bonus;
    reasons.push(`板塊漲幅榜第 ${b.rank} 名 +${P.rankTop.bonus}`);
  }
  // 近 5 日累計趨勢
  if (b.pct5d !== null && b.pct5d > P.pct5d.min) {
    score += P.pct5d.bonus;
    reasons.push(`近 5 日累計 +${b.pct5d.toFixed(1)}% +${P.pct5d.bonus}`);
  }

  return finalize(score, reasons);
}
