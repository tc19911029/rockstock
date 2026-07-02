/**
 * 買進前紅旗避雷檢查 — 純函式判斷引擎（跨市場共用，零 IO）
 *
 * computeRedFlags(input) → RedFlag[]；summarize(flags) → 是否建議避開。
 * 所有門檻集中 REDFLAG_PARAMS（仿 cn-agents SUBSCORE_PARAMS 凍結哲學：
 * 改門檻必須 code review 一眼可見、同輸入必同輸出可回測重現）。
 *
 * 缺資料一律不亮旗（寧漏報不誤報）。
 */

import type { RedFlag, RedFlagInput, RedFlagSummary } from './types';

// ────────────────────────────────────────────────────────────────────────────
// 門檻凍結區
// ────────────────────────────────────────────────────────────────────────────

export const REDFLAG_PARAMS = {
  /** 業績：YoY ≤ crash → 紅；crash < YoY ≤ decline → 黃 */
  earnings: { crashYoY: -50, declineYoY: -20 },
  /** 本益比虛高：PE ≥ perMin 且 同時獲利衰退 ≤ yoyMax → 黃（PE 高是分母失真不是貴得有理） */
  fakeHighPe: { perMin: 40, yoyMax: -50 },
  /** 主力出貨：近窗淨流出 ≤ -netCnyMin（元）或 連續流出 ≥ consecDays 天 → 紅 */
  mainForce: { netCnyMin: 1.5e8, consecDays: 5 },
  /** 大股東質押：累計質押比 ≥ ratioPct → 含還債=紅、否則=黃 */
  pledge: { ratioPct: 50 },
  /** 研報覆蓋：近窗研報數 = 0 → 黃（純題材票） */
  coverage: { zeroIsFlag: true },
} as const;

// ────────────────────────────────────────────────────────────────────────────
// 主函式
// ────────────────────────────────────────────────────────────────────────────

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 取淨利 / EPS YoY 中「較嚴重（較負）」者，兩者皆缺回 null */
function worstEarningsYoY(input: RedFlagInput): number | null {
  const a = num(input.netProfitYoYPct);
  const b = num(input.epsYoYPct);
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

export function computeRedFlags(input: RedFlagInput): RedFlag[] {
  const P = REDFLAG_PARAMS;
  const flags: RedFlag[] = [];

  // 1) 業績爆雷 / 衰退 ─────────────────────────────────────────────
  const yoy = worstEarningsYoY(input);
  if (yoy !== null) {
    if (yoy <= P.earnings.crashYoY) {
      flags.push({
        code: 'earnings_crash',
        severity: 'red',
        label: '業績爆雷',
        detail: `最新一期淨利/EPS 年減 ${yoy.toFixed(0)}%（≤ ${P.earnings.crashYoY}%）`,
      });
    } else if (yoy <= P.earnings.declineYoY) {
      flags.push({
        code: 'earnings_decline',
        severity: 'yellow',
        label: '獲利明顯衰退',
        detail: `最新一期淨利/EPS 年減 ${yoy.toFixed(0)}%`,
      });
    }
  }

  // 2) 本益比虛高（PE 高 + 獲利衰退 = 分母失真）───────────────────
  const per = num(input.per);
  if (per !== null && per >= P.fakeHighPe.perMin && yoy !== null && yoy <= P.fakeHighPe.yoyMax) {
    flags.push({
      code: 'fake_high_pe',
      severity: 'yellow',
      label: '本益比虛高',
      detail: `PE ${per.toFixed(0)} 倍看似高，其實是獲利衰退 ${yoy.toFixed(0)}% 讓分母變小、不是貴得有理`,
    });
  }

  // 3) 主力連續出貨 ───────────────────────────────────────────────
  const net = num(input.mainNetRecentCny);
  const consec = num(input.mainNetConsecOutflowDays);
  const win = num(input.mainFlowWindowDays);
  if (net !== null && net <= -P.mainForce.netCnyMin) {
    flags.push({
      code: 'main_force_distributing',
      severity: 'red',
      label: '主力出貨',
      detail: `近 ${win ?? '?'} 日主力資金淨流出 ${fmtMoney(net)}`,
    });
  } else if (consec !== null && consec >= P.mainForce.consecDays) {
    flags.push({
      code: 'main_force_distributing',
      severity: 'red',
      label: '主力出貨',
      detail: `主力連續 ${consec} 日淨流出`,
    });
  }

  // 4) 大股東高比例質押 ───────────────────────────────────────────
  const pledge = num(input.pledgeRatioPct);
  if (pledge !== null && pledge >= P.pledge.ratioPct) {
    const repay = input.pledgeForRepayDebt === true;
    flags.push({
      code: 'shareholder_pledge',
      severity: repay ? 'red' : 'yellow',
      label: repay ? '大股東質押還債' : '大股東高比例質押',
      detail: repay
        ? `大股東累計質押 ${pledge.toFixed(0)}% 持股、用途含「償還債務」（缺錢訊號）`
        : `大股東累計質押 ${pledge.toFixed(0)}% 持股`,
    });
  }

  // 5) 交易所異常波動公告 ─────────────────────────────────────────
  if (input.abnormalVolatilityRecent === true) {
    flags.push({
      code: 'abnormal_volatility',
      severity: 'yellow',
      label: '近期異常波動',
      detail: '近期觸發交易所「股票交易異常波動」公告',
    });
  }

  // 6) 無券商研報追蹤 ─────────────────────────────────────────────
  const reports = num(input.analystReportCount);
  if (P.coverage.zeroIsFlag && reports !== null && reports === 0) {
    const w = num(input.analystReportWindowDays);
    flags.push({
      code: 'no_analyst_coverage',
      severity: 'info',
      label: '無研報追蹤',
      detail: `近 ${w ?? '半年'} 日 0 篇券商研報（偏向純散戶題材票）`,
    });
  }

  // 7) 題材未落地 ─────────────────────────────────────────────────
  if (input.themeStatus === 'rnd_only' || input.themeStatus === 'rumor') {
    const nm = input.themeName ? `「${input.themeName}」` : '熱門題材';
    flags.push({
      code: 'theme_unproven',
      severity: 'yellow',
      label: '題材未落地',
      detail:
        input.themeStatus === 'rumor'
          ? `${nm}查無公司公告、僅論壇傳聞`
          : `${nm}仍在研發階段、尚未貢獻營收`,
    });
  }

  return flags;
}

// ────────────────────────────────────────────────────────────────────────────
// 彙總結論：是否建議避開
// ────────────────────────────────────────────────────────────────────────────

/**
 * 避開規則（紅旗引擎單一事實）：
 *   ≥1 面紅旗 → 建議避開；或 ≥3 面黃旗（多個警示疊加）→ 建議避開。
 * info 級（如無研報）只揭露不計入避開。
 */
export function summarizeRedFlags(flags: RedFlag[]): RedFlagSummary {
  const redCount = flags.filter((f) => f.severity === 'red').length;
  const yellowCount = flags.filter((f) => f.severity === 'yellow').length;
  const shouldAvoid = redCount >= 1 || yellowCount >= 3;

  let avoidReason: string | null = null;
  if (shouldAvoid) {
    const worst = flags.find((f) => f.severity === 'red') ?? flags.find((f) => f.severity === 'yellow');
    avoidReason = worst ? `${worst.label}：${worst.detail}` : null;
  }

  return { flags, redCount, yellowCount, shouldAvoid, avoidReason };
}

// ── 小工具 ────────────────────────────────────────────────────────────────────

function fmtMoney(v: number): string {
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1e8) return `${sign}${(a / 1e8).toFixed(2)} 億`;
  if (a >= 1e4) return `${sign}${(a / 1e4).toFixed(0)} 萬`;
  return `${sign}${a.toFixed(0)}`;
}
