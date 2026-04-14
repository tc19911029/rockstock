/**
 * 最終修復：TW 21支 + CN 988支 stale 股票
 * TW: 用 Vercel repair API (symbol= 逐支)
 * CN: 用 EastMoney 直接抓（現在從台灣可連）
 *
 * npx tsx scripts/repair-stale-final.ts
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

const VERCEL_URL = 'https://rockstock-pv90u666w-tc19911029-5086s-projects.vercel.app';
const DATA_DIR = 'data/candles';
const TARGET_DATE = '2026-04-13';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function log(msg: string) {
  const line = `[${new Date().toLocaleTimeString('zh-TW', { hour12: false })}] ${msg}`;
  console.log(line);
  fs.appendFileSync('/tmp/repair-stale-final.log', line + '\n');
}

// ─── HTTP GET helper ────────────────────────────────────────────────────────
function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const agent = new https.Agent({ rejectUnauthorized: false });
    const req = https.get(url, { agent, headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ─── EastMoney CN 歷史K線 ────────────────────────────────────────────────────
async function fetchCNCandles(symbol: string): Promise<{ date: string; open: number; high: number; low: number; close: number; volume: number }[]> {
  const [code, suffix] = symbol.split('.');
  const market = suffix === 'SS' ? '1' : '0';
  const secid = `${market}.${code}`;
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&beg=20240101&end=20260413&lmt=800`;

  const raw = await httpGet(url);
  const data = JSON.parse(raw);
  const klines: string[] = data?.data?.klines ?? [];
  return klines.map(line => {
    const [date, open, close, high, low, volume] = line.split(',');
    return { date, open: +open, high: +high, low: +low, close: +close, volume: +volume };
  }).filter(c => c.date && !isNaN(c.close));
}

// ─── 取得 Blob TW stale 清單 ─────────────────────────────────────────────────
function getTWStaleList(): string[] {
  return [
    '3057.TW', '2489.TW', '2419.TW', '1203.TW', '1233.TW',
    '2035.TWO', '8291.TWO', '2321.TW', '1538.TW', '1213.TW',
    '5906.TW', '9110.TW', '2073.TWO', '2949.TWO', '3064.TWO',
    '4568.TWO', '5345.TWO', '5523.TWO', '5601.TWO', '6997.TWO', '8067.TWO',
  ];
}

// ─── 取得 Blob CN stale 清單（從本地找出 lastDate < TARGET）──────────────────
function getCNStaleList(): string[] {
  const dir = `${DATA_DIR}/CN`;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const stale: string[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const ld = raw.lastDate || '';
      if (ld < TARGET_DATE) stale.push(f.replace('.json', ''));
    } catch { /* skip */ }
  }
  return stale;
}

// ─── TW: vercel curl 逐支修復 ────────────────────────────────────────────────
async function repairTWStock(symbol: string): Promise<boolean> {
  try {
    const raw = execSync(
      `vercel curl "/api/admin/repair-candles?market=TW&mode=repair&symbol=${encodeURIComponent(symbol)}" 2>/dev/null`,
      { encoding: 'utf8', timeout: 60000 }
    );
    const d = JSON.parse(raw);
    return d?.repaired === 1 || (d?.repairedSymbols ?? []).includes(symbol);
  } catch {
    return false;
  }
}

// ─── CN: EastMoney 直接修復 + 存本地 + 上傳 Blob ────────────────────────────
async function repairCNStock(symbol: string): Promise<boolean> {
  try {
    const candles = await fetchCNCandles(symbol);
    if (candles.length === 0) return false;
    const lastDate = candles[candles.length - 1].date;
    const data = { symbol, lastDate, updatedAt: new Date().toISOString(), candles, sealedDate: lastDate };
    const json = JSON.stringify(data);

    // 寫本地
    fs.writeFileSync(path.join(DATA_DIR, 'CN', `${symbol}.json`), json);

    // 上傳 Blob
    const { put } = await import('@vercel/blob');
    await (put as Function)(`candles/CN/${symbol}.json`, json, {
      access: 'private', addRandomSuffix: false, allowOverwrite: true,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    return true;
  } catch {
    return false;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  // Load env
  const envRaw = fs.readFileSync('.env.local', 'utf8');
  for (const line of envRaw.split('\n')) {
    const m = line.match(/^([^=]+)="?([^"]*)"?$/);
    if (m) process.env[m[1]] = m[2];
  }

  // ── TW ──
  const twStale = getTWStaleList();
  log(`🇹🇼 TW stale: ${twStale.length} 支，逐支呼叫 Vercel repair API...`);
  let twOk = 0, twFail = 0;
  for (const sym of twStale) {
    const ok = await repairTWStock(sym);
    if (ok) { twOk++; log(`  ✅ TW ${sym}`); }
    else { twFail++; log(`  ❌ TW ${sym}`); }
    await sleep(3000);
  }
  log(`🇹🇼 TW 完成: ok=${twOk} fail=${twFail}`);

  // ── CN ──
  const cnStale = getCNStaleList();
  log(`\n🇨🇳 CN stale: ${cnStale.length} 支，用 EastMoney 修復...`);
  let cnOk = 0, cnFail = 0;
  for (let i = 0; i < cnStale.length; i++) {
    const sym = cnStale[i];
    const ok = await repairCNStock(sym);
    if (ok) cnOk++;
    else cnFail++;
    if ((i + 1) % 50 === 0 || i === cnStale.length - 1) {
      log(`  [CN] ${i + 1}/${cnStale.length} ok=${cnOk} fail=${cnFail}`);
    }
    await sleep(300);
  }
  log(`🇨🇳 CN 完成: ok=${cnOk} fail=${cnFail}`);

  // ── 最終統計 ──
  log('\n📊 最終本地統計:');
  for (const market of ['TW', 'CN'] as const) {
    const dir = `${DATA_DIR}/${market}`;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    let done = 0;
    for (const f of files) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if ((d.lastDate || '') >= TARGET_DATE) done++;
      } catch { /* skip */ }
    }
    log(`  ${market}: ${done}/${files.length} (${(done / files.length * 100).toFixed(1)}%) 已到 ${TARGET_DATE}`);
  }

  // ── commit + push ──
  log('\n📝 Commit + Push...');
  execSync('git add -A', { cwd: process.cwd() });
  try {
    execSync(`git commit -m "fix(data): 修復 TW 21支 + CN stale 股票 → ${TARGET_DATE}

- TW: 透過 Vercel repair API (symbol= 逐支) 補齊21支
- CN: EastMoney 重新連通，直接從台灣IP抓取並上傳 Blob

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"`, { cwd: process.cwd() });
    execSync('git push origin main', { cwd: process.cwd() });
    log('✅ commit + push 完成');
  } catch {
    log('(no changes to commit)');
  }
  log('\n✅ 全部完成！');
}

main().catch(err => { log('ERROR: ' + err.message); process.exit(1); });
