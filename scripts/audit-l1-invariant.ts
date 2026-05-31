/**
 * L1 OHLC invariant audit — 每日跑、確保不再累積壞 K
 *
 * 用法：
 *   npx tsx scripts/audit-l1-invariant.ts                       # summary
 *   npx tsx scripts/audit-l1-invariant.ts --market TW
 *   npx tsx scripts/audit-l1-invariant.ts --json --write data/l1-invariant-audit.json
 *
 * 規則：
 *   close > high (差 > 0.1%) → 違反
 *   close < low (差 > 0.1%) → 違反
 *   open > high / open < low (差 > 0.1%) → 違反（2026-05-31 加；寫入層已 clip，殘留代表繞過）
 *   違反 > 100 筆 → exit 1（給 cron 看）
 */
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';

if (existsSync('.env.local')) config({ path: '.env.local' });
config();

type Market = 'TW' | 'CN';
const VIOLATION_THRESHOLD = 0.001; // 絕對價差千分之一（防 float 浮點誤差）
// 2026-05-20：percentage filter 閾值 0.001 → 0.005 (0.5%)
// 原因：vendor 對單日 OHLC 抓的時間點不一致（盤後結算 close 跟 intraday high/low
// 不同來源），常見差 < 0.5%（如 2321.TW 5/14 close 比 low 低 5 分錢 = 0.39%）。
// 真實 mis.twse 類 bug 都是 amplitude 接近 0 + close 大幅偏離 high/low（>1%），
// 閾值 0.5% 仍能抓得到。0.1% 抓太緊產生 false alarm 不利於 ops。
const VIOLATION_PCT_FILTER = 0.005;
const ALERT_LIMIT = 100;

interface MarketAudit {
  market: Market;
  totalCandles: number;
  violations: number;
  byBucket: { '0.1-1%': number; '1-5%': number; '>5%': number };
  samples: Array<{ symbol: string; date: string; type: 'close>high' | 'close<low' | 'open>high' | 'open<low'; diffPct: number }>;
}

function auditMarket(market: Market): MarketAudit {
  const dir = path.join(process.cwd(), 'data', 'candles', market);
  const out: MarketAudit = {
    market, totalCandles: 0, violations: 0,
    byBucket: { '0.1-1%': 0, '1-5%': 0, '>5%': 0 },
    samples: [],
  };
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let candles: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>;
    try {
      const raw = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      candles = Array.isArray(raw) ? raw : (raw.candles ?? []);
    } catch { continue; }
    const sym = f.replace('.json', '');
    for (const c of candles) {
      out.totalCandles++;
      let violation: 'close>high' | 'close<low' | 'open>high' | 'open<low' | null = null;
      let diff = 0;
      if (c.close > c.high + VIOLATION_THRESHOLD) {
        violation = 'close>high';
        diff = (c.close - c.high) / c.high;
      } else if (c.close < c.low - VIOLATION_THRESHOLD) {
        violation = 'close<low';
        diff = (c.low - c.close) / c.low;
      } else if (c.open > c.high + VIOLATION_THRESHOLD) {
        // open 出界（2026-05-31 加）：寫入層 sanitizeOHLC 已對 open 一律 clip，
        // 正常不該再出現；若出現代表有路徑繞過寫入層或舊壞檔殘留。
        violation = 'open>high';
        diff = (c.open - c.high) / c.high;
      } else if (c.open < c.low - VIOLATION_THRESHOLD) {
        violation = 'open<low';
        diff = (c.low - c.open) / c.low;
      }
      if (!violation) continue;
      if (diff < VIOLATION_PCT_FILTER) continue; // vendor data precision (0.5%)
      out.violations++;
      if (diff < 0.01) out.byBucket['0.1-1%']++;
      else if (diff < 0.05) out.byBucket['1-5%']++;
      else out.byBucket['>5%']++;
      if (out.samples.length < 20) {
        out.samples.push({ symbol: sym, date: c.date, type: violation, diffPct: diff });
      }
    }
  }
  return out;
}

interface Args { market?: Market; json: boolean; write?: string; }
function parseArgs(): Args {
  const a: Args = { json: false };
  for (let i = 2; i < process.argv.length; i++) {
    const x = process.argv[i];
    if (x === '--market') a.market = process.argv[++i] as Market;
    else if (x === '--json') a.json = true;
    else if (x === '--write') a.write = process.argv[++i];
  }
  return a;
}

function printSummary(r: MarketAudit) {
  console.log(`=== ${r.market} L1 invariant audit ===`);
  console.log(`  Total candles: ${r.totalCandles}`);
  console.log(`  Violations: ${r.violations} (${(r.violations / r.totalCandles * 100).toFixed(3)}%)`);
  console.log(`    0.1-1%: ${r.byBucket['0.1-1%']}`);
  console.log(`    1-5%: ${r.byBucket['1-5%']}`);
  console.log(`    >5%: ${r.byBucket['>5%']}`);
  if (r.samples.length > 0) {
    console.log(`  Sample 前 ${Math.min(r.samples.length, 5)}:`);
    r.samples.slice(0, 5).forEach(s =>
      console.log(`    ${s.symbol} ${s.date} ${s.type} ${(s.diffPct * 100).toFixed(2)}%`));
  }
}

async function main() {
  const args = parseArgs();
  const markets: Market[] = args.market ? [args.market] : ['TW', 'CN'];
  const results = markets.map(auditMarket);

  if (args.json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), markets: results }, null, 2));
  } else {
    results.forEach(printSummary);
  }

  if (args.write) {
    const outPath = path.resolve(args.write);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      markets: results,
    }, null, 2));
    console.log(`Written ${outPath}`);
  }

  const totalViolations = results.reduce((s, r) => s + r.violations, 0);
  if (totalViolations > ALERT_LIMIT) {
    console.error(`★ Total violations ${totalViolations} > ${ALERT_LIMIT} — exit 1`);
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(2); });
