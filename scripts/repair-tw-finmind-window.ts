#!/usr/bin/env npx tsx
/**
 * 以本機 FinMind 全市場日 K 快照重建台股一段價格窗。
 *
 * 用途：清掉舊 Yahoo 還原價／原始價混用造成的連續污染。逐根離群修補抓不到整段同尺度偏移，
 * 因此在 FinMind 有權威資料的日期直接以未還權 OHLC 為準；快照窗外與 FinMind 未涵蓋日期保留。
 * FinMind volume=0 是無成交占位，不寫入交易 K。
 *
 *   npx tsx scripts/repair-tw-finmind-window.ts --since 2025-08-01
 *   npx tsx scripts/repair-tw-finmind-window.ts --since 2025-08-01 --apply
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isZeroVolumeFlatBar } from '../lib/datasource/candleSanitizers';

interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface L1File {
  symbol: string;
  candles: Bar[];
  lastDate?: string;
  updatedAt?: string;
  sealedDate?: string;
  [key: string]: unknown;
}

const APPLY = process.argv.includes('--apply');
const sinceIndex = process.argv.indexOf('--since');
const SINCE = sinceIndex >= 0 ? (process.argv[sinceIndex + 1] ?? '2025-08-01') : '2025-08-01';
const ROOT = process.cwd();
const FM_DIR = path.join(ROOT, 'data/_finmind/TW');
const L1_DIR = path.join(ROOT, 'data/candles/TW');

function normalizeBar(date: string, raw: Omit<Bar, 'date'> & { volume: number }): Bar | null {
  if (![raw.open, raw.high, raw.low, raw.close].every(Number.isFinite)) return null;
  if (raw.high <= 0 || raw.low <= 0 || raw.close <= 0 || raw.low > raw.high) return null;
  if (raw.volume <= 0) return null;
  const bar = {
    date,
    open: Math.min(raw.high, Math.max(raw.low, raw.open > 0 ? raw.open : raw.close)),
    high: raw.high,
    low: raw.low,
    close: Math.min(raw.high, Math.max(raw.low, raw.close)),
    volume: Math.round(raw.volume / 1000),
  };
  return isZeroVolumeFlatBar(bar) ? null : bar;
}

async function main(): Promise<void> {
  const fmFiles = (await fs.readdir(FM_DIR)).filter((f) => f.endsWith('.json')).sort();
  const refs = new Map<string, Map<string, Bar | null>>();
  let maxDate = '';

  for (const file of fmFiles) {
    const data = JSON.parse(await fs.readFile(path.join(FM_DIR, file), 'utf8')) as {
      date: string;
      tradingDay: boolean;
      bars?: Array<{ code: string; open: number; high: number; low: number; close: number; volume: number }>;
    };
    if (!data.tradingDay || data.date < SINCE || !data.bars?.length) continue;
    if (data.date > maxDate) maxDate = data.date;
    for (const raw of data.bars) {
      let byDate = refs.get(raw.code);
      if (!byDate) {
        byDate = new Map();
        refs.set(raw.code, byDate);
      }
      // null 也是明確訊號：官方該日 volume=0，若本地有占位必須移除。
      byDate.set(data.date, normalizeBar(data.date, raw));
    }
  }
  if (!maxDate) throw new Error(`FinMind 找不到 ${SINCE} 之後的交易資料`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(ROOT, 'data/candles', `TW-backup-finmind-window-${stamp}`);
  let filesChanged = 0;
  let barsReplaced = 0;
  let barsInserted = 0;
  let placeholdersRemoved = 0;

  const files = (await fs.readdir(L1_DIR)).filter((f) => /\.(TW|TWO)\.json$/.test(f));
  for (const file of files) {
    const code = file.replace(/\.(TW|TWO)\.json$/, '');
    const ref = refs.get(code);
    if (!ref) continue;
    const fullPath = path.join(L1_DIR, file);
    const data = JSON.parse(await fs.readFile(fullPath, 'utf8')) as L1File;
    const byDate = new Map(data.candles.map((bar) => [bar.date, bar]));
    let changed = false;

    for (const [date, official] of ref) {
      const local = byDate.get(date);
      if (!official) {
        if (local) {
          byDate.delete(date);
          placeholdersRemoved++;
          changed = true;
        }
        continue;
      }
      if (!local) barsInserted++;
      else if (
        local.open !== official.open || local.high !== official.high || local.low !== official.low ||
        local.close !== official.close || local.volume !== official.volume
      ) barsReplaced++;
      else continue;
      byDate.set(date, official);
      changed = true;
    }

    if (!changed) continue;
    filesChanged++;
    if (!APPLY) continue;
    await fs.mkdir(backupDir, { recursive: true });
    await fs.copyFile(fullPath, path.join(backupDir, file));
    const candles = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    const lastDate = candles.at(-1)?.date ?? data.lastDate ?? '';
    await fs.writeFile(fullPath, JSON.stringify({
      ...data,
      candles,
      lastDate,
      sealedDate: data.sealedDate && data.sealedDate > lastDate ? lastDate : data.sealedDate,
      updatedAt: new Date().toISOString(),
    }));
  }

  console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'} FinMind raw window ${SINCE}~${maxDate}`);
  console.log(`檔案 ${filesChanged}；覆寫 ${barsReplaced} 根；補入 ${barsInserted} 根；移除零量占位 ${placeholdersRemoved} 根`);
  if (APPLY) console.log(`備份：${backupDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
