/**
 * CH5-02 書本硬篩 vs 成交額 top500 宇宙對照（裁決項回測，2026-07-05）
 *
 * 書本「特別報價選股法」硬篩：昨量 <500 張淘汰、價 <5 元淘汰（全市場其餘保留）。
 * 現行近似：成交額 top500（BOOK_UNIVERSE_TOP_N）。疑慮＝低價高量股會漏網。
 *
 * 對每個交易日把 L1 全部股票分三組：
 *   A∩B：top500 且過書本篩（兩者都收）
 *   B\A：過書本篩但不在 top500（現行「漏網」— 爭點）
 *   A\B：top500 但書本會淘汰（低價 or 低量 — 書本會丟掉的現行池成員）
 * 看各組 D20 前瞻超額（減同日全體平均，去 beta）與「未來大漲股」(D20 ≥ +20%) 捕獲率。
 *
 * 裁決標準：B\A 若超額顯著為正或含大量未來大漲股 → 改書本硬篩有理；
 * 反之（B\A 是垃圾堆）→ 維持 top500。train/test 對半。
 */
import { promises as fs } from 'fs';
import path from 'path';

const C = path.join(process.cwd(), 'data/candles/TW');
const FROM = '2024-07-01';
const TOP_N = 500;
const MIN_VOL_LOT = 500;  // 書本：昨量 <500 張淘汰
const MIN_PRICE = 5;      // 書本：價 <5 元淘汰

interface OHLC { date: string; open: number; high: number; low: number; close: number; volume: number }
async function readJ(p: string) { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }

interface Row { code: string; turnover: number; passBook: boolean; fwd20: number }

async function main() {
  const files = (await fs.readdir(C)).filter(f => /^\d{4}\.(TW|TWO)\.json$/.test(f));
  // byDate: date → rows
  const byDate = new Map<string, Row[]>();

  for (const f of files) {
    if (f.startsWith('00')) continue; // ETF 不進選股宇宙
    const code = f.replace(/\.json$/, '');
    const cdl = await readJ(path.join(C, f)); if (!cdl) continue;
    const cs: OHLC[] = (cdl.candles || []).filter((c: OHLC) => c.close > 0);
    if (cs.length < 60) continue;
    for (let t = 1; t + 20 < cs.length; t++) {
      if (cs[t].date < FROM) continue;
      const turnover = cs[t].close * (cs[t].volume || 0) * 1000; // TW L1 volume 單位=張
      const passBook = (cs[t].volume || 0) >= MIN_VOL_LOT && cs[t].close >= MIN_PRICE;
      const fwd20 = (cs[t + 20].close / cs[t].close - 1) * 100;
      const arr = byDate.get(cs[t].date) ?? [];
      arr.push({ code, turnover, passBook, fwd20 });
      byDate.set(cs[t].date, arr);
    }
  }

  const dates = [...byDate.keys()].sort();
  console.log(`交易日 ${dates.length}（${dates[0]} ~ ${dates[dates.length - 1]}），L1 檔數 ${files.length}`);
  const mid = dates[Math.floor(dates.length / 2)];

  type Acc = { n: number; sumEx: number; winners: number; sizeSum: number; days: number };
  const mk = (): Acc => ({ n: 0, sumEx: 0, winners: 0, sizeSum: 0, days: 0 });

  for (const [name, ds] of [['train（前半）', dates.filter(d => d < mid)], ['test（後半）', dates.filter(d => d >= mid)]] as const) {
    const groups: Record<string, Acc> = { 'A∩B(都收)': mk(), 'B\\A(書本收/topN漏)': mk(), 'A\\B(topN收/書本淘汰)': mk() };
    let winnersTotal = 0;
    const winnersIn: Record<string, number> = { 'A∩B(都收)': 0, 'B\\A(書本收/topN漏)': 0, 'A\\B(topN收/書本淘汰)': 0, '兩者都不收': 0 };

    for (const d of ds) {
      const rows = byDate.get(d)!;
      const mean = rows.reduce((s, r) => s + r.fwd20, 0) / rows.length;
      const sorted = [...rows].sort((a, b) => b.turnover - a.turnover);
      const inTop = new Set(sorted.slice(0, TOP_N).map(r => r.code));
      for (const r of rows) {
        const isWinner = r.fwd20 >= 20;
        if (isWinner) winnersTotal++;
        const g = inTop.has(r.code)
          ? (r.passBook ? 'A∩B(都收)' : 'A\\B(topN收/書本淘汰)')
          : (r.passBook ? 'B\\A(書本收/topN漏)' : null);
        if (isWinner) winnersIn[g ?? '兩者都不收']++;
        if (!g) continue;
        const acc = groups[g];
        acc.n++; acc.sumEx += r.fwd20 - mean;
        if (isWinner) acc.winners++;
      }
      for (const g of Object.keys(groups)) groups[g].days++;
    }

    console.log(`\n===== ${name}  交易日 ${ds.length}  分界 ${mid} =====`);
    console.log('組                        日均檔數   D20超額(去beta)  未來+20%大漲股占比(組內)');
    for (const [g, a] of Object.entries(groups)) {
      if (a.n === 0) continue;
      console.log(
        `${g.padEnd(20)} ${(a.n / ds.length).toFixed(0).padStart(8)}  ` +
        `${(a.sumEx / a.n >= 0 ? '+' : '')}${(a.sumEx / a.n).toFixed(2)}%`.padStart(12) +
        `  ${(a.winners / a.n * 100).toFixed(1)}%`.padStart(10),
      );
    }
    console.log(`未來大漲股（D20≥+20%）分佈：${Object.entries(winnersIn).map(([g, n]) => `${g} ${(n / Math.max(1, winnersTotal) * 100).toFixed(0)}%`).join('｜')}（共 ${winnersTotal} 檔次）`);
  }
  console.log('\n判讀：B\\A（書本會收、現行漏掉）若超額為正/大漲股占比高 → 改硬篩有理；為負 → 維持 top500。');
}
main().catch(e => { console.error(e); process.exit(1); });
