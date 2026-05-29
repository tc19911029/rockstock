#!/usr/bin/env npx tsx
/**
 * backfill-cn-deep-history.ts — 把「歷史深度不足」的 CN 個股 + 上證指數補到 ~5 年（~1211 根）。
 *
 * 背景：先前有一批 CN 股（422 檔從 2024-04-17 起、共 ~700 檔 < 1239 根）只回補了 ~2 年歷史，
 *      導致「主力狀態 F／中控線(midControl)」算不出來 —— midControl 用 SUM(VOL,480) + MA(...,20) + MA(...,10)，
 *      股票站上 MA240(多頭) 時實際需要 ~507 根才有值。歷史不夠 → 多頭期間中控全空白（例：兆易創新 603986）。
 *
 * 解法：用 TencentHistProvider('5y')（內建 2 段分頁，volume ×100 與全市場一致、qfq 自洽）重抓全段、覆寫。
 *      已驗證 recent bar 與既存 sealed bar 完全相同（close/vol 一致），不會破壞封存值。
 *
 * 安全：candle 檔未進 git → 覆寫前一律備份到 data/candles/CN-backup-<ts>/。
 *      嚴格驗證：只在「抓到的根數 > 既存 且 最新日不退 且 近期 close 與既存相差 < 5%」時才覆寫。
 *
 * 用法：
 *   npx tsx scripts/backfill-cn-deep-history.ts            # 跑全部需補的（active 且 < 1100 根）
 *   npx tsx scripts/backfill-cn-deep-history.ts --dry      # 只列出目標 + 抓第一批試跑，不寫檔
 *   npx tsx scripts/backfill-cn-deep-history.ts --only 603986.SS,000001.SS
 */
import { config } from 'dotenv';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync } from 'fs';
import path from 'path';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { tencentHistProvider } from '@/lib/datasource/TencentHistProvider';

const DIR = path.join(process.cwd(), 'data', 'candles', 'CN');
const NEED_BELOW = 1100;   // 根數 < 此值 → 視為歷史深度不足（全段檔 1211/1239 不會被重抓）
const BATCH = 6;
const SLEEP_MS = 400;
const MIN_CLOSE_DIFF_PCT = 0.05;  // 近期 close 與既存差 > 5% → 疑似抓錯標的，跳過
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface RawCandle { date: string; open: number; high: number; low: number; close: number; volume: number }

function readCandles(file: string): RawCandle[] {
  try { return (JSON.parse(readFileSync(path.join(DIR, file), 'utf8')).candles ?? []) as RawCandle[]; }
  catch { return []; }
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  let only: string[] | null = null;
  const oi = args.indexOf('--only');
  if (oi >= 0 && args[oi + 1]) only = args[oi + 1].split(',').map((s) => s.trim());

  const idxLast = readCandles('000001.SS.json').slice(-1)[0]?.date;
  if (!idxLast) { console.error('❌ 讀不到 000001.SS 指數最新日'); process.exit(1); }
  console.log(`📅 指數最新交易日 = ${idxLast}`);

  // 目標：指數 + 所有「active(最新日==指數) 且 根數 < NEED_BELOW」的個股
  const files = readdirSync(DIR).filter((f) => /^\d{6}\.(SS|SZ)\.json$/i.test(f));
  let targets: { file: string; sym: string; bars: number; last: string }[] = [];
  for (const f of files) {
    const c = readCandles(f);
    if (!c.length) continue;
    const last = c[c.length - 1].date;
    const sym = f.replace('.json', '');
    const isIndex = sym === '000001.SS';
    if (only) { if (only.includes(sym)) targets.push({ file: f, sym, bars: c.length, last }); continue; }
    if (isIndex && c.length < NEED_BELOW) { targets.push({ file: f, sym, bars: c.length, last }); continue; }
    if (last === idxLast && c.length < NEED_BELOW) targets.push({ file: f, sym, bars: c.length, last });
  }

  console.log(`🎯 需補目標：${targets.length} 檔（含指數）。範例：`,
    targets.slice(0, 5).map((t) => `${t.sym}(${t.bars})`).join(', '));
  if (!targets.length) { console.log('✅ 沒有需要補的，全部已達深度。'); return; }

  // 備份目錄（candle 檔未進 git）
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(process.cwd(), 'data', 'candles', `CN-backup-${ts}`);
  if (!dry) mkdirSync(backupDir, { recursive: true });
  if (!dry) console.log(`💾 備份目錄：${backupDir}`);

  let ok = 0, skip = 0, fail = 0;
  const skipped: string[] = [];
  const start = Date.now();
  const runBatch = dry ? targets.slice(0, BATCH) : targets;

  for (let i = 0; i < runBatch.length; i += BATCH) {
    const batch = runBatch.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map(async (t) => {
      const existing = readCandles(t.file);
      const fetched = await tencentHistProvider.getHistoricalCandles(t.sym, '5y');
      if (!fetched.length) throw new Error('fetch empty');

      const fLast = fetched[fetched.length - 1];
      const eLast = existing[existing.length - 1];
      // 1) 最新日不可退
      if (fLast.date < eLast.date) throw new Error(`stale fetch ${fLast.date} < ${eLast.date}`);
      // 2) 必須真的補到更多根（否則沒意義；年輕 IPO 股本來就少根 → 跳過不傷）
      if (fetched.length <= existing.length) { return { sym: t.sym, action: 'skip', reason: `no gain (${fetched.length}<=${existing.length})` }; }
      // 3) 指數 close 合理性
      if (t.sym === '000001.SS' && fLast.close < 1000) throw new Error(`index close ${fLast.close} < 1000`);
      // 4) 近期 close 與既存相差 < 5%（防抓錯標的）
      const eMap = new Map(existing.map((c) => [c.date, c.close]));
      const ovClose = eMap.get(fLast.date);
      if (ovClose && Math.abs(fLast.close - ovClose) / ovClose > MIN_CLOSE_DIFF_PCT) {
        throw new Error(`close mismatch ${fLast.close} vs ${ovClose}`);
      }

      const stripped: RawCandle[] = fetched.map((c) => ({
        date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      }));
      const out = {
        symbol: t.sym,
        lastDate: stripped[stripped.length - 1].date,
        updatedAt: new Date().toISOString(),
        candles: stripped,
        sealedDate: stripped[stripped.length - 1].date,
      };
      if (!dry) {
        copyFileSync(path.join(DIR, t.file), path.join(backupDir, t.file));  // 備份
        writeFileSync(path.join(DIR, t.file), JSON.stringify(out), 'utf8');
      }
      return { sym: t.sym, action: 'write', from: existing.length, to: stripped.length, range: `${stripped[0].date}~${out.lastDate}` };
    }));

    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === 'fulfilled') {
        if (r.value.action === 'write') { ok++; if (ok <= 8 || dry) console.log(`  ✅ ${r.value.sym}: ${r.value.from}→${r.value.to} 根 (${r.value.range})`); }
        else { skip++; skipped.push(`${r.value.sym}: ${r.value.reason}`); }
      } else {
        fail++; skipped.push(`${batch[j].sym}: ${(r.reason as Error)?.message?.slice(0, 60)}`);
        if (fail <= 10) console.error(`  ❌ ${batch[j].sym}: ${(r.reason as Error)?.message?.slice(0, 60)}`);
      }
    }

    const done = Math.min(i + BATCH, runBatch.length);
    if (done % 60 === 0 || done === runBatch.length) {
      const el = ((Date.now() - start) / 1000).toFixed(0);
      console.log(`  [${done}/${runBatch.length}] ok=${ok} skip=${skip} fail=${fail} | ${el}s`);
    }
    if (i + BATCH < runBatch.length) await sleep(SLEEP_MS);
  }

  console.log(`\n${dry ? '🧪 DRY-RUN' : '✅'} 完成：write=${ok} skip=${skip} fail=${fail} | ${((Date.now() - start) / 1000).toFixed(1)}s`);
  if (skipped.length) console.log(`略過/失敗（前 30）：\n  ${skipped.slice(0, 30).join('\n  ')}`);
  if (!dry && ok) console.log(`\n備份在 ${backupDir}（確認無誤後可刪）`);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
