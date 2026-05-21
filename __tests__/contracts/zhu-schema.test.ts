/**
 * Contract test: 朱老師 v2 answer schema
 *
 * 驗證 `/zhu` skill 寫出的 chart-answer.json 結構：
 *   - schemaVersion = 2
 *   - reasoning 必為陣列且涵蓋全部 8 段（trend/kbar/visual/chip/fundamental/news/macro/action）
 *   - grade ∈ A-E
 *   - lights 5 個 key 各為 green/yellow/red/gray
 *
 * 這是 LLM 輸出守門員：朱老師若漏段、寫錯 grade、忘加 schemaVersion，網頁 polling 會 reject。
 */

import type { DigestResponse, Grade, Light, ReasoningSection } from '@/lib/ai/zhuTypes';

const VALID_LIGHTS: Light[] = ['green', 'yellow', 'red', 'gray'];
const VALID_GRADES: Grade[] = ['A', 'B', 'C', 'D', 'E'];
const REQUIRED_SECTIONS: ReasoningSection[] = [
  'trend', 'kbar', 'visual', 'chip', 'fundamental', 'news', 'macro', 'action',
];

function validateDigest(d: unknown): { ok: true } | { ok: false; reason: string } {
  if (!d || typeof d !== 'object') return { ok: false, reason: 'not an object' };
  const v = d as Record<string, unknown>;

  if (v.schemaVersion !== 2) return { ok: false, reason: `schemaVersion ≠ 2 (got ${v.schemaVersion})` };

  if (typeof v.grade !== 'string' || !VALID_GRADES.includes(v.grade as Grade)) {
    return { ok: false, reason: `invalid grade: ${v.grade}` };
  }
  if (typeof v.gradeReason !== 'string') return { ok: false, reason: 'gradeReason missing' };

  if (!v.lights || typeof v.lights !== 'object') return { ok: false, reason: 'lights missing' };
  for (const key of ['technical', 'chip', 'fundamental', 'theme', 'valuation'] as const) {
    const l = (v.lights as Record<string, unknown>)[key];
    if (typeof l !== 'string' || !VALID_LIGHTS.includes(l as Light)) {
      return { ok: false, reason: `lights.${key} invalid: ${l}` };
    }
  }

  if (!Array.isArray(v.reasoning)) return { ok: false, reason: 'reasoning not array' };
  const sections = new Set((v.reasoning as Array<{ section?: string }>).map(r => r.section));
  for (const required of REQUIRED_SECTIONS) {
    if (!sections.has(required)) return { ok: false, reason: `missing reasoning section: ${required}` };
  }
  // 檢查每個 section 都有 text
  for (const item of v.reasoning as Array<{ section?: string; text?: unknown }>) {
    if (typeof item.text !== 'string' || item.text.length === 0) {
      return { ok: false, reason: `reasoning.${item.section} text missing` };
    }
  }

  if (typeof v.overview !== 'string') return { ok: false, reason: 'overview missing' };
  if (typeof v.verdict !== 'string') return { ok: false, reason: 'verdict missing' };
  if (typeof v.verdictReason !== 'string') return { ok: false, reason: 'verdictReason missing' };

  return { ok: true };
}

describe('Zhu v2 answer schema', () => {
  test('合法 answer 通過驗證', () => {
    const sample: DigestResponse = {
      schemaVersion: 2,
      grade: 'B',
      gradeReason: '技術+籌碼雙綠，基本面待觀察',
      lights: {
        technical: 'green', chip: 'green', fundamental: 'yellow',
        theme: 'green', valuation: 'yellow',
      },
      reasoning: [
        { section: 'trend', light: 'green', text: '多頭排列，頭頭高底底高' },
        { section: 'kbar', light: 'green', text: '長紅突破整理平台' },
        { section: 'visual', light: 'green', text: '量價對齊向上' },
        { section: 'chip', light: 'green', text: '外資連 3 買超 5000 張' },
        { section: 'fundamental', light: 'yellow', text: 'EPS YoY 8%，普通' },
        { section: 'news', light: 'green', text: 'AI 題材續強' },
        { section: 'macro', text: '大盤多頭，^TWII 站上 MA20' },
        { section: 'action', text: '停損 95，目標 120' },
      ],
      overview: '突破關鍵壓力，可逢回布局',
      verdict: '進場',
      verdictReason: '技術 + 籌碼 + 題材三綠',
    };
    expect(validateDigest(sample)).toEqual({ ok: true });
  });

  test('schemaVersion ≠ 2 被 reject', () => {
    const r = validateDigest({ schemaVersion: 1, grade: 'A', lights: {}, reasoning: [] });
    expect(r.ok).toBe(false);
  });

  test('grade 非 A-E 被 reject', () => {
    const r = validateDigest({ schemaVersion: 2, grade: 'X', lights: {}, reasoning: [] });
    expect(r.ok).toBe(false);
  });

  test('lights 缺 fundamental 被 reject', () => {
    const r = validateDigest({
      schemaVersion: 2, grade: 'A',
      lights: { technical: 'green', chip: 'green', theme: 'green', valuation: 'green' },
      reasoning: [],
    });
    expect(r.ok).toBe(false);
  });

  test('reasoning 漏掉 action 段被 reject', () => {
    const items = REQUIRED_SECTIONS.filter(s => s !== 'action').map(s => ({ section: s, text: 'x' }));
    const r = validateDigest({
      schemaVersion: 2, grade: 'B', gradeReason: 'r',
      lights: { technical: 'green', chip: 'green', fundamental: 'green', theme: 'green', valuation: 'green' },
      reasoning: items, overview: '', verdict: '', verdictReason: '',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('action');
  });

  test('reasoning 段 text 為空字串被 reject', () => {
    const items = REQUIRED_SECTIONS.map(s => ({ section: s, text: s === 'visual' ? '' : 'x' }));
    const r = validateDigest({
      schemaVersion: 2, grade: 'B', gradeReason: 'r',
      lights: { technical: 'green', chip: 'green', fundamental: 'green', theme: 'green', valuation: 'green' },
      reasoning: items, overview: '', verdict: '', verdictReason: '',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('visual');
  });

  test('invalid light 值被 reject', () => {
    const items = REQUIRED_SECTIONS.map(s => ({ section: s, text: 'x' }));
    const r = validateDigest({
      schemaVersion: 2, grade: 'B', gradeReason: 'r',
      lights: { technical: 'rainbow', chip: 'green', fundamental: 'green', theme: 'green', valuation: 'green' },
      reasoning: items, overview: '', verdict: '', verdictReason: '',
    });
    expect(r.ok).toBe(false);
  });
});
