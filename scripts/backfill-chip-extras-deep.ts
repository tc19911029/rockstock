/**
 * 融資融券 / 借券 / 當沖 深歷史回填（FinMind Sponsor，過去1年）
 * 這些 dataset 支援範圍查詢（一股一次抓一年），補完整配方缺的「散戶/放空/當沖」拼圖。
 * 用法：npx tsx scripts/backfill-chip-extras-deep.ts [--from 2025-06-12]
 */
import { config } from 'dotenv';
import { existsSync, promises as fs } from 'fs';
import path from 'path';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

const TOKEN = process.env.FINMIND_API_TOKEN || '';
const ROOT = process.cwd();
const INST_DIR = path.join(ROOT, 'data/chips/TW/inst');
const DIRS = {
  margin: path.join(ROOT, 'data/chips/TW/margin'),
  sbl: path.join(ROOT, 'data/chips/TW/sbl'),
  daytrade: path.join(ROOT, 'data/chips/TW/daytrade'),
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fmRange(dataset: string, code: string, from: string, to: string, retry = 0): Promise<any[]> {
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=${dataset}&data_id=${code}&start_date=${from}&end_date=${to}&token=${TOKEN}`;
  try {
    const res = await fetch(url);
    const j = await res.json();
    if (j.status !== 200) {
      if (/limit|402|429|too many/i.test(String(j.msg || '')) && retry < 5) { await sleep(8000 * (retry + 1)); return fmRange(dataset, code, from, to, retry + 1); }
      return [];
    }
    return j.data || [];
  } catch (e) {
    if (retry < 3) { await sleep(2000); return fmRange(dataset, code, from, to, retry + 1); }
    return [];
  }
}

async function mergeWrite(dir: string, code: string, rows: { date: string }[]) {
  if (!rows.length) return 0;
  await fs.mkdir(dir, { recursive: true });
  let existing: any[] = [];
  try { existing = JSON.parse(await fs.readFile(path.join(dir, `${code}.json`), 'utf8')).data || []; } catch {}
  const have = new Set(existing.map((r: any) => r.date));
  const merged = [...existing, ...rows.filter(r => !have.has(r.date))].sort((a, b) => a.date.localeCompare(b.date));
  await fs.writeFile(path.join(dir, `${code}.json`),
    JSON.stringify({ symbol: code, market: 'TW', lastDate: merged[merged.length - 1]?.date, updatedAt: new Date().toISOString(), data: merged }));
  return rows.length;
}

async function pool<T>(items: T[], n: number, fn: (it: T) => Promise<void>) {
  let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

async function main() {
  const args = process.argv.slice(2);
  const from = args.includes('--from') ? args[args.indexOf('--from') + 1] : '2025-06-12';
  const to = '2026-06-12';
  const codes = (await fs.readdir(INST_DIR)).filter(f => /^\d{4}\.json$/.test(f)).map(f => f.replace('.json', ''));
  console.log(`回填融資/借券/當沖 ${from}~${to}，${codes.length} 檔`);
  let done = 0, m = 0, s = 0, dt = 0;

  await pool(codes, 3, async (code) => {
    // 融資融券
    const mr = await fmRange('TaiwanStockMarginPurchaseShortSale', code, from, to);
    m += await mergeWrite(DIRS.margin, code, mr.map((r: any) => ({
      date: r.date,
      marginBalance: r.MarginPurchaseTodayBalance,
      marginNet: r.MarginPurchaseTodayBalance - r.MarginPurchaseYesterdayBalance,
      shortBalance: r.ShortSaleTodayBalance,
      shortNet: r.ShortSaleTodayBalance - r.ShortSaleYesterdayBalance,
      marginUtilRate: r.MarginPurchaseLimit > 0 ? +((r.MarginPurchaseTodayBalance / r.MarginPurchaseLimit) * 100).toFixed(2) : 0,
    })));
    // 借券
    const sr = await fmRange('TaiwanDailyShortSaleBalances', code, from, to);
    const toLots = (v: number) => v === 0 ? 0 : Math.abs(v) < 1000 ? (v >= 0 ? 1 : -1) : Math.round(v / 1000);
    s += await mergeWrite(DIRS.sbl, code, sr.map((r: any) => ({
      date: r.date,
      lendingBalance: toLots(r.SBLShortSalesCurrentDayBalance ?? 0),
      lendingNet: toLots((r.SBLShortSalesShortSales ?? 0) - (r.SBLShortSalesReturns ?? 0)),
    })));
    // 當沖
    const dr = await fmRange('TaiwanStockDayTrading', code, from, to);
    dt += await mergeWrite(DIRS.daytrade, code, dr.map((r: any) => ({
      date: r.date,
      dayTradeLots: Math.round((r.Volume ?? 0) / 1000),
      buyValue: r.BuyAmount ?? 0,
      sellValue: r.SellAmount ?? 0,
    })));
    done++;
    if (done % 40 === 0) console.log(`[${done}/${codes.length}] 融資+${m} 借券+${s} 當沖+${dt}`);
    await sleep(100);
  });
  console.log(`完成 ${done} 檔｜融資 ${m} / 借券 ${s} / 當沖 ${dt} 筆`);
}
main().catch(e => { console.error(e); process.exit(1); });
