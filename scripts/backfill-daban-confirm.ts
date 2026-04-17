import { confirmDabanAtOpen } from '../lib/scanner/DabanScanner';

async function main() {
  const pairs: [string, string][] = [
    ['2026-04-14', '2026-04-15'],
    ['2026-04-15', '2026-04-16'],
  ];
  for (const [scanDate, openDate] of pairs) {
    console.log(`=== ${scanDate} → ${openDate} ===`);
    const result = await confirmDabanAtOpen(scanDate, openDate);
    if (!result) { console.log('  NULL'); continue; }
    const withOC = result.results.filter(r => r.openConfirmed !== undefined).length;
    const confirmed = result.results.filter(r => r.openConfirmed).length;
    console.log(`  total=${result.results.length}  withOC=${withOC}  confirmed=${confirmed}`);
    const top5 = result.results.slice(0, 5).map(r => ({
      sym: r.symbol, cp: r.closePrice, op: r.openPrice, th: r.buyThresholdPrice, gu: r.gapUpPct, oc: r.openConfirmed,
    }));
    console.log('  top5:', JSON.stringify(top5, null, 2));
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
