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
 *   整根複製前一交易日 (封存 bug) → dupBars（2026-06-02 加；見下方常數註解）
 *   違反 > 100 筆 或 dupBars > 0 → 觸發 HEALTH_ALERT_WEBHOOK_URL + exit 1（給 cron 看）
 */
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';

import { isValidTwTick, snapTwTick, isTwEtf } from '../lib/datasource/twTick';

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

// ── 整根複製偵測（2026-06-02 加）─────────────────────────────────────────────
// 封存 bug：某日封存時來源回傳停在前一交易日的舊資料，被原封寫成當日 bar
// （OHLC 連 volume 都一字不差）。因連續兩日收盤常很接近（6190 0513: 92 vs 真實
// 91.6 差 0.43%），上面的 close/open vs high/low 自洽檢查與 repair-l1-from-yahoo
// 的 close-only 偏差都抓不到——錯的是整根被複製、open/high/low/volume 全錯。
// 判別子：相鄰「已封存」兩根 O/H/L/C/volume 全等 + date 不同
//   + volume > 0（V0 是個股停牌平盤帶過，屬正常）
//   + high > low 且振幅 (high-low)/low >= 1%（濾掉薄量單一價股連兩日 byte 相同的
//     真實巧合——那種全市場 951 件清一色 V1~6 的 H==L 單價日）。
// 只掃近 DUP_WINDOW 根已封存 bar：涵蓋近期、避開 2017 等老 artifacts 天天告警。
// 對應一次性修復腳本：scripts/repair-dup-bars.ts（同判別子 + Yahoo 整根覆寫）。
const DUP_WINDOW = 30;
const DUP_RANGE_MIN = 0.01;
const DUP_ALERT_LIMIT = 0; // 真實巧合已被 range>=1% 濾盡，> 0 即真 bug → 告警

// ── 次檔位收盤偵測（2026-06-09 加；TW only）─────────────────────────────────────
// settle 檔位守衛（lib/datasource/twTick + eodSettle）上線前，.TWO 封存時 FinMind 被 402
// 熔斷缺席 → 落到 Yahoo/EODHD 的中間價（如 100-500 區間的 158.75，非合法檔位）→ 封進 L1。
// 守衛只查「每檔最新一根已封存 bar」= 驗最近一次 settle 品質：settle 修好後新封存應全合法 →
// 此數歸 0；不掃歷史（歷史 backlog 由 FinMind 回補處理），避免每天洗版。> 0 即最近 settle 漏網。
const SUBTICK_ALERT_LIMIT = 0;

function todayTaipei(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
}

interface MarketAudit {
  market: Market;
  totalCandles: number;
  violations: number;
  byBucket: { '0.1-1%': number; '1-5%': number; '>5%': number };
  samples: Array<{ symbol: string; date: string; type: 'close>high' | 'close<low' | 'open>high' | 'open<low'; diffPct: number }>;
  dupBars: number;
  dupSamples: Array<{ symbol: string; prevDate: string; date: string; close: number; volume: number; rangePct: number }>;
  subTickCloses: number;
  subTickSamples: Array<{ symbol: string; date: string; close: number; snapped: number }>;
}

function auditMarket(market: Market): MarketAudit {
  const dir = path.join(process.cwd(), 'data', 'candles', market);
  const out: MarketAudit = {
    market, totalCandles: 0, violations: 0,
    byBucket: { '0.1-1%': 0, '1-5%': 0, '>5%': 0 },
    samples: [],
    dupBars: 0, dupSamples: [],
    subTickCloses: 0, subTickSamples: [],
  };
  if (!existsSync(dir)) return out;
  const today = todayTaipei();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let candles: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>;
    let sealedDate: string | undefined;
    try {
      const raw = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      candles = Array.isArray(raw) ? raw : (raw.candles ?? []);
      sealedDate = Array.isArray(raw) ? undefined : raw.sealedDate;
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

    // ── 整根複製偵測（近 DUP_WINDOW 根已封存 bar）─────────────────────────────
    let sealed = candles.filter(c => c.date < today);
    if (sealedDate) sealed = sealed.filter(c => c.date <= sealedDate!);
    const win = sealed.slice(-DUP_WINDOW);
    for (let i = 1; i < win.length; i++) {
      const p = win[i - 1], n = win[i];
      const range = n.low > 0 ? (n.high - n.low) / n.low : 0;
      if (
        n.date !== p.date &&
        n.open === p.open && n.high === p.high && n.low === p.low &&
        n.close === p.close && n.volume === p.volume &&
        n.volume > 0 && n.high > n.low && range >= DUP_RANGE_MIN
      ) {
        out.dupBars++;
        if (out.dupSamples.length < 20) {
          out.dupSamples.push({ symbol: sym, prevDate: p.date, date: n.date, close: n.close, volume: n.volume, rangePct: range });
        }
      }
    }

    // ── 次檔位收盤偵測（TW only，只查最新一根已封存 bar = 驗最近一次 settle 品質）──
    // 指數（^TWII 等）沒有股票檔位規則，排除（2026-06-12：^TWII 43149.46 誤報）
    if (market === 'TW' && sealed.length > 0 && !sym.startsWith('^')) {
      const latest = sealed[sealed.length - 1];
      const etf = isTwEtf(sym);
      if (latest.close > 0 && !isValidTwTick(latest.close, etf)) {
        out.subTickCloses++;
        if (out.subTickSamples.length < 20) {
          out.subTickSamples.push({ symbol: sym, date: latest.date, close: latest.close, snapped: snapTwTick(latest.close, etf) });
        }
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
  console.log(`  整根複製前一日 (封存 bug): ${r.dupBars}`);
  if (r.dupSamples.length > 0) {
    r.dupSamples.slice(0, 5).forEach(s =>
      console.log(`    ⚠ ${s.symbol} ${s.prevDate}→${s.date} (整根=前一日複製, range ${(s.rangePct * 100).toFixed(1)}%, V${s.volume})`));
  }
  if (r.market === 'TW') {
    console.log(`  最新封存次檔位收盤 (settle 漏網): ${r.subTickCloses}`);
    r.subTickSamples.slice(0, 5).forEach(s =>
      console.log(`    ⚠ ${s.symbol} ${s.date} close=${s.close} → snap ${s.snapped}`));
  }
}

/** 告警 webhook（HEALTH_ALERT_WEBHOOK_URL，沒設就 skip；失敗不擋 cron） */
async function sendAlert(text: string, level: 'warning' | 'critical', extra: Record<string, unknown>): Promise<void> {
  const webhook = process.env.HEALTH_ALERT_WEBHOOK_URL;
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `🚨 L1 audit: ${text}`, level, source: 'audit-l1-invariant', ...extra }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch { /* webhook 失敗不擋 cron */ }
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
  const totalDupBars = results.reduce((s, r) => s + r.dupBars, 0);
  const totalSubTick = results.reduce((s, r) => s + r.subTickCloses, 0);

  const alertMsgs: string[] = [];
  if (totalViolations > ALERT_LIMIT) {
    alertMsgs.push(`OHLC invariant 違反 ${totalViolations} 筆 (>${ALERT_LIMIT})`);
  }
  if (totalDupBars > DUP_ALERT_LIMIT) {
    const ex = results.flatMap(r => r.dupSamples).slice(0, 8).map(s => `${s.symbol} ${s.date}`).join(', ');
    alertMsgs.push(`整根複製前一日封存 bug ${totalDupBars} 筆: ${ex}`);
  }
  if (totalSubTick > SUBTICK_ALERT_LIMIT) {
    const ex = results.flatMap(r => r.subTickSamples).slice(0, 8).map(s => `${s.symbol} ${s.date} ${s.close}`).join(', ');
    alertMsgs.push(`最新封存次檔位收盤 ${totalSubTick} 檔(settle 漏網): ${ex}`);
  }

  if (alertMsgs.length > 0) {
    const level = totalDupBars > DUP_ALERT_LIMIT || totalSubTick > SUBTICK_ALERT_LIMIT || totalViolations > ALERT_LIMIT * 5 ? 'critical' : 'warning';
    await sendAlert(alertMsgs.join(' ｜ '), level, { totalViolations, totalDupBars, totalSubTick });
    console.error(`★ ${alertMsgs.join(' ｜ ')} — exit 1`);
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(2); });
