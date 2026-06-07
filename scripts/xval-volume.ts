// 交叉驗證成交量（張）：每個市場用「兩份獨立的官方交易所報表」對拍
//   上市 .TW : ① MI_INDEX(市場別·當日全市場) ② STOCK_DAY(個股別·當月逐日)  ← 不同報表路徑
//   上櫃 .TWO: ① afterTrading/otc(市場別·當日全市場) ② tradingStock(個股別·當月，成交仟股=張)
//   (Yahoo/FinMind/Stooq 此刻都被限流/擋 JS，故用兩份官方報表互拍 = 最強證據)
import { config } from 'dotenv';
config({ path: '.env.local' });
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const pexec = promisify(execFile);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
const num = (s: unknown) => { const n = parseFloat(String(s ?? '').replace(/,/g, '')); return isNaN(n) ? 0 : n; };
const lots = (shares: number) => Math.round(shares / 1000);
const rocFull = (d: string) => `${+d.slice(0, 4) - 1911}/${d.slice(5, 7)}/${d.slice(8)}`;

async function curlJson(url: string): Promise<any | null> {
  for (let a = 0; a < 2; a++) { try { const { stdout } = await pexec('curl', ['-s', '--max-time', '30', '-A', UA, url], { maxBuffer: 64 * 1024 * 1024 }); return JSON.parse(stdout); } catch { /* retry */ } }
  return null;
}
async function miIndex(d: string, code: string) {
  const j = await curlJson(`https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${d.replace(/-/g, '')}&type=ALLBUT0999`);
  const r = j?.tables?.[8]?.data?.find((x: string[]) => x[0]?.trim() === code); return r ? lots(num(r[2])) : null;
}
async function twseStockDay(d: string, code: string) {
  const j = await curlJson(`https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${d.replace(/-/g, '').slice(0, 6)}01&stockNo=${code}`);
  const r = j?.data?.find((x: string[]) => x[0]?.trim() === rocFull(d)); return r ? lots(num(r[1])) : null;
}
async function tpexHist(d: string, code: string) {
  const j = await curlJson(`https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=${d.replace(/-/g, '/')}&type=EW&response=json`);
  const t = j?.tables?.[0]; if (!t?.fields) return null;
  const vi = t.fields.findIndex((f: string) => f.trim() === '成交股數');
  const r = t.data?.find((x: string[]) => x[0]?.trim() === code); return r && vi >= 0 ? lots(num(r[vi])) : null;
}
async function tpexTradingStock(d: string, code: string) {
  const j = await curlJson(`https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${code}&date=${d.replace(/-/g, '/')}&response=json`);
  const r = j?.tables?.[0]?.data?.find((x: string[]) => String(x[0]).trim() === rocFull(d));
  return r ? Math.round(num(r[1])) : null;   // 成交仟股 = 張
}

async function main() {
  const sample = [
    { code: '2330', mkt: 'TW' }, { code: '2317', mkt: 'TW' },
    { code: '6104', mkt: 'TWO' }, { code: '8932', mkt: 'TWO' }, { code: '3086', mkt: 'TWO' },
  ];
  const dates = ['2026-06-05', '2026-05-20', '2024-04-16'];
  let allAgree = true;
  for (const s of sample) {
    console.log(`\n=== ${s.code}.${s.mkt} (${s.mkt === 'TW' ? '上市' : '上櫃'}) 成交量(張) — 兩份官方報表對拍 ===`);
    console.log('date         報表A        報表B        一致?');
    for (const d of dates) {
      const a = s.mkt === 'TW' ? await miIndex(d, s.code) : await tpexHist(d, s.code);
      const b = s.mkt === 'TW' ? await twseStockDay(d, s.code) : await tpexTradingStock(d, s.code);
      const ok = a != null && b != null && Math.abs(a - b) / Math.max(a, b, 1) <= 0.01;
      if (a != null && b != null && !ok) allAgree = false;
      console.log(`${d}  ${String(a ?? '—').padEnd(11)} ${String(b ?? '—').padEnd(11)} ${a == null || b == null ? '?(缺)' : ok ? '✅ 一致' : '❌ 差異'}`);
    }
  }
  console.log(`\n總結：${allAgree ? '✅ 所有有資料的點，兩份官方報表都一致 → 修復源值可信' : '❌ 有差異點，需查'}`);
}
main();
