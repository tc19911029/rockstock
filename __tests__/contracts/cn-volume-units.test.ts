/**
 * 合約：陸股量單位規則不可回歸
 *
 * 騰訊（fqkline 歷史 + qt.gtimg 即時）量單位板塊敏感：
 *   科創板(688/689) 回「股」、主板/創業板回「手」。
 * 2026-07-03 事故：TencentHistProvider 對 CN 一律 ×100 → 379 檔科創 L1 量灌成 100 倍、
 * 成交額索引 top800 被科創塞 379 席（見記憶 cn_star_board_volume_x100_pollution）。
 *
 * EM（push2 f5/f47）對所有板塊含科創都是「手」→ EastMoney 的 ×100 是對的，此測試不管它。
 */
import { tencentVolumeMultiplier } from '@/lib/datasource/TencentHistProvider';

describe('騰訊 K 線量單位（科創回股、其餘回手）', () => {
  it('科創板 688/689 不可 ×100（騰訊已回股）', () => {
    expect(tencentVolumeMultiplier('sh688981', true)).toBe(1);
    expect(tencentVolumeMultiplier('sh688008', true)).toBe(1);
    expect(tencentVolumeMultiplier('sh689009', true)).toBe(1);
  });

  it('主板/創業板 ×100 轉股（騰訊回手）', () => {
    expect(tencentVolumeMultiplier('sh600519', true)).toBe(100);
    expect(tencentVolumeMultiplier('sh601398', true)).toBe(100);
    expect(tencentVolumeMultiplier('sz000858', true)).toBe(100);
    expect(tencentVolumeMultiplier('sz300750', true)).toBe(100);
  });

  it('非 CN（美股）不轉換', () => {
    expect(tencentVolumeMultiplier('usAAPL.OQ', false)).toBe(1);
    expect(tencentVolumeMultiplier('usNVDA.OQ', false)).toBe(1);
  });
});
