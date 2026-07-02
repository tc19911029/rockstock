/**
 * 籌碼資料體檢 — 盯「持倉股」最新交易日的籌碼欄位有沒有變空/過期，紅了讓 health 自動報警。
 *
 * 為什麼（2026-06-19）：買賣超原本只靠 Yahoo cron（一天只抓前 250 檔）→ 排在後面的持倉股
 * 靜默漏、欄位留白，只能等使用者眼睛掃到。換源（改吃 FinMind 分點同源）治了那一欄，但
 * 「失敗只留白、不報警」才是這類 bug 反覆出現的真正根因。這支把「籌碼變空」接進每日
 * health snapshot → 紅燈 webhook，讓**系統先叫、不是使用者先發現**。見 [[feedback-fill-data-gaps-proactively]]。
 *
 * 設計（避免誤報）：
 *   - 對象＝全 profile 的 open 持倉（台股；籌碼是 TW-only）。沒幾檔 → 主動打源、不靠別的 cron 先暖。
 *   - 主動向 FinMind 分點要「該股最近 2 個交易日」的資料（用 L1 K 線當交易日曆）。
 *     2 日窗＝容「今日盤後分點未出 / 今日 L1 未封存」，所以單日暫時抓不到不會誤報；
 *     要落後 ≥2 個交易日（像 5314 卡 06-15、今天已 06-18）才算 stale → 報警。
 *   - 停牌股自然免疫：沒新 K 線 → 窗就停在最後交易日 → 分點也停在那 → 落在窗內＝fresh。
 *   - 純讀檔 + 少量 FinMind（每檔 ≤2 次），不擴 L1、不改任何選股 gate。
 */
import { listAllProfilesOpenStockHoldings } from '@/lib/agents/portfolio/storage';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { fetchFinMindBranchDay } from '@/lib/datasource/FinMindBranchProvider';

export interface ChipStaleEntry {
  symbol: string;
  name: string;
  /** 該股「最近有分點資料」的日期；null = 連最近 2 個交易日都抓不到 */
  chipLast: string | null;
  /** 期望的最新交易日（該股 L1 最後一根 K 線日） */
  expected: string | null;
}

export interface ChipFreshnessResult {
  level: 'green' | 'red';
  /** 實際檢查的台股持倉檔數（排除太短/無 K 線無法判斷者） */
  checked: number;
  /** 籌碼過期（買賣超/集中度會留白）的持倉 */
  stale: ChipStaleEntry[];
  note?: string;
}

/** 台股代號（4-5 位數字，可帶 .TW/.TWO）；排除陸股 .SS/.SZ 與場外基金 .OF */
function isTwStock(symbol: string): boolean {
  if (/\.(SS|SZ|OF)$/i.test(symbol)) return false;
  return /^\d{4,5}(\.(TW|TWO))?$/i.test(symbol);
}

const CONCURRENCY = 4;

/**
 * 體檢全持倉台股的「買賣超/集中度」籌碼新鮮度（FinMind 分點同源）。
 * 任一持倉籌碼落後 ≥2 個交易日 → level=red（持倉是天天在看的，空了就該修，不設黃）。
 */
export async function checkChipFreshness(): Promise<ChipFreshnessResult> {
  const holdings = (await listAllProfilesOpenStockHoldings()).filter(h => isTwStock(h.symbol));
  if (holdings.length === 0) return { level: 'green', checked: 0, stale: [], note: '無台股持倉' };

  const stale: ChipStaleEntry[] = [];
  let checked = 0;

  for (let i = 0; i < holdings.length; i += CONCURRENCY) {
    const chunk = holdings.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async h => {
      const code = h.symbol.replace(/\.(TW|TWO)$/i, '');
      const cf = (await readCandleFile(`${code}.TW`, 'TW')) ?? (await readCandleFile(`${code}.TWO`, 'TW'));
      // K 線太短（新股/停牌剛上市）→ 無法判斷新鮮度，跳過不誤報
      if (!cf?.candles || cf.candles.length < 5) return;
      checked++;

      // 新鮮窗＝該股 L1 最近 2 個交易日（先查最新那天，沒有再退一天）
      const recent2 = cf.candles.slice(-2).map(c => c.date);
      const expected = recent2[recent2.length - 1] ?? null;
      let chipLast: string | null = null;
      for (const d of [...recent2].reverse()) {
        const net = await fetchFinMindBranchDay(code, d);
        if (net.size > 0) { chipLast = d; break; }
      }
      if (chipLast == null) stale.push({ symbol: h.symbol, name: h.name, chipLast, expected });
    }));
  }

  return { level: stale.length > 0 ? 'red' : 'green', checked, stale };
}
