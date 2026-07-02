/** 一次性：06-12 L1 修復後，用乾淨 L1 重算 TW MA Base（原本被壞值污染）。 */
import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { generateMABase } from '@/lib/datasource/MABaseGenerator';

async function main() {
  const date = process.argv[2] || '2026-06-12';
  const scanner = new TaiwanScanner();
  const stocks = await scanner.getStockList();
  console.log(`TW stocks: ${stocks.length}, regen MA base @ ${date} ...`);
  const r = await generateMABase('TW', date, stocks);
  console.log('done:', r);
}
main().catch(e => { console.error(e); process.exit(1); });
