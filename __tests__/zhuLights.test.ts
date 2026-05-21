/**
 * 朱老師 5 燈號 + ABCDE 純規則單元測試
 *
 * 覆蓋：
 *   - computeChartLights：技術/籌碼/基本面/題材/估值的綠/黃/紅/灰邊界
 *   - computeScanLights：scan 模式 fundamental/valuation 強制 gray
 *   - computeGrade：A-E 各組合
 *   - lightsTotalScore：gray = 0
 */

import {
  computeChartLights,
  computeGrade,
  computeScanLights,
  lightsTotalScore,
} from '@/lib/ai/zhuLights';
import type { ChartLightsInput, ScanLightsInput, ZhuLights } from '@/lib/ai/zhuTypes';

// ── computeChartLights ────────────────────────────────────────────────────

describe('computeChartLights — technical', () => {
  const base: ChartLightsInput = {
    sixCond: 6, trendState: '多頭', closePrice: 100, ma20: 95, ma60: 90,
    longProhibitionsCount: 0,
  };
  test('全部對齊 → 綠', () => {
    expect(computeChartLights(base).technical).toBe('green');
  });
  test('趨勢空頭 → 紅', () => {
    expect(computeChartLights({ ...base, trendState: '空頭' }).technical).toBe('red');
  });
  test('戒律 ≥ 2 → 紅', () => {
    expect(computeChartLights({ ...base, longProhibitionsCount: 2 }).technical).toBe('red');
  });
  test('收盤 < MA60 → 紅', () => {
    expect(computeChartLights({ ...base, closePrice: 85 }).technical).toBe('red');
  });
  test('六條件不足 → 黃', () => {
    expect(computeChartLights({ ...base, sixCond: 4 }).technical).toBe('yellow');
  });
  test('盤整 → 黃', () => {
    expect(computeChartLights({ ...base, trendState: '盤整' }).technical).toBe('yellow');
  });
  test('MA20 缺資料但六條件 ≥ 5 + 多頭 → 綠（六條件已涵蓋 MA 排列）', () => {
    expect(computeChartLights({ ...base, ma20: null }).technical).toBe('green');
  });
  test('MA20 有資料但 close < MA20 → 黃（短線轉弱）', () => {
    expect(computeChartLights({ ...base, ma20: 105 }).technical).toBe('yellow');
  });
});

describe('computeChartLights — chip', () => {
  const base: ChartLightsInput = { chipScore: 75, consecutiveForeignBuy: 3, marginUtilRate: 20 };
  test('chipScore≥70 且外資連買 ≥ 3 → 綠', () => {
    expect(computeChartLights(base).chip).toBe('green');
  });
  test('chipScore < 40 → 紅', () => {
    expect(computeChartLights({ ...base, chipScore: 30 }).chip).toBe('red');
  });
  test('外資連賣 ≥ 3 → 紅', () => {
    expect(computeChartLights({ ...base, consecutiveForeignSell: 3 }).chip).toBe('red');
  });
  test('融資使用率 > 40 → 紅', () => {
    expect(computeChartLights({ ...base, marginUtilRate: 50 }).chip).toBe('red');
  });
  test('無 chipScore → gray', () => {
    expect(computeChartLights({}).chip).toBe('gray');
  });
});

describe('computeChartLights — fundamental', () => {
  test('EPS YoY > 20 且營收 YoY > 10 → 綠', () => {
    expect(computeChartLights({
      fundamentals: { eps: 5, epsYoY: 30, revenueMoM: 0, revenueYoY: 15, per: 20, pbr: 2, dividendYield: 2 },
    }).fundamental).toBe('green');
  });
  test('EPS 衰退 → 紅', () => {
    expect(computeChartLights({
      fundamentals: { eps: 1, epsYoY: -10, revenueMoM: 0, revenueYoY: 0, per: 20, pbr: 2, dividendYield: 2 },
    }).fundamental).toBe('red');
  });
  test('營收 YoY < -10 → 紅', () => {
    expect(computeChartLights({
      fundamentals: { eps: 5, epsYoY: 5, revenueMoM: 0, revenueYoY: -15, per: 20, pbr: 2, dividendYield: 2 },
    }).fundamental).toBe('red');
  });
  test('高殖利率 (>4%) 防守標的 → 綠（黃升綠）', () => {
    expect(computeChartLights({
      fundamentals: { eps: 5, epsYoY: 5, revenueMoM: 0, revenueYoY: 5, per: 12, pbr: 1.5, dividendYield: 5 },
    }).fundamental).toBe('green');
  });
  test('fundamentals null → gray', () => {
    expect(computeChartLights({ fundamentals: null }).fundamental).toBe('gray');
  });
  test('epsYoY/revenueYoY 都 null → gray', () => {
    expect(computeChartLights({
      fundamentals: { eps: null, epsYoY: null, revenueMoM: null, revenueYoY: null, per: 20, pbr: 2, dividendYield: 2 },
    }).fundamental).toBe('gray');
  });
});

describe('computeChartLights — theme', () => {
  test('同產業共振 (≥3 檔且自己 top5) → 綠', () => {
    expect(computeChartLights({ sectorPeers: { sameIndustryCount: 5, selfRank: 2 } }).theme).toBe('green');
  });
  test('孤鳥 (sameIndustryCount=0) → 紅', () => {
    expect(computeChartLights({ sectorPeers: { sameIndustryCount: 0, selfRank: null } }).theme).toBe('red');
  });
  test('sectorPeers null → 黃預設', () => {
    expect(computeChartLights({ sectorPeers: null }).theme).toBe('yellow');
  });
  test('共振但自己排名差 → 黃', () => {
    expect(computeChartLights({ sectorPeers: { sameIndustryCount: 5, selfRank: 8 } }).theme).toBe('yellow');
  });
});

describe('computeChartLights — valuation', () => {
  test('PER < 18 → 綠', () => {
    expect(computeChartLights({
      fundamentals: { eps: 5, epsYoY: 0, revenueMoM: 0, revenueYoY: 0, per: 15, pbr: 2, dividendYield: 2 },
    }).valuation).toBe('green');
  });
  test('PER > 35 → 紅', () => {
    expect(computeChartLights({
      fundamentals: { eps: 5, epsYoY: 0, revenueMoM: 0, revenueYoY: 0, per: 40, pbr: 2, dividendYield: 2 },
    }).valuation).toBe('red');
  });
  test('PBR > 5 → 紅', () => {
    expect(computeChartLights({
      fundamentals: { eps: 5, epsYoY: 0, revenueMoM: 0, revenueYoY: 0, per: 20, pbr: 6, dividendYield: 2 },
    }).valuation).toBe('red');
  });
  test('PER null + PBR null → gray', () => {
    expect(computeChartLights({
      fundamentals: { eps: 5, epsYoY: 0, revenueMoM: 0, revenueYoY: 0, per: null, pbr: null, dividendYield: 2 },
    }).valuation).toBe('gray');
  });
  test('fundamentals null → gray', () => {
    expect(computeChartLights({ fundamentals: null }).valuation).toBe('gray');
  });
});

// ── computeScanLights ────────────────────────────────────────────────────

describe('computeScanLights', () => {
  const base: ScanLightsInput = { sixCond: 6, trendState: '多頭' };

  test('fundamental 強制 gray（scan 無基本面資料）', () => {
    expect(computeScanLights({ ...base, chipScore: 80 }).fundamental).toBe('gray');
  });
  test('valuation 強制 gray（scan 無 PER/PBR）', () => {
    expect(computeScanLights({ ...base, chipScore: 80 }).valuation).toBe('gray');
  });
  test('technical：六條件 6 + 多頭 → 綠', () => {
    expect(computeScanLights(base).technical).toBe('green');
  });
  test('technical：空頭 → 紅', () => {
    expect(computeScanLights({ ...base, trendState: '空頭' }).technical).toBe('red');
  });
  test('technical：六條件 < 3 → 紅', () => {
    expect(computeScanLights({ sixCond: 2 }).technical).toBe('red');
  });
  test('chip：scan 模式 chipScore null → gray', () => {
    expect(computeScanLights(base).chip).toBe('gray');
  });
});

// ── computeGrade ─────────────────────────────────────────────────────────

function lightsOf(t: ZhuLights['technical'], c: ZhuLights['chip'], f: ZhuLights['fundamental'], th: ZhuLights['theme'], v: ZhuLights['valuation']): ZhuLights {
  return { technical: t, chip: c, fundamental: f, theme: th, valuation: v };
}

describe('computeGrade', () => {
  test('A：全綠 → A', () => {
    expect(computeGrade(lightsOf('green', 'green', 'green', 'green', 'green'))).toBe('A');
  });
  test('A：4 綠 1 黃 (技術綠+籌碼不紅+9 分) → A', () => {
    expect(computeGrade(lightsOf('green', 'green', 'green', 'green', 'yellow'))).toBe('A');
  });
  test('B：technical 綠 + score 7 → B', () => {
    expect(computeGrade(lightsOf('green', 'green', 'yellow', 'yellow', 'green'))).toBe('B');
  });
  test('C：score 5-6 (沒到 B 門檻) → C', () => {
    expect(computeGrade(lightsOf('yellow', 'yellow', 'yellow', 'yellow', 'yellow'))).toBe('C');
  });
  test('D：technical 紅 + fundamental 綠（基本面護身）→ D', () => {
    expect(computeGrade(lightsOf('red', 'yellow', 'green', 'yellow', 'green'))).toBe('D');
  });
  test('D：score 3-4 → D', () => {
    expect(computeGrade(lightsOf('yellow', 'yellow', 'yellow', 'red', 'red'))).toBe('D');
  });
  test('E：technical 紅 + chip 紅 → E', () => {
    expect(computeGrade(lightsOf('red', 'red', 'green', 'green', 'green'))).toBe('E');
  });
  test('E：score ≤ 2 → E', () => {
    expect(computeGrade(lightsOf('red', 'red', 'red', 'red', 'yellow'))).toBe('E');
  });
  test('fallback：≥2 燈 gray 退化 3 燈版（technical 綠 + chip 綠 + theme 綠 → A）', () => {
    // 三燈綠 + fund/val gray (2 gray) → fallback 用 3 燈：score3=6+t綠 → A
    expect(computeGrade(lightsOf('green', 'green', 'gray', 'green', 'gray'))).toBe('A');
  });
  test('fallback：技術綠 + 籌碼 gray (FinMind 拉不到) + 題材黃 → C（不再是 D）', () => {
    // 3 燈 gray → fallback：score3 = 2+0+1 = 3 → C
    expect(computeGrade(lightsOf('green', 'gray', 'gray', 'yellow', 'gray'))).toBe('C');
  });
  test('5 燈完整版（≤1 燈 gray）走原規則：4 綠 1 gray (score=8+技綠+籌不紅) → B', () => {
    // 4 綠 1 gray → grayCount=1 不退化 → score=8 + technical=green → B
    expect(computeGrade(lightsOf('green', 'green', 'green', 'green', 'gray'))).toBe('B');
  });
});

describe('lightsTotalScore', () => {
  test('gray 算 0 分', () => {
    expect(lightsTotalScore(lightsOf('gray', 'gray', 'gray', 'gray', 'gray'))).toBe(0);
  });
  test('全綠 = 10', () => {
    expect(lightsTotalScore(lightsOf('green', 'green', 'green', 'green', 'green'))).toBe(10);
  });
  test('全黃 = 5', () => {
    expect(lightsTotalScore(lightsOf('yellow', 'yellow', 'yellow', 'yellow', 'yellow'))).toBe(5);
  });
});
