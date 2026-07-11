/**
 * 用楊雲翔特殊EMA濾網法，回測「我的」持股，一檔一測，比較不同移動停利法哪個獲利高。
 * 期間 2026-01-01 ~ 2026-07-11，每檔初始資金 100 萬（台股 TWD / 陸股 CNY），全倉進出、單檔獨立、期間複利。
 * ⚠️ 他原版是 30 分K，但分鐘K回看不夠半年 → 只能用日K版（唯一能覆蓋整段的方式）。
 *
 * 規則：EMA23/EMA60；進場＝站上EMA60 +（單根收盤≥EMA23×1.03 或 連兩根≥EMA23×1.01）；隔日開盤成交。
 * 出場三層擇一先到：移動停利 / 收破EMA60 / 跌破EMA23濾網(收破下方3% 或 連兩根下方1%)；隔日開盤成交。
 * 掃 7 種移動停利法比最終獲利。
 */
import { promises as fs } from 'fs';
import path from 'path';

const FROM = '2026-01-01', TO = '2026-07-11', CAP = 1_000_000;
const COST = { TW: 0.006, CN: 0.0013 };  // 來回成本

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

async function readJ(p: string): Promise<any> { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }
function ema(vals: number[], n: number): number[] { const k = 2 / (n + 1); const out: number[] = []; let prev = NaN; for (let i = 0; i < vals.length; i++) { prev = i === 0 ? vals[0] : vals[i] * k + prev * (1 - k); out[i] = prev; } return out; }

function candleDir(sym: string): 'TW' | 'CN' { return /\.(SS|SZ)$/i.test(sym) || /^\d{6}/.test(sym) ? 'CN' : 'TW'; }

function simulate(cs: OHLC[], e23: number[], e60: number[], sIdx: number, eIdx: number, st: Setting, cost: number) {
  let cash = CAP, shares = 0, inPos = false, entry = 0, peakGain = 0;
  let trades = 0, wins = 0, lastFillCash = CAP;
  for (let i = Math.max(sIdx, 1); i <= eIdx; i++) {
    const c = cs[i], pc = cs[i - 1];
    if (!inPos) {
      const above60 = c.close >= e60[i];
      const f3 = c.close >= e23[i] * 1.03;
      const f1x2 = c.close >= e23[i] * 1.01 && pc.close >= e23[i - 1] * 1.01;
      if (above60 && (f3 || f1x2)) {
        const ni = i + 1; if (ni > eIdx) break;
        const px = cs[ni].open;
        shares = Math.floor(cash / (px * (1 + cost / 2)));
        if (shares <= 0) break;
        cash -= shares * px * (1 + cost / 2);
        entry = px; peakGain = 0; inPos = true; lastFillCash = cash + shares * px;
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
        const ni = i + 1; const px = ni <= eIdx ? cs[ni].open : c.close;
        cash += shares * px * (1 - cost / 2);
        trades++; if (cash > lastFillCash) wins++;
        shares = 0; inPos = false;
      }
    }
  }
  const equity = cash + shares * cs[eIdx].close * (1 - cost / 2);
  return { equity, ret: equity / CAP - 1, trades, wins };
}

async function main() {
  const cnH = await readJ(path.join(process.cwd(), 'data/portfolio/holdings-cn.json'));
  const twH = await readJ(path.join(process.cwd(), 'data/portfolio/holdings.json'));
  const holdings = [...(cnH?.holdings ?? []), ...(twH?.holdings ?? [])].filter((h: any) => h.status === 'open');
  console.log(`「我的」持股 ${holdings.length} 檔 ｜ 期間 ${FROM} ~ ${TO} ｜ 每檔 100 萬全倉、單檔獨立\n`);

  const agg = new Map<string, { equity: number; ret: number }>();
  for (const st of SETTINGS) agg.set(st.name, { equity: 0, ret: 0 });

  for (const h of holdings) {
    const mkt = candleDir(h.symbol);
    const cur = mkt === 'CN' ? 'CNY' : 'TWD';
    const j = await readJ(path.join(process.cwd(), `data/candles/${mkt}/${h.symbol}.json`));
    const cs: OHLC[] = j?.candles;
    if (!cs || cs.length < 80) { console.log(`${h.symbol} ${h.name}: 無足夠日K，跳過`); continue; }
    const e23 = ema(cs.map(c => c.close), 23), e60 = ema(cs.map(c => c.close), 60);
    let sIdx = cs.findIndex(c => c.date >= FROM); if (sIdx < 0) sIdx = 0;
    let eIdx = cs.length - 1; for (let i = cs.length - 1; i >= 0; i--) { if (cs[i].date <= TO) { eIdx = i; break; } }
    const bh = cs[eIdx].close / cs[sIdx].open - 1; // 買抱不動基準

    console.log(`══ ${h.symbol} ${h.name}（${cur}）  買抱不動 ${(bh * 100 >= 0 ? '+' : '')}${(bh * 100).toFixed(1)}% ══`);
    const rows = SETTINGS.map(st => {
      const r = simulate(cs, e23, e60, sIdx, eIdx, st, COST[mkt]);
      const a = agg.get(st.name)!; a.equity += r.equity; a.ret += r.ret;
      return { st, r };
    });
    rows.sort((a, b) => b.r.equity - a.r.equity);
    for (const { st, r } of rows) {
      const wr = r.trades ? ` ｜勝率 ${(r.wins / r.trades * 100).toFixed(0)}%(${r.wins}/${r.trades})` : ' ｜無交易';
      console.log(`   ${(r.ret * 100 >= 0 ? '+' : '')}${(r.ret * 100).toFixed(1)}%  期末 ${Math.round(r.equity).toLocaleString()} ${cur}  ← ${st.name}${wr}`);
    }
    console.log('');
  }

  console.log('════════ 三檔加總（哪種移動停利法整體獲利最高）════════');
  const sorted = [...agg.entries()].sort((a, b) => b[1].ret - a[1].ret);
  for (const [name, v] of sorted) {
    console.log(`   平均報酬 ${(v.ret / holdings.length * 100 >= 0 ? '+' : '')}${(v.ret / holdings.length * 100).toFixed(1)}%  ← ${name}`);
  }
  console.log('\n⚠️ 日K版(非30分K原版,分鐘K回看不夠半年)；報酬含大盤beta,僅比較「移動停利法之間」相對優劣。');
}
main();
