/**
 * TW 近窗孤立缺日修復（2026-06-12）— 官方真相驅動。
 *
 * 輸入：/tmp/gaps-TW.json（{symbol: [dates...]}，由缺口偵測產生）
 * 對每個缺日抓官方 bulk（上市 MI_INDEX / 上櫃 wn1430，逐日一次 curl + cache）：
 *   - 官方該日有成交 → 插入官方 OHLCV bar（股→張）
 *   - 官方無此檔或無成交（'----'）→ 合法缺口（薄量股當日真的沒成交），跳過並記錄
 * 6945.TWO 實案：06-04 131 → 06-08 104 被誤讀 -20.6%，其實是缺 06-05（兩日各跌停）。
 *
 * 用法：npx tsx scripts/repair-tw-missing-days.ts [--dry] [--gaps /tmp/gaps-TW.json]
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';
import { isValidTwTick, snapTwTick, isTwEtf } from '../lib/datasource/twTick';

const exec = promisify(execFile);
const DRY = process.argv.includes('--dry');
const gi = process.argv.indexOf('--gaps');
const GAPS_FILE = gi >= 0 ? process.argv[gi + 1] : '/tmp/gaps-TW.json';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

interface OffRow { open: number; high: number; low: number; close: number; volume: number }
const num = (s: unknown) => { const n = parseFloat(String(s ?? '').replace(/,/g, '')); return isNaN(n) ? 0 : n; };

const tpexCache = new Map<string, Map<string, OffRow>>();
const twseCache = new Map<string, Map<string, OffRow>>();

async function curlJson(url: string, referer?: string): Promise<unknown> {
  const args = ['-s', '-4', '--max-time', '30', '-H', `User-Agent: ${UA}`];
  if (referer) args.push('-H', `Referer: ${referer}`);
  args.push(url);
  for (let a = 1; a <= 3; a++) {
    try {
      const { stdout } = await exec('curl', args, { encoding: 'utf-8', maxBuffer: 60 * 1024 * 1024 });
      return JSON.parse(stdout);
    } catch { await new Promise(r => setTimeout(r, 8000)); }
  }
  return null;
}

async function tpexDay(date: string): Promise<Map<string, OffRow>> {
  if (tpexCache.has(date)) return tpexCache.get(date)!;
  const map = new Map<string, OffRow>();
  const roc = `${parseInt(date.slice(0, 4)) - 1911}/${date.slice(5, 7)}/${date.slice(8, 10)}`;
  const j = await curlJson(
    `https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php?l=zh-tw&d=${encodeURIComponent(roc)}&se=EW`,
    'https://www.tpex.org.tw/zh-tw/mainboard/trading/info/stock-pricing.html',
  ) as { tables?: Array<{ date?: string; data?: string[][] }> } | null;
  const t = j?.tables?.[0];
  if (t && t.date === roc) {
    for (const r of t.data ?? []) {
      const code = String(r[0] ?? '').trim();
      if (!/^\d{4,6}[A-Z]?$/.test(code)) continue;
      map.set(code, { close: num(r[2]), open: num(r[4]), high: num(r[5]), low: num(r[6]), volume: Math.round(num(r[7]) / 1000) });
    }
  }
  tpexCache.set(date, map);
  await new Promise(r => setTimeout(r, 20_000)); // TPEx Cloudflare 限流，逐日間隔
  return map;
}

async function twseDay(date: string): Promise<Map<string, OffRow>> {
  if (twseCache.has(date)) return twseCache.get(date)!;
  const map = new Map<string, OffRow>();
  const j = await curlJson(
    `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${date.replace(/-/g, '')}&type=ALLBUT0999`,
  ) as { stat?: string; tables?: Array<{ data?: string[][] }> } | null;
  const t = j?.stat === 'OK' ? j.tables?.[8] : null;
  for (const r of t?.data ?? []) {
    const code = String(r[0] ?? '').trim();
    if (!/^\d{4,}[A-Z]?$/.test(code)) continue;
    map.set(code, { open: num(r[5]), high: num(r[6]), low: num(r[7]), close: num(r[8]), volume: Math.round(num(r[2]) / 1000) });
  }
  twseCache.set(date, map);
  await new Promise(r => setTimeout(r, 5_000));
  return map;
}

async function main() {
  const gaps = JSON.parse(readFileSync(GAPS_FILE, 'utf8')) as Record<string, string[]>;
  let inserted = 0, legitNoTrade = 0, noOfficial = 0;
  for (const [sym, dates] of Object.entries(gaps)) {
    const isTwo = sym.endsWith('.TWO');
    const code = sym.replace(/\.(TW|TWO)$/, '');
    const etf = isTwEtf(sym);
    for (const d of dates) {
      const map = isTwo ? await tpexDay(d) : await twseDay(d);
      const row = map.get(code);
      if (!row) { noOfficial++; continue; }
      const hasTrade = row.close > 0 && row.open > 0 && row.high > 0 && row.low > 0;
      if (!hasTrade) { legitNoTrade++; continue; }
      const bar = {
        date: d,
        open: isValidTwTick(row.open, etf) ? row.open : snapTwTick(row.open, etf),
        high: isValidTwTick(row.high, etf) ? row.high : snapTwTick(row.high, etf),
        low: isValidTwTick(row.low, etf) ? row.low : snapTwTick(row.low, etf),
        close: isValidTwTick(row.close, etf) ? row.close : snapTwTick(row.close, etf),
        volume: row.volume,
      };
      if (!(bar.high >= Math.max(bar.open, bar.close) - 1e-9 && bar.low <= Math.min(bar.open, bar.close) + 1e-9)) continue;
      console.log(`  ${DRY ? '[DRY] ' : ''}補 ${sym} ${d} O${bar.open} H${bar.high} L${bar.low} C${bar.close} V${bar.volume}`);
      if (!DRY) await saveLocalCandles(sym, 'TW', [bar]);
      inserted++;
    }
  }
  console.log(`完成：補 ${inserted} 根；官方無成交(合法缺) ${legitNoTrade}；官方名單無此檔 ${noOfficial}`);
}

main().catch(e => { console.error(e); process.exit(1); });
