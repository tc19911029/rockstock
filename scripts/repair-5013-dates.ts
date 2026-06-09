/**
 * scripts/repair-5013-dates.ts  （一次性）
 *
 * 修 5013.TWO 早 6 月 L1：date-shift + 停牌幻影（2026-06-09 發現，dup audit 抓不到 date-shift）。
 * 現況 vs FinMind ground truth（已逐日對齊驗證）：
 *   local 06-02 = FM 06-01 價（腐爛，≈06-01 重複）
 *   local 06-03 = FM 06-02（標錯日，慢 1 天）         → 應為 FM 06-03（local 完全缺）
 *   local 06-05 = FM 06-04（停牌日幻影複製）           → 06-05 FinMind 停牌(0/0/0/0)，不該有 bar
 *   local 06-01 / 06-04 / 06-08 已與 FinMind 對齊 → 不動
 *
 * 修法（外科式，最小變動）：覆寫 06-02←FM06-02、06-03←FM06-03、移除 06-05。
 * 安全：套用前斷言 local 現況符合上述腐爛簽章，任一不符就中止（避免改到已變動/已修的資料）。
 * 量單位：FinMind 股 → 本地張，round(股/1000)。
 *
 * 用法：
 *   npx tsx scripts/repair-5013-dates.ts             # dry-run
 *   npx tsx scripts/repair-5013-dates.ts --apply
 */
import { config } from 'dotenv';
import { existsSync, readFileSync, writeFileSync } from 'fs';

if (existsSync('.env.local')) config({ path: '.env.local' });
config();

const APPLY = process.argv.includes('--apply');
const TOKEN = (process.env.FINMIND_API_TOKEN || '').trim();
const FILE = 'data/candles/TW/5013.TWO.json';

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number; }

async function finmindWindow(): Promise<Map<string, Bar>> {
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=5013&start_date=2026-06-01&end_date=2026-06-08&token=${TOKEN}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const j = await res.json() as { data?: Array<{ date: string; open: number; max: number; min: number; close: number; Trading_Volume: number }> };
  const m = new Map<string, Bar>();
  for (const d of j.data ?? []) {
    if (!(d.close > 0)) continue; // 停牌(0/0/0/0)不建 bar
    m.set(d.date, { date: d.date, open: d.open, high: d.max, low: d.min, close: d.close, volume: Math.round((d.Trading_Volume ?? 0) / 1000) });
  }
  return m;
}

function samePrices(a: Bar, b: Bar): boolean {
  return a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close;
}

async function main() {
  if (!TOKEN) { console.error('✗ 沒有 FINMIND_API_TOKEN'); process.exit(1); }
  console.log(`repair-5013-dates — ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);

  const fm = await finmindWindow();
  const fm01 = fm.get('2026-06-01'), fm02 = fm.get('2026-06-02'), fm03 = fm.get('2026-06-03'), fm04 = fm.get('2026-06-04');
  if (!fm01 || !fm02 || !fm03 || !fm04) { console.error('✗ FinMind 06-01~04 缺值，無法安全修'); process.exit(1); }

  const doc = JSON.parse(readFileSync(FILE, 'utf8')) as { candles: Bar[]; lastDate?: string; sealedDate?: string; updatedAt?: string };
  const at = (d: string) => doc.candles.find(b => b.date === d);
  const l02 = at('2026-06-02'), l03 = at('2026-06-03'), l05 = at('2026-06-05');

  // ── 安全斷言：確認現況確實是已知的腐爛簽章 ──
  const checks: Array<[string, boolean]> = [
    ['06-02 應 = FM06-01 價(腐爛)', !!l02 && samePrices(l02, fm01)],
    ['06-03 應 = FM06-02 價(標錯日)', !!l03 && samePrices(l03, fm02)],
    ['06-05 應 = FM06-04 價(停牌幻影)', !!l05 && samePrices(l05, fm04)],
  ];
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} 斷言：${label}`);
    if (!ok) { console.error('\n✗ 現況與預期腐爛簽章不符 → 中止（資料可能已變動/已修）'); process.exit(1); }
  }

  console.log('\n  變更：');
  console.log(`   06-02  O${l02!.open} H${l02!.high} L${l02!.low} C${l02!.close} V${l02!.volume}  →  O${fm02.open} H${fm02.high} L${fm02.low} C${fm02.close} V${fm02.volume}`);
  console.log(`   06-03  O${l03!.open} H${l03!.high} L${l03!.low} C${l03!.close} V${l03!.volume}  →  O${fm03.open} H${fm03.high} L${fm03.low} C${fm03.close} V${fm03.volume}`);
  console.log(`   06-05  O${l05!.open} H${l05!.high} L${l05!.low} C${l05!.close} V${l05!.volume}  →  移除（停牌日）`);

  // ── 套用 ──
  doc.candles = doc.candles
    .filter(b => b.date !== '2026-06-05')           // 移除停牌幻影
    .map(b => b.date === '2026-06-02' ? { ...fm02 } : b.date === '2026-06-03' ? { ...fm03 } : b)
    .sort((a, b) => a.date.localeCompare(b.date));   // 保險：重排

  if (APPLY) {
    doc.updatedAt = new Date().toISOString();
    writeFileSync(FILE, JSON.stringify(doc));
    console.log('\n  ✓ 已寫入');
  } else {
    console.log('\n  dry-run only. add --apply to write.');
  }
}
main().catch(e => { console.error(e); process.exit(2); });
