/**
 * scripts/audit-twoo-dateshift.ts
 *
 * 抽樣 .TWO 上櫃股，跨 FinMind 逐日 OHLC 比對「日期位移(date-shift)」——
 * dup audit（audit-l1-invariant 的 byte-複製判別子）抓不到這種錯（日期標錯但非整根複製）。
 * 2026-06-09 在 5013.TWO 發現後加，先抽樣評估普遍性再決定要不要全市場跑。
 *
 * 判別：local 某根的 (O,H,L,C) 簽章在 FinMind 同窗存在，但對應的是「不同日期」→ 位移。
 * （量不比；FinMind 偶有單日量異常，OHLC 比對較穩。）
 *
 * 用法：npx tsx scripts/audit-twoo-dateshift.ts [--sample 30]
 */
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';

if (existsSync('.env.local')) config({ path: '.env.local' });
config();

const TOKEN = (process.env.FINMIND_API_TOKEN || '').trim();
const SAMPLE = Number(process.argv[process.argv.indexOf('--sample') + 1]) || 30;
const START = '2026-05-15', END = '2026-06-08';

interface Bar { date: string; open: number; high: number; low: number; close: number; }
const r2 = (x: number) => Math.round(x * 100) / 100;
const sig = (b: Bar) => `${r2(b.open)}|${r2(b.high)}|${r2(b.low)}|${r2(b.close)}`;

async function finmindSigMap(code: string): Promise<Map<string, string> | null> {
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${code}&start_date=${START}&end_date=${END}&token=${TOKEN}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (res.status === 402) return null; // 限流
    const j = await res.json() as { data?: Array<{ date: string; open: number; max: number; min: number; close: number }> };
    const m = new Map<string, string>();
    for (const d of j.data ?? []) {
      if (!(d.close > 0)) continue;
      m.set(sig({ date: d.date, open: d.open, high: d.max, low: d.min, close: d.close }), d.date);
    }
    return m;
  } catch { return null; }
}

async function main() {
  if (!TOKEN) { console.error('✗ 沒有 FINMIND_API_TOKEN'); process.exit(1); }
  const dir = 'data/candles/TW';
  const files = readdirSync(dir).filter(f => f.endsWith('.TWO.json'));
  const step = Math.max(1, Math.floor(files.length / SAMPLE));
  const sample = files.filter((_, i) => i % step === 0).slice(0, SAMPLE);
  console.log(`抽樣 ${sample.length}/${files.length} 檔 .TWO，比對 ${START}~${END} 日期位移\n`);

  let checked = 0, shiftedStocks = 0, rateLimited = 0;
  for (const f of sample) {
    const code = f.replace('.TWO.json', '');
    const doc = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as { candles?: Bar[] };
    const local = (doc.candles ?? []).filter(b => b.date >= START && b.date <= END);
    if (local.length < 3) continue;
    const fmMap = await finmindSigMap(code);
    if (fmMap === null) { rateLimited++; continue; }
    if (fmMap.size < 3) continue;
    checked++;
    const shifts: string[] = [];
    for (const b of local) {
      const fmDate = fmMap.get(sig(b));
      if (fmDate && fmDate !== b.date) shifts.push(`${b.date}→FM${fmDate}`);
    }
    if (shifts.length) { shiftedStocks++; console.log(`  ⚠ ${code}.TWO: ${shifts.length} 位移  ${shifts.slice(0, 5).join(', ')}`); }
  }
  console.log(`\n結果：有效比對 ${checked} 檔，${shiftedStocks} 檔有日期位移${rateLimited ? `（另 ${rateLimited} 檔 FinMind 限流跳過）` : ''}`);
  if (shiftedStocks === 0) console.log('→ 抽樣內 date-shift 看似為 5013 個案，非普遍。');
  else console.log('→ date-shift 非個案，建議擴大樣本 / 全市場跑 + 逐檔 FinMind 重校。');
}
main().catch(e => { console.error(e); process.exit(2); });
