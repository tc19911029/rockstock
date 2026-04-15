import { TaiwanScanner } from '../lib/scanner/TaiwanScanner';
import { ChinaScanner } from '../lib/scanner/ChinaScanner';
import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';
import { readFileSync } from 'fs';
import path from 'path';

const market = process.argv[2] as 'TW' | 'CN';
if (!market) { console.error('Usage: npx tsx /tmp/download-l1.ts TW|CN'); process.exit(1); }

const BATCH = 8;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function main() {
  const scanner = market === 'CN' ? new ChinaScanner() : new TaiwanScanner();
  
  // 找出需要更新的（lastCandle < 2026-04-15）
  const dataDir = path.join(process.cwd(), 'data', 'candles', market);
  const stocks = await scanner.getStockList();
  
  const needUpdate: typeof stocks = [];
  for (const s of stocks) {
    try {
      const file = path.join(dataDir, `${s.symbol}.json`);
      const data = JSON.parse(readFileSync(file, 'utf8'));
      const lastCandle = data.candles?.[data.candles.length - 1]?.date;
      if (!lastCandle || lastCandle < '2026-04-15') {
        needUpdate.push(s);
      }
    } catch {
      needUpdate.push(s);
    }
  }
  
  console.log(`[${market}] 總共 ${stocks.length} 支，需更新 ${needUpdate.length} 支`);
  
  let ok = 0, fail = 0;
  const start = Date.now();
  
  for (let i = 0; i < needUpdate.length; i += BATCH) {
    const batch = needUpdate.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async ({ symbol }) => {
        const candles = await scanner.fetchCandles(symbol);
        if (candles.length > 0) {
          await saveLocalCandles(symbol, market, candles);
          return candles[candles.length - 1]?.date;
        }
        return null;
      })
    );
    
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) ok++;
      else fail++;
    }
    
    const done = i + batch.length;
    if (done % 100 === 0 || done === needUpdate.length) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      console.log(`  [${done}/${needUpdate.length}] ok=${ok} fail=${fail} | ${elapsed}s`);
    }
    
    if (i + BATCH < needUpdate.length) await sleep(300);
  }
  
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n✅ ${market} 完成: ${ok} 成功, ${fail} 失敗, ${elapsed}s`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
