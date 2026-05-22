/**
 * Contract test: 朱老師 v3 answer schema
 *
 * 驗證 `/zhu` skill 寫出的 chart-answer.json 結構：
 *   - schemaVersion = 3
 *   - reasoning 必為陣列且涵蓋全部 8 段（trend/kbar/visual/chip/fundamental/news/macro/action）
 *   - dataPoints 必為陣列且 length ≥ 10（contract 門檻；目標 30+）
 *   - 每個 dataPoint 必填 category/label/value/source
 *
 * 這是 LLM 輸出守門員：朱老師若漏段、漏 dataPoints、忘加 schemaVersion，網頁 polling 會 reject。
 */

import type { DataCategory, DataPoint, DigestResponse, ReasoningSection } from '@/lib/ai/zhuTypes';

const VALID_CATEGORIES: DataCategory[] = [
  'technical', 'chip', 'fundamental', 'news',
  'macro', 'valuation', 'governance', 'industry',
];
const REQUIRED_SECTIONS: ReasoningSection[] = [
  'trend', 'kbar', 'visual', 'chip', 'fundamental', 'news', 'macro', 'action',
];
const MIN_DATAPOINTS = 30;  // contract 門檻；zhu.md 目標 80+
const MIN_PER_CATEGORY: Record<DataCategory, number> = {
  technical:   10,
  chip:        12,
  fundamental: 12,
  valuation:    6,
  news:         8,
  industry:     5,
  macro:        8,
  governance:   6,
};

function validateDigest(d: unknown): { ok: true } | { ok: false; reason: string } {
  if (!d || typeof d !== 'object') return { ok: false, reason: 'not an object' };
  const v = d as Record<string, unknown>;

  if (v.schemaVersion !== 3) return { ok: false, reason: `schemaVersion ≠ 3 (got ${v.schemaVersion})` };

  if (typeof v.overview !== 'string') return { ok: false, reason: 'overview missing' };
  if (typeof v.verdict !== 'string') return { ok: false, reason: 'verdict missing' };
  if (typeof v.verdictReason !== 'string') return { ok: false, reason: 'verdictReason missing' };

  if (!Array.isArray(v.reasoning)) return { ok: false, reason: 'reasoning not array' };
  const sections = new Set((v.reasoning as Array<{ section?: string }>).map(r => r.section));
  for (const required of REQUIRED_SECTIONS) {
    if (!sections.has(required)) return { ok: false, reason: `missing reasoning section: ${required}` };
  }
  for (const item of v.reasoning as Array<{ section?: string; text?: unknown }>) {
    if (typeof item.text !== 'string' || item.text.length === 0) {
      return { ok: false, reason: `reasoning.${item.section} text missing` };
    }
  }

  if (!Array.isArray(v.dataPoints)) return { ok: false, reason: 'dataPoints not array' };
  const dps = v.dataPoints as DataPoint[];
  if (dps.length < MIN_DATAPOINTS) {
    return { ok: false, reason: `dataPoints too few: ${dps.length} < ${MIN_DATAPOINTS}` };
  }
  for (let i = 0; i < dps.length; i++) {
    const p = dps[i];
    if (!p || typeof p !== 'object') return { ok: false, reason: `dataPoints[${i}] not object` };
    if (typeof p.category !== 'string' || !VALID_CATEGORIES.includes(p.category)) {
      return { ok: false, reason: `dataPoints[${i}].category invalid: ${p.category}` };
    }
    if (typeof p.label !== 'string' || !p.label) return { ok: false, reason: `dataPoints[${i}].label missing` };
    if (typeof p.value !== 'string' || !p.value) return { ok: false, reason: `dataPoints[${i}].value missing` };
    if (typeof p.source !== 'string' || !p.source) return { ok: false, reason: `dataPoints[${i}].source missing` };
  }

  // 逐類最低門檻檢查（避免朱老師只撈某一類大量數字湊總數）
  const perCategoryCount = new Map<DataCategory, number>();
  for (const p of dps) {
    perCategoryCount.set(p.category, (perCategoryCount.get(p.category) ?? 0) + 1);
  }
  for (const cat of VALID_CATEGORIES) {
    const got = perCategoryCount.get(cat) ?? 0;
    const need = MIN_PER_CATEGORY[cat];
    if (got < need) {
      return { ok: false, reason: `dataPoints[${cat}] too few: ${got} < ${need}` };
    }
  }

  return { ok: true };
}

/**
 * 預設按 MIN_PER_CATEGORY 對應筆數產出，恰好滿足 contract 最低門檻
 * 想模擬不足時，傳 overrides 改某類筆數
 */
function makeDataPoints(overrides?: Partial<Record<DataCategory, number>>): DataPoint[] {
  const out: DataPoint[] = [];
  for (const cat of VALID_CATEGORIES) {
    const n = overrides?.[cat] ?? MIN_PER_CATEGORY[cat];
    for (let i = 0; i < n; i++) {
      out.push({
        category: cat,
        label: `${cat}-${i}`,
        value: `${i * 1.5}`,
        source: 'WebSearch: 鉅亨網 + MoneyDJ (2 來源一致)',
        asOf: '2026-05-21',
      });
    }
  }
  return out;
}

describe('Zhu v3 answer schema', () => {
  test('合法 answer 通過驗證', () => {
    const sample: DigestResponse = {
      schemaVersion: 3,
      overview: '突破關鍵壓力',
      verdict: '進場',
      verdictReason: '技術 + 籌碼 + 題材三綠',
      caveat: '若大盤反轉則退場',
      reasoning: [
        { section: 'trend', text: '日線多頭，5/19 突破前高 152.5（prefetch.ohlcv），週線連 3 紅（screenshot）' },
        { section: 'kbar', text: '當日長紅實體 4.2%（screenshot），量增 1.8 倍（prefetch.ohlcv 5/21）' },
        { section: 'visual', text: '上影線短、下影線無，量價同步向上（screenshot）；缺口 148-150（screenshot）' },
        { section: 'chip', text: '外資 5/19-5/21 連 3 買超 8,420 張（prefetch.institutional）；融資餘額 12.3 萬張（prefetch.chip）' },
        { section: 'fundamental', text: 'EPS YoY +25.3%（prefetch.fundamentals 2026Q1）；月營收 YoY +18.2%（WebSearch: MOPS 5/10）' },
        { section: 'news', text: '5/20 法說財測上修 10%（WebSearch: 鉅亨網）；摩根目標價 180 元（WebSearch: 工商 5/19）' },
        { section: 'macro', text: '^TWII 多頭站上 MA20（prefetch.marketTrend）；US 10Y 4.32%（WebSearch: investing.com 5/21）' },
        { section: 'action', text: '進場價 152，停損 145（-4.6%），目標 175（+15%）' },
      ],
      dataPoints: makeDataPoints(),
    };
    expect(validateDigest(sample)).toEqual({ ok: true });
  });

  test('schemaVersion ≠ 3 被 reject', () => {
    const r = validateDigest({ schemaVersion: 2, reasoning: [], dataPoints: [] });
    expect(r.ok).toBe(false);
  });

  test('reasoning 漏掉 action 段被 reject', () => {
    const items = REQUIRED_SECTIONS.filter(s => s !== 'action').map(s => ({ section: s, text: 'x' }));
    const r = validateDigest({
      schemaVersion: 3, overview: '', verdict: '', verdictReason: '',
      reasoning: items, dataPoints: makeDataPoints(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('action');
  });

  test('reasoning 段 text 為空字串被 reject', () => {
    const items = REQUIRED_SECTIONS.map(s => ({ section: s, text: s === 'visual' ? '' : 'x' }));
    const r = validateDigest({
      schemaVersion: 3, overview: '', verdict: '', verdictReason: '',
      reasoning: items, dataPoints: makeDataPoints(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('visual');
  });

  test('dataPoints 總數少於 30 筆被 reject', () => {
    const items = REQUIRED_SECTIONS.map(s => ({ section: s, text: 'x' }));
    // 每類各 1 筆 = 8 筆，遠少於 30 門檻
    const dps = makeDataPoints({
      technical: 1, chip: 1, fundamental: 1, valuation: 1,
      news: 1, industry: 1, macro: 1, governance: 1,
    });
    const r = validateDigest({
      schemaVersion: 3, overview: '', verdict: '', verdictReason: '',
      reasoning: items, dataPoints: dps,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('dataPoints too few');
  });

  test('某類少於門檻被 reject（technical 不足）', () => {
    const items = REQUIRED_SECTIONS.map(s => ({ section: s, text: 'x' }));
    // 總筆數夠（> 30），但 technical 只給 5 筆（門檻 10）
    const dps = makeDataPoints({ technical: 5 });
    const r = validateDigest({
      schemaVersion: 3, overview: '', verdict: '', verdictReason: '',
      reasoning: items, dataPoints: dps,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('technical');
  });

  test('某類少於門檻被 reject（chip 不足）', () => {
    const items = REQUIRED_SECTIONS.map(s => ({ section: s, text: 'x' }));
    const dps = makeDataPoints({ chip: 6 });
    const r = validateDigest({
      schemaVersion: 3, overview: '', verdict: '', verdictReason: '',
      reasoning: items, dataPoints: dps,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('chip');
  });

  test('dataPoints[i].category 非法被 reject', () => {
    const items = REQUIRED_SECTIONS.map(s => ({ section: s, text: 'x' }));
    const dps = makeDataPoints();
    (dps[3] as { category: string }).category = 'rainbow';
    const r = validateDigest({
      schemaVersion: 3, overview: '', verdict: '', verdictReason: '',
      reasoning: items, dataPoints: dps,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('category invalid');
  });

  test('dataPoints[i].source 空字串被 reject', () => {
    const items = REQUIRED_SECTIONS.map(s => ({ section: s, text: 'x' }));
    const dps = makeDataPoints();
    dps[7].source = '';
    const r = validateDigest({
      schemaVersion: 3, overview: '', verdict: '', verdictReason: '',
      reasoning: items, dataPoints: dps,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('source missing');
  });

  test('dataPoints 為非 array 被 reject', () => {
    const items = REQUIRED_SECTIONS.map(s => ({ section: s, text: 'x' }));
    const r = validateDigest({
      schemaVersion: 3, overview: '', verdict: '', verdictReason: '',
      reasoning: items, dataPoints: 'not an array' as unknown,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('dataPoints not array');
  });
});
