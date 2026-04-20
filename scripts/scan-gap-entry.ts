/**
 * 缺口進場偵測驗證腳本（Phase 2 路線 B）
 *
 * Usage: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/scan-gap-entry.ts TW 2026-04-08
 * （4/8 台積電應該要被選到，書本位置 4 經典案例）
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import { detectGapEntry } from '@/lib/analysis/gapEntry';
import type { CandleWithIndicators } from '@/types';

const market = (process.argv[2] ?? 'TW').toUpperCase() as 'TW' | 'CN';
const date   = process.argv[3] ?? '2026-04-17';

interface Hit {
  symbol: string;
  name: string;
  gapPct: number;
  bodyPct: number;
  volumeRatio: number;
  price: number;
  changePercent: number;
  detail: string;
}

function loadDir(market: 'TW' | 'CN'): Array<{ symbol: string; name: string; candles: CandleWithIndicators[] }> {
  const dir = path.join(process.cwd(), 'data', 'candles', market);
  if (!fs.existsSync(dir)) { console.error('L1 目錄不存在：' + dir); return []; }
  const all: Array<{ symbol: string; name: string; candles: CandleWithIndicators[] }> = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      const c: CandleWithIndicators[] = Array.isArray(raw) ? raw : raw.candles ?? raw;
      if (!c || c.length < 2) continue;
      const name = (raw as { name?: string }).name ?? f.replace('.json', '');
      all.push({ symbol: f.replace('.json', ''), name, candles: computeIndicators(c) });
    } catch { /* ignore */ }
  }
  return all;
}

function main() {
  console.log(`\n缺口進場偵測：${market} ${date}\n`);
  process.stdout.write('  讀取 L1...');
  const stocks = loadDir(market);
  console.log(` ${stocks.length} 支`);

  const hits: Hit[] = [];
  for (const { symbol, name, candles } of stocks) {
    const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
    if (idx < 1) continue;

    const result = detectGapEntry(candles, idx);
    if (!result?.isGapEntry) continue;

    const c = candles[idx];
    const prev = candles[idx - 1];
    const changePercent = prev && prev.close > 0 ? (c.close - prev.close) / prev.close * 100 : 0;
    hits.push({
      symbol, name,
      gapPct: result.gapPct,
      bodyPct: result.bodyPct,
      volumeRatio: result.volumeRatio,
      price: c.close,
      changePercent,
      detail: result.detail,
    });
  }

  hits.sort((a, b) => b.changePercent - a.changePercent);

  console.log(`\n符合跳空上漲：${hits.length} 支\n`);
  if (hits.length === 0) {
    console.log('  （無）');
    return;
  }
  console.log('  代號     名稱               收盤    漲幅    跳空    實體    量比');
  console.log('  ----------------------------------------------------------------');
  for (const h of hits.slice(0, 50)) {
    console.log(
      `  ${h.symbol.padEnd(8)} ${h.name.padEnd(18)} ${h.price.toFixed(2).padStart(7)} ${(h.changePercent.toFixed(2) + '%').padStart(7)} ${(h.gapPct.toFixed(2) + '%').padStart(7)} ${(h.bodyPct.toFixed(2) + '%').padStart(7)} ×${h.volumeRatio.toFixed(2).padStart(5)}`,
    );
  }
  if (hits.length > 50) console.log(`\n  （僅顯示前 50 支，共 ${hits.length} 支）`);
  console.log('');
}

main();
