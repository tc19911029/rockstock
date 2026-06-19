/**
 * Y軌資料齊全度稽核 — top-500 池子，最近 N 個交易日，broker(主力分點)＋inst(法人) 覆蓋率。
 * 列出每天缺幾檔、以及哪些股缺哪天，確認「資料抓齊」。
 * 用法：npx tsx scripts/audit-inststeal-data-complete.ts [--days 8]
 */
import { promises as fs } from 'fs';
import path from 'path';

const BROKER_DIR = path.join(process.cwd(), 'data/chips/TW/broker');
const INST_DIR = path.join(process.cwd(), 'data/chips/TW/inst');
const TWII = path.join(process.cwd(), 'data/candles/TW/^TWII.json');

async function loadDates(dir: string, code: string): Promise<Set<string>> {
  try {
    const j = JSON.parse(await fs.readFile(path.join(dir, `${code}.json`), 'utf8'));
    return new Set((j.data || []).map((d: { date: string }) => d.date));
  } catch { return new Set(); }
}

async function main() {
  const days = process.argv.includes('--days') ? parseInt(process.argv[process.argv.indexOf('--days') + 1], 10) : 8;
  const { readTurnoverRank } = await import('../lib/scanner/TurnoverRank');
  const rank = await readTurnoverRank('TW');
  if (!rank) { console.error('無 turnover-rank 索引'); process.exit(1); }
  const pool = Array.from(rank.symbols).map(s => s.replace(/\.(TW|TWO)$/i, ''));

  const twii = JSON.parse(await fs.readFile(TWII, 'utf8'));
  const tradingDays: string[] = (twii.candles || []).map((c: { date: string }) => c.date).slice(-days);

  // 每檔的 broker/inst 日期集合
  const brokerSets = new Map<string, Set<string>>();
  const instSets = new Map<string, Set<string>>();
  for (const code of pool) {
    brokerSets.set(code, await loadDates(BROKER_DIR, code));
    instSets.set(code, await loadDates(INST_DIR, code));
  }

  console.log(`\n池子 ${pool.length} 檔（成交額前 ${rank.topN}@${rank.date}），最近 ${days} 交易日資料齊全度：\n`);
  console.log(`日期         主力分點(broker)   法人(inst)`);
  const brokerHoles: Record<string, string[]> = {};
  const instHoles: Record<string, string[]> = {};
  for (const d of tradingDays) {
    const bMiss = pool.filter(c => !brokerSets.get(c)!.has(d));
    const iMiss = pool.filter(c => !instSets.get(c)!.has(d));
    brokerHoles[d] = bMiss;
    instHoles[d] = iMiss;
    const bPct = ((pool.length - bMiss.length) / pool.length * 100).toFixed(0);
    const iPct = ((pool.length - iMiss.length) / pool.length * 100).toFixed(0);
    console.log(`${d}   ${String(pool.length - bMiss.length).padStart(3)}/${pool.length} (${bPct}%) 缺${bMiss.length}   ${String(pool.length - iMiss.length).padStart(3)}/${pool.length} (${iPct}%) 缺${iMiss.length}`);
  }

  // 列出最近一天還缺的具體代號（最多 30 個）
  const lastD = tradingDays[tradingDays.length - 1];
  console.log(`\n最新交易日 ${lastD} 仍缺主力分點的代號（最多列30）：`);
  console.log('  ' + (brokerHoles[lastD].slice(0, 30).join(' ') || '（無，全齊）') + (brokerHoles[lastD].length > 30 ? ` …共${brokerHoles[lastD].length}` : ''));
  console.log(`最新交易日 ${lastD} 仍缺法人的代號（最多列30）：`);
  console.log('  ' + (instHoles[lastD].slice(0, 30).join(' ') || '（無，全齊）') + (instHoles[lastD].length > 30 ? ` …共${instHoles[lastD].length}` : ''));

  // 兩份都齊的天數（Y軌真正能評估的）
  console.log(`\nY軌可評估（broker∩inst 同日都有）的檔數/天：`);
  for (const d of tradingDays) {
    const both = pool.filter(c => brokerSets.get(c)!.has(d) && instSets.get(c)!.has(d)).length;
    console.log(`  ${d}: ${both}/${pool.length}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
