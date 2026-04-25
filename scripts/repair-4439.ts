/**
 * 補抓 4439.TW 04-22 ~ 04-24 三天 K 線
 * 多 provider fallback：Fugle → Yahoo → FinMind → TWSE OHLCV
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { promises as fs } from 'fs';
import path from 'path';

const SYMBOL = '4439.TW';
const FILE = path.join('data', 'candles', 'TW', `${SYMBOL}.json`);

interface Candle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function fetchYahoo(): Promise<Candle[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${SYMBOL}?range=1mo&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const j = await res.json();
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error('Yahoo empty');
  const ts: number[] = r.timestamp ?? [];
  const q = r.indicators?.quote?.[0];
  if (!q) throw new Error('Yahoo no quote');
  const out: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const d = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    if (q.open[i] == null || q.close[i] == null) continue;
    out.push({
      date: d,
      open: q.open[i], high: q.high[i], low: q.low[i],
      close: q.close[i], volume: q.volume[i] ?? 0,
    });
  }
  return out;
}

async function fetchTWSE(yyyymm: string): Promise<Candle[]> {
  // TWSE STOCK_DAY: monthly OHLCV
  const code = SYMBOL.replace('.TW', '');
  const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${yyyymm}01&stockNo=${code}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`TWSE HTTP ${res.status}`);
  const j = await res.json();
  if (j.stat !== 'OK' || !j.data) throw new Error(`TWSE: ${j.stat}`);
  const out: Candle[] = [];
  for (const row of j.data as string[][]) {
    // row: [日期, 成交股數, 成交金額, 開盤價, 最高價, 最低價, 收盤價, 漲跌價差, 成交筆數]
    const [rocDate, vol, , o, h, l, c] = row;
    const [y, m, d] = rocDate.split('/');
    const date = `${parseInt(y, 10) + 1911}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    out.push({
      date,
      open: parseFloat(o.replace(/,/g, '')),
      high: parseFloat(h.replace(/,/g, '')),
      low: parseFloat(l.replace(/,/g, '')),
      close: parseFloat(c.replace(/,/g, '')),
      volume: Math.round(parseFloat(vol.replace(/,/g, '')) / 1000),
    });
  }
  return out;
}

async function main() {
  const raw = JSON.parse(await fs.readFile(FILE, 'utf8'));
  const existing: Candle[] = raw.candles;
  const lastDate = existing[existing.length - 1].date;
  console.log(`📂 L1 最新: ${lastDate}, 共 ${existing.length} 根`);

  const target = ['2026-04-22', '2026-04-23', '2026-04-24'];
  console.log(`🎯 目標補抓: ${target.join(', ')}`);

  // Try Yahoo first
  let fetched: Candle[] = [];
  try {
    fetched = await fetchYahoo();
    console.log(`✅ Yahoo 取得 ${fetched.length} 根 (${fetched[0]?.date} ~ ${fetched[fetched.length - 1]?.date})`);
  } catch (err) {
    console.warn(`⚠️  Yahoo 失敗: ${err instanceof Error ? err.message : err}`);
  }

  // Fallback to TWSE if Yahoo missed any target dates
  const got = new Set(fetched.map(c => c.date));
  if (!target.every(d => got.has(d))) {
    console.log('🔄 Yahoo 沒拿齊，嘗試 TWSE...');
    try {
      const twse = await fetchTWSE('202604');
      console.log(`✅ TWSE 取得 ${twse.length} 根`);
      // Merge unique
      const merged = new Map<string, Candle>();
      for (const c of fetched) merged.set(c.date, c);
      for (const c of twse) if (!merged.has(c.date)) merged.set(c.date, c);
      fetched = Array.from(merged.values()).sort((a, b) => a.date.localeCompare(b.date));
    } catch (err) {
      console.warn(`⚠️  TWSE 失敗: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Filter to target dates only
  const newCandles = fetched.filter(c => target.includes(c.date) && c.close > 0);
  console.log(`📥 命中目標: ${newCandles.length}/${target.length}`);
  for (const c of newCandles) {
    console.log(`   ${c.date}  O:${c.open}  H:${c.high}  L:${c.low}  C:${c.close}  V:${c.volume}`);
  }

  if (newCandles.length === 0) {
    console.log('❌ 沒抓到任何目標日資料，可能 4/22~24 真的停牌');
    return;
  }

  // Merge into existing (keep existing dates, append new)
  const seen = new Set(existing.map(c => c.date));
  const toAppend = newCandles.filter(c => !seen.has(c.date));
  const updated = [...existing, ...toAppend].sort((a, b) => a.date.localeCompare(b.date));

  raw.candles = updated;
  raw.lastDate = updated[updated.length - 1].date;
  raw.updatedAt = new Date().toISOString();
  raw.sealedDate = updated[updated.length - 1].date;

  await fs.writeFile(FILE, JSON.stringify(raw), 'utf8');
  console.log(`\n✅ 寫入完成: ${existing.length} → ${updated.length} 根, lastDate=${raw.lastDate}`);
}

main().catch(err => {
  console.error('❌ 失敗:', err);
  process.exit(1);
});
