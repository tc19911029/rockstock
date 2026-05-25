/**
 * Contract test: summarizeFacetVerdicts 一句話結論
 */

import { summarizeFacetVerdicts } from '@/lib/decision/summarizeFacetVerdicts';

const EMPTY_HINTS = { technical: '', news: '', chip: '', fundamental: '' };

describe('summarizeFacetVerdicts', () => {
  test('4 pass → green + 可考慮進場', () => {
    const r = summarizeFacetVerdicts({
      technical: 'pass', news: 'pass', chip: 'pass', fundamental: 'pass', hints: EMPTY_HINTS,
    });
    expect(r.level).toBe('green');
    expect(r.conclusion).toContain('4 面向都同意');
    expect(r.counts).toEqual({ pass: 4, watch: 0, fail: 0 });
  });

  test('3 pass + 1 watch → green + 可等買點', () => {
    const r = summarizeFacetVerdicts({
      technical: 'pass', news: 'pass', chip: 'pass', fundamental: 'watch', hints: EMPTY_HINTS,
    });
    expect(r.level).toBe('green');
    expect(r.conclusion).toContain('可等買點');
  });

  test('3 pass + 1 fail → yellow + 訊號分歧', () => {
    const r = summarizeFacetVerdicts({
      technical: 'pass', news: 'pass', chip: 'pass', fundamental: 'fail', hints: EMPTY_HINTS,
    });
    expect(r.level).toBe('yellow');
    expect(r.conclusion).toContain('訊號分歧');
  });

  test('2 pass → yellow + 不夠強', () => {
    const r = summarizeFacetVerdicts({
      technical: 'pass', news: 'pass', chip: 'fail', fundamental: 'fail', hints: EMPTY_HINTS,
    });
    expect(r.level).toBe('yellow');
    expect(r.conclusion).toContain('不夠強');
  });

  test('1 pass → red + 不適合進場', () => {
    const r = summarizeFacetVerdicts({
      technical: 'pass', news: 'fail', chip: 'fail', fundamental: 'fail', hints: EMPTY_HINTS,
    });
    expect(r.level).toBe('red');
    expect(r.conclusion).toContain('不適合進場');
  });

  test('0 pass → red + 絕對不進場', () => {
    const r = summarizeFacetVerdicts({
      technical: 'fail', news: 'fail', chip: 'fail', fundamental: 'fail', hints: EMPTY_HINTS,
    });
    expect(r.level).toBe('red');
    expect(r.conclusion).toContain('絕對不進場');
  });

  test('戒律觸發 + 技術 fail → red + 書本絕對禁止（最高優先級）', () => {
    const r = summarizeFacetVerdicts({
      technical: 'fail', news: 'pass', chip: 'pass', fundamental: 'pass',
      prohibitionHit: true,
      hints: EMPTY_HINTS,
    });
    expect(r.level).toBe('red');
    expect(r.conclusion).toContain('戒律觸發');
    expect(r.conclusion).toContain('絕對禁止');
  });

  test('戒律觸發但技術 pass → 不觸發特殊規則、走一般流程', () => {
    const r = summarizeFacetVerdicts({
      technical: 'pass', news: 'pass', chip: 'pass', fundamental: 'pass',
      prohibitionHit: true,
      hints: EMPTY_HINTS,
    });
    expect(r.level).toBe('green');
    expect(r.conclusion).toContain('4 面向都同意');
  });
});
