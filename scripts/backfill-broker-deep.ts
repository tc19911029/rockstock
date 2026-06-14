/**
 * 主力券商分點 深歷史回填（FinMind Sponsor，TaiwanStockTradingDailyReport）
 * 算正版籌碼集中度 =（買超前15分點 − 賣超前15分點）÷ 成交量 ×100%（徐黎芳/CMoney 公式）
 * 存進 data/chips/TW/broker/{code}.json（BrokerDay: {date, netDifference(張), concentration(%)}）
 *
 * ⚠️ FinMind 分點一次只給一天 → 一股一天一抓。可續跑(已存的日期跳過)。
 * 用法：npx tsx scripts/backfill-broker-deep.ts [--from 2024-06-12] [--top 200] [--symbols 2330,2317]
 */
import { config } from 'dotenv';
import { existsSync, promises as fs } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

// Node fetch 對 FinMind 慢(連線開銷~幾秒/req)；改 curl(實測 20並發 742ms)
function curlJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile('curl', ['-s', '--max-time', '30', url], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
  });
}

const TOKEN = process.env.FINMIND_API_TOKEN || '';
const ROOT = process.cwd();
const BROKER_DIR = path.join(ROOT, 'data/chips/TW/broker');
const INST_DIR = path.join(ROOT, 'data/chips/TW/inst');
const CANDLE_DIR = path.join(ROOT, 'data/candles/TW');
const CONC = 16; // 並行度（FinMind Sponsor 實測 20 並發 742ms 零限流）

interface BrokerDay { date: string; netDifference: number; concentration: number }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchBrokerDay(code: string, date: string, retry = 0): Promise<BrokerDay | null> {
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockTradingDailyReport&data_id=${code}&start_date=${date}&token=${TOKEN}`;
  let j: any;
  try {
    j = await curlJson(url);
  } catch (e) {
    if (retry < 3) { await sleep(2000 * (retry + 1)); return fetchBrokerDay(code, date, retry + 1); }
    throw e;
  }
  if (j.status !== 200) {
    const msg = String(j.msg || '');
    if (/upper limit|limit|402|429|too many|exceed/i.test(msg)) {
      // FinMind Sponsor 6000/hr 硬上限 → 撞到就等 ~10 分鐘讓滾動窗清，再續(不丟棄進度)
      if (retry < 30) { await sleep(10 * 60 * 1000); return fetchBrokerDay(code, date, retry + 1); }
      throw new Error('RATE_LIMIT:' + msg);
    }
    return null; // 非交易日/無資料
  }
  const rows = j.data || [];
  if (!rows.length) return null;
  const net = new Map<string, number>();
  let totalBuy = 0;
  for (const r of rows) {
    net.set(r.securities_trader_id, (net.get(r.securities_trader_id) || 0) + (r.buy - r.sell));
    totalBuy += r.buy;
  }
  if (totalBuy <= 0) return null;
  const nets = [...net.values()];
  const topBuy = nets.filter(n => n > 0).sort((a, b) => b - a).slice(0, 15).reduce((s, n) => s + n, 0);
  const topSell = -nets.filter(n => n < 0).sort((a, b) => a - b).slice(0, 15).reduce((s, n) => s + n, 0);
  return {
    date,
    netDifference: Math.round((topBuy - topSell) / 1000), // 張
    concentration: +(((topBuy - topSell) / totalBuy) * 100).toFixed(2), // 簽名集中度%
  };
}

async function readBroker(code: string): Promise<BrokerDay[]> {
  try { return (JSON.parse(await fs.readFile(path.join(BROKER_DIR, `${code}.json`), 'utf8')).data || []); } catch { return []; }
}
async function writeBroker(code: string, data: BrokerDay[]) {
  await fs.mkdir(BROKER_DIR, { recursive: true });
  data.sort((a, b) => a.date.localeCompare(b.date));
  await fs.writeFile(path.join(BROKER_DIR, `${code}.json`),
    JSON.stringify({ symbol: code, market: 'TW', lastDate: data[data.length - 1]?.date, updatedAt: new Date().toISOString(), data }));
}

async function pool<T>(items: T[], n: number, fn: (it: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k]); }
  }));
}

async function main() {
  const args = process.argv.slice(2);
  const from = args.includes('--from') ? args[args.indexOf('--from') + 1] : '2024-06-12';
  const topN = args.includes('--top') ? parseInt(args[args.indexOf('--top') + 1], 10) : 200;
  const symArg = args.includes('--symbols') ? args[args.indexOf('--symbols') + 1] : null;

  // 交易日（^TWII）
  const twii = JSON.parse(await fs.readFile(path.join(CANDLE_DIR, '^TWII.json'), 'utf8')).candles;
  const tradingDays: string[] = twii.map((c: any) => c.date).filter((d: string) => d >= from);

  // 宇宙：法人有資料的股票，按近期成交額排序取 top N
  let codes: string[];
  if (symArg) codes = symArg.split(',').map(s => s.trim());
  else {
    const all = (await fs.readdir(INST_DIR)).filter(f => /^\d{4}\.json$/.test(f)).map(f => f.replace('.json', ''));
    const scored: { code: string; to: number }[] = [];
    for (const code of all) {
      try {
        const cs = JSON.parse(await fs.readFile(path.join(CANDLE_DIR, `${code}.TW.json`), 'utf8')).candles;
        const recent = cs.slice(-20);
        const to = recent.reduce((s: number, c: any) => s + c.close * (c.volume || 0), 0) / Math.max(recent.length, 1);
        scored.push({ code, to });
      } catch {}
    }
    scored.sort((a, b) => b.to - a.to);
    codes = scored.slice(0, topN).map(s => s.code);
  }

  console.log(`分點回填：${codes.length} 檔 × ${tradingDays.length} 交易日 (${from}~)  約 ${(codes.length * tradingDays.length / 1000).toFixed(0)}k 次查詢`);
  let totalNew = 0, doneStocks = 0;
  const t0 = Date.now();

  for (const code of codes) {
    const existing = await readBroker(code);
    const have = new Set(existing.map(d => d.date));
    const missing = tradingDays.filter(d => !have.has(d));
    const fetched: BrokerDay[] = [];
    await pool(missing, CONC, async (date) => {
      try {
        const bd = await fetchBrokerDay(code, date);
        if (bd) fetched.push(bd);
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('RATE_LIMIT')) { console.error('🚫 限流，停止（已存的有效）'); process.exit(2); }
      }
    });
    if (fetched.length) { await writeBroker(code, [...existing, ...fetched]); totalNew += fetched.length; }
    doneStocks++;
    const elapsed = (Date.now() - t0) / 1000;
    if (doneStocks % 5 === 0 || doneStocks <= 3)
      console.log(`[${doneStocks}/${codes.length}] ${code} +${fetched.length}日 (累計新增 ${totalNew}, 已跑 ${(elapsed/60).toFixed(0)}分)`);
  }
  console.log(`完成 ${doneStocks} 檔，新增 ${totalNew} 筆，耗時 ${((Date.now()-t0)/60000).toFixed(0)} 分`);
}
main().catch(e => { console.error(e); process.exit(1); });
