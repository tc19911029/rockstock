/**
 * 抓一批樣本股的歷史逐季財報（含公告日）→ 快取到 data/cn-agents/_fin-cache/{code}.json。
 * 給基本面因子回測用。可續跑（已有檔跳過）。
 *
 * 用法：npx tsx scripts/fetch-cn-fin-sample.ts
 */
import fs from 'fs';
import path from 'path';
import { fetchCnFinancials } from '@/lib/datasource/EastMoneyFinancials';

const CDIR = path.join(process.cwd(), 'data', 'candles', 'CN');
const OUT = path.join(process.cwd(), 'data', 'cn-agents', '_fin-cache');
fs.mkdirSync(OUT, { recursive: true });

const INDEX = new Set(['000001.SS', '000300.SS', '000016.SS', '000905.SS', '000852.SS', '000010.SS', '000009.SS', '000688.SS']);
const isIndex = (s: string) => INDEX.has(s) || s.startsWith('399') || s.startsWith('899');

const all = fs.readdirSync(CDIR).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')).filter((s) => !isIndex(s));
// 每 12 檔抽 1（廣度取樣，~270 檔）
const sample = all.filter((_, i) => i % 12 === 0);

async function main() {
  console.log(`樣本 ${sample.length} 檔，開始抓財報…`);
  let ok = 0, skip = 0, fail = 0;
  for (let i = 0; i < sample.length; i++) {
    const sym = sample[i];
    const code = sym.split('.')[0];
    const out = path.join(OUT, `${sym}.json`);
    if (fs.existsSync(out)) { skip++; continue; }
    try {
      const q = await fetchCnFinancials(code, 20); // 20 季 = ~5 年
      fs.writeFileSync(out, JSON.stringify({ symbol: sym, code, quarters: q, fetchedAt: new Date().toISOString() }));
      ok++;
      if (ok % 20 === 0) console.log(`  進度 ${i + 1}/${sample.length}：成功 ${ok} 跳過 ${skip} 失敗 ${fail}（最新 ${sym} ${q.length} 季）`);
    } catch (e) {
      fail++;
      console.log(`  ✗ ${sym}: ${e instanceof Error ? e.message.slice(0, 60) : e}`);
    }
  }
  console.log(`完成：成功 ${ok} 跳過 ${skip} 失敗 ${fail}`);
}
main();
