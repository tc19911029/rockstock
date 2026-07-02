/**
 * scripts/audit-twoo-dateshift-full.ts
 *
 * 全市場 .TWO 上櫃股 L1 vs FinMind 逐日比對，分類資料品質問題（dup audit 抓不到的那類）。
 * 2026-06-09 建。輸出受影響清單給重校階段用；FinMind 回應快取到磁碟（可續跑、給 repair 共用）。
 *
 * 分類（每根 local bar）：
 *   correct        — local.date 是 FinMind 交易日且 OHLC 相符
 *   shift          — sig(local) 在 FinMind 唯一對應到「別的日期」（高信心錯標日；唯一簽章避開平盤巧合）
 *   contamination  — local.date 是 FinMind 交易日但 OHLC 不符，且 sig(local) 在整窗 FinMind 找不到（疑快照中間值）
 *   value-mismatch — OHLC 不符但 sig 在 FinMind 出現多次（模糊，低信心）
 *   phantom-halt   — FinMind 該日停牌(0/0/0/0) 但 local 有非平盤 bar
 *   orphan-date    — local.date 不在 FinMind（且 sig 非唯一對應）→ 可能 FinMind 缺日或 local 錯日
 *   missing        — FinMind 有交易日但 local 缺（不影響既有 bar 正確性，另記）
 *
 * 用法：npx tsx scripts/audit-twoo-dateshift-full.ts [--limit N] [--refetch]
 *   續跑：已有快取的檔直接用快取，不重打 FinMind；遇 402 限流就停止抓新檔（保留進度，再跑接續）。
 */
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';

if (existsSync('.env.local')) config({ path: '.env.local' });
config();

const TOKEN = (process.env.FINMIND_API_TOKEN || '').trim();
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i >= 0 ? Number(process.argv[i + 1]) : Infinity; })();
const REFETCH = process.argv.includes('--refetch');
const START = '2026-05-01', END = '2026-06-08';
const CACHE_DIR = 'data/_finmind-cache-twoo';
const REPORT = 'data/_audit/twoo-dateshift-report.json';
const THROTTLE_MS = 200;

interface LBar { date: string; open: number; high: number; low: number; close: number; volume: number; }
interface FRow { date: string; open: number; max: number; min: number; close: number; Trading_Volume: number }
const r2 = (x: number) => Math.round(x * 100) / 100;
const sig = (o: number, h: number, l: number, c: number) => `${r2(o)}|${r2(h)}|${r2(l)}|${r2(c)}`;
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

async function getFinmind(code: string): Promise<{ rows: FRow[]; rateLimited?: boolean }> {
  const cf = path.join(CACHE_DIR, `${code}.json`);
  if (!REFETCH && existsSync(cf)) {
    try { return { rows: JSON.parse(readFileSync(cf, 'utf8')) }; } catch { /* refetch */ }
  }
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${code}&start_date=${START}&end_date=${END}&token=${TOKEN}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (res.status === 402) return { rows: [], rateLimited: true };
    const j = await res.json() as { data?: FRow[] };
    const rows = j.data ?? [];
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cf, JSON.stringify(rows));
    await sleep(THROTTLE_MS);
    return { rows };
  } catch { return { rows: [] }; }
}

interface Issue { type: string; date: string; should?: string; detail?: string }

function classify(local: LBar[], rows: FRow[]): Issue[] {
  const fmByDate = new Map<string, FRow>();
  const sigToDates = new Map<string, string[]>();
  for (const r of rows) {
    fmByDate.set(r.date, r);
    if (r.close > 0) {
      const s = sig(r.open, r.max, r.min, r.close);
      (sigToDates.get(s) ?? sigToDates.set(s, []).get(s)!).push(r.date);
    }
  }
  const localDates = new Set(local.map(b => b.date));
  const issues: Issue[] = [];
  for (const b of local) {
    const fd = fmByDate.get(b.date);
    const s = sig(b.open, b.high, b.low, b.close);
    const sigDates = sigToDates.get(s);
    const uniqueElsewhere = sigDates && sigDates.length === 1 && sigDates[0] !== b.date;
    if (!fd) {
      if (uniqueElsewhere) issues.push({ type: 'shift', date: b.date, should: sigDates![0] });
      else issues.push({ type: 'orphan-date', date: b.date });
    } else if (fd.close === 0) {
      const flatHalt = b.open === b.high && b.high === b.low && b.low === b.close && b.volume === 0;
      if (!flatHalt) issues.push({ type: 'phantom-halt', date: b.date });
    } else if (sig(fd.open, fd.max, fd.min, fd.close) === s) {
      // correct
    } else if (uniqueElsewhere) {
      issues.push({ type: 'shift', date: b.date, should: sigDates![0] });
    } else if (!sigDates) {
      issues.push({ type: 'contamination', date: b.date, detail: `C${b.close}≠FM C${fd.close}` });
    } else {
      issues.push({ type: 'value-mismatch', date: b.date });
    }
  }
  for (const r of rows) if (r.close > 0 && !localDates.has(r.date)) issues.push({ type: 'missing', date: r.date });
  return issues;
}

async function main() {
  if (!TOKEN) { console.error('✗ 沒有 FINMIND_API_TOKEN'); process.exit(1); }
  const dir = 'data/candles/TW';
  const files = readdirSync(dir).filter(f => f.endsWith('.TWO.json')).slice(0, LIMIT === Infinity ? undefined : LIMIT);
  mkdirSync(path.dirname(REPORT), { recursive: true });

  const report: Record<string, Issue[]> = {};
  const tally: Record<string, number> = {};
  let scanned = 0, affected = 0, rateLimitedAt = -1;

  for (let i = 0; i < files.length; i++) {
    const code = files[i].replace('.TWO.json', '');
    const doc = JSON.parse(readFileSync(path.join(dir, files[i]), 'utf8')) as { candles?: LBar[] };
    const local = (doc.candles ?? []).filter(b => b.date >= START && b.date <= END);
    if (local.length < 3) continue;
    const { rows, rateLimited } = await getFinmind(code);
    if (rateLimited) { rateLimitedAt = i; break; }
    if (rows.length < 3) continue;
    scanned++;
    const issues = classify(local, rows).filter(x => x.type !== 'missing'); // missing 另計、不算「壞」
    const real = issues.filter(x => x.type === 'shift' || x.type === 'contamination' || x.type === 'phantom-halt');
    if (real.length) {
      report[code] = issues;
      affected++;
      for (const x of issues) tally[x.type] = (tally[x.type] ?? 0) + 1;
    }
  }

  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(`\n=== .TWO date-shift 全市場審查 ===`);
  console.log(`掃描 ${scanned} 檔（共 ${files.length}），受影響 ${affected} 檔`);
  console.log(`問題分類統計（根數）：`, tally);
  if (rateLimitedAt >= 0) console.log(`⚠ 在第 ${rateLimitedAt} 檔(${files[rateLimitedAt]?.replace('.json','')}) 遇 FinMind 402 限流 → 已抓的進快取，過一陣子再跑會接續。`);
  const top = Object.entries(report).sort((a, b) => b[1].filter(x=>x.type!=='missing').length - a[1].filter(x=>x.type!=='missing').length).slice(0, 15);
  console.log(`\n受影響最重的 ${top.length} 檔：`);
  for (const [code, issues] of top) {
    const summary = issues.filter(x=>x.type!=='missing').map(x => `${x.date}:${x.type}${x.should?`→${x.should}`:''}`).slice(0, 4).join(', ');
    console.log(`  ${code}.TWO  (${issues.filter(x=>x.type!=='missing').length})  ${summary}`);
  }
  console.log(`\n報告寫入 ${REPORT}`);
}
main().catch(e => { console.error(e); process.exit(2); });
