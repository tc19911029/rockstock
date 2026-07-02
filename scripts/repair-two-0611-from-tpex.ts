/**
 * 修復上櫃 .TWO 某日 L1 污染 — 用 TPEx 官方日收盤行情 (wn1430) 整批覆蓋。
 *
 * 背景（2026-06-12 凌晨發現）：06-11 14:30 eod-settle 跑時 TWSE/TPEx bulk 全空
 * （bulk size=0）+ FinMind 已 402 熔斷 → 唯一 vendor Yahoo 的 OTC 殘值跟 L1 盤中
 * 殘值同源互證 → 1649 檔被標 skipped-already-correct、833 檔 .TWO 收盤與官方不符
 * （多為 O=H=L=C、volume=0 的扁平中間價殘根）。T+1 只重驗 pending，不會自癒。
 *
 * 處理：抓 TPEx wn1430（指定日、官方權威源，欄位含 OHLC+成交股數），對每檔
 * 已有該日 bar 的 .TWO：
 *   - 官方有成交（close>0）且 OHLCV 任一不符 → 官方 bar 覆蓋（單根寫，volume 股/1000=張）
 *   - 官方無成交（close 非數字）且 L1 是扁平 vol=0 殘根 → 刪該偽根、重算 lastDate
 *   - 其他不動。寫前 snap 合法檔位 + OHLC 自洽檢查。
 *
 * 用法：npx tsx scripts/repair-two-0611-from-tpex.ts [--date 2026-06-11] [--dry]
 *       [--cache /tmp/tpex-0611.json]   ← TPEx 被 Cloudflare 擋時用已抓好的 JSON
 */
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';
import { isValidTwTick, snapTwTick, isTwEtf } from '../lib/datasource/twTick';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const DATE = arg('--date', '2026-06-11');
const CACHE = arg('--cache', '');
const DRY = process.argv.includes('--dry');

interface OffRow { open: number; high: number; low: number; close: number; volume: number }

function toRocDate(date: string): string {
  const [y, m, d] = date.split('-');
  return `${parseInt(y, 10) - 1911}/${m}/${d}`;
}

const num = (s: unknown) => {
  const n = parseFloat(String(s ?? '').replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
};

async function fetchTpexDay(date: string): Promise<Map<string, OffRow>> {
  const map = new Map<string, OffRow>();
  let data: { tables?: Array<{ title?: string; date?: string; data?: string[][] }> } | null = null;
  const url = `https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php?l=zh-tw&d=${encodeURIComponent(toRocDate(date))}&se=EW`;
  for (let attempt = 1; attempt <= 3 && !data; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const text = await res.text();
      data = JSON.parse(text);
    } catch {
      console.warn(`  TPEx fetch attempt ${attempt} 失敗，等 5s 重試`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  if (!data && CACHE && existsSync(CACHE)) {
    console.warn(`  TPEx 線上抓不到 → 用 cache ${CACHE}`);
    data = JSON.parse(readFileSync(CACHE, 'utf8'));
  }
  if (!data) throw new Error('TPEx wn1430 抓取失敗且無 cache');
  const table = data.tables?.[0];
  // 防呆：feed 自帶日期必須 === 要修的日（民國格式）
  if (!table || table.date !== toRocDate(date)) {
    throw new Error(`TPEx feed 日期不符: feed=${table?.date} want=${toRocDate(date)}`);
  }
  for (const r of table.data ?? []) {
    const code = String(r[0] ?? '').trim();
    if (!/^\d{4,6}[A-Z]?$/.test(code)) continue;
    // 欄位: 0代號 1名稱 2收盤 3漲跌 4開盤 5最高 6最低 7成交股數
    map.set(code, {
      close: num(r[2]), open: num(r[4]), high: num(r[5]), low: num(r[6]),
      volume: Math.round(num(r[7]) / 1000), // 股 → 張（L1 標準）
    });
  }
  return map;
}

async function main() {
  console.log(`repair .TWO ${DATE} from TPEx 官方${DRY ? ' [DRY]' : ' ★ APPLY'}`);
  const off = await fetchTpexDay(DATE);
  console.log(`TPEx 官方列數: ${off.size}`);
  if (off.size < 500) throw new Error('官方資料異常少 — 中止');

  const dir = path.join(process.cwd(), 'data', 'candles', 'TW');
  let fixed = 0, ok = 0, deleted = 0, noFeed = 0, noTrade = 0, ohlcBad = 0;
  const fixSamples: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.TWO.json')) continue;
    const sym = f.replace('.json', '');
    const code = sym.replace('.TWO', '');
    const fp = path.join(dir, f);
    let j: { candles: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>; lastDate?: string };
    try { j = JSON.parse(readFileSync(fp, 'utf8')); } catch { continue; }
    const bar = (j.candles || []).find(c => c.date === DATE);
    if (!bar) continue;
    const row = off.get(code);
    if (!row) { noFeed++; continue; }

    const etf = isTwEtf(sym);
    const hasTrade = row.close > 0 && row.open > 0 && row.high > 0 && row.low > 0;

    if (!hasTrade) {
      // 官方該日無成交：L1 若是扁平 vol=0 殘根 → 刪偽根
      const flat = bar.volume === 0 && bar.open === bar.close && bar.high === bar.low && bar.open === bar.high;
      if (flat) {
        if (!DRY) {
          j.candles = j.candles.filter(c => c.date !== DATE);
          j.lastDate = j.candles.length ? j.candles[j.candles.length - 1].date : undefined;
          writeFileSync(fp, JSON.stringify(j));
        }
        deleted++;
        if (deleted <= 5) console.log(`  刪偽根: ${sym} ${DATE} (官方無成交, L1 扁平 vol=0 close=${bar.close})`);
      } else {
        noTrade++;
      }
      continue;
    }

    const target = {
      date: DATE,
      open: isValidTwTick(row.open, etf) ? row.open : snapTwTick(row.open, etf),
      high: isValidTwTick(row.high, etf) ? row.high : snapTwTick(row.high, etf),
      low: isValidTwTick(row.low, etf) ? row.low : snapTwTick(row.low, etf),
      close: isValidTwTick(row.close, etf) ? row.close : snapTwTick(row.close, etf),
      volume: row.volume,
    };
    const same = Math.abs(bar.close - target.close) <= 0.001 && Math.abs(bar.open - target.open) <= 0.001 &&
      Math.abs(bar.high - target.high) <= 0.001 && Math.abs(bar.low - target.low) <= 0.001 &&
      bar.volume === target.volume;
    if (same) { ok++; continue; }
    if (!(target.high >= Math.max(target.open, target.close) - 1e-9 && target.low <= Math.min(target.open, target.close) + 1e-9 && target.low <= target.high)) {
      ohlcBad++; console.warn(`  官方 OHLC 不自洽跳過: ${sym} ${JSON.stringify(target)}`); continue;
    }
    if (!DRY) {
      try { await saveLocalCandles(sym, 'TW', [target]); } catch (e) {
        console.warn(`  ${sym} 寫入失敗: ${(e as Error).message}`); continue;
      }
    }
    fixed++;
    if (fixSamples.length < 8) fixSamples.push(`${sym} C ${bar.close}→${target.close} V ${bar.volume}→${target.volume}`);
  }
  console.log('---');
  console.log(`覆蓋 ${fixed}；已正確 ${ok}；刪偽根 ${deleted}；官方無此檔 ${noFeed}；官方無成交但 L1 非扁平(未動) ${noTrade}；官方 OHLC 不自洽 ${ohlcBad}`);
  fixSamples.forEach(s => console.log('  ', s));
}

main().catch(e => { console.error(e); process.exit(1); });
