// ============================================================
// 台股 L1 成交量「以 FinMind 為準」校正
//
// 病徵：本地 K 線 OHLC 全對，但「成交量」對部分股不可靠（對照 FinMind 權威源證實）：
//   (1) 持續性少算（2330 每日量僅真實 ~57-87%）；(2) 單日爆壞（某日只剩真實 1/3~1/5）；
//   (3) 殘留股單位未轉張（local 是股、與 fm張 差 ~1000×）。
//   後果：走圖量柱偏、主力狀態「中控」SUM(VOL,480) 失真、量能突破訊號誤判。
//   （成本／壓力價已在 dataLoader 改用 FinMind 同源量，不受此污染；本腳本修「資料本身」。）
//
// 修法：用 FinMind Trading_Volume(股) ÷1000 → 張，覆蓋本地 volume。OHLC 一律不動。
//   只覆蓋「相對誤差 > 8% 且 絕對差 ≥ 50 張」的 bar —— 過濾掉低量股 ±1~2 張的 rounding 雜訊，
//   只修真實污染（單位殘留、大比例錯、單日爆壞）。FinMind 該日無量(停牌) → 保留本地。
//
// 範圍：預設 = 持股 ∪ 有 inst cache 的「實際在看」個股（約 300+，含全部持股，holdings 先跑）。
//   --all = 全市場 candle 檔。FinMind 免費層有時限額；遇限額會「乾淨中止 + 記錄進度」，
//   稍後 --resume 接著跑（已校正者跳過、不重抓）。
//
// 安全：dry-run 為預設；--apply 才「備份 → 覆寫 → 清 L1 cache」。備份到
//   data/candles/TW-backup-volfinmind-<ts>/。
//
//   npx tsx scripts/repair-tw-volume-from-finmind.ts                 # dry-run（持股+inst宇宙）
//   npx tsx scripts/repair-tw-volume-from-finmind.ts --apply         # 校正
//   npx tsx scripts/repair-tw-volume-from-finmind.ts --apply --all   # 全市場
//   npx tsx scripts/repair-tw-volume-from-finmind.ts --apply --resume# 限額後接著跑
//   npx tsx scripts/repair-tw-volume-from-finmind.ts 2330            # 單檔
//   旗標：--days=N 限近 N 日（預設全歷史）
// ============================================================
import { config } from 'dotenv';
config({ path: '.env.local' });
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Candle } from '@/types';

const APPLY = process.argv.includes('--apply');
const ALL = process.argv.includes('--all');
const RESUME = process.argv.includes('--resume');
const ONLY = process.argv.find((a) => /^[0-9][0-9A-Z]{3,6}$/.test(a));
const DAYS = ((): number => { const a = process.argv.find((x) => x.startsWith('--days=')); return a ? parseInt(a.split('=')[1], 10) : 0; })();
const THRESH = 0.08;             // 相對誤差 > 8%
const MIN_ABS = 50;             // 且 絕對差 ≥ 50 張（過濾低量股 rounding 雜訊）
const TOKEN = (process.env.FINMIND_API_TOKEN ?? '').replace(/['"]/g, '').trim();
const DIR = path.join(process.cwd(), 'data/candles/TW');
const INST_DIR = path.join(process.cwd(), 'data/chips/TW/inst');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const BACKUP = path.join(process.cwd(), 'data/candles', `TW-backup-volfinmind-${STAMP}`);
const DONE_FILE = path.join(process.cwd(), 'data/candles', '_volfix-done.json');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function daysAgo(end: string, n: number) { const d = new Date(end + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); }

type FmResult = { ok: true; map: Map<string, number> } | { ok: false; rate: boolean };
async function fmVolLots(code: string, start: string, end: string): Promise<FmResult> {
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${encodeURIComponent(code)}&start_date=${start}&end_date=${end}&token=${encodeURIComponent(TOKEN)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (res.status === 402 || res.status === 429) return { ok: false, rate: true };
    if (!res.ok) return { ok: false, rate: false };
    const j = (await res.json()) as { status?: number; msg?: string; data?: Array<{ date: string; Trading_Volume: number }> };
    if (j.status === 402 || /level|limit|quota|upgrade/i.test(j.msg ?? '')) return { ok: false, rate: true };
    if (j.status !== 200 || !Array.isArray(j.data)) return { ok: false, rate: false };
    const m = new Map<string, number>();
    for (const r of j.data) { const lots = Math.round((Number(r.Trading_Volume) || 0) / 1000); if (lots > 0) m.set(String(r.date).slice(0, 10), lots); }
    return { ok: true, map: m };
  } catch { return { ok: false, rate: false }; }
}

async function loadJson<T>(p: string, fallback: T): Promise<T> { try { return JSON.parse(await fs.readFile(p, 'utf8')) as T; } catch { return fallback; } }

(async () => {
  if (!TOKEN) { console.error('FINMIND_API_TOKEN 未設定'); process.exit(1); }

  // 範圍
  let files = (await fs.readdir(DIR)).filter((f) => /^[0-9][0-9A-Z]{3,6}\.(TW|TWO)\.json$/.test(f));
  if (ONLY) {
    files = files.filter((f) => f.startsWith(`${ONLY}.`));
  } else if (!ALL) {
    const instCodes = new Set((await fs.readdir(INST_DIR).catch(() => [])).map((f) => f.replace('.json', '')));
    const holdings = await loadJson<{ holdings?: Array<{ symbol?: string }> }>(path.join(process.cwd(), 'data/agents/portfolio/holdings.json'), {});
    for (const h of holdings.holdings ?? []) { const c = String(h.symbol ?? '').replace(/\.(TW|TWO)$/i, ''); if (c) instCodes.add(c); }
    files = files.filter((f) => instCodes.has(f.replace(/\.(TW|TWO)\.json$/, '')));
  }

  // holdings 先跑（即使限額也保證持股乾淨）
  const HOLD = new Set((await loadJson<{ holdings?: Array<{ symbol?: string }> }>(path.join(process.cwd(), 'data/agents/portfolio/holdings.json'), {})).holdings?.map((h) => String(h.symbol ?? '').replace(/\.(TW|TWO)$/i, '')) ?? []);
  files.sort((a, b) => (HOLD.has(b.replace(/\.(TW|TWO)\.json$/, '')) ? 1 : 0) - (HOLD.has(a.replace(/\.(TW|TWO)\.json$/, '')) ? 1 : 0));

  const done: Set<string> = RESUME ? new Set(await loadJson<string[]>(DONE_FILE, [])) : new Set();
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

  const results: { sym: string; changed: number; scanned: number; sample: string[] }[] = [];
  let fmFail = 0, totalChanged = 0, filesChanged = 0, processed = 0;
  let rateHit = false;

  for (let i = 0; i < files.length; i++) {
    const f = files[i]; const sym = f.replace('.json', ''); const code = sym.replace(/\.(TW|TWO)$/, '');
    if (done.has(sym)) continue;
    let j: { candles: Candle[] };
    try { j = JSON.parse(await fs.readFile(path.join(DIR, f), 'utf8')); } catch { continue; }
    if (!Array.isArray(j.candles) || j.candles.length < 5) { done.add(sym); continue; }

    const firstDate = String(j.candles[0].date).replace('*', '').slice(0, 10);
    const start = DAYS > 0 ? daysAgo(today, DAYS) : firstDate;
    const res = await fmVolLots(code, start, today);
    await sleep(110);
    if (!res.ok) { if (res.rate) { rateHit = true; break; } fmFail++; done.add(sym); continue; }
    processed++;

    const sample: string[] = []; let changed = 0, scanned = 0;
    for (const c of j.candles) {
      const d = String(c.date).replace('*', '').slice(0, 10);
      if (d < start) continue;
      const fv = res.map.get(d); if (fv == null) continue;
      scanned++;
      const cur = Number(c.volume) || 0;
      if (Math.abs(cur - fv) / Math.max(fv, 1) > THRESH && Math.abs(cur - fv) >= MIN_ABS) {
        if (sample.length < 3) sample.push(`${d} ${cur}→${fv}`);
        if (APPLY) c.volume = fv;
        changed++;
      }
    }
    if (changed > 0) {
      results.push({ sym, changed, scanned, sample });
      totalChanged += changed; filesChanged++;
      if (APPLY) {
        await fs.mkdir(BACKUP, { recursive: true });
        await fs.copyFile(path.join(DIR, f), path.join(BACKUP, f));
        await fs.writeFile(path.join(DIR, f), JSON.stringify(j));
        try { const { invalidateEntry } = await import('@/lib/datasource/L1CandleCache'); invalidateEntry(sym, 'TW'); } catch { /* nonfatal */ }
      }
    }
    done.add(sym);
    if (APPLY && processed % 25 === 0) await fs.writeFile(DONE_FILE, JSON.stringify([...done]));
    if ((i + 1) % 50 === 0) console.error(`…進度 ${i + 1}/${files.length}`);
  }
  if (APPLY) await fs.writeFile(DONE_FILE, JSON.stringify([...done]));

  results.sort((a, b) => b.changed - a.changed);
  console.log(`\n=== FinMind 成交量校正${APPLY ? '（已備份+覆寫+清 cache）' : '（dry-run）'} ===`);
  console.log(`掃描宇宙 ${files.length} 檔；本次處理 ${processed} 檔；需校正 ${filesChanged} 檔 / ${totalChanged} 根；FinMind 無資料 ${fmFail}`);
  if (rateHit) console.log(`⚠ 觸發 FinMind 限額，已乾淨中止（持股已優先處理）。稍後跑 --apply --resume 接續。`);
  console.log('\nsymbol        改根數/掃描   範例(舊→新)');
  for (const r of results.slice(0, 40)) console.log(`  ${r.sym.padEnd(12)} ${String(r.changed).padStart(4)}/${String(r.scanned).padEnd(4)}  ${r.sample.join('  ')}`);
  if (results.length > 40) console.log(`  …(其餘 ${results.length - 40} 檔略)`);
  console.log(APPLY ? `\n備份：data/candles/TW-backup-volfinmind-${STAMP}/  進度檔：${DONE_FILE}` : '\n(dry-run；加 --apply 才會寫入)');
})();
