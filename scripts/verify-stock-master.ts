/**
 * 驗證 stockMaster：
 *   1. 強制從 TWSE/TPEx 重新 fetch（refresh=true）
 *   2. 對一組真實節目常見會講的股票名稱跑 lookup
 *   3. 印出對照表 size + 各 sample 的 confidence/match_via
 *
 * Usage:  npx tsx scripts/verify-stock-master.ts
 */

import { loadStockMaster, lookupStock } from '@/lib/youtube/stockMaster';

const SAMPLE_QUERIES = [
  // 半導體大盤
  '台積電', '台積', '2330', 'TSMC',
  '聯發科', '2454',
  // ASIC / IC 設計
  '世芯', '世芯-KY', '3661',
  '創意', '3443',
  '智原', '3035',
  // 散熱 / PCB
  '雙鴻', '奇鋐', '台光電', '金像電',
  // 大盤代表
  '鴻海', '緯穎', '台達電',
  // 金融
  '中信金', '國泰金',
  // ETF / 概念
  '00940', '0050',
  // 故意 try 失敗
  '錯字股票名稱', '9999999',
];

async function main() {
  console.log('=== loadStockMaster (forceRefresh=true) ===');
  const t0 = Date.now();
  const master = await loadStockMaster(true);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`entries=${master.entries.length} fetched_at=${master.fetched_at} took=${elapsed}s`);

  const twseCount = master.entries.filter(e => e.market === 'TWSE').length;
  const tpexCount = master.entries.filter(e => e.market === 'TPEx').length;
  console.log(`  TWSE=${twseCount} TPEx=${tpexCount}`);

  console.log();
  console.log('=== Sample lookups ===');
  for (const q of SAMPLE_QUERIES) {
    const r = lookupStock(q, master);
    if (r) {
      console.log(`  ${q.padEnd(12)} → ${r.code} ${r.name.padEnd(15)} confidence=${r.confidence.toFixed(2)} via=${r.match_via}`);
    } else {
      console.log(`  ${q.padEnd(12)} → null (no match)`);
    }
  }

  // 額外抽 5 個 alias check
  console.log();
  console.log('=== Alias spot-check (these should all hit) ===');
  for (const alias of ['台積電', '世芯', '聯發科', '中信金', '緯穎']) {
    const r = lookupStock(alias, master);
    if (r && r.confidence >= 0.8) {
      console.log(`  OK ${alias} → ${r.code} ${r.name} (${r.confidence.toFixed(2)})`);
    } else {
      console.log(`  MISS ${alias} → ${r ? `${r.code} ${r.confidence}` : 'null'}`);
    }
  }
}

main().catch((err) => {
  console.error('verify failed:', err);
  process.exit(1);
});
