/**
 * 用 FinMind 分點補寫「主力分點淨買賣超」到 broker 檔 — 取代會漏的 Yahoo 250 檔上限 cron。
 *
 * 為什麼（2026-06-19）：原 snapshot-broker-tw 抓 Yahoo 當日快照，但一次只掃前 250 檔
 * （broker∪inst 共 2300+ 檔）→ 排在後面的持倉股（含 2330/5314/6770）靜默漏，連帶
 * 「主力成本」(lib/chipcost/brokerCost)、掃描、/api/chip 集中度欄都跟著斷。FinMind 分點
 * 同源、沒有 250 上限、有歷史 → 改用它逐檔補寫 broker 檔最新一筆，這些下游就持續累積。
 *
 * 口徑與 [lib/chips/chipConcentration.ts] 的集中度完全一致（前 15 大淨買賣超 ÷ 當日量）。
 * 純資料流、不改任何選股 gate。掛在 prewarm-chip（18:10，分點已出）對持倉股逐檔跑。
 */
import { fetchFinMindBranchDay } from '@/lib/datasource/FinMindBranchProvider';
import { dailyNetFromBranch } from '@/lib/chips/chipConcentration';
import { appendBrokerDay, readBrokerStock } from '@/lib/chips/BrokerStorage';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';

/**
 * 對單一台股，用 FinMind 分點補寫「最新交易日」的主力淨買賣超到 broker 檔。
 * - 以 L1 K 線最後一根當目標日；該日分點未出 → 退一天（容盤後尚未公布）。
 * - 已有該日資料就跳過（idempotent，重跑不重複寫）。
 * @returns 寫入的日期；null = 無 K 線/分點抓不到/已存在 → 沒動檔
 */
export async function snapshotBrokerDayFromFinMind(code: string): Promise<string | null> {
  const cf = (await readCandleFile(`${code}.TW`, 'TW')) ?? (await readCandleFile(`${code}.TWO`, 'TW'));
  if (!cf?.candles || cf.candles.length < 2) return null;

  const existing = await readBrokerStock(code);
  const haveLast = existing?.lastDate ?? '';

  // 目標日＝最近 2 個交易日，先試最新那天，沒有再退一天（盤後分點未出）
  const recent2 = cf.candles.slice(-2);
  for (let i = recent2.length - 1; i >= 0; i--) {
    const c = recent2[i];
    if (c.date <= haveLast) continue; // 已寫過 → 不重寫（也代表更新的那天還沒分點，跳過）
    const branch = await fetchFinMindBranchDay(code, c.date);
    const net = dailyNetFromBranch(branch);
    if (net == null) continue; // 該日分點未出 → 試更早一天
    const volK = c.volume || 0;
    const concentration = volK > 0 ? +(((net / volK) * 100).toFixed(2)) : 0;
    await appendBrokerDay(code, c.date, { netDifference: net, concentration });
    return c.date;
  }
  return null;
}
