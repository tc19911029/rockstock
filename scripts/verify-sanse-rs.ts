// 驗證三色 RS 基準修正：scanSanSe 對 .SZ 用深證成指、.SS 用上證，且與手算一致。
import { promises as fs } from 'fs';
import path from 'path';
import { scanSanSe } from '@/lib/cn-sanse/scan';
import { getLocalCandleDir } from '@/lib/datasource/LocalCandleStore';

const ASOF = '2026-05-28';
const dir = getLocalCandleDir('CN');

async function loadClose(sym: string): Promise<{ d: string; c: number }[]> {
  const j = JSON.parse(await fs.readFile(path.join(dir, `${sym}.json`), 'utf8'));
  return (j.candles || []).filter((c: any) => c.date <= ASOF).map((c: any) => ({ d: c.date, c: c.close }));
}
const MA = (a: number[], n: number, i: number) => (i + 1 < n ? NaN : a.slice(i - n + 1, i + 1).reduce((x, y) => x + y, 0) / n);

async function manualMidStrength(stockSym: string, idxSym: string): Promise<number> {
  const stk = await loadClose(stockSym);
  const idx = await loadClose(idxSym);
  const m = new Map(idx.map((x) => [x.d, x.c]));
  let last = NaN;
  const ic = stk.map((x) => { const v = m.get(x.d); if (v != null) last = v; return last; });
  const sc = stk.map((x) => x.c);
  const i = sc.length - 1;
  const stockOver = sc[i] / MA(sc, 240, i) - 1;
  const rel = ic.map((c, k) => (k + 1 < 240 ? NaN : c / MA(ic, 240, k) - 1));
  const idxRel = MA(rel, 3, i);
  return +((stockOver - idxRel) * 50).toFixed(2);
}

async function main() {
  const res = await scanSanSe({ asOfDate: ASOF });
  const recs = res.records;
  const sz = recs.filter((r) => r.symbol.endsWith('.SZ')).slice(0, 3);
  const ss = recs.filter((r) => r.symbol.endsWith('.SS')).slice(0, 3);
  console.log(`scan asOf ${ASOF}: ${recs.length} 筆共振紀錄`);

  console.log('\n=== 深市 .SZ（應 = 深證成指手算）===');
  for (const r of sz) {
    const scan = r.report.scores.midStrength;
    const mSZ = await manualMidStrength(r.symbol, '399001.SZ');
    const mSH = await manualMidStrength(r.symbol, '000001.SS');
    const ok = Math.abs(scan - mSZ) < 0.05;
    console.log(`${r.symbol} ${r.name}  scan中線強勢=${scan}  手算深證=${mSZ}  手算上證=${mSH}  ${ok ? '✅相符深證' : '❌'}`);
  }
  console.log('\n=== 滬市 .SS（應 = 上證手算，不變）===');
  for (const r of ss) {
    const scan = r.report.scores.midStrength;
    const mSH = await manualMidStrength(r.symbol, '000001.SS');
    const ok = Math.abs(scan - mSH) < 0.05;
    console.log(`${r.symbol} ${r.name}  scan中線強勢=${scan}  手算上證=${mSH}  ${ok ? '✅相符上證' : '❌'}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
