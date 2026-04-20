/**
 * 一字底偵測驗證腳本（Phase 1 路線 B）
 *
 * 用途：不動生產 scanner，單獨驗證 detectFlatBottom() 在全市場能選出哪些股。
 * Usage: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/scan-flat-bottom.ts TW 2026-04-17
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import { detectFlatBottom } from '@/lib/analysis/highWinRateEntry';
import type { CandleWithIndicators } from '@/types';

const market = (process.argv[2] ?? 'TW').toUpperCase() as 'TW' | 'CN';
const date   = process.argv[3] ?? '2026-04-17';

interface Hit {
  symbol: string;
  name: string;
  consolidationDays: number;
  detail: string;
  price: number;
  changePercent: number;
  volume: number;
}

function loadDir(market: 'TW' | 'CN'): Array<{ symbol: string; name: string; candles: CandleWithIndicators[] }> {
  const dir = path.join(process.cwd(), 'data', 'candles', market);
  if (!fs.existsSync(dir)) { console.error('L1 目錄不存在：' + dir); return []; }
  const all: Array<{ symbol: string; name: string; candles: CandleWithIndicators[] }> = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      const c: CandleWithIndicators[] = Array.isArray(raw) ? raw : raw.candles ?? raw;
      if (!c || c.length < 60) continue;
      const name = (raw as { name?: string }).name ?? f.replace('.json', '');
      all.push({ symbol: f.replace('.json', ''), name, candles: computeIndicators(c) });
    } catch { /* ignore */ }
  }
  return all;
}

function main() {
  console.log(`\n一字底偵測：${market} ${date}\n`);
  process.stdout.write('  讀取 L1...');
  const stocks = loadDir(market);
  console.log(` ${stocks.length} 支`);

  const hits: Hit[] = [];
  for (const { symbol, name, candles } of stocks) {
    const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
    if (idx < 60) continue;

    const result = detectFlatBottom(candles, idx);
    if (!result?.isFlatBottom) continue;

    const c = candles[idx];
    const prev = candles[idx - 1];
    const changePercent = prev && prev.close > 0 ? (c.close - prev.close) / prev.close * 100 : 0;
    hits.push({
      symbol, name,
      consolidationDays: result.consolidationDays,
      detail: result.detail,
      price: c.close,
      changePercent,
      volume: c.volume,
    });
  }

  hits.sort((a, b) => b.changePercent - a.changePercent);

  console.log(`\n符合一字底突破：${hits.length} 支\n`);
  if (hits.length === 0) {
    console.log('  （無）');
    return;
  }
  console.log('  代號     名稱               收盤    漲幅     盤整天數   量');
  console.log('  --------------------------------------------------------');
  for (const h of hits) {
    console.log(
      `  ${h.symbol.padEnd(8)} ${h.name.padEnd(18)} ${h.price.toFixed(2).padStart(7)} ${(h.changePercent.toFixed(2) + '%').padStart(8)} ${String(h.consolidationDays).padStart(8)}天 ${h.volume.toLocaleString().padStart(12)}`,
    );
  }
  console.log('');
}

main();
