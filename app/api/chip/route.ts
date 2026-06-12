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
  /** 各 tier 週變化（pp，最新一週 vs 前一週）；null = 兩週缺欄位無法比較 */
  holderTierChange?: {
    h100: number | null; h200: number | null; h400: number | null; h1000: number | null;
    h400To600: number | null; h600To800: number | null; h800To1000: number | null;
  };
  /** 主 tier 連續週趨勢（連 N 增/減）— 對 weekly delta 序列跑 detectTrend */
  holderTierTrend?: {
    h100?: TrendInfo; h200?: TrendInfo; h400?: TrendInfo; h1000?: TrendInfo;
  };
  /** TDCC 最新基準日 / 前一週基準日（UI 顯示「週變化 vs MM/DD」）*/
  tdccDate?: string;
  tdccPrevDate?: string;
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

  // v2 對齊籌碼K線 9 區塊：主力綜合 + 趨勢
  /** 主力綜合（當日，張）= 外資 + 投信 + 自營 + 大戶 ─ 融資增加 */
  composite?: number;
  /** 主力集中度（%）— 5 週主力綜合 / 該股流通量 */
  compositeConcentration?: number;
  /** 各維度趨勢標記（連 N 賣 / N 增轉減 等）*/
  trends?: {
    foreign?: TrendInfo;
    trust?: TrendInfo;
    dealer?: TrendInfo;
    institutional?: TrendInfo;   // 三法人合計
    margin?: TrendInfo;
    lending?: TrendInfo;
    composite?: TrendInfo;
    holderLarge?: TrendInfo;     // 大戶 weekly delta 連續方向
  };
  /** 5 週累計變化（%）*/
  holder5wChange?: {
    largePct: number;       // 大戶（>400 張）5 週變化 %
    retailPct: number;      // 散戶 5 週變化 %
  };
  /** 5 月累計變化（%）*/
  holder5mChange?: {
    largePct: number;
  };

  // v3 主力券商分點（Yahoo broker scraper）— 對齊籌碼K線「主力」精確口徑
  /** 主力券商：前 15 大買 − 前 15 大賣（張）*/
  brokerNetBuy?: number;
  /** 主力集中度（%，正值；方向看 brokerNetBuy 符號）*/
  brokerConcentration?: number;
  /** 前 15 大買進券商 */
  topBuyers?: BrokerRankRow[];
  /** 前 15 大賣出券商 */
  topSellers?: BrokerRankRow[];

  // v4 成本／壓力價精簡摘要（外資/投信/自營/主力/融資/融券/券賣 成本 + 嘎空價 + 斷頭價）
  // 純顯示，不進 chipScore；完整版走 /api/cost-basis
  costBasis?: CostBasisSummary;

  // v5 三大法人衍生欄位（純衍生計算，零新資料源；純顯示不進 chipScore / 選股 gate）
  /** 外資連續買超天數（從最新交易日往回數，淨買 > 0 算連續；最新日賣超 → 0） */
  foreignConsecBuyDays: number;
  /** 投信連續買超天數（同上） */
  trustConsecBuyDays: number;
  /** 最新日外資買賣超(張) ÷ 當日成交量(張) × 100（1 位小數；成交量缺或 0 → null） */
  foreignNetToVolumePct: number | null;
  /** 最新日投信買賣超(張) ÷ 當日成交量(張) × 100（同上） */
  trustNetToVolumePct: number | null;
  /** 外資 + 投信最新日同步買超（兩者淨買 > 0） */
  instSyncBuy: boolean;
  /** 外資 + 投信「同日同步買超」連續天數 */
  instSyncBuyDays: number;
}

// ── 計算籌碼面綜合評分 v2 ────────────────────────────────────────────────────
// 對齊籌碼K線 app 9 區塊：外資/投信/自營/三法人/融資/融券/主力綜合/借券/大戶散戶 5 週
// 加入「連 N 賣」「N 增轉減」趨勢加權；拆掉舊版「主力卡位 +15」死板加分
import type { TrendInfo } from '@/lib/chips/trends';
interface ScoreInputs {
  inst?: { foreignBuy: number; trustBuy: number; dealerBuy: number; totalBuy: number };
  margin?: { marginNet: number; shortNet: number; marginUtilRate: number };
  dt?: { dayTradeRatio: number };
  lending?: { lendingBalance: number; lendingNet: number };
  holder5w?: { largeChangePct: number; retailChangePct: number };   // 5 週累計變化 %
  trends?: {
    foreign?: TrendInfo; trust?: TrendInfo; dealer?: TrendInfo;
    institutional?: TrendInfo; margin?: TrendInfo; lending?: TrendInfo;
    composite?: TrendInfo;
  };
  composite?: number;  // 主力綜合（當日合併張數）
}

function calculateChipScore(input: ScoreInputs): { score: number; grade: string; signal: string; detail: string } {
  const { inst, margin, dt, lending, holder5w, trends, composite } = input;

  const hasAnyData = inst || margin || lending || holder5w || composite != null;
  if (!hasAnyData) {
    return { score: 0, grade: '—', signal: '無資料', detail: '無籌碼資料（小型股/上櫃股 / 資料源未涵蓋）' };
  }

  let score = 50;
  const details: string[] = [];

  // 趨勢加權 helper — 連 N 同向就 ±N（最多 ±5）；reversal +/- 1
  const trendAdj = (t?: TrendInfo, signCoef = 1): number => {
    if (!t || t.direction === 'flat') return 0;
    const dirSign = t.direction === 'up' ? 1 : -1;
    let pts = Math.min(5, t.consecutiveCount) * dirSign * signCoef;
    if (t.reversal) pts += dirSign * signCoef * 1.5;  // 反轉訊號額外加成
    return pts;
  };

  // ── 1) 外資（單位：張）──
  if (inst?.foreignBuy) {
    const v = inst.foreignBuy;
    score += Math.max(-15, Math.min(15, v / 5000 * 15));
    if (Math.abs(v) >= 1000) details.push(`外資${v > 0 ? '買超' : '賣超'}${Math.abs(v).toLocaleString()}張`);
  }
  score += trendAdj(trends?.foreign);

  // ── 2) 投信 ──
  if (inst?.trustBuy) {
    const v = inst.trustBuy;
    score += Math.max(-12, Math.min(12, v / 500 * 12));
    if (Math.abs(v) >= 100) details.push(`投信${v > 0 ? '買' : '賣'}${Math.abs(v).toLocaleString()}張`);
  }
  score += trendAdj(trends?.trust);

  // ── 3) 自營 ──（權重小，最多 ±5）
  if (inst?.dealerBuy) {
    const v = inst.dealerBuy;
    score += Math.max(-5, Math.min(5, v / 1000 * 5));
  }
  score += trendAdj(trends?.dealer, 0.5);

  // ── 4) 三法人合計趨勢 — 連續方向最重要 ──
  if (inst?.totalBuy) {
    if (inst.foreignBuy > 0 && inst.trustBuy > 0 && inst.dealerBuy > 0) { score += 8; details.push('三法人同買'); }
    if (inst.foreignBuy < 0 && inst.trustBuy < 0 && inst.dealerBuy < 0) { score -= 8; details.push('三法人同賣'); }
  }
  if (trends?.institutional) {
    const adj = trendAdj(trends.institutional, 1.5);
    score += adj;
    if (trends.institutional.consecutiveCount >= 4) {
      details.push(`三法人${trends.institutional.label}`);
    }
  }

  // ── 5) 融資（散戶面，反向解讀：增 = 看空、減 = 看多）──
  if (margin?.marginNet) {
    if (margin.marginNet > 200) {
      const penalty = Math.min(8, margin.marginNet / 500 * 5);
      score -= penalty;
      details.push(`融資增${margin.marginNet.toLocaleString()}張`);
    } else if (margin.marginNet < -200) {
      score += Math.min(4, Math.abs(margin.marginNet) / 500 * 3);
    }
  }
  // 融資連 N 增 = 散戶追高 = 扣分（反向 trendAdj）
  score += trendAdj(trends?.margin, -1);

  if (margin?.marginUtilRate && margin.marginUtilRate > 60) {
    score -= 3;
    details.push(`融資使用率 ${margin.marginUtilRate.toFixed(1)}%`);
  }

  // ── 6) 融券 + 軋空機會 ──
  if (margin?.shortNet && inst?.totalBuy && margin.shortNet > 0 && inst.totalBuy > 0) {
    score += 2;
    details.push('軋空訊號');
  }

  // ── 7) 主力綜合（核心指標）──
  // composite = 外資+投信+自營 (合計) + 大戶 net - 融資增加
  // 籌碼K線「主力」連 5 賣 / -4.00% 主力集中度是強烈空頭訊號
  if (composite != null) {
    score += Math.max(-15, Math.min(15, composite / 3000 * 15));
    if (Math.abs(composite) >= 500) details.push(`主力${composite > 0 ? '買' : '賣'}${Math.abs(composite).toLocaleString()}張`);
  }
  if (trends?.composite) {
    const adj = trendAdj(trends.composite, 2);  // 主力趨勢權重最大
    score += adj;
    if (trends.composite.consecutiveCount >= 4) {
      details.push(`主力${trends.composite.label}`);
    }
  }

  // ── 8) 借券（放空籌碼）──
  if (lending?.lendingNet) {
    const v = lending.lendingNet;
    if (v > 50) {
      const penalty = Math.min(10, v / 100 * 5);
      score -= penalty;
      details.push(`借券增${v.toLocaleString()}張`);
    } else if (v < -50) {
      // 借券回補 = 看空力道減弱
      score += Math.min(3, Math.abs(v) / 100 * 2);
    }
  }
  // 借券連續增 = 持續放空，重扣
  score += trendAdj(trends?.lending, -1.5);

  // ── 9) 大戶散戶 5 週變化（取代舊「主力卡位 +15」死板加分）──
  if (holder5w) {
    if (holder5w.largeChangePct > 0.3) {
      score += Math.min(8, holder5w.largeChangePct * 10);
      details.push(`大戶 5 週 +${holder5w.largeChangePct.toFixed(2)}%`);
    } else if (holder5w.largeChangePct < -0.3) {
      score += Math.max(-10, holder5w.largeChangePct * 12);  // 大戶減持扣比較重
      details.push(`大戶 5 週 ${holder5w.largeChangePct.toFixed(2)}%`);
    }
  }

  // ── 當沖比過高 ──
  if (dt?.dayTradeRatio && dt.dayTradeRatio > 40) {
    score -= 3;
    details.push(`當沖比 ${dt.dayTradeRatio.toFixed(1)}%`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = score >= 80 ? 'S' : score >= 65 ? 'A' : score >= 50 ? 'B' : score >= 35 ? 'C' : 'D';

  let signal = '中性';
  const compositeDown = trends?.composite?.direction === 'down' && trends.composite.consecutiveCount >= 3;
  const lendingUp = trends?.lending?.direction === 'up' && trends.lending.consecutiveCount >= 3;
  const instDown = trends?.institutional?.direction === 'down' && trends.institutional.consecutiveCount >= 4;

  if (score >= 75 && inst && inst.foreignBuy > 0 && inst.trustBuy > 0) signal = '主力進場';
  else if (score >= 65 && inst && inst.totalBuy > 0) signal = '法人偏多';
  else if (score <= 30 && (compositeDown || (instDown && lendingUp))) signal = '主力出貨';
  else if (score <= 35 && lendingUp) signal = '空方積極';
  else if (score <= 40 && inst && inst.foreignBuy < 0 && inst.trustBuy < 0) signal = '法人偏空';
  else if (score <= 45 && compositeDown) signal = '主力撤退';

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
import type { TdccDay } from '@/lib/chips/types';
import { fetchMarginForStock, fetchDayTradeForStock, fetchLendingForStock, fetchLendingHistoryForStock } from '@/lib/datasource/FinmindChipExtras';
import { getSharesIssued } from '@/lib/datasource/FinMindClient';
import { detectTrend, rollingChange } from '@/lib/chips/trends';
import { fetchYahooBrokerTrades, type BrokerRankRow } from '@/lib/datasource/YahooBrokerScraper';
import { fetchTwseSblForStock, fetchTwseSblHistory } from '@/lib/datasource/TwseSblProvider';
import { fetchTpexSblForStock, fetchTpexSblHistory } from '@/lib/datasource/TpexSblProvider';
import { fetchTwseMarginForStock } from '@/lib/datasource/TwseMarginProvider';
import { fetchTpexMarginForStock } from '@/lib/datasource/TpexMarginProvider';
import { getCostBasisBundle, toCostBasisSummary } from '@/lib/chipcost/aggregate';
import type { CostBasisSummary } from '@/lib/chipcost/types';
import { computeInstDerived } from '@/lib/chips/instDerived';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';

/** 讀本地 L1 日K，取指定日的成交量（張）；上市 .TW → 上櫃 .TWO fallback；缺 → null */
async function loadVolumeLotsOnDate(code: string, date: string): Promise<number | null> {
  for (const suffix of ['TW', 'TWO'] as const) {
    const file = await readCandleFile(`${code}.${suffix}`, 'TW').catch(() => null);
    if (!file) continue;
    const bar = file.candles.find(c => c.date === date);
    return bar?.volume ?? null;   // 檔案存在但該日無 bar → null（不再試另一後綴）
  }
  return null;
}

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
  // FinMind 融資/借券通常盤後 17:00 才揭露；當日盤中或剛開盤抓 → 沒資料
  // 預設改用「最近一個揭露完成的交易日」：若現在台北時間 < 17:00 或 > 0:00 還沒過完今日，就退到昨日
  const now = new Date();
  const taipeiHour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', hour12: false, hour: '2-digit' }).format(now), 10);
  const taipeiToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(now);
  const defaultDate = (() => {
    if (taipeiHour >= 17) return taipeiToday;  // 17:00 後當日已揭露
    const y = new Date(now.getTime() - 86400_000);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(y);
  })();
  const rawDate = parsed.data.date ?? defaultDate;
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
    // 融資融券：TWSE（上市）→ TPEX（上櫃）→ FinMind 最後 fallback；全部免費無 quota
    const marginPromise = (async () => {
      const tw = await fetchTwseMarginForStock(code, date).catch(() => null);
      if (tw) return { marginBalance: tw.marginBalance, marginNet: tw.marginNet, shortBalance: tw.shortBalance, shortNet: tw.shortNet, marginUtilRate: tw.marginUtilRate };
      const tpex = await fetchTpexMarginForStock(code, date).catch(() => null);
      if (tpex) return { marginBalance: tpex.marginBalance, marginNet: tpex.marginNet, shortBalance: tpex.shortBalance, shortNet: tpex.shortNet, marginUtilRate: tpex.marginUtilRate };
      return fetchMarginForStock(code, date);
    })();

    const settled = await Promise.allSettled([
      readTdccStock(code),
      marginPromise,
      fetchDayTradeForStock(code, date),
      // v3: SBL — TWSE（上市）→ TPEX（上櫃）fallback；全免費無 quota
      fetchTwseSblForStock(code, date).then(r => r ?? fetchTpexSblForStock(code, date)).catch(() => null),
      getSharesIssued(code),
      // 30 天歷史做趨勢；TWSE 沒有就試 TPEX
      fetchTwseSblHistory(code, date, 30).then(h => h.length > 0 ? h : fetchTpexSblHistory(code, date, 30)).catch(() => []),
      // v3: 主力券商分點（Yahoo 籌碼頁；對齊籌碼K線「主力 -102」）
      fetchYahooBrokerTrades(code),
      // v5: 法人最新資料日的當日成交量（張，本地 L1；衍生欄位占量計算用）
      instOnDate ? loadVolumeLotsOnDate(code, instOnDate.date) : Promise.resolve(null),
    ]);
    const pickFulfilled = <T,>(idx: number): T | null => {
      const r = settled[idx];
      return r.status === 'fulfilled' ? (r.value as T) : null;
    };
    const tdccFile = pickFulfilled<Awaited<ReturnType<typeof readTdccStock>>>(0);
    const marginInfo = pickFulfilled<Awaited<ReturnType<typeof fetchMarginForStock>>>(1);
    const dayTradeInfo = pickFulfilled<Awaited<ReturnType<typeof fetchDayTradeForStock>>>(2);
    const sblToday = pickFulfilled<Awaited<ReturnType<typeof fetchTwseSblForStock>>>(3);
    const sharesIssued = pickFulfilled<number>(4);
    const sblHistory = pickFulfilled<Awaited<ReturnType<typeof fetchTwseSblHistory>>>(5) ?? [];
    const brokerTrades = pickFulfilled<Awaited<ReturnType<typeof fetchYahooBrokerTrades>>>(6);
    const latestVolumeLots = pickFulfilled<number | null>(7);
    // 把 sblToday 轉成 lendingInfo shape 給後面 code 用（向下相容）
    const lendingInfo = sblToday ? {
      lendingBalance: sblToday.lendingBalance,
      lendingNet: sblToday.lendingNet,
    } : null;
    const lendingHistory = sblHistory.map(r => ({
      date: r.date,
      lendingBalance: r.lendingBalance,
      lendingNet: r.lendingNet,
    }));
    const latestTdcc = tdccFile?.data[tdccFile.data.length - 1];
    const prevTdcc = tdccFile?.data[tdccFile.data.length - 2];

    const clampPct = (v: number | undefined): number =>
      Math.min(100, Math.max(0, v ?? 0));

    // ── v2: 趨勢偵測（取最近 N 個交易日的 inst row）──
    const recentInstRows = (instFile?.data ?? []).slice(-15);  // 取最近 15 個交易日
    const trendForeign = detectTrend(recentInstRows.map(r => r.foreign), 'buy_sell');
    const trendTrust = detectTrend(recentInstRows.map(r => r.trust), 'buy_sell');
    const trendDealer = detectTrend(recentInstRows.map(r => r.dealer), 'buy_sell');
    const trendInst = detectTrend(recentInstRows.map(r => r.total), 'buy_sell');
    // 融資趨勢從 fetchMarginForStock 只有單日，先標 flat（之後可再補 history）
    const trendMargin: TrendInfo | undefined = undefined;
    // 借券趨勢
    const lendingRows = lendingHistory.slice(-15);
    const trendLending = detectTrend(lendingRows.map(r => r.lendingNet), 'inc_dec');

    // ── 主力綜合（當日，張）對齊籌碼 K 線「主力」口徑
    // v3: 優先用 Yahoo 籌碼分點 (totalDifferenceVolK)，無資料時 fallback 用三法人+融資/借券合成
    const marginNetToday = marginInfo?.marginNet ?? 0;
    const lendingNetToday = lendingInfo?.lendingNet ?? 0;
    const computeComposite = (row: { foreign: number; trust: number; dealer: number }, mNet: number, lNet: number): number => {
      return row.foreign + row.trust + row.dealer - lNet * 0.7 - mNet * 0.5;
    };
    const compositeSeries = recentInstRows.map(r => computeComposite(r, 0, 0));
    const compositeToday = brokerTrades?.totalDifferenceVolK != null
      ? brokerTrades.totalDifferenceVolK
      : instOnDate ? computeComposite(instOnDate, marginNetToday, lendingNetToday) : 0;
    // trendComposite 仍用三法人 series（broker scraper 只有當日 snapshot 沒歷史）
    const trendComposite = detectTrend(compositeSeries, 'buy_sell');

    // ── 大戶 5 週變化 — 籌碼 K 線定義：最新一筆 TDCC snapshot 與上一筆的差
    //    （TDCC 每週四公布，所以「5 週」實際上是「最近 1 個週度 delta」）
    //    連續方向偵測：對 weekly delta 序列跑 detectTrend
    let holder5wChange: { largePct: number; retailPct: number } | undefined;
    let holder5mChange: { largePct: number } | undefined;
    let trendHolderLarge: TrendInfo | undefined;
    if (tdccFile?.data && tdccFile.data.length >= 2) {
      const rows = tdccFile.data;
      const latestLarge = clampPct(rows[rows.length - 1].holder400Pct);
      const prevLarge = clampPct(rows[rows.length - 2].holder400Pct);
      const wkDelta = latestLarge - prevLarge;
      holder5wChange = { largePct: wkDelta, retailPct: -wkDelta };

      // 5 月變化 = 最近 ~21 筆 weekly snapshot 之前的值 vs 現在；TDCC weekly 約每 7 天一筆
      if (rows.length >= 21) {
        const baseIdx = Math.max(0, rows.length - 21);
        holder5mChange = { largePct: latestLarge - clampPct(rows[baseIdx].holder400Pct) };
      }

      // 對 weekly delta series 偵測連 N 增 / N 減
      const deltas: number[] = [];
      for (let i = 1; i < rows.length; i++) {
        deltas.push(clampPct(rows[i].holder400Pct) - clampPct(rows[i - 1].holder400Pct));
      }
      trendHolderLarge = detectTrend(deltas.slice(-10), 'inc_dec');
    }

    // 投信動向（30/60/90 天累計淨買換算 pp）
    const instRows = instFile?.data ?? [];
    const trustNetBuy30d = sumTrustNetBuy(instRows, date, 30);
    const trustNetBuy60d = sumTrustNetBuy(instRows, date, 60);
    const trustNetBuy90d = sumTrustNetBuy(instRows, date, 90);
    const trustHoldingChange30d = netBuyToPp(trustNetBuy30d, sharesIssued);
    const trustHoldingChange60d = netBuyToPp(trustNetBuy60d, sharesIssued);
    const trustHoldingChange90d = netBuyToPp(trustNetBuy90d, sharesIssued);
    const trustMomentumStage = classifyTrustMomentum(trustHoldingChange30d);

    // ── v5: 三大法人衍生欄位（連買天數 / 占量 / 同步買）──
    // 錨定在「實際回傳的法人資料日」（instOnDate 可能是盤中 fallback 的最新歷史日），
    // 序列只取錨定日（含）以前，確保連買天數與 foreignBuy 顯示值同一基準。
    const anchorInstDate = instOnDate?.date;
    const instDerived = computeInstDerived(
      anchorInstDate ? instRows.filter(r => r.date <= anchorInstDate) : [],
      latestVolumeLots,
    );
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
    const h400To600 = clampPct(latestTdcc?.holder400To600Pct);
    const h600To800 = clampPct(latestTdcc?.holder600To800Pct);
    const h800To1000 = clampPct(latestTdcc?.holder800To1000Pct);
    const h1000 = clampPct(latestTdcc?.holder1000Pct);
    const structureBuilding =
      h400To600 > 0 && h600To800 > 0 && h800To1000 > 0 && h1000 > 0;
    const holder1000Change = latestTdcc && prevTdcc
      ? +(clampPct(latestTdcc.holder1000Pct) - clampPct(prevTdcc.holder1000Pct)).toFixed(2)
      : 0;

    // ── 各 tier「跟前一週比」週變化（pp）+ 連續週趨勢（連 N 增/減）──
    //    防呆：holder100/200 與三個細分桶是 2026-05-22 後才有的選填欄位；
    //    舊週缺值會被 clampPct→0 算成「假性暴增」，所以一律要「兩週都有原始值」才比。
    const tierWoW = (cur?: number, prev?: number): number | null =>
      (cur != null && prev != null) ? +(clampPct(cur) - clampPct(prev)).toFixed(2) : null;
    const holderTierChange = latestTdcc ? {
      h100:       tierWoW(latestTdcc.holder100Pct,       prevTdcc?.holder100Pct),
      h200:       tierWoW(latestTdcc.holder200Pct,       prevTdcc?.holder200Pct),
      h400:       tierWoW(latestTdcc.holder400Pct,       prevTdcc?.holder400Pct),
      h1000:      tierWoW(latestTdcc.holder1000Pct,      prevTdcc?.holder1000Pct),
      h400To600:  tierWoW(latestTdcc.holder400To600Pct,  prevTdcc?.holder400To600Pct),
      h600To800:  tierWoW(latestTdcc.holder600To800Pct,  prevTdcc?.holder600To800Pct),
      h800To1000: tierWoW(latestTdcc.holder800To1000Pct, prevTdcc?.holder800To1000Pct),
    } : undefined;

    // 連續週趨勢：只用「該欄位有值」的週來組 weekly delta 序列（跳過缺欄位週，避免初次出現算成假跳階）
    const tierDeltaSeries = (pick: (d: TdccDay) => number | undefined): number[] => {
      const vals: number[] = [];
      for (const r of (tdccFile?.data ?? [])) { const v = pick(r); if (v != null) vals.push(clampPct(v)); }
      const ds: number[] = [];
      for (let i = 1; i < vals.length; i++) ds.push(vals[i] - vals[i - 1]);
      return ds.slice(-10);
    };
    const tierTrend = (pick: (d: TdccDay) => number | undefined): TrendInfo | undefined =>
      (tdccFile?.data?.length ?? 0) >= 2 ? detectTrend(tierDeltaSeries(pick), 'inc_dec') : undefined;
    const holderTierTrend = latestTdcc ? {
      h100:  tierTrend(d => d.holder100Pct),
      h200:  tierTrend(d => d.holder200Pct),
      h400:  tierTrend(d => d.holder400Pct),
      h1000: tierTrend(d => d.holder1000Pct),
    } : undefined;

    const inst = instOnDate ? { foreignBuy, trustBuy, dealerBuy, totalBuy, name: '' } : undefined;
    const { score, grade, signal, detail } = calculateChipScore({
      inst: inst ? { foreignBuy, trustBuy, dealerBuy, totalBuy } : undefined,
      margin: marginInfo ? {
        marginNet: marginInfo.marginNet,
        shortNet: marginInfo.shortNet,
        marginUtilRate: marginInfo.marginUtilRate,
      } : undefined,
      dt: dayTradeInfo ?? undefined,
      lending: lendingInfo ?? undefined,
      holder5w: holder5wChange ? {
        largeChangePct: holder5wChange.largePct,
        retailChangePct: holder5wChange.retailPct,
      } : undefined,
      composite: compositeToday,
      trends: {
        foreign: trendForeign,
        trust: trendTrust,
        dealer: trendDealer,
        institutional: trendInst,
        margin: trendMargin,
        lending: trendLending,
        composite: trendComposite,
      },
    });

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
      holderTierChange,
      holderTierTrend,
      tdccDate: latestTdcc?.date,
      tdccPrevDate: prevTdcc?.date,
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
      // v2 — 9 區塊 + 趨勢
      composite: compositeToday,
      trends: {
        foreign: trendForeign,
        trust: trendTrust,
        dealer: trendDealer,
        institutional: trendInst,
        margin: trendMargin,
        lending: trendLending,
        composite: trendComposite,
        holderLarge: trendHolderLarge,
      },
      holder5wChange,
      holder5mChange,
      // v3 主力券商分點
      brokerNetBuy: brokerTrades?.totalDifferenceVolK,
      brokerConcentration: brokerTrades
        ? (brokerTrades.concentration * 100 * (brokerTrades.totalDifferenceVolK >= 0 ? 1 : -1))
        : undefined,
      topBuyers: brokerTrades?.buyerRankList,
      topSellers: brokerTrades?.sellerRankList,
      // v5 三大法人衍生欄位（純顯示）
      ...instDerived,
    };

    // v4 成本／壓力價摘要（best-effort；失敗不影響籌碼面板主體）
    try {
      const bundle = await getCostBasisBundle(rawSymbol, date);
      data.costBasis = toCostBasisSummary(bundle);
    } catch (err) {
      console.warn('[/api/chip] costBasis 計算失敗:', err instanceof Error ? err.message : err);
    }

    return apiOk(data);
  } catch (err) {
    console.error('[/api/chip] error:', err);
    return apiError('籌碼資料讀取失敗');
  }
}
