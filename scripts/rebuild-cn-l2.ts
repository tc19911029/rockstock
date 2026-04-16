/**
 * 緊急重建 CN L2 快照 — 用騰訊報價 API
 *
 * 用途：東財API異常導致L2只有80支時，盤後用此腳本修復
 *
 * Usage: npx tsx scripts/rebuild-cn-l2.ts [date]
 * Default date: today (CST)
 */

import { getTencentRealtime } from '../lib/datasource/TencentRealtime';
import { CN_STOCKS } from '../lib/scanner/cnStocks';
import type { IntradaySnapshot, IntradayQuote } from '../lib/datasource/IntradayCache';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

const date = process.argv[2] ||
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());

async function main() {
  console.log(`[rebuild-cn-l2] 重建 CN L2 快照: ${date}`);

  // 1. 用騰訊抓全市場
  const symbols = CN_STOCKS.map(s => s.symbol);
  console.log(`[rebuild-cn-l2] 抓取 ${symbols.length} 支報價 (騰訊)...`);
  const tcMap = await getTencentRealtime(symbols);
  console.log(`[rebuild-cn-l2] 騰訊返回 ${tcMap.size} 支`);

  if (tcMap.size < 500) {
    console.error(`[rebuild-cn-l2] 騰訊只返回 ${tcMap.size} 支，數量不足，放棄`);
    process.exit(1);
  }

  // 2. 組裝 IntradayQuote
  const quotes: IntradayQuote[] = [];
  for (const [, q] of tcMap) {
    const prevClose = q.prevClose ?? q.close;
    const changePercent = prevClose > 0
      ? Math.round(((q.close - prevClose) / prevClose) * 10000) / 100
      : 0;
    quotes.push({
      symbol: q.code,
      name: q.name,
      open: q.open,
      high: q.high,
      low: q.low,
      close: q.close,
      volume: q.volume,
      prevClose,
      changePercent,
    });
  }

  // 3. 組裝 snapshot
  const snapshot: IntradaySnapshot = {
    market: 'CN',
    date,
    updatedAt: new Date().toISOString(),
    count: quotes.length,
    quotes,
  };

  // 4. 寫入本地
  const localPath = join(process.cwd(), 'data', `intraday-CN-${date}.json`);

  // 備份舊檔
  if (existsSync(localPath)) {
    const backupPath = localPath.replace('.json', '.bak.json');
    const old = readFileSync(localPath, 'utf8');
    writeFileSync(backupPath, old, 'utf8');
    console.log(`[rebuild-cn-l2] 舊快照備份到 ${backupPath}`);
  }

  writeFileSync(localPath, JSON.stringify(snapshot), 'utf8');
  const sizeMB = (Buffer.byteLength(JSON.stringify(snapshot)) / 1024).toFixed(0);
  console.log(`[rebuild-cn-l2] 寫入 ${localPath} (${sizeMB}KB, ${quotes.length} 支)`);

  // 5. 統計漲停
  const limitUp = quotes.filter(q => q.changePercent >= 9.5);
  console.log(`[rebuild-cn-l2] 漲停(>=9.5%): ${limitUp.length} 支`);
  for (const q of limitUp.slice(0, 10)) {
    console.log(`  ${q.symbol} ${q.name} close=${q.close} chg=${q.changePercent}%`);
  }

  console.log('[rebuild-cn-l2] 完成！接下來請跑: L2→L1注入 + 打板掃描');
}

main().catch(err => { console.error(err); process.exit(1); });
