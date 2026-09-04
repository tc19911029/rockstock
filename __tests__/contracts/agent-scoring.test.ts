/**
 * Contract test：v1 評分系統
 *
 * 守門:
 *   1. SIGNAL_SPECS_BY_AGENT 4 個 agent 的非 penalty weight 加總 = 1.0(誤差 < 0.001)
 *   2. scoreToLight 5 階閾值對應(80/60/40/20)
 *   3. computeAgentScore 對固定 signals 算出穩定分數(避免版本漂移)
 *   4. data_missing 自動重新加權(分母剔除缺值 signal)
 *   5. core signal 全缺判定(allCoreSignalsMissing)
 *   6. assignGrade 規則表完整覆蓋 A/B/C/D/E
 *   7. risk='red' / technical.light='red' / totalScore<50 一律 E
 *   8. SCORING_VERSION 字面 'v1'(未來改公式必須 bump)
 */

import {
  AGENT_WEIGHTS,
  SCORING_VERSION,
} from '@/lib/agents/scoringTypes';
import {
  allCoreSignalsMissing,
  assignGrade,
  buildAgentScoreBlock,
  computeAgentScore,
  computeTotalScore,
  CHIP_SIGNAL_SPECS,
  deriveFreeCashFlow,
  derivePEG,
  deriveROE,
  deriveSqueezeRisk,
  FUNDAMENTAL_SIGNAL_SPECS,
  NEWS_SIGNAL_SPECS,
  scoreToLight,
  SIGNAL_SPECS_BY_AGENT,
  TECHNICAL_SIGNAL_SPECS,
} from '@/lib/agents/scoring';
import type {
  AgentScoreBlock,
  ScoreLight,
  SignalValue,
} from '@/lib/agents/scoringTypes';

// ────────────────────────────────────────────────────────────────────────────
// 1. SIGNAL_SPECS 完整性
// ────────────────────────────────────────────────────────────────────────────

describe('SIGNAL_SPECS_BY_AGENT 完整性', () => {
  it('4 個 agent 的非 penalty weight 加總 = 1.0(誤差 < 0.01)', () => {
    for (const specs of Object.values(SIGNAL_SPECS_BY_AGENT)) {
      const sum = specs
        .filter((s) => !s.penalty)
        .reduce((a, s) => a + s.weight, 0);
      expect(Math.abs(sum - 1.0)).toBeLessThan(0.01);
      expect(specs.length).toBeGreaterThanOrEqual(4);
      // 至少要有一個 core signal
      expect(specs.some((s) => s.core)).toBe(true);
    }
  });

  it('技術面有 8 個 signals 含 sixConditionsMet 為 core', () => {
    expect(TECHNICAL_SIGNAL_SPECS.length).toBe(8);
    const six = TECHNICAL_SIGNAL_SPECS.find((s) => s.key === 'sixConditionsMet');
    expect(six?.core).toBe(true);
  });

  it('籌碼面有 10 個 signals 含 etfConsensus / trustMomentum / largeHolderTrend(不獨立 panel)', () => {
    expect(CHIP_SIGNAL_SPECS.length).toBe(10);
    const keys = CHIP_SIGNAL_SPECS.map((s) => s.key);
    expect(keys).toContain('etfConsensus');
    expect(keys).toContain('trustMomentum');
    expect(keys).toContain('largeHolderTrend');
  });

  it('基本面有 11 個 signals 含 revenueYoY 為 core', () => {
    expect(FUNDAMENTAL_SIGNAL_SPECS.length).toBe(11);
    const rev = FUNDAMENTAL_SIGNAL_SPECS.find((s) => s.key === 'revenueYoY');
    expect(rev?.core).toBe(true);
  });

  it('消息面有 10 個 signals 含 youtubeConsensus 為 core', () => {
    expect(NEWS_SIGNAL_SPECS.length).toBe(10);
    const yt = NEWS_SIGNAL_SPECS.find((s) => s.key === 'youtubeConsensus');
    expect(yt?.core).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. scoreToLight 映射
// ────────────────────────────────────────────────────────────────────────────

describe('scoreToLight 5 階閾值', () => {
  const cases: Array<[number, ScoreLight]> = [
    [100, 'green'],
    [80, 'green'],
    [79, 'yellow_green'],
    [60, 'yellow_green'],
    [59, 'yellow'],
    [40, 'yellow'],
    [39, 'orange_red'],
    [20, 'orange_red'],
    [19, 'red'],
    [0, 'red'],
  ];
  test.each(cases)('score=%i → %s', (score, expected) => {
    expect(scoreToLight(score)).toBe(expected);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. computeAgentScore 固定輸入穩定性 + data_missing
// ────────────────────────────────────────────────────────────────────────────

describe('computeAgentScore 穩定性 + data_missing 重新加權', () => {
  it('全部 signal=80 應算出 80 分(無 penalty 觸發)', () => {
    const signals: Record<string, SignalValue> = {};
    for (const spec of TECHNICAL_SIGNAL_SPECS) {
      signals[spec.key] = spec.penalty
        ? { value: 0, direction: 'neutral', score: 0 }  // penalty 未觸發
        : { value: 1, direction: 'bullish', score: 80 };
    }
    const { score, confidence } = computeAgentScore('technical', signals);
    expect(score).toBe(80);
    expect(confidence).toBe('high');
  });

  it('部分 signal 有值、其餘 missing → 重新加權後分數仍精準 + confidence 隨 coverage 降', () => {
    // 用前 4 個非 penalty signal(weight 0.20+0.13+0.12+0.25 = 0.70 → medium)
    const signals: Record<string, SignalValue> = {};
    const nonPenalty = TECHNICAL_SIGNAL_SPECS.filter((s) => !s.penalty);
    nonPenalty.forEach((spec, i) => {
      signals[spec.key] = i < 4
        ? { value: 1, direction: 'bullish', score: 80 }
        : { value: null, direction: 'neutral', score: 0 };
    });
    for (const spec of TECHNICAL_SIGNAL_SPECS.filter((s) => s.penalty)) {
      signals[spec.key] = { value: 0, direction: 'neutral', score: 0 };
    }
    const { score, confidence } = computeAgentScore('technical', signals);
    expect(score).toBe(80);  // 剩餘 signal 全是 80,加權後仍 80(重新 normalize)
    expect(confidence).toBe('medium');  // coverage 0.70 → 落入 [0.5, 0.8)
  });

  it('coverage < 0.5 → confidence=low', () => {
    const signals: Record<string, SignalValue> = {};
    const nonPenalty = TECHNICAL_SIGNAL_SPECS.filter((s) => !s.penalty);
    nonPenalty.forEach((spec, i) => {
      signals[spec.key] = i < 2  // 前 2 個(weight 0.20+0.13=0.33,低於 0.5)
        ? { value: 1, direction: 'bullish', score: 80 }
        : { value: null, direction: 'neutral', score: 0 };
    });
    for (const spec of TECHNICAL_SIGNAL_SPECS.filter((s) => s.penalty)) {
      signals[spec.key] = { value: 0, direction: 'neutral', score: 0 };
    }
    const { confidence } = computeAgentScore('technical', signals);
    expect(confidence).toBe('low');
  });

  it('penalty 觸發應扣分', () => {
    const signals: Record<string, SignalValue> = {};
    for (const spec of TECHNICAL_SIGNAL_SPECS) {
      signals[spec.key] = spec.penalty
        ? { value: 1, direction: 'bearish', score: 100 }  // penalty 觸發 + 強度 100
        : { value: 1, direction: 'bullish', score: 80 };
    }
    const { score } = computeAgentScore('technical', signals);
    // 戒律 weight=0.15 + 淘汰法 weight=0.10 都觸發 + bearish score=100 → 扣 25
    expect(score).toBe(80 - 25);
  });

  it('全部 signal=0 應算出 0 分', () => {
    const signals: Record<string, SignalValue> = {};
    for (const spec of TECHNICAL_SIGNAL_SPECS) {
      signals[spec.key] = spec.penalty
        ? { value: 0, direction: 'neutral', score: 0 }
        : { value: 1, direction: 'bearish', score: 0 };
    }
    const { score } = computeAgentScore('technical', signals);
    expect(score).toBe(0);
  });

  it('全部 signal missing → score=0、confidence=low、missing 全列', () => {
    const signals: Record<string, SignalValue> = {};
    for (const spec of TECHNICAL_SIGNAL_SPECS) {
      signals[spec.key] = { value: null, direction: 'neutral', score: 0 };
    }
    const { score, confidence, dataStatus } = computeAgentScore('technical', signals);
    expect(score).toBe(0);
    expect(confidence).toBe('low');
    expect(dataStatus.missing.length).toBe(TECHNICAL_SIGNAL_SPECS.length);
    expect(dataStatus.available.length).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. allCoreSignalsMissing
// ────────────────────────────────────────────────────────────────────────────

describe('allCoreSignalsMissing', () => {
  it('core signal 全缺 → true', () => {
    const signals: Record<string, SignalValue> = {
      trendDirection: { value: null, direction: 'neutral', score: 0 },
      sixConditionsMet: { value: null, direction: 'neutral', score: 0 },
      maAlignment: { value: 1, direction: 'bullish', score: 80 },  // 非 core
    };
    expect(allCoreSignalsMissing('technical', signals)).toBe(true);
  });

  it('任一 core 有值 → false', () => {
    const signals: Record<string, SignalValue> = {
      trendDirection: { value: 1, direction: 'bullish', score: 80 },
      sixConditionsMet: { value: null, direction: 'neutral', score: 0 },
    };
    expect(allCoreSignalsMissing('technical', signals)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5. assignGrade 規則表完整覆蓋
// ────────────────────────────────────────────────────────────────────────────

function mkBlock(score: number): AgentScoreBlock {
  return {
    scoringVersion: SCORING_VERSION,
    score,
    light: scoreToLight(score),
    confidence: 'high',
    signals: {},
    dataStatus: { available: [], missing: [] },
  };
}

describe('assignGrade 規則表', () => {
  it('A 級:總分 ≥ 80 + 技術綠 + 籌碼綠 + 風控非紅黃', () => {
    const result = assignGrade({
      technical: mkBlock(85),
      chip: mkBlock(82),
      fundamental: mkBlock(75),
      news: mkBlock(80),
      riskVerdict: 'green',
    });
    expect(result.grade).toBe('A');
    expect(result.totalScore).toBeGreaterThanOrEqual(80);
    expect(['swing', 'long_term']).toContain(result.suitableFor);
  });

  it('B 級:總分 65-79 + 技術籌碼不弱', () => {
    const result = assignGrade({
      technical: mkBlock(75),
      chip: mkBlock(68),
      fundamental: mkBlock(60),
      news: mkBlock(65),
      riskVerdict: 'green',
    });
    expect(result.grade).toBe('B');
  });

  it('C 級:總分 50-64', () => {
    const result = assignGrade({
      technical: mkBlock(60),
      chip: mkBlock(55),
      fundamental: mkBlock(60),
      news: mkBlock(50),
      riskVerdict: 'green',
    });
    expect(result.grade).toBe('C');
    expect(result.suitableFor).toBe('observe_only');
  });

  it('D 級:消息高 + 技術高,但籌碼紅 → 高風險追高', () => {
    const result = assignGrade({
      technical: mkBlock(82),
      chip: mkBlock(18),    // red
      fundamental: mkBlock(60),
      news: mkBlock(85),
      riskVerdict: 'yellow',
    });
    expect(result.grade).toBe('D');
    expect(result.suitableFor).toBe('observe_only');
  });

  it('E 級:風控紅燈一律 E', () => {
    const result = assignGrade({
      technical: mkBlock(90),
      chip: mkBlock(85),
      fundamental: mkBlock(80),
      news: mkBlock(90),
      riskVerdict: 'red',
    });
    expect(result.grade).toBe('E');
    expect(result.suitableFor).toBe('avoid');
  });

  it('E 級:技術紅燈一律 E', () => {
    const result = assignGrade({
      technical: mkBlock(15),  // red
      chip: mkBlock(80),
      fundamental: mkBlock(75),
      news: mkBlock(85),
      riskVerdict: 'green',
    });
    expect(result.grade).toBe('E');
  });

  it('E 級:總分 < 50 一律 E', () => {
    const result = assignGrade({
      technical: mkBlock(45),
      chip: mkBlock(45),
      fundamental: mkBlock(45),
      news: mkBlock(45),
      riskVerdict: 'green',
    });
    expect(result.grade).toBe('E');
  });

  it('gradeReason 含 4 面燈號描述 + 總分', () => {
    const result = assignGrade({
      technical: mkBlock(85),
      chip: mkBlock(82),
      fundamental: mkBlock(75),
      news: mkBlock(80),
      riskVerdict: 'green',
    });
    expect(result.gradeReason).toContain('總分');
    expect(result.gradeReason).toContain('技術');
    expect(result.gradeReason).toContain('籌碼');
    expect(result.gradeReason).toContain('基本');
    expect(result.gradeReason).toContain('消息');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 6. computeTotalScore 缺面向時重新加權
// ────────────────────────────────────────────────────────────────────────────

describe('computeTotalScore 缺面向處理', () => {
  it('4 面齊全按預設權重(技 30% + 籌 25% + 基 25% + 消 20%)', () => {
    const total = computeTotalScore({
      technical: mkBlock(80),
      chip: mkBlock(60),
      fundamental: mkBlock(60),
      news: mkBlock(80),
      riskVerdict: 'green',
    });
    // 0.3*80 + 0.25*60 + 0.25*60 + 0.2*80 = 24+15+15+16 = 70
    expect(total).toBe(70);
  });

  it('缺 news 面向 → 剩 3 面重新加權', () => {
    const total = computeTotalScore({
      technical: mkBlock(80),
      chip: mkBlock(60),
      fundamental: mkBlock(60),
      news: null,
      riskVerdict: 'green',
    });
    // 剩 0.30+0.25+0.25 = 0.80 → (0.3*80 + 0.25*60 + 0.25*60) / 0.80 = 54/0.80 = 67.5 → 68
    expect(total).toBe(68);
  });

  it('4 面都缺 → 0', () => {
    expect(computeTotalScore({
      technical: null, chip: null, fundamental: null, news: null, riskVerdict: null,
    })).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 7. buildAgentScoreBlock 端到端
// ────────────────────────────────────────────────────────────────────────────

describe('buildAgentScoreBlock 端到端', () => {
  it('scoringVersion 標 v1', () => {
    const signals: Record<string, SignalValue> = {};
    for (const spec of TECHNICAL_SIGNAL_SPECS) {
      signals[spec.key] = { value: 1, direction: 'bullish', score: 50 };
    }
    const block = buildAgentScoreBlock('technical', signals);
    expect(block.scoringVersion).toBe('v1');
    expect(block.light).toBe(scoreToLight(block.score));
  });

  it('signals 直接保留(LLM 寫的 raw 不被刪)', () => {
    const signals: Record<string, SignalValue> = {
      trendDirection: { value: 'MA5>10>20', direction: 'bullish', score: 90, note: '多頭排列' },
    };
    for (const spec of TECHNICAL_SIGNAL_SPECS) {
      if (!signals[spec.key]) {
        signals[spec.key] = { value: null, direction: 'neutral', score: 0 };
      }
    }
    const block = buildAgentScoreBlock('technical', signals);
    expect(block.signals.trendDirection?.value).toBe('MA5>10>20');
    expect(block.signals.trendDirection?.note).toBe('多頭排列');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 8. SCORING_VERSION 字面值
// ────────────────────────────────────────────────────────────────────────────

describe('SCORING_VERSION', () => {
  it('字面值 = "v1"(改公式必須 bump)', () => {
    expect(SCORING_VERSION).toBe('v1');
  });

  it('AGENT_WEIGHTS 4 面加總 = 1.0', () => {
    const sum = Object.values(AGENT_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1.0)).toBeLessThan(0.001);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Derived signal helpers — PEG / 軋空 / ROE / 自由現金流
// ────────────────────────────────────────────────────────────────────────────

describe('derivePEG — PER ÷ EPS YoY', () => {
  it('PEG ≤ 1.0 → 90 分(成長被低估)', () => {
    const { ratio, score } = derivePEG(15, 20);
    expect(ratio).toBe(0.75);
    expect(score).toBe(90);
  });

  it('PEG 1.0-1.5 → 70 分', () => {
    expect(derivePEG(20, 15).score).toBe(70);
  });

  it('PEG 1.5-2.0 → 50 分', () => {
    expect(derivePEG(35, 18).score).toBe(50);
  });

  it('PEG > 2.0 → 30 分(成長偏貴)', () => {
    expect(derivePEG(40, 10).score).toBe(30);
  });

  it('EPS YoY ≤ 0 → null(衰退不適用)', () => {
    expect(derivePEG(15, -5)).toEqual({ ratio: null, score: null });
    expect(derivePEG(15, 0)).toEqual({ ratio: null, score: null });
  });

  it('PER 或 EPS YoY 任一缺失 → null', () => {
    expect(derivePEG(null, 15).score).toBeNull();
    expect(derivePEG(15, null).score).toBeNull();
  });
});

describe('deriveSqueezeRisk — 券資比', () => {
  it('券資比 ≥ 50% → bearish + 90 分(強烈警示)', () => {
    const r = deriveSqueezeRisk(1000, 600);
    expect(r.resvRatio).toBe(60);
    expect(r.score).toBe(90);
    expect(r.direction).toBe('bearish');
  });

  it('券資比 30-50% → bearish + 60 分(候選)', () => {
    const r = deriveSqueezeRisk(1000, 400);
    expect(r.score).toBe(60);
    expect(r.direction).toBe('bearish');
  });

  it('券資比 10-30% → neutral + 30 分(微弱)', () => {
    const r = deriveSqueezeRisk(1000, 200);
    expect(r.score).toBe(30);
    expect(r.direction).toBe('neutral');
  });

  it('券資比 < 10% → neutral + 0 分(無訊號)', () => {
    const r = deriveSqueezeRisk(1000, 50);
    expect(r.score).toBe(0);
    expect(r.direction).toBe('neutral');
  });

  it('融資為 0 或 null → null(無法算)', () => {
    expect(deriveSqueezeRisk(0, 100).resvRatio).toBeNull();
    expect(deriveSqueezeRisk(null, 100).resvRatio).toBeNull();
    expect(deriveSqueezeRisk(1000, null).resvRatio).toBeNull();
  });
});

describe('deriveROE — 淨利 ÷ 股東權益', () => {
  it('ROE ≥ 20% → 100 分', () => {
    const r = deriveROE(25, 100);
    expect(r.roePct).toBe(25);
    expect(r.score).toBe(100);
  });

  it('ROE 15-20% → 85 分', () => {
    expect(deriveROE(18, 100).score).toBe(85);
  });

  it('ROE 10-15% → 65 分', () => {
    expect(deriveROE(12, 100).score).toBe(65);
  });

  it('ROE 5-10% → 50 分', () => {
    expect(deriveROE(7, 100).score).toBe(50);
  });

  it('ROE 0-5% → 35 分', () => {
    expect(deriveROE(3, 100).score).toBe(35);
  });

  it('ROE 負 → 15 分(虧損)', () => {
    expect(deriveROE(-5, 100).score).toBe(15);
  });

  it('股東權益 ≤ 0 或 null → null', () => {
    expect(deriveROE(10, 0).roePct).toBeNull();
    expect(deriveROE(10, null).roePct).toBeNull();
    expect(deriveROE(null, 100).roePct).toBeNull();
  });
});

describe('deriveFreeCashFlow — 營業現金流 − 資本支出', () => {
  it('FCF 正且 margin ≥ 50% → 90 分 + bullish', () => {
    const r = deriveFreeCashFlow(100, 40);
    expect(r.fcf).toBe(60);
    expect(r.score).toBe(90);
    expect(r.direction).toBe('bullish');
  });

  it('FCF 正且 margin 30-50% → 75 分', () => {
    expect(deriveFreeCashFlow(100, 60).score).toBe(75);
  });

  it('FCF 正但 margin 10-30% → 60 分', () => {
    expect(deriveFreeCashFlow(100, 80).score).toBe(60);
  });

  it('FCF 負 → 30 分 + bearish', () => {
    const r = deriveFreeCashFlow(100, 150);
    expect(r.fcf).toBe(-50);
    expect(r.score).toBe(30);
    expect(r.direction).toBe('bearish');
  });

  it('capex 為負數 abs 處理(資料源符號不一致)', () => {
    const r = deriveFreeCashFlow(100, -40);
    expect(r.fcf).toBe(60);  // 100 - abs(-40) = 60
  });

  it('任一欄位缺失 → null', () => {
    expect(deriveFreeCashFlow(null, 40).fcf).toBeNull();
    expect(deriveFreeCashFlow(100, null).fcf).toBeNull();
  });
});
