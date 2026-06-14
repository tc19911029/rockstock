/**
 * 「大戶偷買」長期回測（補完法人 3.5 年後跑）
 *   策略：近5日跌>3% + 法人5日集中度>8% → 隔日開盤買 → 持有5日 → 算贏大盤(^TWII)
 *   重點：①成交量單位守衛(老資料防髒) ②按「年/半年」+「大盤多空」拆開看
 *   目的：看多頭以外(2024下跌/盤整)還贏不贏 — 把「有跡象」變「可信」
 */
import { promises as fs } from 'fs';
import path from 'path';

const INST_DIR = path.join(process.cwd(), 'data/chips/TW/inst');
const CANDLE_DIR = path.join(process.cwd(), 'data/candles/TW');
const FWD = 5, DROP = -3, CONC = 8;

interface OHLC { date: string; open: number; high: number; low: number; close: number; volume: number }
interface Trade { date: string; code: string; ret: number; excess: number; mktRet: number }

function summarize(label: string, ts: Trade[]) {
  if (ts.length < 3) { console.log(`  ${label.padEnd(22)} ${ts.length} 筆(太少)`); return; }
  const n = ts.length;
  const avg = ts.reduce((s, t) => s + t.ret, 0) / n;
  const win = 100 * ts.filter(t => t.ret > 0).length / n;
  const exc = ts.reduce((s, t) => s + t.excess, 0) / n;
  const winM = 100 * ts.filter(t => t.excess > 0).length / n;
  const g = ts.filter(t => t.ret > 0).reduce((s, t) => s + t.ret, 0);
  const l = ts.filter(t => t.ret < 0).reduce((s, t) => s + Math.abs(t.ret), 0);
  const pf = l > 0 ? g / l : Infinity;
  console.log(`  ${label.padEnd(22)} ${String(n).padStart(4)}筆 | 報酬${avg>=0?'+':''}${avg.toFixed(2)}% | 勝${win.toFixed(0)}% | 超額${exc>=0?'+':''}${exc.toFixed(2)}% | 贏大盤${winM.toFixed(0)}%`);
}

async function main() {
  const files = (await fs.readdir(INST_DIR)).filter(f => f.endsWith('.json'));
  const twii: OHLC[] = JSON.parse(await fs.readFile(path.join(CANDLE_DIR, '^TWII.json'), 'utf8')).candles;
  const td = twii.map(c => c.date);
  const twIdx = (d: string): number => { let lo=0,hi=td.length-1,a=-1; while(lo<=hi){const m=(lo+hi)>>1; if(td[m]<=d){a=m;lo=m+1}else hi=m-1} return a; };

  const trades: Trade[] = [];
  let unitSkipped = 0;

  for (const f of files) {
    const code = f.replace('.json', '');
    if (!/^\d{4}$/.test(code)) continue;
    let inst: any, cdl: any;
    try {
      inst = JSON.parse(await fs.readFile(path.join(INST_DIR, f), 'utf8'));
      cdl = JSON.parse(await fs.readFile(path.join(CANDLE_DIR, `${code}.TW.json`), 'utf8'));
    } catch { continue; }
    const im = new Map<string, number>();
    for (const d of (inst.data || [])) im.set(d.date, d.total ?? 0);
    const cs: OHLC[] = (cdl.candles || []).filter((c: OHLC) => c.close > 0);
    if (cs.length < 30) continue;

    let lockUntil = -1;
    for (let t = 5; t + 1 + FWD < cs.length; t++) {
      if (!im.has(cs[t].date)) continue;
      let inst5 = 0, vol5 = 0, miss = false, unitBad = false;
      for (let k = t - 4; k <= t; k++) {
        if (!im.has(cs[k].date)) { miss = true; break; }
        const it = im.get(cs[k].date)!;
        inst5 += it; vol5 += cs[k].volume || 0;
        if (Math.abs(it) > (cs[k].volume || 0) * 1.5 && cs[k].volume > 0) unitBad = true; // 單位守衛
      }
      if (miss || vol5 <= 0) continue;
      if (unitBad) { unitSkipped++; continue; } // 老資料股÷張錯 → 跳過不污染
      const conc = inst5 / vol5 * 100;
      const dip = (cs[t].close / cs[t - 5].close - 1) * 100;
      if (!(dip < DROP && conc > CONC)) continue;
      if (t + 1 <= lockUntil) continue; // 同檔不重疊

      const entry = cs[t + 1].open;
      if (!(entry > 0)) continue;
      const exitI = Math.min(t + 1 + FWD, cs.length - 1);
      const ret = (cs[exitI].close / entry - 1) * 100;
      if (Math.abs(ret) > 50) continue;
      const e = twIdx(cs[t + 1].date), x = twIdx(cs[exitI].date);
      const mkt = (e >= 0 && x >= 0 && twii[e].close > 0) ? (twii[x].close / twii[e].close - 1) * 100 : 0;
      trades.push({ date: cs[t].date, code, ret, excess: ret - mkt, mktRet: mkt });
      lockUntil = exitI;
    }
  }

  trades.sort((a, b) => a.date.localeCompare(b.date));
  console.log('================================================');
  console.log(`「大戶偷買」長期回測  跌>${-DROP}% + 集中度>${CONC}%  進場隔日開盤持有${FWD}日`);
  console.log(`期間 ${trades[0]?.date} ~ ${trades[trades.length-1]?.date}  共 ${trades.length} 筆  (單位守衛跳過 ${unitSkipped} obs)`);
  console.log('================================================');
  summarize('全期', trades);
  console.log('\n【按半年拆】');
  const buckets: Record<string, Trade[]> = {};
  for (const t of trades) {
    const y = t.date.slice(0, 4), h = t.date.slice(5, 7) <= '06' ? 'H1' : 'H2';
    (buckets[`${y}-${h}`] ||= []).push(t);
  }
  for (const k of Object.keys(buckets).sort()) {
    const avgMkt = buckets[k].reduce((s, t) => s + t.mktRet, 0) / buckets[k].length;
    summarize(`${k} (大盤均${avgMkt>=0?'+':''}${avgMkt.toFixed(1)}%)`, buckets[k]);
  }
  console.log('\n【按時間窗對照（查 7 個月 +5% 的矛盾）】');
  summarize('近1年(>=2025-06)', trades.filter(t => t.date >= '2025-06-12'));
  summarize('近7月(>=2025-11)', trades.filter(t => t.date >= '2025-11-01'));
  summarize('原始窗(2025-11~2026-06)', trades.filter(t => t.date >= '2025-11-01' && t.date <= '2026-06-12'));

  console.log('\n【大盤多空拆】(該筆持有期大盤漲=多頭環境)');
  summarize('大盤上漲時進場', trades.filter(t => t.mktRet > 0));
  summarize('大盤下跌時進場', trades.filter(t => t.mktRet <= 0));
  console.log('\n判讀：看「大盤下跌時進場」+「2024 各半年」超額是否仍 >0、贏大盤>50%。');
}
main().catch(e => { console.error(e); process.exit(1); });
