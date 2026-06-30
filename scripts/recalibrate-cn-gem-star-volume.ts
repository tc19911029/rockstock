#!/usr/bin/env npx tsx
/**
 * recalibrate-cn-gem-star-volume.ts — 無網路修正科創/創業 L1 量單位。
 *
 * 背景：騰訊 qfq 對科創(688.SS)回「股」、對創業(300.SZ)/主板回「手」，同端點不一致。
 * backfill 一律 ×100（手→股）會讓科創成交額爆 100 倍（中芯 15514億、澜起 31597億 = 荒謬）。
 *
 * 判定：單一陸股單日成交額不可能持續 > 800 億（兩市龍頭 ~200-400 億；STAR 全板日 ~3000 億）。
 * 近 20 根 close×vol 中位數 > 8e10 → 量被 ×100 灌水 → 全序列 ÷100 修回「股」。
 * 只動 CN_STOCKS_GEM_STAR 內代號（不碰主板）。冪等：已正確的不會被誤砍（中位數 < 門檻）。
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { CN_STOCKS_GEM_STAR } from '../lib/scanner/cnStocksGemStar';

const DATA_ROOT = path.join(process.cwd(), 'data', 'candles', 'CN');
const THRESHOLD = 8e10; // 800 億 元

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

let fixed = 0, kept = 0, missing = 0;
for (const e of CN_STOCKS_GEM_STAR) {
  const file = path.join(DATA_ROOT, `${e.symbol}.json`);
  if (!existsSync(file)) { missing++; continue; }
  const json = JSON.parse(readFileSync(file, 'utf8'));
  const candles: { close: number; volume: number }[] = json.candles ?? [];
  if (candles.length < 5) { kept++; continue; }
  const recent = candles.slice(-20);
  const medTurnover = median(recent.map((c) => (c.close || 0) * (c.volume || 0)));
  if (medTurnover > THRESHOLD) {
    json.candles = candles.map((c: { volume: number }) => ({ ...c, volume: Math.round(c.volume / 100) }));
    writeFileSync(file, JSON.stringify(json));
    fixed++;
  } else {
    kept++;
  }
}
console.log(`[recalibrate] 修正 ${fixed} 檔（÷100）；保留 ${kept}；缺檔 ${missing}`);
