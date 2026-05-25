import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';

// ═══════════════════════════════════════════════════════════════════════════════
// 台股籌碼面完整 API
// 數據來源：TWSE + TPEX + TDCC（全部免費公開 API）
// ═══════════════════════════════════════════════════════════════════════════════

// ── 完整籌碼數據 ─────────────────────────────────────────────────────────────
export interface ChipData {
  symbol: string;
  name?: string;
  // 三大法人
  foreignBuy: number;       // 外資買賣超（元）
  trustBuy: number;         // 投信買賣超（元）
  dealerBuy: number;        // 自營商買賣超（元）
  totalInstitutional: number;
  // 融資融券
  marginBalance: number;    // 融資餘額（張）
  marginNet: number;        // 融資增減（張）
  shortBalance: number;     // 融券餘額（張）
  shortNet: number;         // 融券增減（張）
  marginUtilRate: number;   // 融資使用率 %
  // 當沖
  dayTradeVolume: number;   // 當沖成交量
  dayTradeRatio: number;    // 當沖比例 %
  // 大額交易人
  largeTraderBuy: number;   // 大額交易人買超
  largeTraderSell: number;  // 大額交易人賣超
  largeTraderNet: number;   // 大額交易人淨買超
  // 借券
  lendingBalance: number;   // 借券餘額
  lendingNet: number;       // 借券增減
  // 集保大戶（依書本實務：股價 >50 看 400 張、千金股看 100 張）
  largeHolderPct: number;        // 千張以上大戶持股比例 %（向下相容欄位）
  largeHolderChange: number;     // 千張大戶持股變化 %（vs 上週）
  holder100Pct: number;          // 100 張↑ 比例（千金股大戶門檻）
  holder200Pct: number;          // 200 張↑ 比例（高價股大戶門檻）
  holder400Pct: number;          // 400 張↑ 比例（中價股大戶門檻、業界主流）
  holder400To600Pct: number;     // 400-600 張比例（各級明細）
  holder600To800Pct: number;     // 600-800 張比例
  holder800To1000Pct: number;    // 800-1000 張比例
  /** 主力卡位訊號：400/600/800/1000 四級都有持股（業界：籌碼結構最完整）*/
  structureBuilding: boolean;
  // 投信動向（陳威良 3比8 proxy；用最近窗口累計淨買 ÷ 已發行股數，動向 pp，不是絕對持股 %）
  sharesIssued: number;                     // 已發行股數（股，from FinMind）；0 = 缺資料
  trustNetBuy30d: number;                   // 30 天累計投信淨買（張）
  trustNetBuy60d: number;
  trustNetBuy90d: number;
  trustHoldingChange30d: number | null;     // 30 天投信持股變化（百分點）；null = 缺 sharesIssued
  trustHoldingChange60d: number | null;
  trustHoldingChange90d: number | null;
  trustDataCoverageDays: number;            // inst raw 實際涵蓋天數（max 90）；UI 用來判斷 60/90 天值是否可信
  trustMomentumStage: TrustMomentumStage;   // 動向分區
  // 評分
  chipScore: number;
  chipGrade: string;
  chipSignal: string;
  chipDetail: string;       // 詳細說明
}

// ── 計算籌碼面綜合評分 ───────────────────────────────────────────────────────
function calculateChipScore(
  inst: { foreignBuy: number; trustBuy: number; dealerBuy: number; totalBuy: number } | undefined,
  margin: { marginBalance: number; marginNet: number; shortBalance: number; shortNet: number; marginUtilRate: number } | undefined,
  dt: { dayTradeVolume: number; dayTradeRatio: number } | undefined,
  lt: { buy: number; sell: number; net: number } | undefined,
  holder: { structureBuilding: boolean; holder1000Change: number } | undefined,
): { score: number; grade: string; signal: string; detail: string } {
  // 2026-05-11 fix: 全部 input 都缺或全空殼（小型股/上櫃股常無資料）→ 回傳「無資料」避免誤導性 50/B/中性
  const hasAnyInst = inst && (inst.foreignBuy !== 0 || inst.trustBuy !== 0 || inst.dealerBuy !== 0 || inst.totalBuy !== 0);
  const hasAnyMargin = margin && (margin.marginBalance !== 0 || margin.marginNet !== 0 || margin.shortBalance !== 0 || margin.shortNet !== 0);
  const hasAnyDt = dt && (dt.dayTradeVolume !== 0 || dt.dayTradeRatio !== 0);
  const hasAnyLt = lt && (lt.buy !== 0 || lt.sell !== 0 || lt.net !== 0);
  if (!hasAnyInst && !hasAnyMargin && !hasAnyDt && !hasAnyLt) {
    return { score: 0, grade: '—', signal: '無資料', detail: '無籌碼資料（小型股/上櫃股 / 資料源未涵蓋）' };
  }

  let score = 50;
  const details: string[] = [];

  // ── 法人面（單位：張）──
  if (inst) {
    // 外資：買超 > 500張 有意義，> 5000張 很大
    if (inst.foreignBuy > 0) {
      const pts = Math.min(20, inst.foreignBuy / 5000);
      score += pts;
      if (inst.foreignBuy >= 1000) details.push(`外資買超${inst.foreignBuy.toLocaleString()}張`);
    } else if (inst.foreignBuy < 0) {
      score += Math.max(-15, inst.foreignBuy / 5000);
      if (inst.foreignBuy <= -1000) details.push(`外資賣超${Math.abs(inst.foreignBuy).toLocaleString()}張`);
    }
    // 投信：買超 > 100張 就有意義（投信量較小但精準）
    if (inst.trustBuy > 0) {
      score += Math.min(15, inst.trustBuy / 500);
      if (inst.trustBuy >= 100) details.push(`投信買超${inst.trustBuy.toLocaleString()}張`);
    } else if (inst.trustBuy < 0) {
      score += Math.max(-10, inst.trustBuy / 500);
      if (inst.trustBuy <= -100) details.push(`投信賣超${Math.abs(inst.trustBuy).toLocaleString()}張`);
    }
    if (inst.foreignBuy > 0 && inst.trustBuy > 0 && inst.dealerBuy > 0) { score += 10; details.push('三法人同步買超'); }
    if (inst.foreignBuy < 0 && inst.trustBuy < 0 && inst.dealerBuy < 0) { score -= 10; details.push('三法人同步賣超'); }
  }

  // ── 融資融券面 ──
  if (margin) {
    if (margin.marginNet < -200) { score += Math.min(5, Math.abs(margin.marginNet) / 500); details.push(`融資減${Math.abs(margin.marginNet).toLocaleString()}張`); }
    if (margin.marginNet > 500) { score -= Math.min(10, margin.marginNet / 500); details.push(`融資增${margin.marginNet.toLocaleString()}張`); }
    if (margin.shortNet > 0 && inst && inst.totalBuy > 0) { score += 3; details.push('軋空機會'); }
    if (margin.marginUtilRate > 60) { score -= 3; details.push(`融資使用率${margin.marginUtilRate}%偏高`); }
  }

  // ── 大額交易人（單位：張）──
  if (lt) {
    if (lt.net > 0) { score += Math.min(8, lt.net / 5000); if (lt.net >= 500) details.push(`大戶買超${lt.net.toLocaleString()}張`); }
    if (lt.net < -500) { score -= 5; details.push(`大戶賣超${Math.abs(lt.net).toLocaleString()}張`); }
  }

  // ── 當沖面 ──
  if (dt) {
    if (dt.dayTradeRatio > 40) { score -= 5; details.push(`當沖比${dt.dayTradeRatio}%過高`); }
    else if (dt.dayTradeRatio > 25) { score -= 2; }
  }

  // ── 集保大戶結構（業界：400/600/800/1000 四級全到位 = 主力卡位最強訊號）──
  if (holder) {
    if (holder.structureBuilding) {
      score += 15;
      details.push('主力卡位（400/600/800/1000 四級全到位）');
    }
    if (holder.holder1000Change >= 0.5) {
      score += 5;
      details.push(`千張大戶持股 +${holder.holder1000Change.toFixed(2)}%`);
    } else if (holder.holder1000Change <= -1) {
      score -= 8;
      details.push(`千張大戶持股 ${holder.holder1000Change.toFixed(2)}% 出脫`);
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = score >= 80 ? 'S' : score >= 65 ? 'A' : score >= 50 ? 'B' : score >= 35 ? 'C' : 'D';

  let signal = '中性';
  if (score >= 75 && inst && inst.foreignBuy > 0 && inst.trustBuy > 0) signal = '主力進場';
  else if (score >= 65 && inst && inst.totalBuy > 0) signal = '法人偏多';
  else if (score >= 55 && lt && lt.net > 0) signal = '大戶加碼';
  else if (score <= 25 && inst && inst.totalBuy < 0) signal = '主力出貨';
  else if (score <= 35 && margin && margin.marginNet > 500) signal = '散戶追高';
  else if (score <= 40 && inst && inst.foreignBuy < 0 && inst.trustBuy < 0) signal = '法人偏空';

  return { score, grade, signal, detail: details.join('；') || '中性' };
}

// ── 找最近有資料的交易日（最多往前找 5 天）────────────────────────────────
import { isTradingDay } from '@/lib/utils/tradingDay';

/** 從 requestedDate 往前找最近的 TW 交易日（不打外部 API） */
async function findLatestTradingDate(requestedDate: string): Promise<string> {
  let d = new Date(requestedDate + 'T12:00:00');
  for (let i = 0; i < 7; i++) {
    const dateStr = d.toISOString().slice(0, 10);
    if (isTradingDay(dateStr, 'TW')) return dateStr;
    d = new Date(d.getTime() - 86400000);
  }
  return requestedDate;
}

const chipQuerySchema = z.object({
  date:   z.string().optional(),
  symbol: z.string().optional(),
});

// ─── 新版：用 FinMind + TDCC L1 直接抓單檔資料（不再 bulk pre-fetch 全市場） ──

import { fetchT86ForStock } from '@/lib/datasource/TwseT86Provider';
import { readTdccStock, readInstStock, writeInstStock } from '@/lib/chips/ChipStorage';
import { fetchMarginForStock, fetchDayTradeForStock, fetchLendingForStock } from '@/lib/datasource/FinmindChipExtras';
import { getSharesIssued } from '@/lib/datasource/FinMindClient';

// ── 投信動向（陳威良 3比8 法則的 proxy）────────────────────────────────────
// FinMind 免費層無「絕對投信持股 %」資料源；先用「最近 30/60/90 天投信淨買 ÷ 已發行股數」
// 當動向 proxy。UI 必須明確標示「動向（pp）」不是「絕對持股 %」，避免誤導為陳威良講的 3%/8%/15%。
//
// 後續若加 Goodinfo 爬蟲拿到絕對值，這個 proxy 仍保留為「最近增持速度」指標。
export type TrustMomentumStage =
  | 'unknown'        // 缺資料
  | 'cooling'        // < 0 pp (賣超)
  | 'building'       // 0 ~ 0.5 pp（試水溫）
  | 'accelerating'   // 0.5 ~ 1.5 pp（積極加碼，3 比 8 起飛區）
  | 'peak';          // ≥ 1.5 pp（爆量加碼）

function classifyTrustMomentum(change30d: number | null): TrustMomentumStage {
  if (change30d === null) return 'unknown';
  if (change30d < 0) return 'cooling';
  if (change30d < 0.5) return 'building';
  if (change30d < 1.5) return 'accelerating';
  return 'peak';
}

interface InstDailyRow { date: string; foreign: number; trust: number; dealer: number; total: number }

/**
 * 從 inst raw 累計指定窗口的投信淨買張數。
 * @param rows  升冪排序的歷史 daily rows
 * @param asOfDate 截止日（含）
 * @param windowDays 倒推幾天
 */
function sumTrustNetBuy(rows: InstDailyRow[], asOfDate: string, windowDays: number): number {
  const cutoff = dateMinusDays(asOfDate, windowDays);
  return rows
    .filter(r => r.date > cutoff && r.date <= asOfDate)
    .reduce((s, r) => s + (r.trust ?? 0), 0);
}

/** 把張數換成佔已發行股數的百分點。1 張 = 1000 股。 */
function netBuyToPp(netBuyShares: number, sharesIssued: number | null): number | null {
  if (!sharesIssued || sharesIssued <= 0) return null;
  return Number(((netBuyShares * 1000 / sharesIssued) * 100).toFixed(3));
}

function dateMinusDays(d: string, n: number): string {
  const dt = new Date(d + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const parsed = chipQuerySchema.safeParse(Object.fromEntries(searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);

  // 用 Asia/Taipei TZ；UTC 在 CST 凌晨會回傳前一天，籌碼資料對不上
  const rawDate = parsed.data.date ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  const rawSymbol = parsed.data.symbol;
  if (!rawSymbol) return apiError('symbol required', 400);
  const code = rawSymbol.replace(/\.(TW|TWO)$/i, '');

  const date = await findLatestTradingDate(rawDate);

  try {
    // ── 1) 法人：先讀 L1，缺則 FinMind 補抓 ──
    let instFile = await readInstStock(code);
    let instOnDate = instFile?.data.find(r => r.date === date);
    if (!instOnDate) {
      const fetchStart = instFile?.lastDate ? dateMinusDays(instFile.lastDate, -1) : dateMinusDays(date, 30);
      try {
        const fetched = await fetchT86ForStock(code, fetchStart, date);
        if (fetched.size > 0) {
          const newRows = Array.from(fetched.entries()).map(([d, v]) => ({ date: d, ...v }));
          await writeInstStock(code, newRows);
          instFile = await readInstStock(code);
          instOnDate = instFile?.data.find(r => r.date === date);
        }
      } catch (err) {
        console.warn(`[/api/chip] FinMind ${code} 失敗:`, err instanceof Error ? err.message : err);
      }
    }
    // 盤中 / 早上 T86 還沒揭露當日資料 → fallback 到歷史最新一筆，
    // 避免籌碼面板整片顯示「中立 0 張、chipScore=0」誤導用戶。
    // T86 通常 17:00-18:30 才揭露，盤中查詢必然抓不到當日數據。
    if (!instOnDate && instFile?.data && instFile.data.length > 0) {
      instOnDate = instFile.data[instFile.data.length - 1];
    }

    // ── 2) 大戶持股 TDCC L1 + 3) 融資融券、當沖、借券、4) 已發行股數（FinMind 並行）──
    // 用 allSettled：任何單一資料源失敗不應打掉整個籌碼面板（書本實務以外資+融資為主，借券/股本缺值可接受）
    const settled = await Promise.allSettled([
      readTdccStock(code),
      fetchMarginForStock(code, date),
      fetchDayTradeForStock(code, date),
      fetchLendingForStock(code, date),
      getSharesIssued(code),
    ]);
    const pickFulfilled = <T,>(idx: number): T | null => {
      const r = settled[idx];
      return r.status === 'fulfilled' ? (r.value as T) : null;
    };
    const tdccFile = pickFulfilled<Awaited<ReturnType<typeof readTdccStock>>>(0);
    const marginInfo = pickFulfilled<Awaited<ReturnType<typeof fetchMarginForStock>>>(1);
    const dayTradeInfo = pickFulfilled<Awaited<ReturnType<typeof fetchDayTradeForStock>>>(2);
    const lendingInfo = pickFulfilled<Awaited<ReturnType<typeof fetchLendingForStock>>>(3);
    const sharesIssued = pickFulfilled<number>(4);
    const latestTdcc = tdccFile?.data[tdccFile.data.length - 1];
    const prevTdcc = tdccFile?.data[tdccFile.data.length - 2];

    // 投信動向（30/60/90 天累計淨買換算 pp）
    const instRows = instFile?.data ?? [];
    const trustNetBuy30d = sumTrustNetBuy(instRows, date, 30);
    const trustNetBuy60d = sumTrustNetBuy(instRows, date, 60);
    const trustNetBuy90d = sumTrustNetBuy(instRows, date, 90);
    const trustHoldingChange30d = netBuyToPp(trustNetBuy30d, sharesIssued);
    const trustHoldingChange60d = netBuyToPp(trustNetBuy60d, sharesIssued);
    const trustHoldingChange90d = netBuyToPp(trustNetBuy90d, sharesIssued);
    const trustMomentumStage = classifyTrustMomentum(trustHoldingChange30d);
    // 算實際資料涵蓋天數：(date - oldest row) 內的最大值，cap 90
    const oldestInst = instRows[0]?.date;
    const trustDataCoverageDays = oldestInst
      ? Math.min(90, Math.max(0, Math.floor((new Date(date).getTime() - new Date(oldestInst).getTime()) / 86400000)))
      : 0;

    // 沒法人也沒大戶也沒融資資料 → 真正無資料
    if (!instOnDate && !latestTdcc && !marginInfo) {
      return apiError('not found', 404);
    }

    const foreignBuy = instOnDate?.foreign ?? 0;
    const trustBuy = instOnDate?.trust ?? 0;
    const dealerBuy = instOnDate?.dealer ?? 0;
    const totalBuy = instOnDate?.total ?? 0;

    // 集保大戶各級摘要 + 主力卡位訊號
    const clampPct = (v: number | undefined): number =>
      Math.min(100, Math.max(0, v ?? 0));
    const h400To600 = clampPct(latestTdcc?.holder400To600Pct);
    const h600To800 = clampPct(latestTdcc?.holder600To800Pct);
    const h800To1000 = clampPct(latestTdcc?.holder800To1000Pct);
    const h1000 = clampPct(latestTdcc?.holder1000Pct);
    const structureBuilding =
      h400To600 > 0 && h600To800 > 0 && h800To1000 > 0 && h1000 > 0;
    const holder1000Change = latestTdcc && prevTdcc
      ? +(clampPct(latestTdcc.holder1000Pct) - clampPct(prevTdcc.holder1000Pct)).toFixed(2)
      : 0;

    const inst = instOnDate ? { foreignBuy, trustBuy, dealerBuy, totalBuy, name: '' } : undefined;
    const { score, grade, signal, detail } = calculateChipScore(
      inst,
      marginInfo ?? undefined,
      dayTradeInfo ?? undefined,
      undefined,
      latestTdcc ? { structureBuilding, holder1000Change } : undefined,
    );

    const data: ChipData = {
      symbol: code,
      foreignBuy, trustBuy, dealerBuy,
      totalInstitutional: totalBuy,
      marginBalance: marginInfo?.marginBalance ?? 0,
      marginNet: marginInfo?.marginNet ?? 0,
      shortBalance: marginInfo?.shortBalance ?? 0,
      shortNet: marginInfo?.shortNet ?? 0,
      marginUtilRate: marginInfo?.marginUtilRate ?? 0,
      dayTradeVolume: dayTradeInfo?.dayTradeVolume ?? 0,
      dayTradeRatio: dayTradeInfo?.dayTradeRatio ?? 0,
      largeTraderBuy: 0, largeTraderSell: 0, largeTraderNet: 0,
      lendingBalance: lendingInfo?.lendingBalance ?? 0,
      lendingNet: lendingInfo?.lendingNet ?? 0,
      // ETF (如 0050) TDCC 原始資料持股分級比例異常高（>100%），可能因發行單位/集保
      // 統計口徑不同；clamp 到 0-100 避免 UI 顯示 5313% 等誤導值。
      largeHolderPct: h1000,
      largeHolderChange: holder1000Change,
      holder100Pct: clampPct(latestTdcc?.holder100Pct),
      holder200Pct: clampPct(latestTdcc?.holder200Pct),
      holder400Pct: clampPct(latestTdcc?.holder400Pct),
      holder400To600Pct: h400To600,
      holder600To800Pct: h600To800,
      holder800To1000Pct: h800To1000,
      structureBuilding,
      sharesIssued: sharesIssued ?? 0,
      trustNetBuy30d,
      trustNetBuy60d,
      trustNetBuy90d,
      trustHoldingChange30d,
      trustHoldingChange60d,
      trustHoldingChange90d,
      trustDataCoverageDays,
      trustMomentumStage,
      chipScore: score,
      chipGrade: grade,
      chipSignal: signal,
      chipDetail: detail,
    };

    return apiOk(data);
  } catch (err) {
    console.error('[/api/chip] error:', err);
    return apiError('籌碼資料讀取失敗');
  }
}
