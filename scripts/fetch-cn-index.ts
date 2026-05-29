// ============================================================
// 抓陸股指數深歷史寫進 L1（data/candles/CN/{sym}.json），供三色 RS 基準用。
// 預設抓深證成指 399001.SZ（深市股的 INDEXC 基準；滬市股用既有上證 000001.SS）。
// 用法：npx tsx scripts/fetch-cn-index.ts [sym1 sym2 ...]（預設 399001.SZ）
// ============================================================

import { promises as fs } from 'fs';
import path from 'path';
import { tencentHistProvider } from '@/lib/datasource/TencentHistProvider';
import { getLocalCandleDir } from '@/lib/datasource/LocalCandleStore';

async function main() {
  const syms = process.argv.slice(2).length ? process.argv.slice(2) : ['399001.SZ'];
  const dir = getLocalCandleDir('CN');
  for (const sym of syms) {
    try {
      const candles = await tencentHistProvider.getHistoricalCandles(sym, '5y');
      if (!candles.length) { console.error(`❌ ${sym} 抓到空`); continue; }
      const last = candles[candles.length - 1];
      if (sym.includes('399001') && last.close < 1000) { console.error(`❌ ${sym} close ${last.close} 不像深證成指，跳過`); continue; }
      const file = path.join(dir, `${sym}.json`);
      await fs.writeFile(file, JSON.stringify({ candles, lastDate: last.date }), 'utf8');
      console.log(`✅ ${sym}: ${candles.length} 根  ${candles[0].date} ~ ${last.date}  收 ${last.close}`);
    } catch (e) {
      console.error(`❌ ${sym}:`, e instanceof Error ? e.message : e);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
