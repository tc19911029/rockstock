// ============================================================
// 台股【上市】L1 成交量歷史校正 —— 用 TWSE MI_INDEX 官方日收盤（權威源、免費、bulk）
//
// 為什麼用 MI_INDEX 而非 FinMind：MI_INDEX 一次回「某日全上市股票」官方 OHLCV
//   （成交股數 row[2]），是 candle pipeline 自己認定的「唯一正確來源」；curl 可取、
//   不像 FinMind 逐檔會 IP ban。實測 2330 6/05：MI_INDEX 43,404 張 = FinMind，本地 32,568(錯)。
//
// 修法：逐「交易日」重抓 MI_INDEX → 對每檔 .TW 個股，把本地 volume 改成官方值
//   （成交股數 ÷1000 → 張）。只改「相對誤差 > 8% 且 絕對差 ≥ 50 張」的 bar；OHLC 不動。
//   每日回應快取到 data/tmp/mi-cache/<date>.json → dry-run 抓過，--apply 直接重用不重抓。
//   ⚠️ 上櫃 .TWO 無歷史 bulk 源(TPEx OpenAPI 只給最新日)，本腳本不處理；之後用 FinMind 逐檔補。
//
// 安全：dry-run 預設；--apply 才備份(TW-backup-volmi-<ts>/)+覆寫+清 L1 cache。
//
//   npx tsx scripts/repair-tw-volume-mi-index.ts                 # dry-run 近 520 交易日
//   npx tsx scripts/repair-tw-volume-mi-index.ts --apply         # 校正
//   npx tsx scripts/repair-tw-volume-mi-index.ts --days=520 2330 # 限窗/單檔(仍逐日抓全市場)
// ============================================================
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Candle } from '@/types';

const pexec = promisify(execFile);
const APPLY = process.argv.includes('--apply');
const ONLY = process.argv.find((a) => /^[0-9][0-9A-Z]{3,6}$/.test(a));
const DAYS = ((): number => { const a = process.argv.find((x) => x.startsWith('--days=')); return a ? parseInt(a.split('=')[1], 10) : 520; })();
const THRESH = 0.08;
const MIN_ABS = 50;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const DIR = path.join(process.cwd(), 'data/candles/TW');
const MICACHE = path.join(process.cwd(), 'data/tmp/mi-cache');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const BACKUP = path.join(process.cwd(), 'data/candles', `TW-backup-volmi-${STAMP}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const parseNum = (s: string) => { const n = parseFloat(String(s).replace(/,/g, '')); return isNaN(n) ? 0 : n; };

/** 抓某日 MI_INDEX → code→張；先讀 disk cache（dry-run 抓過 apply 重用） */
async function miIndexDay(ymd: string): Promise<Map<string, number> | null> {
  const cacheFile = path.join(MICACHE, `${ymd}.json`);
  try {
    const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8')) as Record<string, number>;
    return new Map(Object.entries(cached));
  } catch { /* miss → fetch */ }

  const url = `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${ymd}&type=ALLBUT0999`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { stdout } = await pexec('curl', ['-s', '--max-time', '30', '-A', UA, url], { maxBuffer: 64 * 1024 * 1024 });
      const j = JSON.parse(stdout) as { stat?: string; tables?: Array<{ data?: string[][] }> };
      if (j.stat !== 'OK') return null;            // 非交易日/無資料
      const table = j.tables?.[8];
      if (!table?.data?.length) return null;
      const m = new Map<string, number>();
      for (const row of table.data) {
        const code = row[0]?.trim();
        if (!code || !/^\d{4,}[A-Z]?$/.test(code)) continue;
        const lots = Math.round(parseNum(row[2]) / 1000);
        if (lots > 0) m.set(code, lots);
      }
      await fs.mkdir(MICACHE, { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify(Object.fromEntries(m)));
      return m;
    } catch { await sleep(1500); }
  }
  return null;
}

(async () => {
  // 1) 交易日清單：取流動性高、歷史完整的 2330 candle 日期當基準
  let ref: { candles: Candle[] };
  try { ref = JSON.parse(await fs.readFile(path.join(DIR, '2330.TW.json'), 'utf8')); }
  catch { console.error('讀不到 2330.TW.json 當交易日基準'); process.exit(1); }
  const tradingDates = ref.candles.map((c) => String(c.date).replace('*', '').slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(-DAYS);
  const startDate = tradingDates[0];
  console.log(`交易日窗：${startDate} ~ ${tradingDates[tradingDates.length - 1]}（${tradingDates.length} 日）`);

  // 2) 逐日抓 MI_INDEX（含 disk cache）
  const dayMaps = new Map<string, Map<string, number>>();
  let fetched = 0, dayFail = 0;
  for (let i = 0; i < tradingDates.length; i++) {
    const d = tradingDates[i];
    const m = await miIndexDay(d.replace(/-/g, ''));
    if (m) { dayMaps.set(d, m); fetched++; } else dayFail++;
    if ((i + 1) % 40 === 0) console.error(`…MI_INDEX 抓取 ${i + 1}/${tradingDates.length}（失敗 ${dayFail}）`);
    await sleep(120);
  }
  console.log(`MI_INDEX 取得 ${fetched} 日、失敗 ${dayFail} 日\n`);

  // 3) 逐 .TW 檔套用校正
  let files = (await fs.readdir(DIR)).filter((f) => /^[0-9][0-9A-Z]{3,6}\.TW\.json$/.test(f));
  if (ONLY) files = files.filter((f) => f.startsWith(`${ONLY}.`));

  const results: { sym: string; changed: number; sample: string[] }[] = [];
  let totalChanged = 0, filesChanged = 0;
  for (const f of files) {
    const sym = f.replace('.json', ''); const code = sym.replace(/\.TW$/, '');
    let j: { candles: Candle[] };
    try { j = JSON.parse(await fs.readFile(path.join(DIR, f), 'utf8')); } catch { continue; }
    if (!Array.isArray(j.candles)) continue;

    const sample: string[] = []; let changed = 0;
    for (const c of j.candles) {
      const d = String(c.date).replace('*', '').slice(0, 10);
      if (d < startDate) continue;
      const off = dayMaps.get(d)?.get(code);
      if (off == null) continue;
      const cur = Number(c.volume) || 0;
      if (Math.abs(cur - off) / Math.max(off, 1) > THRESH && Math.abs(cur - off) >= MIN_ABS) {
        if (sample.length < 3) sample.push(`${d} ${cur}→${off}`);
        if (APPLY) c.volume = off;
        changed++;
      }
    }
    if (changed > 0) {
      results.push({ sym, changed, sample });
      totalChanged += changed; filesChanged++;
      if (APPLY) {
        await fs.mkdir(BACKUP, { recursive: true });
        await fs.copyFile(path.join(DIR, f), path.join(BACKUP, f));
        await fs.writeFile(path.join(DIR, f), JSON.stringify(j));
        try { const { invalidateEntry } = await import('@/lib/datasource/L1CandleCache'); invalidateEntry(sym, 'TW'); } catch { /* nonfatal */ }
      }
    }
  }

  results.sort((a, b) => b.changed - a.changed);
  console.log(`=== TWSE MI_INDEX 上市成交量校正${APPLY ? '（已備份+覆寫+清 cache）' : '（dry-run）'} ===`);
  console.log(`掃描 ${files.length} 檔上市；需校正 ${filesChanged} 檔 / ${totalChanged} 根 bar\n`);
  console.log('symbol        改根數   範例(舊→新)');
  for (const r of results.slice(0, 40)) console.log(`  ${r.sym.padEnd(12)} ${String(r.changed).padStart(5)}  ${r.sample.join('  ')}`);
  if (results.length > 40) console.log(`  …(其餘 ${results.length - 40} 檔略)`);
  console.log(APPLY ? `\n備份：data/candles/TW-backup-volmi-${STAMP}/` : '\n(dry-run；加 --apply 重用 MI cache 直接覆寫)');
})();
