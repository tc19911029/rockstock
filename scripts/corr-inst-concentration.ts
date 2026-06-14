/**
 * 按影片徐黎芳方法的「近似」回測
 *   她的核心：籌碼集中度 = 主力前15大淨買超 ÷ 成交量；找連續紅(正)、增幅高的股票
 *   她的招牌：股價下跌 + 主力逆勢買超 → 反彈上漲
 *
 * 主力券商集中度只有 1 週歷史 → 改用「三大法人買賣超」當近似
 *   法人集中度(代理) = 近5日法人淨買超(張) ÷ 近5日成交量(張) × 100%
 *
 * 測兩件事：
 *   A. 法人集中度高(大買超) 的股票，下週(之後5交易日)是否比集中度低(大賣超)的漲更多
 *   B. 「近5日股價跌 + 法人逆勢買超」是否真的反彈
 */
import { promises as fs } from 'fs';
import path from 'path';

const INST_DIR = path.join(process.cwd(), 'data/chips/TW/inst');
const CANDLE_DIR = path.join(process.cwd(), 'data/candles/TW');
const FWD = 5;

interface Cdl { date: string; close: number; volume: number }
interface Row { conc: number; past5: number; fwd: number }

function stats(rows: Row[], pick: (r: Row) => boolean) {
  const sub = rows.filter(pick);
  if (!sub.length) return { n: 0, avg: 0, win: 0 };
  const sum = sub.reduce((s, r) => s + r.fwd, 0);
  const win = sub.filter(r => r.fwd > 0).length;
  return { n: sub.length, avg: sum / sub.length, win: 100 * win / sub.length };
}

async function main() {
  const files = (await fs.readdir(INST_DIR)).filter(f => f.endsWith('.json'));
  const rows: Row[] = [];
  let stocksUsed = 0, minDate = '9999', maxDate = '0';

  for (const f of files) {
    const code = f.replace('.json', '');
    if (!/^\d{4}$/.test(code)) continue;
    let inst: any, cdl: any;
    try {
      inst = JSON.parse(await fs.readFile(path.join(INST_DIR, f), 'utf8'));
      cdl = JSON.parse(await fs.readFile(path.join(CANDLE_DIR, `${code}.TW.json`), 'utf8'));
    } catch { continue; }

    const idays: any[] = (inst.data || []);
    const candles: Cdl[] = (cdl.candles || []).filter((c: Cdl) => c.close > 0);
    if (idays.length < 20 || candles.length < 30) continue;

    // 法人 date -> total(張)
    const instByDate = new Map<string, number>();
    for (const d of idays) instByDate.set(d.date, d.total ?? 0);

    const dates = candles.map(c => c.date);
    let used = false;
    for (let t = 5; t + FWD < candles.length; t++) {
      const d = candles[t].date;
      // 只在「有法人資料」的日子取樣
      if (!instByDate.has(d)) continue;

      // 近5日法人淨買超 / 近5日成交量
      let inst5 = 0, vol5 = 0, miss = false;
      for (let k = t - 4; k <= t; k++) {
        const dk = candles[k].date;
        if (!instByDate.has(dk)) { miss = true; break; }
        inst5 += instByDate.get(dk)!;
        vol5 += candles[k].volume || 0;
      }
      if (miss || vol5 <= 0) continue;

      const conc = inst5 / vol5 * 100;
      const past5 = (candles[t].close / candles[t - 5].close - 1) * 100;
      const fwd = (candles[t + FWD].close / candles[t].close - 1) * 100;
      if (Math.abs(past5) > 40 || Math.abs(fwd) > 40) continue;

      rows.push({ conc, past5, fwd });
      used = true;
      if (d < minDate) minDate = d;
      if (d > maxDate) maxDate = d;
    }
    if (used) stocksUsed++;
  }

  console.log('================================================');
  console.log('按影片方法(近似)：法人集中度 → 下週股價');
  console.log('================================================');
  console.log(`股票: ${stocksUsed} 檔   觀測: ${rows.length.toLocaleString()} 筆   期間: ${minDate} ~ ${maxDate}`);
  console.log(`下週 = 之後 ${FWD} 個交易日   集中度 = 近5日法人淨買超 ÷ 近5日量`);
  console.log('');

  // ── 測 A：依集中度五等分，看下週漲幅是否單調遞增 ──
  const sorted = [...rows].sort((a, b) => a.conc - b.conc);
  const q = Math.floor(sorted.length / 5);
  console.log('【測A】依法人集中度由低(大賣超)到高(大買超)分5組，看下週平均漲幅：');
  for (let i = 0; i < 5; i++) {
    const seg = sorted.slice(i * q, i === 4 ? sorted.length : (i + 1) * q);
    const avg = seg.reduce((s, r) => s + r.fwd, 0) / seg.length;
    const win = 100 * seg.filter(r => r.fwd > 0).length / seg.length;
    const loC = seg[0].conc, hiC = seg[seg.length - 1].conc;
    const label = ['Q1 大賣超', 'Q2', 'Q3 中性', 'Q4', 'Q5 大買超'][i];
    console.log(`  ${label.padEnd(9)} 集中度[${loC.toFixed(1)}~${hiC.toFixed(1)}%] | 下週 ${avg>=0?'+':''}${avg.toFixed(2)}% | 漲${win.toFixed(0)}%`);
  }
  console.log('  → 若 Q5 明顯 > Q1，她「買超→漲」成立');
  console.log('');

  // ── 測 B：她的招牌「下跌 + 逆勢買超」 ──
  console.log('【測B】她的招牌：近5日股價下跌 + 法人逆勢買超 → 是否反彈：');
  const all = stats(rows, () => true);
  console.log(`  全體基準              : ${all.n.toLocaleString().padStart(6)} 筆 | 下週 ${all.avg>=0?'+':''}${all.avg.toFixed(2)}% | 漲${all.win.toFixed(0)}%`);
  const downBuy = stats(rows, r => r.past5 < -3 && r.conc > 1);
  console.log(`  跌>3% + 法人買超(>1%) : ${downBuy.n.toLocaleString().padStart(6)} 筆 | 下週 ${downBuy.avg>=0?'+':''}${downBuy.avg.toFixed(2)}% | 漲${downBuy.win.toFixed(0)}%`);
  const downSell = stats(rows, r => r.past5 < -3 && r.conc < 0);
  console.log(`  跌>3% + 法人賣超(<0)  : ${downSell.n.toLocaleString().padStart(6)} 筆 | 下週 ${downSell.avg>=0?'+':''}${downSell.avg.toFixed(2)}% | 漲${downSell.win.toFixed(0)}%`);
  const upBuy = stats(rows, r => r.past5 > 3 && r.conc > 1);
  console.log(`  漲>3% + 法人買超(>1%) : ${upBuy.n.toLocaleString().padStart(6)} 筆 | 下週 ${upBuy.avg>=0?'+':''}${upBuy.avg.toFixed(2)}% | 漲${upBuy.win.toFixed(0)}%`);
  console.log('  → 若「跌+買超」> 全體基準且 > 「跌+賣超」，她的招牌成立');
}

main().catch(e => { console.error(e); process.exit(1); });
