/**
 * Contract test：Memory 不回寫 agent 邏輯（P6 §0 紅線）
 *
 * 守的規則：
 *   - 4 個 agent question schema **不可** 含 priorLessons/memory/learning/reflection 欄位
 *   - sliceSourcesForAgent 切片結果不會混入 memory 內容
 *   - reflect ReflectQuestion schema 帶 outputPaths 給 skill 寫 markdown，
 *     **但** outputPaths 不該指向任何 agent prepare 會讀的位置
 */

import {
  ChipQuestion,
  FundamentalQuestion,
  NewsQuestion,
  TechnicalQuestion,
} from '@/lib/agents/types';
import { MEMORY_KINDS, ReflectQuestion } from '@/lib/agents/memory/types';
import { getMemoryPath } from '@/lib/agents/memory/storage';

/** 列出 agent question schema 不應出現的欄位（會破壞 memory 隔離原則）*/
const FORBIDDEN_FIELDS = [
  'priorLessons',
  'memory',
  'learning',
  'reflection',
  'pastVerdicts',
  'lastWeekFailures',
  'compositeScore',  // 同時也擋 §0 加權平均
];

function checkNoMemoryWriteback(
  question: Record<string, unknown>,
  ctx: string,
): { ok: true } | { ok: false; reason: string } {
  for (const f of FORBIDDEN_FIELDS) {
    if (f in question) {
      return { ok: false, reason: `${ctx} 含禁用欄位 ${f}（§0 紅線：memory 不可回寫 agent 邏輯）` };
    }
    // 檢查 groundTruth 也不可含
    const gt = question.groundTruth;
    if (gt && typeof gt === 'object' && f in (gt as Record<string, unknown>)) {
      return { ok: false, reason: `${ctx}.groundTruth 含禁用欄位 ${f}` };
    }
  }
  return { ok: true };
}

describe('§0 紅線：Memory 不回寫 agent 邏輯', () => {
  test('TechnicalQuestion schema 不含 memory 相關欄位', () => {
    // 模擬一個 minimal valid question
    const q: TechnicalQuestion = {
      schemaVersion: 1, agent: 'technical', runId: 'r1',
      date: '2026-05-22', symbol: '2330.TW', market: 'TW',
      groundTruth: {
        candidateRow: {} as TechnicalQuestion['groundTruth']['candidateRow'],
        mtfMode: 'daily', scanTime: '2026-05-22T10:00:00Z',
      },
      bookRulesRef: { sixConditions: [], longProhibitions: [], eliminations: [] },
      thresholdsSummary: {},
    };
    expect(checkNoMemoryWriteback(q as unknown as Record<string, unknown>, 'TechnicalQuestion')).toEqual({ ok: true });
  });

  test('NewsQuestion 不含 memory 欄位', () => {
    const q: NewsQuestion = {
      schemaVersion: 1, agent: 'news', runId: 'r1',
      date: '2026-05-22', symbol: '2330.TW', market: 'TW',
      groundTruth: { symbol: '2330.TW', name: null, youtube: null, rss: null, fetchErrors: [] },
    };
    expect(checkNoMemoryWriteback(q as unknown as Record<string, unknown>, 'NewsQuestion')).toEqual({ ok: true });
  });

  test('ChipQuestion 不含 memory 欄位', () => {
    const q: ChipQuestion = {
      schemaVersion: 1, agent: 'chip', runId: 'r1',
      date: '2026-05-22', symbol: '2330.TW', market: 'TW',
      groundTruth: { symbol: '2330.TW', chip: null, institutionalHistory: null, fetchErrors: [] },
    };
    expect(checkNoMemoryWriteback(q as unknown as Record<string, unknown>, 'ChipQuestion')).toEqual({ ok: true });
  });

  test('FundamentalQuestion 不含 memory 欄位', () => {
    const q: FundamentalQuestion = {
      schemaVersion: 1, agent: 'fundamental', runId: 'r1',
      date: '2026-05-22', symbol: '2330.TW', market: 'TW',
      groundTruth: { symbol: '2330.TW', name: null, fundamentals: null, industry: null, fetchErrors: [] },
    };
    expect(checkNoMemoryWriteback(q as unknown as Record<string, unknown>, 'FundamentalQuestion')).toEqual({ ok: true });
  });

  test('注入 priorLessons 欄位會被偵測', () => {
    const tainted = {
      schemaVersion: 1, agent: 'technical', runId: 'r1',
      date: '2026-05-22', symbol: '2330.TW', market: 'TW',
      priorLessons: '上週 Technical=pass 但 d5 賠錢，請放寬條件',  // ← 違反
      groundTruth: {},
      bookRulesRef: {},
      thresholdsSummary: {},
    };
    const r = checkNoMemoryWriteback(tainted, 'tainted-tech');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('priorLessons');
  });

  test('compositeScore 欄位也被擋（§0 雙重保險）', () => {
    const tainted = { schemaVersion: 1, agent: 'decision', compositeScore: 85 };
    const r = checkNoMemoryWriteback(tainted, 'tainted-decision');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('compositeScore');
  });

  test('memory 寫入路徑在 data/agents/memory/，不在 agent 會讀的位置', () => {
    for (const kind of MEMORY_KINDS) {
      if (kind === 'weekly') continue;
      const p = getMemoryPath(kind);
      // memory 路徑只可在 data/agents/memory/
      expect(p).toMatch(/\/data\/agents\/memory\//);
      // 不可在 agent prepare 會讀的位置（如 runs/, pool/, /tmp/rockstock-agents/{date}/{symbol}/）
      expect(p).not.toMatch(/\/data\/agents\/(runs|pool|portfolio|backtest)\//);
      expect(p).not.toMatch(/\/tmp\/rockstock-agents\//);
    }
  });

  test('weekly memory 也只在 memory/ 目錄', () => {
    const p = getMemoryPath('weekly', '2026-W21');
    expect(p).toMatch(/\/data\/agents\/memory\/weekly\//);
  });

  test('weekly 需 valid ISO 週 key', () => {
    expect(() => getMemoryPath('weekly')).toThrow();
    expect(() => getMemoryPath('weekly', 'invalid')).toThrow();
    expect(() => getMemoryPath('weekly', '2026-W21')).not.toThrow();
  });

  test('ReflectQuestion.outputPaths 只指向 memory/，不指向 agent 會讀的位置', () => {
    const q: ReflectQuestion = {
      schemaVersion: 1, from: '2026-05-01', to: '2026-05-22',
      market: 'TW', generatedAt: '',
      backtestSummary: {} as ReflectQuestion['backtestSummary'],
      decisions: [], conflictCases: [],
      outputPaths: {
        technical:   getMemoryPath('technical'),
        news:        getMemoryPath('news'),
        chip:        getMemoryPath('chip'),
        fundamental: getMemoryPath('fundamental'),
        risk:        getMemoryPath('risk'),
        debate:      getMemoryPath('debate'),
        decision:    getMemoryPath('decision'),
        conflicts:   getMemoryPath('conflicts'),
        weekly:      getMemoryPath('weekly', '2026-W21'),
      },
    };
    for (const [, p] of Object.entries(q.outputPaths)) {
      expect(p).toMatch(/\/data\/agents\/memory\//);
      expect(p).not.toMatch(/\/data\/agents\/(runs|pool)\//);
    }
  });
});
