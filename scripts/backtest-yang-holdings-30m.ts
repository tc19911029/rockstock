/**
 * 楊雲翔特殊EMA濾網法（30分K原版）回測「我的」6 檔持股，一檔一測，比較移動停利法。
 * 台股(TWD 100萬)：3006 晶豪科 / 3081 聯亞 / 6770 力積電
 * 陸股(CNY 100萬)：000988 华工科技 / 001309 德明利 / 603986 兆易创新
 * 30 分K 現抓：台股 Fugle ~3月、陸股 EastMoney ~2月（分鐘K回看上限，看多少測多少）。
 * 全倉進出、單檔獨立、期間複利；EMA23/60（=30分K的23/60根）；隔一根開盤成交。
 */
import { getFugleHistoricalMinuteCandles } from '../lib/datasource/FugleProvider';
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

// 收集「所有帳本」的持股（我的 + data/portfolios/*），去重；場外基金(.OF)無分鐘K→跳過
async function gatherHoldings() {
  const files: string[] = [
    'data/portfolio/holdings.json', 'data/portfolio/holdings-cn.json',
  ];
  const dir = 'data/portfolios';
  try {
    for (const p of await fs.readdir(dir)) {
      for (const fn of ['holdings.json', 'holdings-cn.json']) {
        const fp = path.join(dir, p, fn);
        try { await fs.access(fp); files.push(fp); } catch { /* skip */ }
      }
    }
  } catch { /* no profiles dir */ }
  const seen = new Map<string, { sym: string; name: string; mkt: 'TW' | 'CN' }>();
  for (const f of files) {
    try {
      const j = JSON.parse(await fs.readFile(path.join(process.cwd(), f), 'utf8'));
      for (const h of j.holdings ?? []) {
        if (h.status !== 'open') continue;
        if (/\.OF$/i.test(h.symbol)) continue;           // 場外基金無分鐘K
        const mkt: 'TW' | 'CN' = /\.(SS|SZ)$/i.test(h.symbol) ? 'CN' : 'TW';
        const sym = mkt === 'TW' ? h.symbol.replace(/\.(TW|TWO)$/i, '') : h.symbol;
        if (!seen.has(sym)) seen.set(sym, { sym, name: h.name, mkt });
      }
    } catch { /* skip */ }
  }
  // 我的台股存 localStorage 沒進 server 檔 → 手動補（使用者截圖確認）
  for (const [sym, name] of [['3006', '晶豪科'], ['3081', '聯亞'], ['6770', '力積電']] as const)
    if (!seen.has(sym)) seen.set(sym, { sym, name, mkt: 'TW' });
  return [...seen.values()];
}

// 騰訊代碼：滬(.SS)=shXXX、深(.SZ)=szXXX
function tencentCode(sym: string): string {
  const code = sym.replace(/\.(SS|SZ)$/i, '');
  return (/\.SS$/i.test(sym) ? 'sh' : 'sz') + code;
}
// 抓騰訊 30分K（mkline，curl --noproxy 直連 — 陸股域名不可走 ClashX 代理否則國外節點 502）
function fetchCN30m(sym: string): OHLC[] {
  const tc = tencentCode(sym);
  const url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${tc},m30,,800`;
  const out = execFileSync('curl', ['--noproxy', '*', '-s', '--max-time', '25', url], { maxBuffer: 64 * 1024 * 1024 }).toString();
  const arr: string[][] = JSON.parse(out)?.data?.[tc]?.m30 ?? [];
  return arr.map(k => ({ date: `${k[0].slice(0, 4)}-${k[0].slice(4, 6)}-${k[0].slice(6, 8)} ${k[0].slice(8, 10)}:${k[0].slice(10, 12)}`, open: +k[1], close: +k[2], high: +k[3], low: +k[4], volume: +k[5] }));
}

const CAP = 1_000_000;
const COST = { TW: 0.006, CN: 0.0013 };
interface OHLC { date: string; open: number; high: number; low: number; close: number; volume: number }
type Setting = { name: string; arm: number; mode: 'none' | 'sub' | 'mult'; gb: number };
const SETTINGS: Setting[] = [
  { name: '無移動停利(只破60/破濾網)', arm: 0, mode: 'none', gb: 0 },
  { name: '回落 5pp (啟動5%)', arm: 0.05, mode: 'sub', gb: 0.05 },
  { name: '回落 8pp (啟動5%)', arm: 0.05, mode: 'sub', gb: 0.08 },
  { name: '回落 10pp(啟動5%)', arm: 0.05, mode: 'sub', gb: 0.10 },
  { name: '回落 15pp(啟動10%)', arm: 0.10, mode: 'sub', gb: 0.15 },
  { name: '吐最大漲幅20%(啟動10%)', arm: 0.10, mode: 'mult', gb: 0.20 },
  { name: '吐最大漲幅30%(啟動10%)', arm: 0.10, mode: 'mult', gb: 0.30 },
];

function ema(vals: number[], n: number): number[] { const k = 2 / (n + 1); const out: number[] = []; let prev = NaN; for (let i = 0; i < vals.length; i++) { prev = i === 0 ? vals[0] : vals[i] * k + prev * (1 - k); out[i] = prev; } return out; }

function simulate(cs: OHLC[], e23: number[], e60: number[], st: Setting, cost: number) {
  let cash = CAP, shares = 0, inPos = false, entry = 0, peakGain = 0;
  let trades = 0, wins = 0, entryEquity = CAP;
  const last = cs.length - 1;
  for (let i = 1; i < last; i++) {
    const c = cs[i], pc = cs[i - 1];
    if (!inPos) {
      const above60 = c.close >= e60[i];
      const f3 = c.close >= e23[i] * 1.03;
      const f1x2 = c.close >= e23[i] * 1.01 && pc.close >= e23[i - 1] * 1.01;
      if (above60 && (f3 || f1x2)) {
        const px = cs[i + 1].open;
        shares = Math.floor(cash / (px * (1 + cost / 2)));
        if (shares <= 0) break;
        cash -= shares * px * (1 + cost / 2);
        entry = px; peakGain = 0; inPos = true; entryEquity = cash + shares * px;
      }
    } else {
      peakGain = Math.max(peakGain, (c.high - entry) / entry);
      const gain = (c.close - entry) / entry;
      let exit = false;
      if (st.mode === 'sub') exit = peakGain >= st.arm && gain <= peakGain - st.gb;
      else if (st.mode === 'mult') exit = peakGain >= st.arm && gain <= peakGain * (1 - st.gb);
      if (!exit && c.close < e60[i]) exit = true;
      if (!exit && (c.close <= e23[i] * 0.97 || (c.close <= e23[i] * 0.99 && pc.close <= e23[i - 1] * 0.99))) exit = true;
      if (exit) {
        cash += shares * cs[i + 1].open * (1 - cost / 2);
        trades++; if (cash > entryEquity) wins++;
        shares = 0; inPos = false;
      }
    }
  }
  const equity = cash + shares * cs[last].close * (1 - cost / 2);
  return { equity, ret: equity / CAP - 1, trades, wins };
}

type Holding = { sym: string; name: string; mkt: 'TW' | 'CN' };
async function fetch30m(h: Holding): Promise<OHLC[]> {
  if (h.mkt === 'TW') {
    const cs = await getFugleHistoricalMinuteCandles(h.sym, '30m', '3mo');
    return [...cs].sort((a, b) => a.date.localeCompare(b.date)) as OHLC[];
  }
  return [...fetchCN30m(h.sym)].sort((a, b) => a.date.localeCompare(b.date));
}

async function main() {
  const HOLDINGS = await gatherHoldings();
  console.log(`楊氏EMA濾網 30分K 回測「全帳本」持股 ${HOLDINGS.length} 檔｜各 100 萬全倉、單檔獨立、期間複利`);
  console.log(`清單：${HOLDINGS.map(h => h.sym + h.name).join('、')}\n`);
  const agg = new Map<string, { ret: number; n: number }>();
  for (const st of SETTINGS) agg.set(st.name, { ret: 0, n: 0 });

  for (const h of HOLDINGS) {
    const cur = h.mkt === 'CN' ? 'CNY' : 'TWD';
    let cs: OHLC[] = [];
    try { cs = await fetch30m(h); } catch (e) { console.log(`${h.sym} ${h.name}: 抓取失敗 ${(e as Error).message}`); continue; }
    if (cs.length < 80) { console.log(`${h.sym} ${h.name}: 30分K 只有 ${cs.length} 根，太少跳過\n`); continue; }
    const e23 = ema(cs.map(c => c.close), 23), e60 = ema(cs.map(c => c.close), 60);
    const bh = cs[cs.length - 1].close / cs[0].open - 1;
    const days = new Set(cs.map(c => c.date.slice(0, 10))).size;
    console.log(`══ ${h.sym} ${h.name}（${cur}）  30分K ${cs.length}根/${days}日  ${cs[0].date.slice(0, 10)}~${cs[cs.length - 1].date.slice(0, 10)}  買抱不動 ${(bh * 100 >= 0 ? '+' : '')}${(bh * 100).toFixed(1)}% ══`);
    const rows = SETTINGS.map(st => ({ st, r: simulate(cs, e23, e60, st, COST[h.mkt]) }));
    for (const { st, r } of rows) { const a = agg.get(st.name)!; a.ret += r.ret; a.n++; }
    rows.sort((a, b) => b.r.equity - a.r.equity);
    for (const { st, r } of rows) {
      const wr = r.trades ? `勝率 ${(r.wins / r.trades * 100).toFixed(0)}%(${r.wins}/${r.trades})` : '無交易';
      console.log(`   ${(r.ret * 100 >= 0 ? '+' : '')}${(r.ret * 100).toFixed(1)}%  期末 ${Math.round(r.equity).toLocaleString()} ${cur}  ← ${st.name} ｜${wr}`);
    }
    console.log('');
  }

  console.log('════════ 全檔平均（哪種移動停利法整體獲利最高）════════');
  [...agg.entries()].filter(([, v]) => v.n > 0).sort((a, b) => b[1].ret / b[1].n - a[1].ret / a[1].n)
    .forEach(([name, v]) => console.log(`   平均報酬 ${(v.ret / v.n * 100 >= 0 ? '+' : '')}${(v.ret / v.n * 100).toFixed(1)}%  ← ${name}`));
  console.log('\n⚠️ 只有 ~2-3 個月樣本(分鐘K回看上限)，含大盤beta，僅比較「移動停利法之間」相對優劣、非絕對賺賠。');
}
main();
