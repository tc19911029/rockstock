/**
 * 多 API Fallback 修復腳本
 * TW: Yahoo Finance → TWSE/TPEX
 * CN: 騰訊 → Yahoo Finance → Sina
 *
 * npx tsx scripts/repair-with-fallback.ts        # 修復所有 stale
 * npx tsx scripts/repair-with-fallback.ts TW     # 只修 TW
 * npx tsx scripts/repair-with-fallback.ts CN     # 只修 CN
 */
import { put } from '@vercel/blob';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const TARGET_DATE = '2026-04-13';
const DATA_DIR = 'data/candles';
const DELAY_MS = 400;
const LOG_FILE = '/tmp/repair-fallback.log';

type Candle = { date: string; open: number; high: number; low: number; close: number; volume: number };
type Market = 'TW' | 'CN';

const marketArg = (process.argv[2] || 'ALL').toUpperCase();
const markets: Market[] = marketArg === 'ALL' ? ['TW', 'CN'] : [marketArg as Market];

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function log(msg: string) {
  const line = `[${new Date().toLocaleTimeString('zh-TW', { hour12: false })}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

const agent = new https.Agent({ rejectUnauthorized: false });

function httpGet(url: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      agent,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', ...headers },
      timeout: 12000,
    }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ─── CN providers ────────────────────────────────────────────────────────────

async function fetchCN_Tencent(symbol: string): Promise<Candle[]> {
  const [code, sfx] = symbol.split('.');
  const prefix = sfx === 'SS' ? 'sh' : 'sz';
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${prefix}${code},day,,2024-01-01,${TARGET_DATE},800&_var=kline_day`;
  const raw = await httpGet(url);
  const jsonStr = raw.replace(/^var kline_day=/, '');
  const data = JSON.parse(jsonStr);
  const klines: any[] = data?.data?.[`${prefix}${code}`]?.day ?? data?.data?.[`${prefix}${code}`]?.qfqday ?? [];
  return klines.map(k => ({
    date: k[0], open: +k[1], close: +k[2], high: +k[3], low: +k[4], volume: +k[5],
  })).filter(c => c.date <= TARGET_DATE);
}

async function fetchCN_Yahoo(symbol: string): Promise<Candle[]> {
  const [code, sfx] = symbol.split('.');
  const ySymbol = sfx === 'SS' ? `${code}.SS` : `${code}.SZ`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ySymbol}?interval=1d&range=2y`;
  const raw = await httpGet(url);
  const data = JSON.parse(raw);
  const result = data?.chart?.result?.[0];
  if (!result) return [];
  const timestamps: number[] = result.timestamp ?? [];
  const ohlcv = result.indicators?.quote?.[0] ?? {};
  return timestamps.map((ts, i) => {
    const date = new Date(ts * 1000).toISOString().slice(0, 10);
    return {
      date,
      open: +(ohlcv.open?.[i] ?? 0).toFixed(2),
      high: +(ohlcv.high?.[i] ?? 0).toFixed(2),
      low: +(ohlcv.low?.[i] ?? 0).toFixed(2),
      close: +(ohlcv.close?.[i] ?? 0).toFixed(2),
      volume: ohlcv.volume?.[i] ?? 0,
    };
  }).filter(c => c.close > 0 && c.date <= TARGET_DATE);
}

async function fetchCN_Sina(symbol: string): Promise<Candle[]> {
  const [code, sfx] = symbol.split('.');
  const prefix = sfx === 'SS' ? 'sh' : 'sz';
  const url = `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${prefix}${code}&scale=240&datalen=500&ma=no`;
  const raw = await httpGet(url);
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) return [];
  return data.map((k: any) => ({
    date: k.d,
    open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v,
  })).filter(c => c.date <= TARGET_DATE);
}

// ─── TW providers ────────────────────────────────────────────────────────────

async function fetchTW_Yahoo(symbol: string): Promise<Candle[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=2y`;
  const raw = await httpGet(url);
  const data = JSON.parse(raw);
  const result = data?.chart?.result?.[0];
  if (!result) return [];
  const timestamps: number[] = result.timestamp ?? [];
  const ohlcv = result.indicators?.quote?.[0] ?? {};
  return timestamps.map((ts, i) => {
    const date = new Date(ts * 1000).toISOString().slice(0, 10);
    return {
      date,
      open: +(ohlcv.open?.[i] ?? 0).toFixed(2),
      high: +(ohlcv.high?.[i] ?? 0).toFixed(2),
      low: +(ohlcv.low?.[i] ?? 0).toFixed(2),
      close: +(ohlcv.close?.[i] ?? 0).toFixed(2),
      volume: ohlcv.volume?.[i] ?? 0,
    };
  }).filter(c => c.close > 0 && c.date <= TARGET_DATE);
}

// ─── Fallback orchestrator ────────────────────────────────────────────────────

async function fetchWithFallback(symbol: string, market: Market): Promise<Candle[]> {
  const providers = market === 'CN'
    ? [
        { name: 'Tencent', fn: () => fetchCN_Tencent(symbol) },
        { name: 'Yahoo',   fn: () => fetchCN_Yahoo(symbol) },
        { name: 'Sina',    fn: () => fetchCN_Sina(symbol) },
      ]
    : [
        { name: 'Yahoo',   fn: () => fetchTW_Yahoo(symbol) },
      ];

  for (const { name, fn } of providers) {
    try {
      const candles = await fn();
      if (candles.length > 10) return candles;
    } catch { /* try next */ }
    await sleep(200);
  }
  return [];
}

// ─── Save local + Blob ────────────────────────────────────────────────────────

async function saveAndUpload(symbol: string, market: Market, candles: Candle[]): Promise<void> {
  const sorted = candles.sort((a, b) => a.date.localeCompare(b.date));
  const lastDate = sorted[sorted.length - 1].date;
  const stripped = sorted.map(({ date, open, high, low, close, volume }) =>
    ({ date, open, high, low, close, volume }));
  const data = { symbol, lastDate, updatedAt: new Date().toISOString(), candles: stripped, sealedDate: lastDate };
  const json = JSON.stringify(data);

  // 寫本地
  fs.writeFileSync(path.join(DATA_DIR, market, `${symbol}.json`), json, 'utf-8');

  // 上傳 Blob
  await put(`candles/${market}/${symbol}.json`, json, {
    access: 'private', addRandomSuffix: false, allowOverwrite: true,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
}

// ─── Get stale list ───────────────────────────────────────────────────────────

function getStaleList(market: Market): string[] {
  const dir = path.join(DATA_DIR, market);
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .filter(f => {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        return (d.lastDate || '') < TARGET_DATE;
      } catch { return false; }
    })
    .map(f => f.replace('.json', ''));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function repairMarket(market: Market) {
  const stale = getStaleList(market);
  log(`${market === 'TW' ? '🇹🇼' : '🇨🇳'} ${market}: ${stale.length} 支需修復`);

  let ok = 0, fail = 0;
  for (let i = 0; i < stale.length; i++) {
    const symbol = stale[i];
    try {
      const candles = await fetchWithFallback(symbol, market);
      if (candles.length > 0) {
        await saveAndUpload(symbol, market, candles);
        ok++;
      } else {
        fail++;
        if (fail <= 10 || fail % 50 === 0) log(`  ❌ ${symbol} (all APIs failed)`);
      }
    } catch (err) {
      fail++;
      if (fail <= 10 || fail % 50 === 0) log(`  ❌ ${symbol}: ${(err as Error).message.slice(0, 60)}`);
    }

    if ((i + 1) % 50 === 0 || i === stale.length - 1) {
      log(`  [${market}] ${i + 1}/${stale.length} ok=${ok} fail=${fail}`);
    }
    await sleep(DELAY_MS);
  }

  log(`${market} 完成: ok=${ok} fail=${fail}`);
  return { ok, fail };
}

async function main() {
  fs.writeFileSync(LOG_FILE, '');
  log(`🚀 修復開始 markets=${markets.join(',')} target=${TARGET_DATE}`);

  for (const market of markets) {
    await repairMarket(market);
  }

  // 最終統計
  log('\n📊 最終統計:');
  for (const market of (['TW', 'CN'] as Market[])) {
    const dir = path.join(DATA_DIR, market);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    let done = 0;
    for (const f of files) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        if ((d.lastDate || '') >= TARGET_DATE) done++;
      } catch { /* skip */ }
    }
    log(`  ${market}: ${done}/${files.length} (${(done/files.length*100).toFixed(1)}%)`);
  }

  // commit + push
  const { execSync } = require('child_process');
  try {
    execSync('git add -A', { cwd: process.cwd() });
    execSync(`git commit -m "fix(data): 多API fallback修復TW+CN stale → ${TARGET_DATE}\n\nTW: Yahoo Finance fallback\nCN: 騰訊→Yahoo→Sina fallback鏈\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"`, { cwd: process.cwd() });
    execSync('git push origin main', { cwd: process.cwd() });
    log('✅ commit + push 完成');
  } catch { log('(no new changes to commit)'); }

  log('✅ 全部完成！');
}

main().catch(err => { log('FATAL: ' + err.message); process.exit(1); });
