/**
 * 一次性修復：2026-04-20 CN L1 當日 K 棒 volume ÷ 100
 *
 * 根因：append-today-from-snapshot.ts 在 4/20 收盤後跑時，對 EastMoney/Tencent
 * 回傳的 volume 多乘一次 × 100（詳見 memory project_append_today_cn_volume_100x_bug_0421）。
 *
 * 策略：比對 4/20 volume vs 前 20 日中位數，只有 ratio > 30 才 ÷ 100，避免重跑炸掉。
 */

import { promises as fs } from 'fs';
import { join } from 'path';

const TARGET_DATE = '2026-04-20';
const CN_DIR = 'data/candles/CN';
const RATIO_THRESHOLD = 30;

interface Candle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface File {
  symbol: string;
  lastDate: string;
  updatedAt: string;
  candles: Candle[];
  sealedDate?: string;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function main(): Promise<void> {
  const files = await fs.readdir(CN_DIR);
  const jsons = files.filter(f => f.endsWith('.json'));

  let scanned = 0;
  let fixed = 0;
  let skippedNoTarget = 0;
  let skippedBelowThreshold = 0;
  let errored = 0;
  const samples: string[] = [];

  for (const fname of jsons) {
    scanned++;
    const path = join(CN_DIR, fname);
    try {
      const raw = await fs.readFile(path, 'utf-8');
      const data = JSON.parse(raw) as File;
      const bars = data.candles;
      if (!Array.isArray(bars) || bars.length < 2) { skippedNoTarget++; continue; }

      const idx = bars.findIndex(b => b.date === TARGET_DATE);
      if (idx < 0) { skippedNoTarget++; continue; }

      const target = bars[idx];
      const prev = bars.slice(Math.max(0, idx - 20), idx).map(b => b.volume).filter(v => v > 0);
      const med = median(prev);
      if (med <= 0) { skippedBelowThreshold++; continue; }

      const ratio = target.volume / med;
      if (ratio < RATIO_THRESHOLD) { skippedBelowThreshold++; continue; }

      const before = target.volume;
      const after = Math.round(before / 100);
      target.volume = after;
      data.updatedAt = new Date().toISOString();

      await fs.writeFile(path, JSON.stringify(data), 'utf-8');
      fixed++;
      if (samples.length < 5) samples.push(`${fname}: ${before} → ${after} (prev_med=${med})`);
    } catch (err) {
      errored++;
      console.error(`   ❌ ${fname}: ${(err as Error).message.slice(0, 80)}`);
    }
  }

  console.log('\n📊 修復結果');
  console.log(`   掃描檔案數: ${scanned}`);
  console.log(`   ✅ 已修復: ${fixed}`);
  console.log(`   ⏭️  無 4/20 K 棒: ${skippedNoTarget}`);
  console.log(`   ⏭️  未達門檻（ratio < ${RATIO_THRESHOLD}）: ${skippedBelowThreshold}`);
  console.log(`   ❌ 錯誤: ${errored}`);
  if (samples.length > 0) {
    console.log('\n   樣本:');
    for (const s of samples) console.log(`   - ${s}`);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
