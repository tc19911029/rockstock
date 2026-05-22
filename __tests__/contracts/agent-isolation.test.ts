/**
 * Contract test：跨 Agent 隔離原則（§0）
 *
 * 守的規則：每個 Agent 的 dataPoint category 必須在自己白名單；
 * 違反就是「Technical 寫了 chip 數據 / News 寫了技術指標」等汙染。
 *
 * 來源：lib/agents/types.ts 的 ALLOWED_CATEGORIES_BY_AGENT
 */

import { ALLOWED_CATEGORIES_BY_AGENT, DataPoint } from '@/lib/agents/types';

type AgentName = keyof typeof ALLOWED_CATEGORIES_BY_AGENT;

function check(agent: AgentName, points: DataPoint[]): { ok: true } | { ok: false; offender: number; got: string } {
  const allowed = ALLOWED_CATEGORIES_BY_AGENT[agent];
  for (let i = 0; i < points.length; i++) {
    if (!allowed.includes(points[i].category)) {
      return { ok: false, offender: i, got: points[i].category };
    }
  }
  return { ok: true };
}

const technicalSample: DataPoint[] = [
  { category: 'technical', label: 'price', value: '100', source: 'L4' },
  { category: 'technical', label: 'sixScore', value: '6/6', source: 'L4' },
];

const newsSample: DataPoint[] = [
  { category: 'news', label: 'mentionCount', value: '3', source: 'prefetch.youtube' },
  { category: 'news', label: 'rssSentiment', value: '0.2', source: 'prefetch.rss' },
];

const chipSample: DataPoint[] = [
  { category: 'chip', label: 'foreignBuy', value: '4251', source: 'prefetch.chip' },
  { category: 'chip', label: 'chipScore', value: '51', source: 'prefetch.chip' },
];

const fundamentalSample: DataPoint[] = [
  { category: 'fundamental', label: 'eps', value: '5.2', source: 'prefetch.fundamentals' },
  { category: 'valuation', label: 'per', value: '18', source: 'prefetch.fundamentals' },
  { category: 'industry', label: '產業', value: '半導體', source: 'L4.candidateRow.industry' },
];

describe('§0 Agent 隔離原則 — dataPoint category 白名單', () => {
  test('Technical Agent 只能寫 technical', () => {
    expect(check('technical', technicalSample)).toEqual({ ok: true });
  });

  test('Technical Agent 寫 chip 違反隔離', () => {
    const dps = [...technicalSample, { category: 'chip', label: 'x', value: '1', source: 'y' } as DataPoint];
    const r = check('technical', dps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.got).toBe('chip');
  });

  test('Technical Agent 寫 fundamental 違反隔離', () => {
    const dps = [...technicalSample, { category: 'fundamental', label: 'x', value: '1', source: 'y' } as DataPoint];
    expect(check('technical', dps).ok).toBe(false);
  });

  test('News Agent 只能寫 news', () => {
    expect(check('news', newsSample)).toEqual({ ok: true });
  });

  test('News Agent 寫 technical 違反隔離', () => {
    const dps = [...newsSample, { category: 'technical', label: 'x', value: '1', source: 'y' } as DataPoint];
    expect(check('news', dps).ok).toBe(false);
  });

  test('News Agent 寫 chip 違反隔離', () => {
    const dps = [...newsSample, { category: 'chip', label: 'x', value: '1', source: 'y' } as DataPoint];
    expect(check('news', dps).ok).toBe(false);
  });

  test('Chip Agent 只能寫 chip', () => {
    expect(check('chip', chipSample)).toEqual({ ok: true });
  });

  test('Chip Agent 寫 news 違反隔離', () => {
    const dps = [...chipSample, { category: 'news', label: 'x', value: '1', source: 'y' } as DataPoint];
    expect(check('chip', dps).ok).toBe(false);
  });

  test('Chip Agent 寫 fundamental 違反隔離', () => {
    const dps = [...chipSample, { category: 'fundamental', label: 'x', value: '1', source: 'y' } as DataPoint];
    expect(check('chip', dps).ok).toBe(false);
  });

  test('Fundamental Agent 可寫 fundamental + valuation + industry', () => {
    expect(check('fundamental', fundamentalSample)).toEqual({ ok: true });
  });

  test('Fundamental Agent 寫 technical 違反隔離', () => {
    const dps = [...fundamentalSample, { category: 'technical', label: 'x', value: '1', source: 'y' } as DataPoint];
    expect(check('fundamental', dps).ok).toBe(false);
  });

  test('Fundamental Agent 寫 chip 違反隔離', () => {
    const dps = [...fundamentalSample, { category: 'chip', label: 'x', value: '1', source: 'y' } as DataPoint];
    expect(check('fundamental', dps).ok).toBe(false);
  });

  test('Fundamental Agent 寫 news 違反隔離', () => {
    const dps = [...fundamentalSample, { category: 'news', label: 'x', value: '1', source: 'y' } as DataPoint];
    expect(check('fundamental', dps).ok).toBe(false);
  });

  test('白名單 sanity — 4 個 agent 都有定義', () => {
    expect(ALLOWED_CATEGORIES_BY_AGENT.technical).toEqual(['technical']);
    expect(ALLOWED_CATEGORIES_BY_AGENT.news).toEqual(['news']);
    expect(ALLOWED_CATEGORIES_BY_AGENT.chip).toEqual(['chip']);
    expect(ALLOWED_CATEGORIES_BY_AGENT.fundamental).toEqual(['fundamental', 'valuation', 'industry']);
  });
});
