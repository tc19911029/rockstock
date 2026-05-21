/**
 * 5 燈號與 ABCDE 等級的純規則計算 — chart 模式 + scan 模式共用引擎
 *
 * 設計準則：
 *   1. 純 function，無 I/O、無 console、無 LLM call，輸入決定輸出
 *   2. chart 模式吃 ChartLightsInput（含 fundamentals/news），scan 模式吃 ScanLightsInput
 *   3. 缺資料的面向回 'gray'（讓前端顯示「—」），不要強行猜
 *   4. computeGrade 從 5 燈號機械算 A-E，朱老師在 chart 模式可覆寫
 *
 * 為什麼用純規則 + 朱老師可覆寫的混合架構（見計畫文件 §核心架構）：
 *   - 純機械避免 LLM 多欄位輸出自打嘴巴（lights 跟 reasoning 矛盾）
 *   - 朱老師可覆寫保留書本立場（例：MA 排列綠燈但平頭破底必須翻紅）
 */

import type {
  ChartLightsInput,
  Grade,
  Light,
  ScanLightsInput,
  ZhuLights,
} from './zhuTypes';

// ── chart 模式（含基本面） ─────────────────────────────────────────────────

function technicalLightChart(input: ChartLightsInput): Light {
  const { sixCond, trendState, closePrice, ma20, ma60, longProhibitionsCount = 0 } = input;
  if (trendState === '空頭') return 'red';
  if (longProhibitionsCount >= 2) return 'red';
  if (closePrice != null && ma60 != null && closePrice < ma60) return 'red';
  // 六條件 ≥ 5 + 多頭 → 綠（六條件已涵蓋 MA 排列，MA20 close 比較只是備援）
  if (sixCond != null && sixCond >= 5 && trendState === '多頭') {
    // 若 MA20 有資料且 close < MA20 → 退黃（短線轉弱訊號）
    if (closePrice != null && ma20 != null && closePrice < ma20) return 'yellow';
    return 'green';
  }
  return 'yellow';
}

function chipLightChart(input: ChartLightsInput): Light {
  const { chipScore, consecutiveForeignBuy = 0, consecutiveForeignSell = 0, marginUtilRate } = input;
  if (chipScore == null) return 'gray';
  if (chipScore < 40) return 'red';
  if (consecutiveForeignSell >= 3) return 'red';
  if (marginUtilRate != null && marginUtilRate > 40) return 'red';
  if (chipScore >= 70 && consecutiveForeignBuy >= 3) return 'green';
  return 'yellow';
}

function fundamentalLightChart(input: ChartLightsInput): Light {
  const f = input.fundamentals;
  if (!f) return 'gray';
  const { epsYoY, revenueYoY, dividendYield } = f;
  // 紅：EPS 衰退 或 營收年減
  if ((epsYoY != null && epsYoY < 0) || (revenueYoY != null && revenueYoY < -10)) return 'red';
  // 綠：成長雙正
  if (epsYoY != null && epsYoY > 20 && revenueYoY != null && revenueYoY > 10) return 'green';
  // 殖利率 > 4% 防守標的 → 黃升綠
  if (dividendYield != null && dividendYield > 4 && (epsYoY ?? 0) >= 0) return 'green';
  if (epsYoY == null && revenueYoY == null) return 'gray';
  return 'yellow';
}

function themeLightChart(input: ChartLightsInput): Light {
  const sp = input.sectorPeers;
  if (!sp) return 'yellow';
  if (sp.sameIndustryCount === 0) return 'red';     // 孤鳥
  if (sp.sameIndustryCount >= 3 && sp.selfRank != null && sp.selfRank <= 5) return 'green';
  return 'yellow';
}

function valuationLightChart(input: ChartLightsInput): Light {
  const f = input.fundamentals;
  if (!f) return 'gray';
  const { per, pbr } = f;
  if (per == null && pbr == null) return 'gray';
  if ((per != null && per > 35) || (pbr != null && pbr > 5)) return 'red';
  if (per != null && per > 0 && per < 18) return 'green';
  return 'yellow';
}

export function computeChartLights(input: ChartLightsInput): ZhuLights {
  return {
    technical:   technicalLightChart(input),
    chip:        chipLightChart(input),
    fundamental: fundamentalLightChart(input),
    theme:       themeLightChart(input),
    valuation:   valuationLightChart(input),
  };
}

// ── scan 模式（無基本面/估值，只用候選 row 既有欄位） ────────────────────

function technicalLightScan(input: ScanLightsInput): Light {
  const { sixCond = 0, trendState, longProhibitionsCount = 0 } = input;
  if (trendState === '空頭') return 'red';
  if (longProhibitionsCount >= 2) return 'red';
  if (sixCond >= 5 && trendState === '多頭') return 'green';
  if (sixCond >= 3) return 'yellow';
  return 'red';
}

function chipLightScan(input: ScanLightsInput): Light {
  const { chipScore, consecutiveForeignBuy = 0 } = input;
  if (chipScore == null) return 'gray';
  if (chipScore < 40) return 'red';
  if (chipScore >= 70 && consecutiveForeignBuy >= 3) return 'green';
  return 'yellow';
}

function themeLightScan(input: ScanLightsInput): Light {
  const { sameIndustryCount, selfRankInIndustry } = input;
  if (sameIndustryCount == null) return 'yellow';
  if (sameIndustryCount === 0) return 'red';
  if (sameIndustryCount >= 3 && selfRankInIndustry != null && selfRankInIndustry <= 5) return 'green';
  return 'yellow';
}

/** scan 模式無 fundamentals/PER → fundamental / valuation 一律 gray */
export function computeScanLights(input: ScanLightsInput): ZhuLights {
  return {
    technical:   technicalLightScan(input),
    chip:        chipLightScan(input),
    fundamental: 'gray',
    theme:       themeLightScan(input),
    valuation:   'gray',
  };
}

// ── ABCDE 等級 ───────────────────────────────────────────────────────────

function lightScore(l: Light): number {
  if (l === 'green') return 2;
  if (l === 'yellow') return 1;
  return 0;  // red / gray
}

/**
 * 算總分（每燈 0-2，滿分 10）— 給 grade 規則 + 排序用
 * gray 算 0 分（避免缺資料的 scan 列表被誤判 A 級）
 */
export function lightsTotalScore(lights: ZhuLights): number {
  return lightScore(lights.technical)
       + lightScore(lights.chip)
       + lightScore(lights.fundamental)
       + lightScore(lights.theme)
       + lightScore(lights.valuation);
}

/**
 * Scan / fallback 模式 grade — 只看 technical / chip / theme 三盞燈
 *
 * 用途：
 *   1. scan 模式（fundamental/valuation 強制 gray，沿用 5 燈規則會塌成全 D）
 *   2. chart 模式 fallback：當 ≥2 燈 gray（FinMind / chip API 拉不到）時，
 *      退化用這套，避免「資料源環境問題就永遠 D 級」
 */
export function computeScanGradeFromLights(lights: ZhuLights): Grade {
  const t = lights.technical, c = lights.chip, th = lights.theme;
  const score3 = ([t, c, th] as Light[]).reduce(
    (s, l) => s + (l === 'green' ? 2 : l === 'yellow' ? 1 : 0),
    0,
  );
  if (t === 'red' && c === 'red') return 'E';
  if (score3 >= 5 && t === 'green') return 'A';
  if (score3 >= 4 && t === 'green') return 'B';
  if (score3 >= 3) return 'C';
  if (score3 >= 2) return 'D';
  return 'E';
}

/**
 * ABCDE 規則（chart 模式 5 燈完整版，含 fallback）
 *
 *   完整版（≤1 燈 gray 時用）：
 *     A：score ≥ 9 且 technical=綠 且 chip≠紅 — 趨勢+資金+基本面+題材都對齊
 *     B：score ≥ 7 且 technical=綠 — 短中線可做
 *     C：score 5-6，或任一面向綠但 technical=黃 — 觀察名單
 *     D：score 3-4，或 technical=紅但 fundamental=綠 — 基本面護身但短期不利
 *     E：score ≤ 2，或 technical=紅 且 chip=紅 — 避開
 *
 *   fallback（≥2 燈 gray 時退化 3 燈）：見 computeScanGradeFromLights
 */
export function computeGrade(lights: ZhuLights): Grade {
  // 資料完整度檢查：≥2 燈 gray → 退化 3 燈版
  // 避免「FinMind/chip 拉不到資料」就被永久打 D 級
  const grayCount = ([lights.technical, lights.chip, lights.fundamental, lights.theme, lights.valuation] as Light[])
    .filter(l => l === 'gray').length;
  if (grayCount >= 2) return computeScanGradeFromLights(lights);

  const score = lightsTotalScore(lights);
  const { technical, chip, fundamental } = lights;

  if (technical === 'red' && chip === 'red') return 'E';
  if (score <= 2) return 'E';
  if (score >= 9 && technical === 'green' && chip !== 'red') return 'A';
  if (score >= 7 && technical === 'green') return 'B';
  if (technical === 'red' && fundamental === 'green') return 'D';
  if (score >= 3 && score <= 4) return 'D';
  return 'C';
}
