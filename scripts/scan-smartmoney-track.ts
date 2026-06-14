/**
 * W 大戶偷買軌 — 掃描並存 L4（給走圖主頁的 W tab 用）
 *
 * 對某日跑 scanner.scanSmartMoneyDip → injectForwardPerf(自動算 d1..d20 漲跌幅)
 * → saveScanSession(buyMethod='W', step1Filter='bypassed')
 *
 * 用法：
 *   npx tsx scripts/scan-smartmoney-track.ts                 # 掃最新交易日
 *   npx tsx scripts/scan-smartmoney-track.ts --date 2026-05-10
 *   npx tsx scripts/scan-smartmoney-track.ts --days 40       # 回填最近 40 個交易日（歷史紀錄+回測）
 *
 * 僅 TW（主力分點 broker）；CN 主力資金歷史不足 → scanSmartMoneyDip 回空。
 */
import { promises as fs } from 'fs';
import path from 'path';

const BROKER_DIR = path.join(process.cwd(), 'data/chips/TW/broker');
const TWII = path.join(process.cwd(), 'data/candles/TW/^TWII.json');

async function tradingDays(n: number, upto?: string): Promise<string[]> {
  const j = JSON.parse(await fs.readFile(TWII, 'utf8'));
  let dates: string[] = (j.candles || []).map((c: { date: string }) => c.date);
  if (upto) dates = dates.filter(d => d <= upto);
  return dates.slice(-n);
}

async function brokerCodes(): Promise<Set<string>> {
  const files = (await fs.readdir(BROKER_DIR)).filter(f => /^\d{4}\.json$/.test(f));
  return new Set(files.map(f => f.replace('.json', '')));
}

async function main() {
  const args = process.argv.slice(2);
  const dateArg = args.includes('--date') ? args[args.indexOf('--date') + 1] : null;
  const daysArg = args.includes('--days') ? parseInt(args[args.indexOf('--days') + 1], 10) : null;

  // 只掃有主力分點資料的股票（W refined 訊號需要主力分點）→ 大幅省掃描時間
  const codes = await brokerCodes();

  const { TaiwanScanner } = await import('../lib/scanner/TaiwanScanner');
  const scanner = new TaiwanScanner();
  const allStocks = await scanner.getStockList();
  const stocks = allStocks.filter((s: { symbol: string }) => codes.has(s.symbol.split('.')[0]));
  console.log(`股票池：主力分點有資料 ${stocks.length} 檔（全市場 ${allStocks.length}）`);

  const fromArg = args.includes('--from') ? args[args.indexOf('--from') + 1] : null;
  const toArg = args.includes('--to') ? args[args.indexOf('--to') + 1] : null;

  let dates: string[];
  if (dateArg) dates = [dateArg];
  else if (fromArg || toArg) {
    const all = await tradingDays(100000, toArg ?? undefined);
    dates = all.filter(d => (!fromArg || d >= fromArg) && (!toArg || d <= toArg));
  }
  else if (daysArg) dates = await tradingDays(daysArg);
  else dates = await tradingDays(1);

  const { injectForwardPerf } = await import('../lib/backtest/injectForwardPerf');
  const { saveScanSession } = await import('../lib/storage/scanStorage');

  for (const date of dates) {
    try {
      const results = await scanner.scanSmartMoneyDip(stocks, date, 'long', 15);
      await injectForwardPerf(results, date, `W-track:${date}`);
      await saveScanSession({
        id: `TW-long-W-${date}-${Date.now()}`,
        market: 'TW',
        date,
        direction: 'long',
        multiTimeframeEnabled: false,
        sessionType: 'post_close',
        scanTime: new Date().toISOString(),
        resultCount: results.length,
        results,
        marketTrend: '',
        buyMethod: 'W',
        step1Filter: 'bypassed',
      } as Parameters<typeof saveScanSession>[0], { allowOverwritePostClose: true });
      console.log(`✅ ${date}: 命中 ${results.length} 檔` +
        (results.length ? ` — ${results.slice(0, 5).map(r => `${r.symbol.split('.')[0]}(集中+${r.smartMoneyConc?.toFixed(0)}%)`).join(' ')}` : ''));
    } catch (e) {
      console.error(`❌ ${date}:`, e instanceof Error ? e.message : e);
    }
  }
  console.log('完成');
}

main().catch(e => { console.error(e); process.exit(1); });
