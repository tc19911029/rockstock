/**
 * 補 TW L1 內部歷史洞：2026-05-04 / 05-05 / 05-06
 *
 * 為什麼：2026-06-10 全市場稽核發現這 3 天有局部 settle/下載失敗——133 / 75 / 133 檔
 * （上市+上櫃）缺這幾根，但 TWSE 官方確認當天有交易（如 6794.TW 有 04-30→[缺05-04]→05-05
 * →[缺05-06]→05-07，孤立缺單日＝pipeline 漏寫，非停牌）。
 *
 * 與 backfill-tw-l1-date.ts 的差別：那支只補 lastDate < date 的「尾端落後」檔；本支補
 * 「中段洞」——檔案 lastDate 已是最新(06-09)、但 first..last 之間缺這幾天。
 *
 * 來源：
 *   - 上市 .TW → TWSE MI_INDEX（&date=YYYYMMDD，支援歷史）
 *   - 上櫃 .TWO → FinMind（TPEx OpenAPI 只回最新日，歷史拿不到）；402 熔斷時自動跳過、印出待補清單
 *
 * 安全：
 *   - 只補「該日在 [first,last] 之間且該檔缺、bulk/FinMind 有合法檔位值」的根
 *   - 寫前 isValidTwTick 驗檔位（沿用 .TWO 次檔位污染的教訓，寧缺勿錯）
 *   - saveLocalCandles merge-sort 插中段、不覆寫既有根（append-into-hole）
 *   - --dry 只預覽不寫
 */
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';

if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';
import { fetchJsonWithCurlFallback } from '../lib/datasource/curlFetch';
import { isValidTwTick, isTwEtf } from '../lib/datasource/twTick';

const TARGET_DATES = ['2026-05-04', '2026-05-05', '2026-05-06'];
const DRY = process.argv.includes('--dry');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface BulkOHLCV { open: number; high: number; low: number; close: number; volume: number; }

async function fetchTWSEBulkClose(dateStr: string): Promise<Map<string, BulkOHLCV>> {
  const d = dateStr.replace(/-/g, '');
  const url = `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${d}&type=ALLBUT0999`;
  const { data } = await fetchJsonWithCurlFallback<{ stat: string; tables: Array<{ data: string[][] }> }>(
    url, { timeoutMs: 30_000 },
  );
  if (data.stat !== 'OK') throw new Error(`TWSE MI_INDEX stat=${data.stat}`);
  const table = data.tables?.[8];
  if (!table?.data?.length) throw new Error('TWSE MI_INDEX table 8 missing');
  const parseNum = (s: string) => { const n = parseFloat(s.replace(/,/g, '')); return isNaN(n) ? 0 : n; };
  const map = new Map<string, BulkOHLCV>();
  for (const row of table.data) {
    const code = row[0]?.trim();
    if (!code || !/^\d{4,}[A-Z]?$/.test(code)) continue;
    const open = parseNum(row[5]), high = parseNum(row[6]), low = parseNum(row[7]), close = parseNum(row[8]);
    const volume = Math.round(parseNum(row[2]) / 1000);
    if (close > 0 && open > 0) map.set(code, { open, high, low, close, volume });
  }
  return map;
}

/** TPEx 上櫃歷史單日全市場 OHLCV（支援歷史日，免 FinMind）— se=EW 全證券不含權證 */
async function fetchTPExHistBulkClose(dateStr: string): Promise<Map<string, BulkOHLCV>> {
  const [y, m, d] = dateStr.split('-');
  const roc = `${parseInt(y, 10) - 1911}/${m}/${d}`;
  const url = `https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php?l=zh-tw&d=${roc}&se=EW`;
  const { data } = await fetchJsonWithCurlFallback<{ tables: Array<{ date?: string; data: string[][] }> }>(
    url, { timeoutMs: 30_000 },
  );
  const table = data.tables?.[0];
  if (!table?.data?.length) throw new Error('TPEx hist table empty');
  if (table.date && table.date !== roc) throw new Error(`TPEx 回傳日 ${table.date} != ${roc}（端點退回最新日）`);
  const parseNum = (s: string) => { const n = parseFloat((s || '').replace(/,/g, '')); return isNaN(n) ? 0 : n; };
  const map = new Map<string, BulkOHLCV>();
  for (const row of table.data) {
    const code = row[0]?.trim();
    if (!code || !/^\d{4,5}[A-Z]?$/.test(code)) continue;
    const close = parseNum(row[2]), open = parseNum(row[4]), high = parseNum(row[5]), low = parseNum(row[6]);
    const volume = Math.round(parseNum(row[7]) / 1000);
    if (close > 0 && open > 0) map.set(code, { open, high, low, close, volume });
  }
  return map;
}

interface FileInfo { sym: string; code: string; isOtc: boolean; dates: Set<string>; first: string; last: string; }

function loadFiles(): FileInfo[] {
  const dir = path.join(process.cwd(), 'data', 'candles', 'TW');
  const out: FileInfo[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('^')) continue;
    const sym = f.replace('.json', '');
    try {
      const j = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      const cs = j.candles || [];
      if (!cs.length) continue;
      const dates = new Set<string>(cs.map((c: { date: string }) => c.date));
      out.push({
        sym, code: sym.replace(/\.(TW|TWO)$/i, ''), isOtc: sym.endsWith('.TWO'),
        dates, first: cs[0].date, last: cs[cs.length - 1].date,
      });
    } catch { /* skip */ }
  }
  return out;
}

async function main() {
  console.log(`補 TW 內部洞 ${TARGET_DATES.join(' / ')}${DRY ? '  [DRY]' : ''}`);
  const files = loadFiles();

  // 找出每個 target date 缺、且該日在生命週期內的檔
  const need: Record<string, FileInfo[]> = {};
  for (const d of TARGET_DATES) {
    need[d] = files.filter((fi) => fi.first <= d && d <= fi.last && !fi.dates.has(d));
  }
  for (const d of TARGET_DATES) {
    const otc = need[d].filter((f) => f.isOtc).length;
    console.log(`  ${d}: 缺 ${need[d].length} 檔（上市 ${need[d].length - otc} / 上櫃 ${otc}）`);
  }

  let wroteTw = 0, wroteOtc = 0, badtick = 0, noData = 0;

  // ---- 上市：TWSE MI_INDEX bulk（歷史可）----
  for (const d of TARGET_DATES) {
    const listed = need[d].filter((f) => !f.isOtc);
    if (!listed.length) continue;
    let bulk: Map<string, BulkOHLCV>;
    try { bulk = await fetchTWSEBulkClose(d); }
    catch (e) { console.warn(`  TWSE ${d} 抓取失敗: ${(e as Error).message}`); continue; }
    console.log(`  TWSE ${d}: bulk ${bulk.size} 檔`);
    for (const fi of listed) {
      const o = bulk.get(fi.code);
      if (!o) { noData++; continue; }
      const etf = isTwEtf(fi.sym);
      if (![o.open, o.high, o.low, o.close].every((v) => isValidTwTick(v, etf))) {
        badtick++; console.warn(`    ${fi.sym} ${d} 次檔位跳過 O=${o.open} H=${o.high} L=${o.low} C=${o.close}`); continue;
      }
      if (!DRY) await saveLocalCandles(fi.sym, 'TW', [{ date: d, ...o }]);
      wroteTw++;
      if (wroteTw <= 6) console.log(`    +上市 ${fi.sym} ${d} C=${o.close} V=${o.volume}`);
    }
    await sleep(300);
  }

  // ---- 上櫃：TPEx 歷史 bulk（歷史可，免 FinMind/402）----
  for (const d of TARGET_DATES) {
    const otc = need[d].filter((f) => f.isOtc);
    if (!otc.length) continue;
    let bulk: Map<string, BulkOHLCV>;
    try { bulk = await fetchTPExHistBulkClose(d); }
    catch (e) { console.warn(`  TPEx ${d} 抓取失敗: ${(e as Error).message}`); continue; }
    console.log(`  TPEx ${d}: bulk ${bulk.size} 檔`);
    for (const fi of otc) {
      const o = bulk.get(fi.code);
      if (!o) { noData++; continue; }
      const etf = isTwEtf(fi.sym);
      if (![o.open, o.high, o.low, o.close].every((v) => isValidTwTick(v, etf))) {
        badtick++; console.warn(`    ${fi.sym} ${d} 次檔位跳過 O=${o.open} H=${o.high} L=${o.low} C=${o.close}`); continue;
      }
      if (!DRY) await saveLocalCandles(fi.sym, 'TW', [{ date: d, ...o }]);
      wroteOtc++;
      if (wroteOtc <= 6) console.log(`    +上櫃 ${fi.sym} ${d} C=${o.close} V=${o.volume}`);
    }
    await sleep(300);
  }

  console.log('---');
  console.log(`寫入：上市 ${wroteTw} 根 / 上櫃 ${wroteOtc} 根；次檔位跳過 ${badtick}；無資料(該日未交易/下市) ${noData}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
