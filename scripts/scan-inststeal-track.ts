/**
 * 法人偷買(原)軌（Y）掃描驅動 — 對某日跑 scanner.scanInstSteal → injectForwardPerf(d1..d20)
 * → saveScanSession(buyMethod='Y', step1Filter='bypassed')。本地 launchd / 手動回填用。
 *
 * 用法：
 *   npx tsx scripts/scan-inststeal-track.ts --date 2026-06-12
 *   npx tsx scripts/scan-inststeal-track.ts --from 2026-05-14 --to 2026-06-12   # 回填
 *   npx tsx scripts/scan-inststeal-track.ts --days 40
 *
 * 僅 TW；池子＝同時有「主力分點 broker」+「三大法人 inst」資料的股票。
 */
import { promises as fs } from 'fs';
import path from 'path';
import { config } from 'dotenv';

// 讀 .env.local（launchd 用 npx tsx 不會自動載）→ INSTSTEAL_NO_FINMIND / FINMIND_API_TOKEN 生效
config({ path: '.env.local' });

const TWII = path.join(process.cwd(), 'data/candles/TW/^TWII.json');

async function tradingDays(n: number, upto?: string): Promise<string[]> {
  const j = JSON.parse(await fs.readFile(TWII, 'utf8'));
  let dates: string[] = (j.candles || []).map((c: { date: string }) => c.date);
  if (upto) dates = dates.filter(d => d <= upto);
  return dates.slice(-n);
}

async function main() {
  const args = process.argv.slice(2);
  const dateArg = args.includes('--date') ? args[args.indexOf('--date') + 1] : null;
  const daysArg = args.includes('--days') ? parseInt(args[args.indexOf('--days') + 1], 10) : null;
  const fromArg = args.includes('--from') ? args[args.indexOf('--from') + 1] : null;
  const toArg = args.includes('--to') ? args[args.indexOf('--to') + 1] : null;

  let dates: string[];
  if (dateArg) dates = [dateArg];
  else if (fromArg || toArg) {
    const all = await tradingDays(100000, toArg ?? undefined);
    dates = all.filter(d => (!fromArg || d >= fromArg) && (!toArg || d <= toArg));
  } else if (daysArg) dates = await tradingDays(daysArg);
  else dates = await tradingDays(1);

  const { runInstStealTrack } = await import('../lib/scanner/instStealTrack');

  for (const date of dates) {
    try {
      const out = await runInstStealTrack(date);
      console.log(`✅ ${date}: 母體 ${out.universe}，命中 ${out.resultCount} 檔` +
        (out.results.length ? ` — ${out.results.slice(0, 5).map(r => `${r.symbol.split('.')[0]}(連買${r.instStealConsec}天)`).join(' ')}` : ''));
    } catch (e) {
      console.error(`❌ ${date}:`, e instanceof Error ? e.message : e);
    }
  }
  console.log('完成');
}

main().catch(e => { console.error(e); process.exit(1); });
