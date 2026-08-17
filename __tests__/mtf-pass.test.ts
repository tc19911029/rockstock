import { passesMtf } from '@/lib/scanner/mtfPass';

describe('passesMtf', () => {
  test('final mtfPass overrides weekly-only compatibility field', () => {
    expect(passesMtf({ mtfPass: false, mtfWeeklyPass: true })).toBe(false);
    expect(passesMtf({ mtfPass: true, mtfWeeklyPass: false })).toBe(true);
  });

  test('falls back for legacy sessions and only permits missing data explicitly', () => {
    expect(passesMtf({ mtfWeeklyPass: true })).toBe(true);
    expect(passesMtf({})).toBe(false);
    expect(passesMtf({}, true)).toBe(true);
  });
});
