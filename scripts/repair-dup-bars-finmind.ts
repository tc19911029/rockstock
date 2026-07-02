/**
 * scripts/repair-dup-bars-finmind.ts
 *
 * repair-dup-bars.ts 的 FinMind 版。標準工具用 Yahoo 當 ground truth，但 Yahoo 對上櫃
 * (.TWO) 日線資料不可靠 / 本機 Node 直連常 403 → 補不了 OTC 的「整根複製前一交易日」封存 bug。
 * 此版改用 FinMind TaiwanStockPrice（有上櫃日線）整根覆寫。偵測子與寫檔格式與標準版完全一致。
 *
 * 安全機制：
 *   - 偵測子同 audit-l1-invariant / repair-dup-bars（近 WINDOW 根 sealed 內相鄰 O/H/L/C/V 全等）
 *   - FinMind close>0 才覆寫；回 0/空（停牌/無交易）→ 報告、不動，交人工
 *   - 量單位：FinMind 是股，本地 .TWO L1 是張 → volume = round(股/1000)（4198 06-04 13000→13 已驗）
 *   - 只改實際動到的檔（不無謂 bump updatedAt）
 *
 * 用法：
 *   npx tsx scripts/repair-dup-bars-finmind.ts                  # dry-run, 全市場
 *   npx tsx scripts/repair-dup-bars-finmind.ts --market TW --apply
 */
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

if (existsSync('.env.local')) config({ path: '.env.local' });
config();

type Market = 'TW' | 'CN';
const APPLY = process.argv.includes('--apply');
const MARKET_ARG = (() => { const i = process.argv.indexOf('--market'); return i >= 0 ? process.argv[i + 1] as Market : null; })();
const TOKEN = (process.env.FINMIND_API_TOKEN || '').trim();
const WINDOW = 30;
const RANGE_MIN = 0.01;

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number; }

function rangePct(b: Bar): number { return b.low > 0 ? (b.high - b.low) / b.low : 0; }
function todayTaipei(): string { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date()); }

/** 同一套 dup 判別子（與 repair-dup-bars.ts / audit-l1-invariant.ts 一致） */
function isDupCopy(prev: Bar, cur: Bar): boolean {
  return cur.date !== prev.date
    && cur.open === prev.open && cur.high === prev.high && cur.low === prev.low
    && cur.close === prev.close && cur.volume === prev.volume
    && cur.volume > 0 && cur.high > cur.low && rangePct(cur) >= RANGE_MIN;
}

const fmCache = new Map<string, Map<string, Bar>>();
async function finmind(sym: string): Promise<Map<string, Bar>> {
  if (fmCache.has(sym)) return fmCache.get(sym)!;
  const m = new Map<string, Bar>();
  const code = sym.replace(/\.(TWO|TW)$/i, '');
  try {
    const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${code}&start_date=2026-05-15&end_date=${todayTaipei()}&token=${TOKEN}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const j = await res.json() as { data?: Array<{ date: string; open: number; max: number; min: number; close: number; Trading_Volume: number }> };
    for (const d of j.data ?? []) {
      if (!(d.close > 0)) continue; // 停牌/無交易（FinMind 回 0/0/0/0 V=1）跳過
      m.set(d.date, { date: d.date, open: d.open, high: d.max, low: d.min, close: d.close, volume: Math.round((d.Trading_Volume ?? 0) / 1000) });
    }
  } catch { /* leave empty */ }
  fmCache.set(sym, m);
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
    let touched = false;
    for (let i = 1; i < win.length; i++) {
      if (!isDupCopy(win[i - 1], win[i])) continue;
      const badDate = win[i].date;
      const idx = all.findIndex(c => c.date === badDate);
      if (idx < 0) continue;
      const real = (await finmind(sym)).get(badDate);
      const old = all[idx];
      if (!real) {
        console.log(`✗ ${market} ${sym} ${badDate}: FinMind 無有效值（停牌/無交易），交人工`);
        unfixable++;
        continue;
      }
      console.log(`● ${market} ${sym} ${badDate}`);
      console.log(`   was : O${old.open} H${old.high} L${old.low} C${old.close} V${old.volume} (= ${win[i - 1].date} 複製)`);
      console.log(`   new : O${real.open} H${real.high} L${real.low} C${real.close} V${real.volume}`);
      if (APPLY) { all[idx] = real; fixed++; touched = true; }
    }
    if (APPLY && touched) {
      j.updatedAt = new Date().toISOString();
      writeFileSync(file, JSON.stringify(j));
    }
  }
  return { fixed, unfixable };
}

async function main() {
  console.log(`repair-dup-bars-finmind — ${APPLY ? 'APPLY' : 'DRY-RUN'} (window=${WINDOW} sealed bars)\n`);
  if (!TOKEN) { console.error('✗ 沒有 FINMIND_API_TOKEN'); process.exit(1); }
  const markets: Market[] = MARKET_ARG ? [MARKET_ARG] : ['TW', 'CN'];
  let totalFixed = 0, totalUnfixable = 0;
  for (const m of markets) {
    const r = await repairMarket(m);
    totalFixed += r.fixed; totalUnfixable += r.unfixable;
  }
  console.log(`\n${APPLY ? `done. fixed ${totalFixed}, unfixable ${totalUnfixable}` : 'dry-run only. add --apply to write.'}`);
}
main().catch(e => { console.error(e); process.exit(2); });
