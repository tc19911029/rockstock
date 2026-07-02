/**
 * 三色盤後掃描「退化結果」防呆合約測試（鐵則 #1：歷史紀錄不可被污染覆蓋）。
 *
 * 鎖住的不變量：當盤後掃描因「指數 L1 封存落後個股」而把全市場判成 stale 時，
 * degenerateScanReason 必須回非 null，route 才會跳過存檔、不覆蓋前一日的好紀錄。
 *
 * 真實事故（2026-06-04 台股）：早班 cron 16:00 觸發時 ^TWII 指數的今日那根要 ~16:39 才封，
 * 個股早在 14:15 就封到今日 → lastDate 卡前一日、1942 檔被判 stale、只評到 1 檔，
 * 近乎空的結果被寫進前一日檔覆蓋掉好紀錄。此防呆讓那種掃描不存檔，交給 18:35 最終版重產。
 */
import { degenerateScanReason, STALE_DEGENERATE_FRACTION } from '@/lib/cn-sanse/scanGuard';
import type { SanSeScanResult } from '@/lib/cn-sanse/scan';

/** 只填 guard 會讀的三個欄位，其餘以最小值補齊（型別完整、不影響判斷）。 */
function mk(evaluated: number, staleSkipped: number, turnoverFiltered: number): SanSeScanResult {
  return {
    lastDate: '2026-06-04', scannedAt: '2026-06-04T08:00:00.000Z',
    evaluated, staleSkipped, turnoverFiltered, turnoverCap: 500,
    counts: { strict: 0, medium: 0, loose: 0 },
    results: { strict: [], medium: [], loose: [] },
    records: [],
    resonanceCounts: { strong: 0, medium: 0, weak: 0, observe: 0, conflict: 0 },
    sessionType: 'post_close', archivedDate: '2026-06-04',
  } as SanSeScanResult;
}

describe('三色盤後掃描退化防呆 (degenerateScanReason)', () => {
  it('正常盤後（500 入圍、少數停牌 stale）→ 放行存檔', () => {
    // 真實健康數據：evaluated=500, staleSkipped=5, turnoverFiltered≈1460
    expect(degenerateScanReason(mk(500, 5, 1460))).toBeNull();
  });

  it('回補既有好日（如還原 0603：evaluated=500, staleSkipped=12）→ 放行', () => {
    expect(degenerateScanReason(mk(500, 12, 1448))).toBeNull();
  });

  it('指數落後競態（evaluated=1, staleSkipped=1942）→ 擋下不存檔', () => {
    const reason = degenerateScanReason(mk(1, 1942, 0));
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/stale-dominated/);
  });

  it('空 universe（完全沒載到 candle）→ 擋下', () => {
    expect(degenerateScanReason(mk(0, 0, 0))).toMatch(/empty universe/);
  });

  it('門檻兩側：stale 占比剛好過半才擋', () => {
    // considered=100：49 stale（49%）放行、51 stale（51%）擋下
    expect(degenerateScanReason(mk(40, 49, 11))).toBeNull();
    expect(degenerateScanReason(mk(40, 51, 9))).not.toBeNull();
    expect(STALE_DEGENERATE_FRACTION).toBe(0.5);
  });

  it('turnoverFiltered 缺省（undefined）也不爆，用 evaluated+staleSkipped 當母數', () => {
    const r = { ...mk(1, 1942, 0), turnoverFiltered: undefined } as SanSeScanResult;
    expect(degenerateScanReason(r)).toMatch(/stale-dominated/);
  });
});
