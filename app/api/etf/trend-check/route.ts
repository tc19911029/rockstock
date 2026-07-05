import { apiOk, apiError } from '@/lib/api/response';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { aggregateCandles } from '@/lib/datasource/aggregateCandles';
import { computeIndicators } from '@/lib/indicators';
import { detectTrend } from '@/lib/analysis/trendAnalysis';

export const runtime = 'nodejs';

// ── ETF 趨勢出場檢查（直播課 2026-07-01 Q53）─────────────────────────────
// 課程判準：大盤型 ETF（0050 這類）想長抱 →「日線趨勢轉空就出場；
// 真的想抱久 → 退一步看週線：週線頭頭低/轉空＝中長空確認，必須出場。
// 空頭趨勢的股票只會跌不會漲，沒有理由抱。」
// 純顯示層：不進選股、不推播，只在 ETF 追蹤 tab 給一行結論。

const BASE_ETFS = ['0050', '006208']; // 大盤型代表；持倉裡的 00 開頭台股碼會自動加入

interface TrendCheckItem {
  symbol: string;
  name: string;
  dailyTrend: string;
  weeklyTrend: string;
  verdict: string;
  tone: 'exit' | 'warn' | 'hold';
}

export async function GET() {
  try {
    const symbols = [...BASE_ETFS];
    try {
      const { listOpenHoldings } = await import('@/lib/agents/portfolio/storage');
      const holdings = await listOpenHoldings();
      for (const h of holdings) {
        const bare = h.symbol.replace(/\.(TW|TWO)$/i, '');
        if (/^00\d{2,4}[A-Z]?$/.test(bare) && !symbols.includes(bare)) symbols.push(bare);
      }
    } catch { /* 持倉讀不到 → 只看基本清單 */ }

    const items: TrendCheckItem[] = [];
    for (const sym of symbols) {
      try {
        // L1 檔名帶市場後綴（0050.TW.json）→ 依序試 .TW / 裸碼 / .TWO
        let file = await readCandleFile(`${sym}.TW`, 'TW');
        if (!file?.candles?.length) file = await readCandleFile(sym, 'TW');
        if (!file?.candles?.length) file = await readCandleFile(`${sym}.TWO`, 'TW');
        const daily = file?.candles;
        if (!Array.isArray(daily) || daily.length < 120) continue;
        const dailyTrend = detectTrend(computeIndicators(daily), daily.length - 1);
        const weekly = aggregateCandles(daily, '1wk');
        const weeklyTrend = weekly.length >= 30
          ? detectTrend(computeIndicators(weekly), weekly.length - 1)
          : '盤整';

        let verdict: string;
        let tone: TrendCheckItem['tone'];
        if (weeklyTrend === '空頭') {
          verdict = '週線已轉空 → 長抱的也該出場（課程 Q53：空頭只會跌，沒有理由抱）';
          tone = 'exit';
        } else if (dailyTrend === '空頭') {
          verdict = '日線轉空 → 標準做法出場；想長抱的盯週線（週線也轉空就必須走）';
          tone = 'warn';
        } else if (dailyTrend === '盤整') {
          verdict = '→ 觀察，跌破區間再處理';
          tone = 'hold';
        } else {
          verdict = '→ 續抱';
          tone = 'hold';
        }
        items.push({
          symbol: sym,
          name: (file as { name?: string } | null)?.name ?? sym,
          dailyTrend, weeklyTrend, verdict, tone,
        });
      } catch { /* 單檔失敗跳過 */ }
    }
    return apiOk({ items });
  } catch {
    return apiError('ETF 趨勢檢查失敗', 500);
  }
}
