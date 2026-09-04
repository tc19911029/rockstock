// ============================================================
// 陸股 L1 成交量單位污染修復 — 騰訊整段重抓覆蓋（只覆蓋 volume，保留 OHLC）
//
// 病徵：深歷史回補(2026-05-29 backfill-cn-deep-history)接上單位不一致來源 → 同檔混用
//   「股」與「股÷1000」(2024-05-21 起一段)，~1000× 跳階污染 SUM(VOL,480) → 主力狀態「中控」
//   炸到上千(實例 000506=3415)。全市場 240 檔近窗 midControl>30、1676 檔近 480 窗有量階。
//   Chrome 實證：工商銀行 2024-05-21 騰訊真實 2,736,760 手(=2.7億股)，本地存 273,676(=真實÷1000)。
//
// 修法：用 tencentHistProvider(已 ×100 轉股，與本地股單位一致)整段重抓，**按日期只覆蓋 volume**，
//   保留本地 OHLC(價格 100/100 已對 ground truth；重抓 qfq 價會動到還權基準，不碰)。
//   價格的調整基準斷層屬另案 [[cn-unadjusted-ex-date-splice]]，不在此處理。
//
// 目標檔：有「內部 >50× 相鄰量階」的混用檔(單一尺度檔 midControl 尺度不變、不需修)。
//
//   npx tsx scripts/repair-cn-volume-from-tencent.ts 601398.SS          # 單檔 dry-run
//   npx tsx scripts/repair-cn-volume-from-tencent.ts 601398.SS --apply  # 單檔修
//   npx tsx scripts/repair-cn-volume-from-tencent.ts --apply            # 全部受污染檔
// ============================================================
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
if (existsSync('.env.local')) dotenv.config({ path: '.env.local' });
import { tencentHistProvider } from '@/lib/datasource/TencentHistProvider';
import type { Candle } from '@/types';

const APPLY = process.argv.includes('--apply');
const ONLY = process.argv.find((a) => /^\d{6}\.(SS|SZ)$/.test(a));
const STEP = 50;          // 相鄰非零 bar 量比 > 此 = 內部單位階(混用特徵)
const DELAY_MS = 400;
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function hasUnitStep(c: Candle[]): boolean {
  for (let i = 1; i < c.length; i++) {
    const a = c[i - 1].volume, b = c[i].volume;
    if (a > 0 && b > 0 && (a / b > STEP || b / a > STEP)) return true;
  }
  return false;
}

(async () => {
  const dir = path.join(process.cwd(), 'data/candles/CN');
  let files = (await fs.readdir(dir)).filter((f) => /^\d{6}\.(SS|SZ)\.json$/.test(f) && f !== '000001.SS.json');
  if (ONLY) files = files.filter((f) => f === `${ONLY}.json`);

  // 先篩出「有內部量階」的目標檔；短歷史／退市檔也必須納入，不能用固定 bars 門檻漏掉。
  const targets: string[] = [];
  for (const f of files) {
    try {
      const c = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')).candles as Candle[];
      if (!Array.isArray(c)) continue;
      const isTarget = ONLY ? c.length > 0 : c.length >= 2 && hasUnitStep(c);
      if (isTarget) targets.push(f);
    } catch { /* skip */ }
  }
  console.log(`目標(有內部量階的混用檔): ${targets.length} 檔  ${APPLY ? '【--apply 覆蓋】' : '(dry-run)'}`);

  const backupDir = path.join(process.cwd(), 'data/candles', `CN-backup-volume-${STAMP}`);
  let ok = 0, noTx = 0, fail = 0, totalChanged = 0;
  const failed: string[] = [];

  for (let i = 0; i < targets.length; i++) {
    const f = targets[i];
    const sym = f.replace('.json', '');
    let local: { candles: Candle[]; [k: string]: unknown };
    try { local = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')); } catch { fail++; failed.push(`${sym}(read)`); continue; }

    let tx: Candle[] = [];
    try { tx = await tencentHistProvider.getHistoricalCandles(sym, '5y'); } // volume 已 ×100 = 股
    catch (e) { fail++; failed.push(`${sym}(${(e as Error).message.slice(0, 30)})`); await sleep(DELAY_MS); continue; }
    if (!tx.length) { noTx++; await sleep(DELAY_MS); continue; }
    const tvol = new Map(tx.map((c) => [c.date, c.volume]));

    let changed = 0;
    const samples: string[] = [];
    for (const c of local.candles) {
      const v = tvol.get(c.date);
      // 只覆蓋「顯著不符」(>1.5×)：精準打單位斷層(~1000×)的 bar，略過 ÷100 轉換的捨入噪聲(<0.1%)
      if (v != null && v > 0 && (c.volume <= 0 || v / c.volume > 1.5 || c.volume / v > 1.5)) {
        if (samples.length < 2) samples.push(`${c.date}:${c.volume}→${v}`);
        changed++;
        if (APPLY) c.volume = v;
      }
    }
    totalChanged += changed;
    if (ONLY || i < 5) console.log(`  ${sym.padEnd(11)} 覆蓋 ${changed} 根  ${samples.join('  ')}`);

    if (APPLY && changed > 0) {
      await fs.mkdir(backupDir, { recursive: true });
      // 只在本次尚未備份過才備份原檔
      const bkp = path.join(backupDir, f);
      try { await fs.access(bkp); } catch { await fs.copyFile(path.join(dir, f), bkp); }
      await fs.writeFile(path.join(dir, f), JSON.stringify(local));
      try { const { invalidateEntry } = await import('@/lib/datasource/L1CandleCache'); invalidateEntry(sym, 'CN'); }
      catch { /* 清不到不致命 */ }
      ok++;
    }
    await sleep(DELAY_MS);
    if ((i + 1) % 200 === 0) console.log(`  …進度 ${i + 1}/${targets.length}  覆蓋檔=${ok} 騰訊無資料=${noTx} 失敗=${fail}`);
  }

  console.log(`\n${APPLY ? '✅ 已覆蓋' : 'dry-run 預估'}：${APPLY ? ok : targets.length} 檔 / ${totalChanged} 根 volume`);
  console.log(`騰訊無資料: ${noTx}  失敗: ${fail}`);
  if (failed.length) console.log('失敗(前20):', failed.slice(0, 20).join(', '));
  if (APPLY) console.log(`備份: ${backupDir}`);
  else console.log('(加 --apply 才會備份+覆寫+清 cache)');
})();
