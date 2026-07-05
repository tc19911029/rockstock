/**
 * 批次B 漏網-13：TW 漲停家數 breadth → regime 輸入（直播 QA#24，2026-07-05）
 *
 * ⚠️ RESEARCH-ONLY：從 L1 全市場日K算每日「漲停家數」（收盤漲幅 ≥9.5% 近似），
 * 檢定它對 ^TWII 前瞻 D5/D20 報酬有沒有 regime 資訊（分位分桶 + train/test）。
 * 有料 → 接 MarketRegimeFlag 顯示層（成數表升級另議）；無料 → 研究區關帳。
 */
import fs from 'fs';
import path from 'path';

const C = path.join(process.cwd(), 'data/candles/TW');
const FROM = '2023-01-01';
const HORIZONS = [5, 20] as const;

interface OHLC { date: string; open: number; high: number; low: number; close: number; volume: number }
function loadRaw(file: string): OHLC[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.candles ?? []);
    const norm = arr.map((c: Partial<OHLC>) => ({
      date: (c.date ?? '').slice(0, 10),
      open: +(c.open ?? 0), high: +(c.high ?? 0), low: +(c.low ?? 0),
      close: +(c.close ?? 0), volume: +(c.volume ?? 0),
    })).filter((c: OHLC) => c.date && c.close > 0);
    return norm.length >= 120 ? norm : null;
  } catch { return null; }
}

async function main() {
  const files = fs.readdirSync(C).filter(f => /^\d{4,6}\.(TW|TWO)\.json$/.test(f));
  const limitUp = new Map<string, number>();   // date → 漲停家數
  const observed = new Map<string, number>();  // date → 有效觀測檔數

  for (const f of files) {
    const cs = loadRaw(path.join(C, f));
    if (!cs) continue;
    for (let t = 1; t < cs.length; t++) {
      const d = cs[t].date;
      if (d < FROM) continue;
      observed.set(d, (observed.get(d) ?? 0) + 1);
      if (cs[t - 1].close > 0 && cs[t].close / cs[t - 1].close - 1 >= 0.095) {
        limitUp.set(d, (limitUp.get(d) ?? 0) + 1);
      }
    }
  }

  const twiiRaw = loadRaw(path.join(C, '^TWII.json'))!;
  const rows: { date: string; count: number; ma5: number; fwd: Record<number, number> }[] = [];
  for (let i = 5; i + 20 < twiiRaw.length; i++) {
    const d = twiiRaw[i].date;
    if (d < FROM) continue;
    if ((observed.get(d) ?? 0) < 500) continue;  // 覆蓋率不足的日子跳過
    const count = limitUp.get(d) ?? 0;
    let s = 0, n = 0;
    for (let k = 0; k < 5; k++) { const dd = twiiRaw[i - k]?.date; if (dd) { s += limitUp.get(dd) ?? 0; n++; } }
    const fwd: Record<number, number> = {};
    for (const h of HORIZONS) fwd[h] = (twiiRaw[i + h].close / twiiRaw[i].close - 1) * 100;
    rows.push({ date: d, count, ma5: s / Math.max(1, n), fwd });
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  console.log(`交易日 ${rows.length}（${rows[0]?.date} ~ ${rows[rows.length - 1]?.date}）`);
  const counts = rows.map(r => r.ma5).sort((a, b) => a - b);
  const q = (p: number) => counts[Math.min(counts.length - 1, Math.floor(p * counts.length))];
  const [p20, p40, p60, p80] = [q(0.2), q(0.4), q(0.6), q(0.8)];
  console.log(`漲停家數(5日均) 分位界：20%=${p20.toFixed(0)} 40%=${p40.toFixed(0)} 60%=${p60.toFixed(0)} 80%=${p80.toFixed(0)}`);
  const bucketOf = (x: number) => x < p20 ? 'Q1(最冷)' : x < p40 ? 'Q2' : x < p60 ? 'Q3' : x < p80 ? 'Q4' : 'Q5(最熱)';

  const mid = rows[Math.floor(rows.length / 2)].date;
  for (const [seg, pool] of [['train', rows.filter(r => r.date < mid)], ['test ', rows.filter(r => r.date >= mid)]] as const) {
    console.log(`\n===== [${seg}] n=${pool.length}  分界 ${mid} =====`);
    console.log('桶'.padEnd(10) + 'n'.padStart(6) + '大盤D5'.padStart(9) + '大盤D20'.padStart(9) + 'D20勝率'.padStart(9));
    for (const b of ['Q1(最冷)', 'Q2', 'Q3', 'Q4', 'Q5(最熱)']) {
      const rs = pool.filter(r => bucketOf(r.ma5) === b);
      if (rs.length < 20) { console.log(`${b.padEnd(10)}${String(rs.length).padStart(6)}  (樣本<20)`); continue; }
      const cols = HORIZONS.map(h => rs.reduce((s, r) => s + r.fwd[h], 0) / rs.length);
      const wr = rs.filter(r => r.fwd[20] > 0).length / rs.length * 100;
      console.log(`${b.padEnd(10)}${String(rs.length).padStart(6)}${cols.map(x => `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(9)).join('')}${wr.toFixed(0).padStart(8)}%`);
    }
  }
  console.log('\n判讀：train/test 分桶單調（過熱→大盤後市弱 或 冰點→反彈）→ 接 regime 顯示層；否則關帳。');
}
main().catch(e => { console.error(e); process.exit(1); });
