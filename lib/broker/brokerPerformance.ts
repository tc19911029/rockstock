/**
 * 法人報告績效 — 報告日後 N 日漲跌幅（複用 computeNDayReturns）+ 目標價達成度。
 *
 * 流程（對齊 app/api/youtube/performance/route.ts）：
 *   loadDailyReports(date) → 每份報告每檔 mention → loadLocalCandles(.TW→.TWO)
 *   → injectL2TodayIfNeeded → computeNDayReturns(candles, report_date) → TargetProgress
 *
 * 重點：
 *   - 每份報告保留為獨立 item（同一檔股票被 3 家券商喊 = 3 個 item，看「哪家怎麼喊」）
 *   - 非台股（market='OTHER'）不載 K 線、status='no_data'、不計達標度
 *   - 目標價達成度只在 report_currency==='TWD' 計（外幣 → currencyMismatch）
 */

import { loadDailyReports } from './brokerStorage';
import { loadLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { injectL2TodayIfNeeded } from '@/lib/datasource/injectL2Today';
import { computeNDayReturns, type NDayReturns } from '@/lib/youtube/performance';
import type {
  BrokerMarket, BrokerRatingNormalized, RatingAction,
} from './types';
import type { StockSentiment } from '@/lib/youtube/analysisStorage';

const EMPTY_PERF: NDayReturns = {
  status: 'no_data', baseClose: null, openReturn: null,
  d1Return: null, d2Return: null, d3Return: null, d4Return: null, d5Return: null,
  d6Return: null, d7Return: null, d8Return: null, d9Return: null, d10Return: null,
  d20Return: null, maxGain: null, maxLoss: null,
};

/** 目標價達成度。 */
export interface TargetProgress {
  currentPrice: number | null;       // 最新收盤
  targetPrice: number | null;        // 券商目標價
  reportClose: number | null;        // 報告日收盤（= performance.baseClose）
  upsideAtReport: number | null;     // 報告日：(target-reportClose)/reportClose %
  distanceToTargetPct: number | null;// 現在：(target-current)/current %（正=還有空間）
  progressPct: number | null;        // 達標進度 (current-reportClose)/(target-reportClose) %（0=報告價、100=達標）
  reached: boolean;                  // 是否已觸及目標價（以最新收盤計）
  currencyMismatch: boolean;         // 目標價幣別非 TWD → 不可與台股股價直接比
}

/** 單一報告對單一股票的績效 item（performance 面板主結構）。 */
export interface BrokerStockPerformance {
  report_id: string;
  broker: string;
  broker_display: string;
  report_date: string;
  report_title: string;
  stock_code: string | null;
  stock_name: string;
  raw_query: string;
  market: BrokerMarket;
  rating: BrokerRatingNormalized;
  rating_raw: string;
  rating_action: RatingAction;
  sentiment: StockSentiment;
  covered: boolean;
  target_price: number | null;
  prev_target_price: number | null;
  report_currency: string;
  thesis: string;
  performance: NDayReturns;
  target: TargetProgress;
}

export interface BrokerPerformanceDay {
  date: string;
  baseDate: string;
  items: BrokerStockPerformance[];
  stats: {
    report_count: number;
    item_count: number;
    covered_count: number;
  };
  message?: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function computeTargetProgress(
  targetPrice: number | null,
  reportClose: number | null,
  currentPrice: number | null,
  currency: string,
): TargetProgress {
  const currencyMismatch = (currency || 'TWD').toUpperCase() !== 'TWD';
  const base: TargetProgress = {
    currentPrice, targetPrice, reportClose,
    upsideAtReport: null, distanceToTargetPct: null, progressPct: null,
    reached: false, currencyMismatch,
  };
  if (targetPrice == null || currencyMismatch) return base;

  if (reportClose != null && reportClose > 0) {
    base.upsideAtReport = round2(((targetPrice - reportClose) / reportClose) * 100);
  }
  if (currentPrice != null && currentPrice > 0) {
    base.distanceToTargetPct = round2(((targetPrice - currentPrice) / currentPrice) * 100);
  }
  if (reportClose != null && currentPrice != null && targetPrice !== reportClose) {
    base.progressPct = round2(((currentPrice - reportClose) / (targetPrice - reportClose)) * 100);
  }
  // 達標：多頭目標（target>reportClose）→ current>=target；空頭目標（target<reportClose）→ current<=target
  if (currentPrice != null && reportClose != null) {
    base.reached = targetPrice >= reportClose ? currentPrice >= targetPrice : currentPrice <= targetPrice;
  }
  return base;
}

/** 計算某日所有法人報告的報告後漲跌幅 + 目標價達成度。 */
export async function computeBrokerPerformance(date: string): Promise<BrokerPerformanceDay> {
  const day = await loadDailyReports(date);
  if (!day || day.reports.length === 0) {
    return {
      date, baseDate: date, items: [],
      stats: { report_count: 0, item_count: 0, covered_count: 0 },
      message: '此日無法人報告 — 把券商 PDF 丟進 ~/Downloads/broker-reports/ 後執行 /broker-analysis',
    };
  }

  // flatten：每份報告每檔 mention 為獨立 item
  const flat = day.reports.flatMap(r =>
    r.stocks.map(s => ({ report: r, mention: s })),
  );

  const items: BrokerStockPerformance[] = await Promise.all(
    flat.map(async ({ report, mention }) => {
      let perf: NDayReturns = EMPTY_PERF;
      let currentPrice: number | null = null;

      if (mention.market === 'TW' && mention.matched) {
        const code = mention.matched.code;
        let candles = await loadLocalCandles(`${code}.TW`, 'TW');
        let symbolForInject = `${code}.TW`;
        if (!candles || candles.length === 0) {
          candles = await loadLocalCandles(`${code}.TWO`, 'TW');
          symbolForInject = `${code}.TWO`;
        }
        candles = await injectL2TodayIfNeeded(candles, symbolForInject, 'TW', report.report_date);
        if (candles && candles.length > 0) {
          perf = computeNDayReturns(candles, report.report_date);
          currentPrice = candles[candles.length - 1].close;
        }
      }

      const target = computeTargetProgress(
        mention.target_price, perf.baseClose, currentPrice, mention.report_currency,
      );

      return {
        report_id: report.report_id,
        broker: report.broker,
        broker_display: report.broker_display,
        report_date: report.report_date,
        report_title: report.title,
        stock_code: mention.matched?.code ?? null,
        stock_name: mention.matched?.name ?? mention.raw_query,
        raw_query: mention.raw_query,
        market: mention.market,
        rating: mention.rating,
        rating_raw: mention.rating_raw,
        rating_action: mention.rating_action,
        sentiment: mention.sentiment,
        covered: mention.covered,
        target_price: mention.target_price,
        prev_target_price: mention.prev_target_price,
        report_currency: mention.report_currency,
        thesis: mention.thesis,
        performance: perf,
        target,
      };
    }),
  );

  return {
    date, baseDate: date, items,
    stats: {
      report_count: day.reports.length,
      item_count: items.length,
      covered_count: items.filter(i => i.covered).length,
    },
  };
}
