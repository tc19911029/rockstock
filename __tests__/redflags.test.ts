/**
 * 買進前紅旗避雷檢查 — 純函式單元測試
 *
 * 真實案例驗證：彩虹股份 600707（使用者 2026-06-13 全倉套牢在最高點的那檔）
 * 必須亮出 業績爆雷 + 本益比虛高 + 主力出貨 + 質押還債 + 異常波動 + 無研報，
 * 且 shouldAvoid=true。乾淨股不亮旗、缺資料不誤報。
 */

import { computeRedFlags, summarizeRedFlags, REDFLAG_PARAMS } from '@/lib/redflags/compute';
import type { RedFlagInput } from '@/lib/redflags/types';

function codes(input: RedFlagInput): string[] {
  return computeRedFlags(input).map((f) => f.code).sort();
}

describe('redflags — 彩虹股份 600707 真實案例', () => {
  // 2026-06-13 從東方財富抓到的真實數字
  const caihong: RedFlagInput = {
    netProfitYoYPct: -98, // 2026 Q1 歸母淨利 -98.28%
    epsYoYPct: -98,
    per: 52, // TTM 約 51.93
    mainNetRecentCny: -8.31e8, // 近 5 日主力淨流出約 8.31 億
    mainFlowWindowDays: 5,
    mainNetConsecOutflowDays: 2,
    pledgeRatioPct: 65, // 咸陽城投累計質押 65.05%
    pledgeForRepayDebt: true, // 用途：償還債務
    abnormalVolatilityRecent: true, // 6/13 異常波動公告
    analystReportCount: 0, // 近半年 0 篇研報
    analystReportWindowDays: 180,
    themeStatus: 'rnd_only', // 玻璃基板封裝仍在研發
    themeName: '半導體玻璃基板封裝',
  };

  it('亮出全部該亮的紅旗', () => {
    expect(codes(caihong)).toEqual(
      [
        'abnormal_volatility',
        'earnings_crash',
        'fake_high_pe',
        'main_force_distributing',
        'no_analyst_coverage',
        'shareholder_pledge',
        'theme_unproven',
      ].sort(),
    );
  });

  it('業績爆雷與質押還債是紅燈、建議避開', () => {
    const s = summarizeRedFlags(computeRedFlags(caihong));
    expect(s.redCount).toBeGreaterThanOrEqual(3); // 爆雷 + 主力出貨 + 質押還債
    expect(s.shouldAvoid).toBe(true);
    expect(s.avoidReason).toContain('業績爆雷');
  });

  it('質押用途含還債 → 紅；不含 → 黃', () => {
    const red = computeRedFlags({ pledgeRatioPct: 65, pledgeForRepayDebt: true });
    const yellow = computeRedFlags({ pledgeRatioPct: 65, pledgeForRepayDebt: false });
    expect(red[0].severity).toBe('red');
    expect(yellow[0].severity).toBe('yellow');
  });
});

describe('redflags — 乾淨股 / 缺資料不誤報', () => {
  it('健康股一面旗都不亮', () => {
    const healthy: RedFlagInput = {
      netProfitYoYPct: 25,
      epsYoYPct: 30,
      per: 18,
      mainNetRecentCny: 2e8,
      mainFlowWindowDays: 5,
      pledgeRatioPct: 5,
      abnormalVolatilityRecent: false,
      analystReportCount: 12,
      analystReportWindowDays: 180,
      themeStatus: 'proven',
    };
    expect(computeRedFlags(healthy)).toHaveLength(0);
    expect(summarizeRedFlags(computeRedFlags(healthy)).shouldAvoid).toBe(false);
  });

  it('全空輸入不亮任何旗（缺資料不誤報）', () => {
    expect(computeRedFlags({})).toHaveLength(0);
    expect(summarizeRedFlags([]).shouldAvoid).toBe(false);
  });

  it('衰退分級：-25% 黃、-60% 紅', () => {
    expect(codes({ netProfitYoYPct: -25 })).toContain('earnings_decline');
    expect(codes({ netProfitYoYPct: -60 })).toContain('earnings_crash');
  });

  it('本益比虛高需同時 PE 高且獲利衰退；單獨高 PE 不亮', () => {
    // PE 高但獲利成長 → 不亮 fake_high_pe
    expect(codes({ per: 80, netProfitYoYPct: 30 })).not.toContain('fake_high_pe');
    // PE 高 + 獲利衰退 → 亮
    expect(codes({ per: 50, netProfitYoYPct: -60 })).toContain('fake_high_pe');
  });

  it('≥3 面黃旗也建議避開（警示疊加）', () => {
    const s = summarizeRedFlags(
      computeRedFlags({
        netProfitYoYPct: -25, // 黃
        abnormalVolatilityRecent: true, // 黃
        themeStatus: 'rumor', // 黃
      }),
    );
    expect(s.redCount).toBe(0);
    expect(s.yellowCount).toBeGreaterThanOrEqual(3);
    expect(s.shouldAvoid).toBe(true);
  });

  it('門檻凍結值符合預期（改門檻會在此被擋下）', () => {
    expect(REDFLAG_PARAMS.earnings.crashYoY).toBe(-50);
    expect(REDFLAG_PARAMS.pledge.ratioPct).toBe(50);
  });
});
