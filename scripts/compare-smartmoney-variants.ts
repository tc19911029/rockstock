/**
 * 比較「大戶偷買」各種訊號定義，挑最強的重做策略
 *   全部：近5日跌>3% 為前提 → 隔天開盤買 → 持有5日收盤出 → 算報酬+贏大盤
 *   比較不同「籌碼確認」條件：5日集中度 / 法人連買天數 / 外資/投信連買 / 加融資退
 */
import { promises as fs } from 'fs';
import path from 'path';

const INST_DIR = path.join(process.cwd(), 'data/chips/TW/inst');
const MARGIN_DIR = path.join(process.cwd(), 'data/chips/TW/margin');
const CANDLE_DIR = path.join(process.cwd(), 'data/candles/TW');

interface OHLC { date: string; open: number; high: number; low: number; close: number; volume: number }

interface Obs {
  dip5: number; conc5: number;
  streakTotal: number; streakForeign: number; streakTrust: number;
  margin5: number | null;   // 融資餘額5日變化%（負=散戶在退）
  ret: number; excess: number;
}

function streak(arr: number[], end: number): number {
  let s = 0;
  for (let i = end; i >= 0; i--) { if (arr[i] > 0) s++; else break; }
  return s;
}

function evalFilter(label: string, obs: Obs[], pick: (o: Obs) => boolean) {
  const sub = obs.filter(pick);
  if (sub.length < 5) { console.log(`  ${label.padEnd(30)} 樣本太少(${sub.length})`); return; }
  const n = sub.length;
  const avg = sub.reduce((s, o) => s + o.ret, 0) / n;
  const win = 100 * sub.filter(o => o.ret > 0).length / n;
  const exc = sub.reduce((s, o) => s + o.excess, 0) / n;
  const winM = 100 * sub.filter(o => o.excess > 0).length / n;
  const gains = sub.filter(o => o.ret > 0).reduce((s, o) => s + o.ret, 0);
  const losses = sub.filter(o => o.ret < 0).reduce((s, o) => s + Math.abs(o.ret), 0);
  const pf = losses > 0 ? gains / losses : Infinity;
  console.log(`  ${label.padEnd(30)} ${String(n).padStart(4)}筆 | 報酬${avg>=0?'+':''}${avg.toFixed(2)}% | 勝${win.toFixed(0)}% | 超額${exc>=0?'+':''}${exc.toFixed(2)}% | 贏大盤${winM.toFixed(0)}% | PF${pf===Infinity?'∞':pf.toFixed(2)}`);
}

async function main() {
  const files = (await fs.readdir(INST_DIR)).filter(f => f.endsWith('.json'));
  const twii: OHLC[] = JSON.parse(await fs.readFile(path.join(CANDLE_DIR, '^TWII.json'), 'utf8')).candles;
  const twiiDates = twii.map(c => c.date);
  const twiiAtOrBefore = (d: string): number | null => {
    let lo = 0, hi = twiiDates.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (twiiDates[m] <= d) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans < 0 ? null : twii[ans].close;
  };

  const obs: Obs[] = [];
  let minD = '9999', maxD = '0';

  for (const f of files) {
    const code = f.replace('.json', '');
    if (!/^\d{4}$/.test(code)) continue;
    let inst: any, cdl: any, mgn: any = null;
    try {
      inst = JSON.parse(await fs.readFile(path.join(INST_DIR, f), 'utf8'));
      cdl = JSON.parse(await fs.readFile(path.join(CANDLE_DIR, `${code}.TW.json`), 'utf8'));
    } catch { continue; }
    try { mgn = JSON.parse(await fs.readFile(path.join(MARGIN_DIR, `${code}.json`), 'utf8')); } catch {}

    const idays: any[] = inst.data || [];
    const candles: OHLC[] = (cdl.candles || []).filter((c: OHLC) => c.close > 0);
    if (idays.length < 10 || candles.length < 30) continue;

    const instByDate = new Map<string, any>();
    for (const d of idays) instByDate.set(d.date, d);
    const marginByDate = new Map<string, number>();
    if (mgn) for (const d of (mgn.data || [])) marginByDate.set(d.date, d.marginBalance ?? 0);

    // 法人各序列（對齊 candle 日期，缺日=0 中斷連買）
    const totalArr = candles.map(c => instByDate.get(c.date)?.total ?? -1);
    const foreignArr = candles.map(c => instByDate.get(c.date)?.foreign ?? -1);
    const trustArr = candles.map(c => instByDate.get(c.date)?.trust ?? -1);

    for (let t = 5; t + 6 < candles.length; t++) {
      const today = candles[t].date;
      if (!instByDate.has(today)) continue;

      // 5日法人集中度
      let inst5 = 0, vol5 = 0, miss = false;
      for (let k = t - 4; k <= t; k++) {
        if (!instByDate.has(candles[k].date)) { miss = true; break; }
        inst5 += instByDate.get(candles[k].date).total ?? 0; vol5 += candles[k].volume || 0;
      }
      if (miss || vol5 <= 0) continue;
      const conc5 = inst5 / vol5 * 100;
      const dip5 = (candles[t].close / candles[t - 5].close - 1) * 100;
      if (dip5 >= -3) continue; // 只看「在跌」的

      // 融資餘額5日變化%
      let margin5: number | null = null;
      const mNow = marginByDate.get(candles[t].date), mPrev = marginByDate.get(candles[t - 5].date);
      if (mNow != null && mPrev != null && mPrev > 0) margin5 = (mNow / mPrev - 1) * 100;

      // 進場隔日開盤、持有5日
      const entry = candles[t + 1].open;
      if (!(entry > 0)) continue;
      const exit = candles[Math.min(t + 6, candles.length - 1)].close;
      const ret = (exit / entry - 1) * 100;
      if (Math.abs(ret) > 50) continue;
      const tE = twiiAtOrBefore(candles[t + 1].date), tX = twiiAtOrBefore(candles[Math.min(t + 6, candles.length - 1)].date);
      const mkt = tE && tX ? (tX / tE - 1) * 100 : 0;

      obs.push({
        dip5, conc5,
        streakTotal: streak(totalArr, t), streakForeign: streak(foreignArr, t), streakTrust: streak(trustArr, t),
        margin5, ret, excess: ret - mkt,
      });
      if (today < minD) minD = today;
      if (today > maxD) maxD = today;
    }
  }

  console.log('================================================');
  console.log('「大戶偷買」訊號比較（前提=近5日跌>3%，進場隔日開盤持有5日）');
  console.log(`期間 ${minD}~${maxD}   跌的樣本共 ${obs.length} 筆`);
  console.log('================================================');
  evalFilter('全體(只要在跌)', obs, () => true);
  console.log('--- 現行版：5日集中度 ---');
  evalFilter('集中度>8% (現行)', obs, o => o.conc5 > 8);
  console.log('--- 法人合計 連買天數 ---');
  evalFilter('連買≥2天', obs, o => o.streakTotal >= 2);
  evalFilter('連買≥3天', obs, o => o.streakTotal >= 3);
  evalFilter('連買≥4天', obs, o => o.streakTotal >= 4);
  console.log('--- 外資 / 投信 連買 ---');
  evalFilter('外資連買≥3天', obs, o => o.streakForeign >= 3);
  evalFilter('投信連買≥2天', obs, o => o.streakTrust >= 2);
  evalFilter('投信連買≥3天', obs, o => o.streakTrust >= 3);
  console.log('--- 連買 + 集中度 雙確認 ---');
  evalFilter('連買≥3 且 集中度>5%', obs, o => o.streakTotal >= 3 && o.conc5 > 5);
  evalFilter('連買≥3 且 集中度>8%', obs, o => o.streakTotal >= 3 && o.conc5 > 8);
  console.log('--- 加 融資退(散戶跑) 濾網 ---');
  evalFilter('連買≥3 且 融資5日<0', obs, o => o.streakTotal >= 3 && o.margin5 != null && o.margin5 < 0);
  evalFilter('集中度>8 且 融資5日<0', obs, o => o.conc5 > 8 && o.margin5 != null && o.margin5 < 0);
}

main().catch(e => { console.error(e); process.exit(1); });
