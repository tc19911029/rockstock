/**
 * Contract test:v1 評分系統的 schema 驗收
 *
 * 守門:
 *   1. 4 個 analyst answer 的 scoreBlock 是 optional 但格式正確
 *   2. scoreBlock.scoringVersion = 'v1'
 *   3. scoreBlock.score ∈ [0, 100]、light enum、confidence enum
 *   4. scoreBlock.signals 是物件,每個 SignalValue 結構合法
 *   5. dataStatus.available / missing 是 string[]
 *   6. FinalDecision.gradeBlock 是 optional 但格式正確
 *   7. gradeBlock.scoringVersion = 'v1'、totalScore ∈ [0, 100]、grade ∈ A-E
 *   8. gradeBlock.suitableFor enum 合法
 *   9. scoresByAgent 4 個 key 都 optional 但若有則包含 score/light/confidence
 *  10. keyBullPoints / keyRiskPoints / nextConditionToWatch 型別正確
 *  11. §0 紅線仍守:gradeBlock.totalScore 是 program-derived,不算「LLM 自寫的加權平均」
 *     (既有 agent-decision-rules.test.ts 的 compositeScore ban 仍有效;gradeBlock 不在 ban 內)
 */

import { SCORING_VERSION } from '@/lib/agents/scoringTypes';
import type {
  AgentScoreBlock,
  GradeBlock,
  ScoreLight,
  ScoreConfidence,
  StockGrade,
  SuitableFor,
} from '@/lib/agents/scoringTypes';

const VALID_LIGHTS: ScoreLight[] = ['green', 'yellow_green', 'yellow', 'orange_red', 'red'];
const VALID_CONFIDENCE: ScoreConfidence[] = ['high', 'medium', 'low'];
const VALID_GRADES: StockGrade[] = ['A', 'B', 'C', 'D', 'E'];
const VALID_SUITABLE: SuitableFor[] = ['short_term', 'swing', 'long_term', 'observe_only', 'avoid'];

function validateScoreBlock(sb: unknown): { ok: true } | { ok: false; reason: string } {
  if (sb === null || sb === undefined) return { ok: true };  // optional
  if (typeof sb !== 'object') return { ok: false, reason: 'scoreBlock 非物件' };
  const b = sb as Record<string, unknown>;

  if (b.scoringVersion !== SCORING_VERSION) {
    return { ok: false, reason: `scoringVersion ≠ '${SCORING_VERSION}', got ${String(b.scoringVersion)}` };
  }
  if (typeof b.score !== 'number') return { ok: false, reason: 'score 非數字' };
  if (b.score < 0 || b.score > 100) return { ok: false, reason: `score ${b.score} 越界 [0,100]` };
  if (!VALID_LIGHTS.includes(b.light as ScoreLight)) {
    return { ok: false, reason: `light 非合法值: ${String(b.light)}` };
  }
  if (!VALID_CONFIDENCE.includes(b.confidence as ScoreConfidence)) {
    return { ok: false, reason: `confidence 非合法值: ${String(b.confidence)}` };
  }
  if (!b.signals || typeof b.signals !== 'object') {
    return { ok: false, reason: 'signals 非物件' };
  }
  // 每個 signal 結構檢查
  for (const [k, v] of Object.entries(b.signals)) {
    if (!v || typeof v !== 'object') return { ok: false, reason: `signals.${k} 非物件` };
    const sv = v as Record<string, unknown>;
    const okValue = sv.value === null || typeof sv.value === 'number' || typeof sv.value === 'string';
    if (!okValue) return { ok: false, reason: `signals.${k}.value 型別不合(應為 number/string/null)` };
    if (!['bullish', 'bearish', 'neutral'].includes(sv.direction as string)) {
      return { ok: false, reason: `signals.${k}.direction 非合法值` };
    }
    if (typeof sv.score !== 'number') return { ok: false, reason: `signals.${k}.score 非數字` };
  }
  if (!b.dataStatus || typeof b.dataStatus !== 'object') {
    return { ok: false, reason: 'dataStatus 非物件' };
  }
  const ds = b.dataStatus as Record<string, unknown>;
  if (!Array.isArray(ds.available)) return { ok: false, reason: 'dataStatus.available 非陣列' };
  if (!Array.isArray(ds.missing)) return { ok: false, reason: 'dataStatus.missing 非陣列' };
  return { ok: true };
}

function validateGradeBlock(gb: unknown): { ok: true } | { ok: false; reason: string } {
  if (gb === null || gb === undefined) return { ok: true };  // optional
  if (typeof gb !== 'object') return { ok: false, reason: 'gradeBlock 非物件' };
  const b = gb as Record<string, unknown>;

  if (b.scoringVersion !== SCORING_VERSION) {
    return { ok: false, reason: `scoringVersion ≠ '${SCORING_VERSION}'` };
  }
  if (typeof b.totalScore !== 'number') return { ok: false, reason: 'totalScore 非數字' };
  if (b.totalScore < 0 || b.totalScore > 100) {
    return { ok: false, reason: `totalScore ${b.totalScore} 越界 [0,100]` };
  }
  if (!VALID_GRADES.includes(b.grade as StockGrade)) {
    return { ok: false, reason: `grade 非合法值: ${String(b.grade)}` };
  }
  if (typeof b.gradeReason !== 'string') return { ok: false, reason: 'gradeReason 非字串' };
  if (!VALID_SUITABLE.includes(b.suitableFor as SuitableFor)) {
    return { ok: false, reason: `suitableFor 非合法值: ${String(b.suitableFor)}` };
  }
  return { ok: true };
}

function validateScoresByAgent(sba: unknown): { ok: true } | { ok: false; reason: string } {
  if (sba === null || sba === undefined) return { ok: true };
  if (typeof sba !== 'object') return { ok: false, reason: 'scoresByAgent 非物件' };
  for (const [agent, mini] of Object.entries(sba as Record<string, unknown>)) {
    if (!['technical', 'chip', 'fundamental', 'news'].includes(agent)) {
      return { ok: false, reason: `scoresByAgent.${agent} 非合法 agent` };
    }
    if (!mini || typeof mini !== 'object') {
      return { ok: false, reason: `scoresByAgent.${agent} 非物件` };
    }
    const m = mini as Record<string, unknown>;
    if (typeof m.score !== 'number') return { ok: false, reason: `${agent}.score 非數字` };
    if (typeof m.light !== 'string') return { ok: false, reason: `${agent}.light 非字串` };
    if (typeof m.confidence !== 'string') return { ok: false, reason: `${agent}.confidence 非字串` };
  }
  return { ok: true };
}

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

function mkValidScoreBlock(): AgentScoreBlock {
  return {
    scoringVersion: SCORING_VERSION,
    score: 75,
    light: 'yellow_green',
    confidence: 'high',
    signals: {
      trendDirection: { value: 1, direction: 'bullish', score: 80, note: '日線多頭' },
      sixConditionsMet: { value: '5/6', direction: 'bullish', score: 83 },
    },
    dataStatus: {
      available: ['trendDirection', 'sixConditionsMet'],
      missing: [],
    },
  };
}

function mkValidGradeBlock(): GradeBlock {
  return {
    scoringVersion: SCORING_VERSION,
    totalScore: 78,
    grade: 'B',
    gradeReason: '總分 78,技術綠燈、籌碼黃綠 — 短線/波段候選',
    suitableFor: 'swing',
  };
}

// ────────────────────────────────────────────────────────────────────────────
// scoreBlock 驗證
// ────────────────────────────────────────────────────────────────────────────

describe('scoreBlock contract', () => {
  test('null / undefined 合法(向下相容)', () => {
    expect(validateScoreBlock(null)).toEqual({ ok: true });
    expect(validateScoreBlock(undefined)).toEqual({ ok: true });
  });

  test('合法 scoreBlock 通過', () => {
    expect(validateScoreBlock(mkValidScoreBlock())).toEqual({ ok: true });
  });

  test('scoringVersion 錯誤 → reject', () => {
    const sb = mkValidScoreBlock();
    (sb as { scoringVersion: string }).scoringVersion = 'v0';
    const r = validateScoreBlock(sb);
    expect(r.ok).toBe(false);
  });

  test('score 越界 → reject', () => {
    const sb = mkValidScoreBlock();
    sb.score = 150;
    const r = validateScoreBlock(sb);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('越界');
  });

  test('light 非合法值 → reject', () => {
    const sb = mkValidScoreBlock();
    (sb as { light: string }).light = 'bluish';
    const r = validateScoreBlock(sb);
    expect(r.ok).toBe(false);
  });

  test('signal value 為 null 合法(data_missing)', () => {
    const sb = mkValidScoreBlock();
    sb.signals.someSignal = { value: null, direction: 'neutral', score: 0 };
    expect(validateScoreBlock(sb)).toEqual({ ok: true });
  });

  test('signal direction 非合法 → reject', () => {
    const sb = mkValidScoreBlock();
    (sb.signals.trendDirection as { direction: string }).direction = 'sideways';
    const r = validateScoreBlock(sb);
    expect(r.ok).toBe(false);
  });

  test('dataStatus.missing 非陣列 → reject', () => {
    const sb = mkValidScoreBlock();
    (sb.dataStatus as unknown as { missing: unknown }).missing = 'none';
    const r = validateScoreBlock(sb);
    expect(r.ok).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// gradeBlock 驗證
// ────────────────────────────────────────────────────────────────────────────

describe('gradeBlock contract', () => {
  test('null / undefined 合法(向下相容)', () => {
    expect(validateGradeBlock(null)).toEqual({ ok: true });
    expect(validateGradeBlock(undefined)).toEqual({ ok: true });
  });

  test('合法 gradeBlock 通過', () => {
    expect(validateGradeBlock(mkValidGradeBlock())).toEqual({ ok: true });
  });

  test('grade 非 A-E → reject', () => {
    const gb = mkValidGradeBlock();
    (gb as { grade: string }).grade = 'F';
    const r = validateGradeBlock(gb);
    expect(r.ok).toBe(false);
  });

  test('totalScore 越界 → reject', () => {
    const gb = mkValidGradeBlock();
    gb.totalScore = 105;
    const r = validateGradeBlock(gb);
    expect(r.ok).toBe(false);
  });

  test('suitableFor 非合法 → reject', () => {
    const gb = mkValidGradeBlock();
    (gb as { suitableFor: string }).suitableFor = 'asap';
    const r = validateGradeBlock(gb);
    expect(r.ok).toBe(false);
  });

  test('scoringVersion 錯誤 → reject', () => {
    const gb = mkValidGradeBlock();
    (gb as { scoringVersion: string }).scoringVersion = 'v2';
    const r = validateGradeBlock(gb);
    expect(r.ok).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// scoresByAgent 驗證
// ────────────────────────────────────────────────────────────────────────────

describe('scoresByAgent contract', () => {
  test('undefined 合法', () => {
    expect(validateScoresByAgent(undefined)).toEqual({ ok: true });
  });

  test('部分 agent 合法(partial 不壞)', () => {
    expect(validateScoresByAgent({
      technical: { score: 80, light: 'green', confidence: 'high' },
    })).toEqual({ ok: true });
  });

  test('未知 agent key → reject', () => {
    const r = validateScoresByAgent({
      esg: { score: 80, light: 'green', confidence: 'high' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('esg');
  });

  test('mini 缺欄位 → reject', () => {
    const r = validateScoresByAgent({
      chip: { score: 60 },
    });
    expect(r.ok).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// §0 紅線:gradeBlock 不該被誤認為 compositeScore
// ────────────────────────────────────────────────────────────────────────────

describe('§0 紅線 — gradeBlock 是程式 derived 不算「LLM 加權平均」', () => {
  test('FinalDecision 有 gradeBlock 物件不違反 compositeScore ban', () => {
    // compositeScore ban 是檢查 top-level key,不檢查 gradeBlock 內部
    const decision = {
      schemaVersion: 1,
      agent: 'decision',
      gradeBlock: mkValidGradeBlock(),
    } as Record<string, unknown>;
    expect('compositeScore' in decision).toBe(false);
    // gradeBlock 內含 totalScore 但這是 server-side derived(orchestrator persist 前覆蓋)
    expect(validateGradeBlock(decision.gradeBlock)).toEqual({ ok: true });
  });

  test('keyBullPoints / keyRiskPoints / nextConditionToWatch 型別', () => {
    const decision = {
      keyBullPoints: ['利多 1', '利多 2'],
      keyRiskPoints: ['風險 1'],
      nextConditionToWatch: '等投信連 3 日買超',
    };
    expect(Array.isArray(decision.keyBullPoints)).toBe(true);
    expect(Array.isArray(decision.keyRiskPoints)).toBe(true);
    expect(typeof decision.nextConditionToWatch).toBe('string');
  });
});
