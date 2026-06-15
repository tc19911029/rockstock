// ============================================================
// 每日成交量稽核 —— 多源交叉驗證 + 管線回歸偵測
//
// 兩道檢查：
//   (1) 全市場「本地 K 線最新一根 vs 官方源」(2 個 bulk call)：抓 download-candles 管線回歸
//       —— 若今日 bar 又被盤中/partial 量寫歪、沒被 MI_INDEX/TPEx 覆蓋，這裡會大量 mismatch。
//   (2) 上市抽樣「兩份官方報表對拍」(MI_INDEX vs STOCK_DAY)：抓官方源本身異常。
//
// mismatch 門檻：相對 > 8% 且 絕對 ≥ 50 張（同 repair；上櫃 ~1-3% 不含定價差不會誤觸）。
//
// --apply（每日 cron 用）：抓到破洞 → 直接用官方一般交易量覆蓋本地最新一根(OHLC 不動) 自我癒合，
//   exit 0；大量回歸(>30 檔)仍發 alert 讓人查 download-candles 管線根因。
//   不帶 --apply（手動 debug）：只稽核 + alert + exit 1，不動資料。
//
//   npx tsx scripts/audit-volume-daily.ts            # 只稽核（不修）
//   npx tsx scripts/audit-volume-daily.ts --apply    # 稽核 + 自動修（cron）
//   npx tsx scripts/audit-volume-daily.ts 2026-06-05 # 指定日
// ============================================================
import { config } from 'dotenv';
config({ path: '.env.local' });
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';

const pexec = promisify(execFile);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
const DIR = path.join(process.cwd(), 'data/candles/TW');
const THRESH = 0.08, MIN_ABS = 50, ALERT_LIMIT = 30;
// --apply：抓到「本地最新一根量 vs 官方一般交易量」破洞時，直接用官方值覆蓋(OHLC 不動) 自我癒合。
const APPLY = process.argv.includes('--apply');
const num = (s: unknown) => { const n = parseFloat(String(s ?? '').replace(/,/g, '')); return isNaN(n) ? 0 : n; };
const lots = (sh: number) => Math.round(sh / 1000);
const rocFull = (d: string) => `${+d.slice(0, 4) - 1911}/${d.slice(5, 7)}/${d.slice(8)}`;

async function curlJson(url: string): Promise<any | null> {
  for (let a = 0; a < 2; a++) { try { const { stdout } = await pexec('curl', ['-s', '--max-time', '30', '-A', UA, url], { maxBuffer: 64 * 1024 * 1024 }); return JSON.parse(stdout); } catch { /* retry */ } }
  return null;
}
async function miBulk(d: string): Promise<Map<string, number>> {
  const j = await curlJson(`https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${d.replace(/-/g, '')}&type=ALLBUT0999`);
  const m = new Map<string, number>(); const rows = j?.tables?.[8]?.data ?? [];
  for (const r of rows) { const c = r[0]?.trim(); if (/^\d{4,}[A-Z]?$/.test(c)) { const v = lots(num(r[2])); if (v > 0) m.set(c, v); } }
  return m;
}
async function tpexBulk(d: string): Promise<Map<string, number>> {
  const j = await curlJson(`https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=${d.replace(/-/g, '/')}&type=EW&response=json`);
  const t = j?.tables?.[0]; const m = new Map<string, number>(); if (!t?.fields) return m;
  const vi = t.fields.findIndex((f: string) => f.trim() === '成交股數');
  for (const r of t.data ?? []) { const c = r[0]?.trim(); if (vi >= 0 && /^\d{4,}[A-Z]?$/.test(c)) { const v = lots(num(r[vi])); if (v > 0) m.set(c, v); } }
  return m;
}
async function twseStockDay(d: string, code: string): Promise<number | null> {
  const j = await curlJson(`https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${d.replace(/-/g, '').slice(0, 6)}01&stockNo=${code}`);
  const r = j?.data?.find((x: string[]) => x[0]?.trim() === rocFull(d)); return r ? lots(num(r[1])) : null;
}
async function sendAlert(text: string, level: 'warning' | 'critical', extra: Record<string, unknown>) {
  const webhook = process.env.HEALTH_ALERT_WEBHOOK_URL; if (!webhook) return;
  try { await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `🚨 量稽核: ${text}`, level, source: 'audit-volume-daily', ...extra }), signal: AbortSignal.timeout(8000) }); } catch { /* nonfatal */ }
}

async function main() {
  const files = (await fs.readdir(DIR)).filter((f) => /^[0-9][0-9A-Z]{3,6}\.(TW|TWO)\.json$/.test(f));
  // 跑當日(沒指定日期)時：收盤結算前(<15:00 CST，eod-settle 14:30 尚未確定) 一律 skip —
  // 否則會拿盤中/未結算的 L2 快照量 vs 官方全日量誤判，--apply 更會誤覆蓋盤中量。機器=台灣本地時。
  const dateArg = process.argv.slice(2).find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (!dateArg && new Date().getHours() < 15) {
    console.log(`現在 ${new Date().toTimeString().slice(0, 5)}(CST) 在收盤結算完成前 — skip（避免拿盤中/未結算量誤判誤修）`);
    process.exit(0);
  }
  // 最新交易日：取流動性高的參考檔 lastDate 最大值
  let latest = dateArg;
  if (!latest) {
    for (const ref of ['2330.TW.json', '2317.TW.json']) {
      try { const j = JSON.parse(await fs.readFile(path.join(DIR, ref), 'utf8')); if (!latest || j.lastDate > latest) latest = j.lastDate; } catch { /* skip */ }
    }
  }
  if (!latest) { console.error('找不到最新交易日'); process.exit(2); }
  console.log(`稽核日：${latest}`);

  const [mi, tp] = await Promise.all([miBulk(latest), tpexBulk(latest)]);
  console.log(`官方源：MI_INDEX ${mi.size} 檔、TPEx ${tp.size} 檔`);
  if (mi.size === 0 && tp.size === 0) { console.error('官方源皆空（非交易日或抓取失敗）— skip'); process.exit(0); }

  // (1) 全市場 本地 vs 官方（--apply 時直接覆蓋破洞的最新一根量）
  const mismatches: string[] = [];          // 顯示用（最多 15 筆）
  const repaired: string[] = [];            // 已自動修的 symbol
  let checked = 0, mismatchCount = 0;
  for (const f of files) {
    const sym = f.replace('.json', ''); const code = sym.replace(/\.(TW|TWO)$/, '');
    let j: { lastDate?: string; sealedDate?: string; updatedAt?: string; candles?: Array<{ date: string; volume: number }> };
    try { j = JSON.parse(await fs.readFile(path.join(DIR, f), 'utf8')); } catch { continue; }
    if (j.lastDate !== latest || !j.candles?.length) continue;
    // 該檔最新一根明確「未封存」(sealedDate 存在且 != latest)=盤中/未結算 → 跳過，不誤判不誤修
    if (j.sealedDate && j.sealedDate !== latest) continue;
    const off = f.endsWith('.TW.json') ? mi.get(code) : tp.get(code);
    if (off == null) continue;
    checked++;
    const cur = Number(j.candles[j.candles.length - 1].volume) || 0;
    if (Math.abs(cur - off) / Math.max(off, 1) > THRESH && Math.abs(cur - off) >= MIN_ABS) {
      mismatchCount++;
      if (mismatches.length < 15) mismatches.push(`${sym} ${cur}≠${off}`);
      if (APPLY) {
        // 最新一根 volume 覆蓋成官方一般交易量；OHLC 一律不動
        j.candles[j.candles.length - 1].volume = off;
        j.updatedAt = new Date().toISOString();
        try { await atomicFsPut(path.join(DIR, f), JSON.stringify(j)); repaired.push(sym); } catch { /* 寫失敗不阻斷 */ }
      }
    }
  }
  console.log(`(1) 本地 vs 官方：檢查 ${checked} 檔，mismatch ${mismatchCount}${APPLY ? `，已自動修 ${repaired.length}` : ''}`);
  if (mismatches.length) console.log('    ' + mismatches.join('  ') + (mismatchCount > 15 ? ' …' : ''));
  if (APPLY && repaired.length) console.log('🔧 已覆蓋成官方量：' + repaired.slice(0, 30).join(' ') + (repaired.length > 30 ? ' …' : ''));

  // (2) 上市抽樣 兩份官方報表對拍（MI_INDEX vs STOCK_DAY）
  const sample = ['2330', '2317', '0050', '2454', '2603'];
  const srcDiff: string[] = [];
  for (const code of sample) {
    const a = mi.get(code); if (a == null) continue;
    const b = await twseStockDay(latest, code); if (b == null) continue;
    if (Math.abs(a - b) / Math.max(a, b, 1) > 0.01) srcDiff.push(`${code} MI=${a}≠SD=${b}`);
  }
  console.log(`(2) 上市官方雙報表對拍：${srcDiff.length ? '❌ ' + srcDiff.join('  ') : '✅ 全一致'}`);

  // 告警判定（--apply 時破洞已自動修好，仍把「大量回歸」當警示讓人查管線根因）
  const alerts: string[] = [];
  if (mismatchCount > ALERT_LIMIT) {
    alerts.push(`本地量與官方源 mismatch ${mismatchCount} 檔(>${ALERT_LIMIT})${APPLY ? `，已自動修 ${repaired.length}` : ''} — 疑 download-candles 管線回歸`);
  }
  if (srcDiff.length) alerts.push(`官方雙報表分歧 ${srcDiff.length}: ${srcDiff.join(', ')}`);
  if (alerts.length) {
    await sendAlert(alerts.join(' ｜ '), mismatchCount > ALERT_LIMIT ? 'critical' : 'warning', { date: latest, mismatches: mismatchCount, repaired: repaired.length, srcDiff: srcDiff.length });
    // --apply：資料已自我癒合 → exit 0（仍留 log/alert）；audit-only：維持 exit 1
    if (APPLY) { console.error(`★ ${alerts.join(' ｜ ')} —（已自動修 ${repaired.length} 檔，exit 0）`); process.exit(0); }
    console.error(`★ ${alerts.join(' ｜ ')} — exit 1`); process.exit(1);
  }
  console.log(`✅ 成交量稽核通過${APPLY && repaired.length ? `（自動修 ${repaired.length} 檔）` : ''}`);
}
main().catch((e) => { console.error(e); process.exit(2); });
