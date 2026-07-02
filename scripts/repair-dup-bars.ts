/**
 * scripts/repair-dup-bars.ts
 *
 * 修補「整根複製前一交易日」的封存 bug：某日封存時來源回傳停在前一交易日的舊資料，
 * 被原封寫成當日 bar — OHLC 連成交量都一字不差，只有 date 不同。因為連續兩日收盤
 * 常很接近，close-only 稽核（repair-l1-from-yahoo / audit-l1-invariant）抓不到。
 *
 * 偵測（與 scripts/audit-l1-invariant.ts 的 dup 檢查同一套判別子）：
 *   近 WINDOW 根「已封存」bar 內，相鄰兩根 O/H/L/C/volume 全等且 date 不同
 *   + volume > 0（停牌 V0 平盤帶過屬正常，不算）
 *   + high > low 且振幅 (high-low)/low >= 1%（濾掉薄量單一價股的真實巧合）
 *
 * 修法：用 Yahoo 為 ground truth 整根覆寫被複製的那根（找不到 Yahoo bar 則報告、不動）。
 *
 * 用法：
 *   npx tsx scripts/repair-dup-bars.ts                 # dry-run，全市場
 *   npx tsx scripts/repair-dup-bars.ts --apply
 *   npx tsx scripts/repair-dup-bars.ts --market TW --apply
 */
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

if (existsSync('.env.local')) config({ path: '.env.local' });
config();

type Market = 'TW' | 'CN';
const APPLY = process.argv.includes('--apply');
const MARKET_ARG = (() => { const i = process.argv.indexOf('--market'); return i >= 0 ? process.argv[i + 1] as Market : null; })();
const WINDOW = 30;
const RANGE_MIN = 0.01;

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number; }

function todayTaipei(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
}
function rangePct(b: Bar): number { return b.low > 0 ? (b.high - b.low) / b.low : 0; }

/** 同一套 dup 判別子 */
function isDupCopy(prev: Bar, cur: Bar): boolean {
  return cur.date !== prev.date
    && cur.open === prev.open && cur.high === prev.high && cur.low === prev.low
    && cur.close === prev.close && cur.volume === prev.volume
    && cur.volume > 0 && cur.high > cur.low && rangePct(cur) >= RANGE_MIN;
}

const yahooCache = new Map<string, Map<string, Bar>>();
async function yahoo(symbol: string): Promise<Map<string, Bar>> {
  if (yahooCache.has(symbol)) return yahooCache.get(symbol)!;
  const m = new Map<string, Bar>();
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15_000) });
    const j = await res.json() as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<Record<string, (number | null)[]>> } }> } };
    const r0 = j.chart?.result?.[0];
    const ts = r0?.timestamp ?? [];
    const q = r0?.indicators?.quote?.[0] ?? {};
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' });
    const r2 = (x: number) => Math.round(x * 100) / 100;
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i] ?? 0;
      if (o == null || h == null || l == null || c == null) continue;
      const date = fmt.format(new Date(ts[i] * 1000));
      m.set(date, { date, open: r2(o), high: r2(h), low: r2(l), close: r2(c), volume: Math.round((v ?? 0) / 1000) });
    }
  } catch { /* leave empty */ }
  yahooCache.set(symbol, m);
  return m;
}

async function repairMarket(market: Market): Promise<{ fixed: number; unfixable: number }> {
  const dir = path.join(process.cwd(), 'data', 'candles', market);
  let fixed = 0, unfixable = 0;
  if (!existsSync(dir)) return { fixed, unfixable };
  const today = todayTaipei();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(dir, f);
    let j: { candles?: Bar[]; sealedDate?: string; updatedAt?: string };
    try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    const all: Bar[] = j.candles ?? [];
    let sealed = all.filter(c => c.date < today);
    if (j.sealedDate) sealed = sealed.filter(c => c.date <= j.sealedDate!);
    const win = sealed.slice(-WINDOW);
    const sym = f.replace('.json', '');
    for (let i = 1; i < win.length; i++) {
      if (!isDupCopy(win[i - 1], win[i])) continue;
      const badDate = win[i].date;
      const idx = all.findIndex(c => c.date === badDate);
      if (idx < 0) continue;
      const real = (await yahoo(sym)).get(badDate);
      const old = all[idx];
      if (!real) {
        console.log(`✗ ${market} ${sym} ${badDate}: Yahoo 無此根，無法自動修（手動處理）`);
        unfixable++;
        continue;
      }
      console.log(`● ${market} ${sym} ${badDate}`);
      console.log(`   was : O${old.open} H${old.high} L${old.low} C${old.close} V${old.volume} (= ${win[i - 1].date} 複製)`);
      console.log(`   new : O${real.open} H${real.high} L${real.low} C${real.close} V${real.volume}`);
      if (APPLY) {
        all[idx] = real;
        fixed++;
      }
    }
    if (APPLY) {
      j.updatedAt = new Date().toISOString();
      writeFileSync(file, JSON.stringify(j));
    }
  }
  return { fixed, unfixable };
}

async function main() {
  console.log(`repair-dup-bars — ${APPLY ? 'APPLY' : 'DRY-RUN'} (window=${WINDOW} sealed bars, range>=${RANGE_MIN * 100}%)\n`);
  const markets: Market[] = MARKET_ARG ? [MARKET_ARG] : ['TW', 'CN'];
  let totalFixed = 0, totalUnfixable = 0;
  for (const m of markets) {
    const r = await repairMarket(m);
    totalFixed += r.fixed; totalUnfixable += r.unfixable;
  }
  console.log(`\n${APPLY ? `done. fixed ${totalFixed}, unfixable ${totalUnfixable}` : 'dry-run only. add --apply to write.'}`);
}
main().catch(e => { console.error(e); process.exit(2); });
