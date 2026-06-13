/**
 * 陸股情緒系統 P2 — 子分計分器單元測試（純 fixture，零網路 / 零 IO）
 *
 * 覆蓋重點：
 *   scoreLimitStructure — 封板時間分檔 / 一字板固定分 / 連板加減 / 反包 / null 缺值
 *   scoreLhb — 機構買 cap / 散戶通道席數比 / 一家獨大 / 未上榜 null
 *   scoreMainFlow — 比例線性內插 / 絕對值粗分檔 / 出貨板懲罰
 *   scoreHeat — 未上榜低分不缺值 / 名次分檔 / 新進榜 bonus
 *   scoreSector — pct cap / 板內漲停分檔 / null 缺值
 */

import {
  scoreHeat,
  scoreLhb,
  scoreLimitStructure,
  scoreMainFlow,
  scoreSector,
} from '@/lib/cn-agents/subScores';
import type {
  BoardEntry,
  BrokenEntry,
  HotRankEntry,
  LhbStockEntry,
  LimitUpEntry,
  SeatTrade,
  SeatType,
} from '@/lib/cn-agents/types';

// ── fixture builders ─────────────────────────────────────────────────────────

function lu(over: Partial<LimitUpEntry> = {}): LimitUpEntry {
  return {
    symbol: '000032',
    name: '深桑達Ａ',
    board: 'SZ-main',
    pct: 10.0,
    close: 20.5,
    turnoverCny: 5e8,
    floatMvCny: 5e9,
    sealAmountCny: 2e7,
    firstSealTime: '09:35:00',
    lastSealTime: '09:35:00',
    brokenTimes: 0,
    consecBoards: 1,
    boardsPattern: null,
    industry: '軟體服務',
    isOneWord: false,
    isST: false,
    ...over,
  };
}

function bk(over: Partial<BrokenEntry> = {}): BrokenEntry {
  return {
    symbol: '000032',
    name: '深桑達Ａ',
    board: 'SZ-main',
    pct: 4.1,
    close: 19.2,
    brokenTimes: 2,
    firstSealTime: '10:05:00',
    industry: '軟體服務',
    isST: false,
    ...over,
  };
}

function seat(type: SeatType, over: Partial<SeatTrade> = {}): SeatTrade {
  return {
    deptCode: 'D0001',
    deptName: '測試營業部',
    buyAmt: 1e7,
    sellAmt: 0,
    netAmt: 1e7,
    type,
    label: null,
    ...over,
  };
}

function lhbEntry(over: Partial<LhbStockEntry> = {}): LhbStockEntry {
  return {
    code: '000032',
    name: '深桑達Ａ',
    board: 'SZ-main',
    close: 20.5,
    changeRate: 10.0,
    reason: '日漲幅偏離值達7%的證券',
    tradeId: '1',
    netAmt: 5e7, // 5% of accumAmount → 不觸發 >10% bonus
    buyAmt: 2e8,
    sellAmt: 1.5e8,
    accumAmount: 1e9,
    freeMarketCap: 8e9,
    turnoverRate: 12.3,
    fwd: { d1: null, d2: null, d5: null, d10: null },
    seats: { buy: [], sell: [] },
    seatSummary: {
      hotMoneyBuyCount: 0,
      institutionBuyCount: 0,
      institutionSellCount: 0,
      retailProxyBuyCount: 0,
      quantBuyCount: 0,
      northboundBuyCount: 0,
      buyOneDominance: null,
    },
    ...over,
  };
}

function hot(over: Partial<HotRankEntry> = {}): HotRankEntry {
  return {
    symbol: '000032',
    name: '深桑達Ａ',
    rank: 50,
    rankYesterday: 52,
    rankChange: 2,
    daysInTop100: 3,
    ...over,
  };
}

function boardEntry(over: Partial<BoardEntry> = {}): BoardEntry {
  return {
    code: 'BK0737',
    name: '軟體開發',
    kind: 'industry',
    pct: 1.0,
    turnoverCny: 5e10,
    mainNetCny: 1e9,
    upCount: 30,
    downCount: 10,
    leaderSymbol: '000032',
    leaderName: '深桑達Ａ',
    leaderPct: 10.0,
    limitUpCount: 0,
    rank: 20,
    pct5d: 1.0,
    ...over,
  };
}

// ── scoreLimitStructure ──────────────────────────────────────────────────────

describe('scoreLimitStructure', () => {
  it('早盤秒板 + 封死 + 強封單 + 2 連板 → 加滿 clamp 100', () => {
    const r = scoreLimitStructure({
      todayLimitUp: lu({
        firstSealTime: '09:35:00', // base 85
        brokenTimes: 0, // +10
        sealAmountCny: 1.5e8, // /5e9 = 3% > 2% → +10
        consecBoards: 2, // +5
      }),
      todayBroken: null,
    });
    expect(r).not.toBeNull();
    expect(r!.score).toBe(100); // 110 → clamp 100
  });

  it('尾盤板 + 炸 2 次 + 弱封單 → 50−15−5 = 30', () => {
    const r = scoreLimitStructure({
      todayLimitUp: lu({
        firstSealTime: '14:45:00', // base 50
        brokenTimes: 2, // −15
        sealAmountCny: 2e7, // /5e9 = 0.4% < 0.5% → −5
        consecBoards: 1,
      }),
      todayBroken: null,
    });
    expect(r!.score).toBe(30);
  });

  it('封板時間邊界：09:40:00 落入 <10:30 檔 base 75', () => {
    const r = scoreLimitStructure({
      todayLimitUp: lu({
        firstSealTime: '09:40:00',
        brokenTimes: null, // 缺值不調整
        sealAmountCny: null, // 缺值不調整
        consecBoards: 1,
      }),
      todayBroken: null,
    });
    expect(r!.score).toBe(75);
  });

  it('≥5 連板高位風險 −10：85+10−10 = 85', () => {
    const r = scoreLimitStructure({
      todayLimitUp: lu({
        firstSealTime: '09:30:00', // base 85
        brokenTimes: 0, // +10
        sealAmountCny: null, // skip
        consecBoards: 6, // −10
      }),
      todayBroken: null,
    });
    expect(r!.score).toBe(85);
  });

  it('一字板固定 60，不計封板時間/連板加分，reasons 註明買不進', () => {
    const r = scoreLimitStructure({
      todayLimitUp: lu({
        isOneWord: true,
        firstSealTime: '09:25:00',
        brokenTimes: 0,
        sealAmountCny: 5e8,
        consecBoards: 3,
      }),
      todayBroken: null,
    });
    expect(r!.score).toBe(60);
    expect(r!.reasons.join('')).toContain('買不進');
  });

  it('非漲停：昨炸板今紅盤 → 反包雛形 70', () => {
    const r = scoreLimitStructure({
      todayLimitUp: null,
      todayBroken: null,
      yesterdayBroken: true,
      todayPct: 2.1,
    });
    expect(r!.score).toBe(70);
  });

  it('非漲停：今日炸板未回封 → 45（優先於近 5 日漲停）', () => {
    const r = scoreLimitStructure({
      todayLimitUp: null,
      todayBroken: bk(),
      recentLimitUpDates: ['2026-06-10'],
    });
    expect(r!.score).toBe(45);
  });

  it('非漲停：近 5 日有漲停 → 55', () => {
    const r = scoreLimitStructure({
      todayLimitUp: null,
      todayBroken: null,
      recentLimitUpDates: ['2026-06-09', '2026-06-11'],
    });
    expect(r!.score).toBe(55);
  });

  it('非漲停：昨炸板但今日綠盤、無近期漲停 → null 缺值', () => {
    const r = scoreLimitStructure({
      todayLimitUp: null,
      todayBroken: null,
      yesterdayBroken: true,
      todayPct: -1.5,
      recentLimitUpDates: [],
    });
    expect(r).toBeNull();
  });
});

// ── scoreLhb ─────────────────────────────────────────────────────────────────

describe('scoreLhb', () => {
  it('未上榜 → null（缺值重加權，不是 0 分）', () => {
    expect(scoreLhb(null)).toBeNull();
  });

  it('機構買 3 席（cap +25）+ 北向 1 席 → 50+25+6 = 81', () => {
    const r = scoreLhb(
      lhbEntry({
        seatSummary: {
          hotMoneyBuyCount: 0,
          institutionBuyCount: 3, // 15+5+5 = 25（剛好 cap）
          institutionSellCount: 0,
          retailProxyBuyCount: 0,
          quantBuyCount: 0,
          northboundBuyCount: 1, // +6
          buyOneDominance: 0.3,
        },
      }),
    );
    expect(r!.score).toBe(81);
  });

  it('機構買 4 席仍 cap +25 → 81', () => {
    const r = scoreLhb(
      lhbEntry({
        seatSummary: {
          hotMoneyBuyCount: 0,
          institutionBuyCount: 4, // 15+5×3=30 → cap 25
          institutionSellCount: 0,
          retailProxyBuyCount: 0,
          quantBuyCount: 0,
          northboundBuyCount: 1,
          buyOneDominance: null,
        },
      }),
    );
    expect(r!.score).toBe(81);
  });

  it('散戶通道佔買五 2/5 席（>30%）+ 一家獨大 → 50−15−10 = 25', () => {
    const r = scoreLhb(
      lhbEntry({
        seats: {
          buy: [
            seat('retail_proxy'),
            seat('retail_proxy'),
            seat('unknown'),
            seat('unknown'),
            seat('unknown'),
          ],
          sell: [],
        },
        seatSummary: {
          hotMoneyBuyCount: 0,
          institutionBuyCount: 0,
          institutionSellCount: 0,
          retailProxyBuyCount: 2,
          quantBuyCount: 0,
          northboundBuyCount: 0,
          buyOneDominance: 0.6, // >0.5 → −10
        },
      }),
    );
    expect(r!.score).toBe(25);
  });

  it('游資 2 席合力 + 榜面淨買佔成交 15% → 50+12+10 = 72', () => {
    const r = scoreLhb(
      lhbEntry({
        netAmt: 1.5e8,
        accumAmount: 1e9,
        seatSummary: {
          hotMoneyBuyCount: 2, // +12
          institutionBuyCount: 0,
          institutionSellCount: 0,
          retailProxyBuyCount: 0,
          quantBuyCount: 0,
          northboundBuyCount: 0,
          buyOneDominance: 0.4,
        },
      }),
    );
    expect(r!.score).toBe(72);
  });

  it('量化買 2 席 + 機構賣 1 席 → 50−8−12 = 30', () => {
    const r = scoreLhb(
      lhbEntry({
        seatSummary: {
          hotMoneyBuyCount: 0,
          institutionBuyCount: 0,
          institutionSellCount: 1, // −12
          retailProxyBuyCount: 0,
          quantBuyCount: 2, // −8
          northboundBuyCount: 0,
          buyOneDominance: null,
        },
      }),
    );
    expect(r!.score).toBe(30);
  });
});

// ── scoreMainFlow ────────────────────────────────────────────────────────────

describe('scoreMainFlow', () => {
  it('mainNet 缺值 → null', () => {
    expect(scoreMainFlow({ mainNetCny: null, freeMarketCapCny: 5e9 })).toBeNull();
  });

  it('比例 2% → 錨點 (1,70)-(3,85) 線性內插 = 77.5 → 78', () => {
    const r = scoreMainFlow({ mainNetCny: 2e8, freeMarketCapCny: 1e10 });
    expect(r!.score).toBe(78);
  });

  it('比例 5%（>3% 封頂 85）+ 連 3 日淨流入 → 95', () => {
    const r = scoreMainFlow({
      mainNetCny: 5e8,
      freeMarketCapCny: 1e10,
      consecutiveInflowDays: 3,
    });
    expect(r!.score).toBe(95);
  });

  it('漲停但主力淨流出（出貨板）：−0.5% → 50，再 −15 = 35', () => {
    const r = scoreMainFlow({
      mainNetCny: -5e7,
      freeMarketCapCny: 1e10,
      isLimitUpToday: true,
    });
    expect(r!.score).toBe(35);
    expect(r!.reasons.join('')).toContain('出貨板');
  });

  it('流通市值缺 → 絕對值粗分檔：5000 萬 > 3000 萬 → 60，reasons 註明粗分檔', () => {
    const r = scoreMainFlow({ mainNetCny: 5e7, freeMarketCapCny: null });
    expect(r!.score).toBe(60);
    expect(r!.reasons.join('')).toContain('粗分檔');
  });

  it('流通市值缺 + 淨流出 −5000 萬（≤−3000 萬）→ 地板 30', () => {
    const r = scoreMainFlow({ mainNetCny: -5e7, freeMarketCapCny: null });
    expect(r!.score).toBe(30);
  });
});

// ── scoreHeat ────────────────────────────────────────────────────────────────

describe('scoreHeat', () => {
  it('未上榜 → 40（低分處理，不缺值）', () => {
    const r = scoreHeat(null);
    expect(r.score).toBe(40);
  });

  it('rank 5（≤10）穩定在榜 → 85', () => {
    const r = scoreHeat(hot({ rank: 5, rankChange: 2, daysInTop100: 3 }));
    expect(r.score).toBe(85);
  });

  it('rank 80 新進榜（daysInTop100=1）→ 50+10 = 60', () => {
    const r = scoreHeat(hot({ rank: 80, rankChange: null, daysInTop100: 1 }));
    expect(r.score).toBe(60);
  });

  it('rank 25 名次急升 +40 → 70+10 = 80', () => {
    const r = scoreHeat(hot({ rank: 25, rankChange: 40, daysInTop100: 4 }));
    expect(r.score).toBe(80);
  });

  it('rank 120（防呆出界）視同未上榜 40', () => {
    const r = scoreHeat(hot({ rank: 120, rankChange: 0, daysInTop100: 2 }));
    expect(r.score).toBe(40);
  });
});

// ── scoreSector ──────────────────────────────────────────────────────────────

describe('scoreSector', () => {
  it('board 缺值 → null', () => {
    expect(scoreSector({ board: null })).toBeNull();
  });

  it('強板塊：pct 4%（cap +25）+ 漲停 5 家 + rank 2 + 5 日 +6% → clamp 100', () => {
    const r = scoreSector({
      board: boardEntry({ pct: 4.0, limitUpCount: 5, rank: 2, pct5d: 6.0 }),
    });
    expect(r!.score).toBe(100); // 50+25+15+10+5 = 105 → 100
  });

  it('弱板塊：pct −3.5%（cap −25）其餘無 bonus → 25', () => {
    const r = scoreSector({
      board: boardEntry({ pct: -3.5, limitUpCount: 0, rank: 40, pct5d: -2.0 }),
    });
    expect(r!.score).toBe(25);
  });

  it('中性板塊：pct 0.5%（+4）+ 板內漲停 2 家（+8）→ 62', () => {
    const r = scoreSector({
      board: boardEntry({ pct: 0.5, limitUpCount: 2, rank: 10, pct5d: 1.0 }),
    });
    expect(r!.score).toBe(62);
  });

  it('limitUpCount null（概念板 P2 前）→ 不調整：pct 1% → 58', () => {
    const r = scoreSector({
      board: boardEntry({ pct: 1.0, limitUpCount: null, rank: 20, pct5d: null }),
    });
    expect(r!.score).toBe(58);
  });
});
