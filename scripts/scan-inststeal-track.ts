/**
 * 法人偷買(原)軌（Y）掃描驅動 — 對某日跑 scanner.scanInstSteal → injectForwardPerf(d1..d20)
 * → saveScanSession(buyMethod='Y', step1Filter='bypassed')。本地 launchd / 手動回填用。
 *
 * 用法：
 *   npx tsx scripts/scan-inststeal-track.ts --date 2026-06-12
 *   npx tsx scripts/scan-inststeal-track.ts --from 2026-05-14 --to 2026-06-12   # 回填
 *   npx tsx scripts/scan-inststeal-track.ts --days 40
 *
 * 僅 TW；池子＝同時有「主力分點 broker」+「三大法人 inst」資料的股票。
 */
import { promises as fs } from 'fs';
import path from 'path';

const TWII = path.join(process.cwd(), 'data/candles/TW/^TWII.json');

async function tradingDays(n: number, upto?: string): Promise<string[]> {
  const j = JSON.parse(await fs.readFile(TWII, 'utf8'));
  let dates: string[] = (j.candles || []).map((c: { date: string }) => c.date);
  if (upto) dates = dates.filter(d => d <= upto);
  return dates.slice(-n);
}

async function main() {
  const args = process.argv.slice(2);
  const dateArg = args.includes('--date') ? args[args.indexOf('--date') + 1] : null;
  const daysArg = args.includes('--days') ? parseInt(args[args.indexOf('--days') + 1], 10) : null;
  const fromArg = args.includes('--from') ? args[args.indexOf('--from') + 1] : null;
  const toArg = args.includes('--to') ? args[args.indexOf('--to') + 1] : null;

  // 池子＝當日成交額前 500（與 W/X 軌一致；不再用 broker∩inst 限制）。
  // scanInstSteal 內部仍需 broker+inst 齊備才評估該股，缺資料自動略過。
  const { TaiwanScanner } = await import('../lib/scanner/TaiwanScanner');
  const { computeTurnoverRankAsOfDate } = await import('../lib/scanner/TurnoverRank');
  const scanner = new TaiwanScanner();
  const allStocks = await scanner.getStockList();
  console.log(`全市場 ${allStocks.length} 檔 → 每日取「成交額前 500」當池子（上市+上櫃）`);

  let dates: string[];
  if (dateArg) dates = [dateArg];
  else if (fromArg || toArg) {
    const all = await tradingDays(100000, toArg ?? undefined);
    dates = all.filter(d => (!fromArg || d >= fromArg) && (!toArg || d <= toArg));
  } else if (daysArg) dates = await tradingDays(daysArg);
  else dates = await tradingDays(1);

  const { injectForwardPerf } = await import('../lib/backtest/injectForwardPerf');
  const { saveScanSession } = await import('../lib/storage/scanStorage');

  for (const date of dates) {
    try {
      // 當日成交額前 500（point-in-time，歷史重跑用當時的前 500，不偷看今天）
      const rankMap = await computeTurnoverRankAsOfDate('TW', allStocks, date, 500);
      const stocks = allStocks.filter((s: { symbol: string }) => rankMap.has(s.symbol));
      const results = await scanner.scanInstSteal(stocks, date, 'long', 15);
      await injectForwardPerf(results, date, `Y-track:${date}`);
      await saveScanSession({
        id: `TW-long-Y-${date}-${Date.now()}`,
        market: 'TW',
        date,
        direction: 'long',
        multiTimeframeEnabled: false,
        sessionType: 'post_close',
        scanTime: new Date().toISOString(),
        resultCount: results.length,
        results,
        marketTrend: '',
        buyMethod: 'Y',
        step1Filter: 'bypassed',
      } as Parameters<typeof saveScanSession>[0], { allowOverwritePostClose: true });
      console.log(`✅ ${date}: 命中 ${results.length} 檔` +
        (results.length ? ` — ${results.slice(0, 5).map(r => `${r.symbol.split('.')[0]}(連買${r.instStealConsec}天)`).join(' ')}` : ''));
    } catch (e) {
      console.error(`❌ ${date}:`, e instanceof Error ? e.message : e);
    }
  }
  console.log('完成');
}

main().catch(e => { console.error(e); process.exit(1); });
