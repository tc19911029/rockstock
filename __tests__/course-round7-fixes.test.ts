/**
 * 2026-07-07 課程審計收尾修正：
 * - 逐字-18 regimeExposureCap 小資族例外
 * - 逐字-22 canUpgradeToLongTerm 升級長線四線多排+末升段 gate
 */
import { regimeExposureCap, EXPOSURE_CAP_BULL, EXPOSURE_CAP_CONSOLIDATION, EXPOSURE_CAP_BEAR } from '@/lib/portfolio/positionSizer';
import { canUpgradeToLongTerm } from '@/lib/sell/v12Operation';

describe('逐字-18 regimeExposureCap 小資族例外', () => {
  it('一般資金：高檔盤整壓五成', () => {
    expect(regimeExposureCap('normal', false, 50_000_000)).toBe(EXPOSURE_CAP_CONSOLIDATION);
    expect(regimeExposureCap('strong_bull', true, 50_000_000)).toBe(EXPOSURE_CAP_CONSOLIDATION); // nearAth 壓五成
  });
  it('小資族（≤100萬）：高檔盤整不壓五成、回多頭成數', () => {
    expect(regimeExposureCap('normal', false, 800_000)).toBe(EXPOSURE_CAP_BULL);
    expect(regimeExposureCap('strong_bull', true, 500_000)).toBe(EXPOSURE_CAP_BULL);
  });
  it('空頭一律壓三成，小資也不例外', () => {
    expect(regimeExposureCap('bear', false, 500_000)).toBe(EXPOSURE_CAP_BEAR);
  });
  it('缺 totalCapital → 向下相容（不啟用例外）', () => {
    expect(regimeExposureCap('normal', false)).toBe(EXPOSURE_CAP_CONSOLIDATION);
  });
});

describe('逐字-22 canUpgradeToLongTerm 升級長線前置', () => {
  const base = { close: 115, entry: 100, mode: 'short' as const, weekly: true };
  it('獲利≥10%+短線+週線多頭+四線多排+非末升段 → 可升級', () => {
    const r = canUpgradeToLongTerm(base.close, base.entry, base.mode, base.weekly, { fourLineBullish: true, nearDoubled: false });
    expect(r.canUpgrade).toBe(true);
  });
  it('日線非四線多排 → 擋', () => {
    const r = canUpgradeToLongTerm(base.close, base.entry, base.mode, base.weekly, { fourLineBullish: false, nearDoubled: false });
    expect(r.canUpgrade).toBe(false);
    expect(r.blockedBy).toContain('四線多排');
  });
  it('漲近一倍（末升段）→ 擋', () => {
    const r = canUpgradeToLongTerm(base.close, base.entry, base.mode, base.weekly, { fourLineBullish: true, nearDoubled: true });
    expect(r.canUpgrade).toBe(false);
    expect(r.blockedBy).toContain('末升段');
  });
  it('缺 opts → 向下相容（不擋，只看 profit/mode/weekly）', () => {
    expect(canUpgradeToLongTerm(base.close, base.entry, base.mode, base.weekly).canUpgrade).toBe(true);
    expect(canUpgradeToLongTerm(105, 100, 'short', true).canUpgrade).toBe(false); // profit 5% < 10%
  });
});
