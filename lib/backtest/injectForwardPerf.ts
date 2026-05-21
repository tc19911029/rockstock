/**
 * 把 forward performance 灌進 StockScanResult[]（in-place mutation）
 *
 * 用途：cron 寫 session 前先注入，讓 client 切歷史日期時可以直接讀內嵌欄位
 * 而不必再打 POST /api/backtest/forward。
 *
 * 2026-05-21：原本只有 ScanPipeline.ts 在 buyMethods 迴圈裡 inline 這段，
 * scan-bm-batch/route.ts（生產 cron）跟 R 機械軌都沒接，導致 session 內所有
 * forward 欄位（openReturn/d1Return/.../d20Return/maxGain/maxLoss/...）全 null，
 * 前端每次切日期都重打一次 /api/backtest/forward POST，每次 40-80s。
 *
 * 抽出來統一一處實作，三處 caller 共用（ScanPipeline、scan-bm-batch、R 分支）。
 */

import type { StockScanResult } from '@/lib/scanner/types';

/**
 * 為 results 灌入 forward perf 欄位（in-place）
 *
 * - 若 results 為空或 analyzeForwardBatch 失敗，靜默返回（不阻擋 cron）
 * - 失敗時印 warn log（含 caller tag）便於追蹤
 *
 * @param results  cron 跑完的 ScanResult 陣列（會被 mutate）
 * @param scanDate session 日期 YYYY-MM-DD
 * @param tag      log prefix（如 'scan-bm-batch:Q'、'ScanPipeline:R'）
 */
export async function injectForwardPerf(
  results: StockScanResult[],
  scanDate: string,
  tag: string,
): Promise<void> {
  if (results.length === 0) return;
  try {
    const { analyzeForwardBatch } = await import('@/lib/backtest/ForwardAnalyzer');
    const fwdInput = results.map(r => ({ symbol: r.symbol, name: r.name, scanPrice: r.price }));
    const { results: fwdPerf } = await analyzeForwardBatch(fwdInput, scanDate);
    const fwdMap = new Map(fwdPerf.map(p => [p.symbol, p]));
    for (const r of results) {
      const p = fwdMap.get(r.symbol);
      if (!p) continue;
      r.openReturn = p.openReturn;
      r.d1Return = p.d1Return; r.d2Return = p.d2Return; r.d3Return = p.d3Return;
      r.d4Return = p.d4Return; r.d5Return = p.d5Return; r.d6Return = p.d6Return;
      r.d7Return = p.d7Return; r.d8Return = p.d8Return; r.d9Return = p.d9Return;
      r.d10Return = p.d10Return; r.d20Return = p.d20Return;
      r.maxGain = p.maxGain; r.maxLoss = p.maxLoss;
      r.nextOpenPrice = p.nextOpenPrice;
      r.d1ReturnFromOpen = p.d1ReturnFromOpen;
      r.d5ReturnFromOpen = p.d5ReturnFromOpen;
      r.d6ReturnFromOpen = p.d6ReturnFromOpen;
      r.d7ReturnFromOpen = p.d7ReturnFromOpen;
      r.d8ReturnFromOpen = p.d8ReturnFromOpen;
      r.d9ReturnFromOpen = p.d9ReturnFromOpen;
      r.d10ReturnFromOpen = p.d10ReturnFromOpen;
    }
  } catch (err) {
    console.warn(`[${tag}] forward 注入失敗（non-fatal）:`, err);
  }
}
