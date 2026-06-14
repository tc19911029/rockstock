/**
 * 法人接刀軌（X）掃描驅動 — 對某日跑 scanner.scanInstDip → injectForwardPerf(d1..d20)
 * → saveScanSession(buyMethod='X', step1Filter='bypassed')。本地 launchd / 手動回填用。
 *
 * 用法：
 *   npx tsx scripts/scan-instdip-track.ts --date 2026-06-12
 *   npx tsx scripts/scan-instdip-track.ts --from 2026-05-14 --to 2026-06-12   # 回填
 *   npx tsx scripts/scan-instdip-track.ts --days 40
 *
 * 僅 TW（法人 T86）；CN 回空。
 */
import { promises as fs } from 'fs';
import path from 'path';

const INST_DIR = path.join(process.cwd(), 'data/chips/TW/inst');
const TWII = path.join(process.cwd(), 'data/candles/TW/^TWII.json');

async function tradingDays(n: number, upto?: string): Promise<string[]> {
  const j = JSON.parse(await fs.readFile(TWII, 'utf8'));
  let dates: string[] = (j.candles || []).map((c: { date: string }) => c.date);
  if (upto) dates = dates.filter(d => d <= upto);
  return dates.slice(-n);
}

async function instCodes(): Promise<Set<string>> {
  const files = (await fs.readdir(INST_DIR)).filter(f => /^\d{4}\.json$/.test(f));
  return new Set(files.map(f => f.replace('.json', '')));
}

async function main() {
  const args = process.argv.slice(2);
  const dateArg = args.includes('--date') ? args[args.indexOf('--date') + 1] : null;
  const daysArg = args.includes('--days') ? parseInt(args[args.indexOf('--days') + 1], 10) : null;
  const fromArg = args.includes('--from') ? args[args.indexOf('--from') + 1] : null;
  const toArg = args.includes('--to') ? args[args.indexOf('--to') + 1] : null;

  // 法人接刀需要：法人(進場條件) + 主力分點/集保(避雷) → 池子以「法人有資料」為準
  const codes = await instCodes();
  const { TaiwanScanner } = await import('../lib/scanner/TaiwanScanner');
  const scanner = new TaiwanScanner();
  const allStocks = await scanner.getStockList();
  const stocks = allStocks.filter((s: { symbol: string }) => codes.has(s.symbol.split('.')[0]));
  console.log(`股票池：法人有資料 ${stocks.length} 檔（全市場 ${allStocks.length}）`);

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
      const results = await scanner.scanInstDip(stocks, date, 'long', 15);
      await injectForwardPerf(results, date, `X-track:${date}`);
      await saveScanSession({
        id: `TW-long-X-${date}-${Date.now()}`,
        market: 'TW',
        date,
        direction: 'long',
        multiTimeframeEnabled: false,
        sessionType: 'post_close',
        scanTime: new Date().toISOString(),
        resultCount: results.length,
        results,
        marketTrend: '',
        buyMethod: 'X',
        step1Filter: 'bypassed',
      } as Parameters<typeof saveScanSession>[0], { allowOverwritePostClose: true });
      console.log(`✅ ${date}: 命中 ${results.length} 檔` +
        (results.length ? ` — ${results.slice(0, 5).map(r => `${r.symbol.split('.')[0]}(法人+${r.instDipInstK?.toLocaleString()}張)`).join(' ')}` : ''));
    } catch (e) {
      console.error(`❌ ${date}:`, e instanceof Error ? e.message : e);
    }
  }
  console.log('完成');
}

main().catch(e => { console.error(e); process.exit(1); });
