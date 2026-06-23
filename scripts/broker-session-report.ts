/**
 * 法人報告「單批」彙整 — 只輸出指定日期（預設 2026-06-22、2026-06-23），不整合歷史。
 * 依市場分組（台股 / 日股 / 歐美股 / 港股），重用 computeBrokerPerformance。
 *
 * 用法：npx tsx scripts/broker-session-report.ts [out.md] [date1 date2 ...]
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { computeBrokerPerformance } from '@/lib/broker/brokerPerformance';

const ACTION_LABEL: Record<string, string> = {
  initiate: '首評', upgrade: '升評', downgrade: '降評', maintain: '維持',
};

function ratingZh(raw: string, norm: string): string {
  if (/[一-鿿]/.test(raw || '')) return raw;
  const s = (raw || '').toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim();
  const RAW: Record<string, string> = {
    'buy': '買進', 'conviction list buy': '確信買進', 'outperform': '優於大盤',
    'overweight': '加碼', 'add': '加碼', 'accumulate': '加碼',
    'neutral': '中立', 'equal-weight': '中性', 'equalweight': '中性', 'equal weight': '中性',
    'hold': '持有', 'market perform': '中性', 'in-line': '中性',
    'underweight': '減碼', 'reduce': '減碼', 'underperform': '劣於大盤', 'sell': '賣出',
  };
  if (RAW[s]) return RAW[s];
  const NORM: Record<string, string> = {
    buy: '買進', overweight: '加碼', neutral: '中立', hold: '持有',
    underweight: '減碼', sell: '賣出', other: '—',
  };
  return NORM[norm] || '—';
}

const pct = (n: number | null | undefined): string =>
  n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
const num = (n: number | null | undefined): string =>
  n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 2 });

function marketGroup(it: { market: string; report_currency: string }): string {
  if (it.market === 'TW') return '台股';
  const c = (it.report_currency || '').toUpperCase();
  if (c === 'JPY') return '日股';
  if (c === 'HKD') return '港股';
  if (c === 'USD') return '歐美股';
  return '其他';
}
const ORDER = ['台股', '日股', '歐美股', '港股', '其他'];

async function main() {
  const args = process.argv.slice(2);
  const out = args.find(a => a.endsWith('.md')) || 'data/broker/法人報告_本批.md';
  const dates = args.filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const useDates = dates.length ? dates : ['2026-06-22', '2026-06-23'];

  const L: string[] = [];
  L.push('# 法人報告彙整（本批）');
  L.push('');
  L.push(`> 只含 **${useDates.join(' 、 ')}**（永豐法人部評等調整）。台股計報告後漲跌幅與距目標價；日／歐美／港股僅列評等不計漲跌。`);
  L.push('');

  let totalTW = 0, totalFX = 0, brokers = new Set<string>();

  for (const d of useDates) {
    const day = await computeBrokerPerformance(d);
    if (!day.items.length) continue;
    L.push(`## ${d}　（共 ${day.items.length} 筆）`);
    L.push('');

    const groups = new Map<string, typeof day.items>();
    for (const it of day.items) {
      const g = marketGroup(it);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(it);
      brokers.add(it.broker_display);
      if (it.market === 'TW') totalTW++; else totalFX++;
    }

    for (const g of ORDER) {
      const items = groups.get(g);
      if (!items || !items.length) continue;
      L.push(`### ${g}（${items.length} 筆）`);
      L.push('');
      if (g === '台股') {
        L.push('| 股票 | 券商 | 評等 | 動作 | 舊目標 | 新目標 | 報告日上漲空間 | 距現價 |');
        L.push('|---|---|---|:--:|---:|---:|---:|---:|');
        for (const it of items) {
          const name = it.stock_code ? `${it.stock_code} ${it.stock_name}` : it.stock_name;
          L.push(`| ${name} | ${it.broker_display} | ${ratingZh(it.rating_raw, it.rating)} | ${ACTION_LABEL[it.rating_action] || '—'} | ${num(it.prev_target_price)} | ${num(it.target_price)} | ${pct(it.target.upsideAtReport)} | ${pct(it.target.distanceToTargetPct)} |`);
        }
      } else {
        L.push('| 股票 | 券商 | 評等 | 動作 | 舊目標 | 新目標 | 幣別 |');
        L.push('|---|---|---|:--:|---:|---:|:--:|');
        for (const it of items) {
          L.push(`| ${it.stock_name} | ${it.broker_display} | ${ratingZh(it.rating_raw, it.rating)} | ${ACTION_LABEL[it.rating_action] || '—'} | ${num(it.prev_target_price)} | ${num(it.target_price)} | ${it.report_currency} |`);
        }
      }
      L.push('');
    }
  }

  L.push('---');
  L.push(`_本批合計：台股 ${totalTW} 筆、海外 ${totalFX} 筆、券商 ${brokers.size} 家。動作：首評/升評/降評/維持。「報告日上漲空間」＝目標價 vs 報告日收盤；「距現價」正＝還有空間。_`);

  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, L.join('\n'), 'utf-8');
  console.log(`✅ 已寫出：${out}（台股 ${totalTW}、海外 ${totalFX}、券商 ${brokers.size}）`);
}

main().catch(e => { console.error(e); process.exit(1); });
