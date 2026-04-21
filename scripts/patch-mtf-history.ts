/**
 * 補跑歷史 scan session 的 MTF 欄位
 *
 * 用途：2026-04-20 MTF 從舊 4 分制重寫為「週線六條件前5 gate」，
 *       4/20 以前的 post_close session 的 mtfWeeklyPass 是舊系統算的。
 *       本腳本用現行 evaluateMultiTimeframe 重算每支股票的 MTF，
 *       只更新 mtfWeeklyPass/mtfScore，不動其他六條件欄位。
 *
 * 使用方式：
 *   cd /Users/tzu-chienhsu/Desktop/rockstock
 *   npx ts-node --project tsconfig.scripts.json scripts/patch-mtf-history.ts
 *
 * 可加 --market CN 只跑 CN（預設 TW）
 * 可加 --dry-run 只列出會改什麼，不寫入
 */

import * as fs from 'fs';
import * as path from 'path';
import { evaluateMultiTimeframe } from '../lib/analysis/multiTimeframeFilter';
import { loadLocalCandlesForDate } from '../lib/datasource/LocalCandleStore';
import { ZHU_PURE_BOOK } from '../lib/strategy/StrategyConfig';

const args = process.argv.slice(2);
const market = args.includes('--market') ? args[args.indexOf('--market') + 1] : 'TW';
const dryRun = args.includes('--dry-run');

const DATA_DIR = path.join(__dirname, '..', 'data');
const thresholds = ZHU_PURE_BOOK.thresholds;

async function patchSession(filePath: string): Promise<void> {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const session = JSON.parse(raw);

  if (!session.results || session.results.length === 0) {
    console.log(`  SKIP (empty): ${path.basename(filePath)}`);
    return;
  }

  const scanDate: string = session.date;
  let updated = 0;
  let skipped = 0;

  for (const result of session.results) {
    const symbol: string = result.symbol;
    const candles = await loadLocalCandlesForDate(symbol, market as 'TW' | 'CN', scanDate);

    if (!candles || candles.length < 20) {
      skipped++;
      continue;
    }

    const mtf = evaluateMultiTimeframe(candles, thresholds);
    const oldPass = result.mtfWeeklyPass;
    const oldScore = result.mtfScore;
    const newPass = mtf.weekly.pass;   // weeklyCore5Pass
    const newScore = mtf.totalScore;

    if (oldPass !== newPass || oldScore !== newScore) {
      if (!dryRun) {
        result.mtfWeeklyPass = newPass;
        result.mtfScore = newScore;
        result.mtfMonthlyPass = mtf.monthly.pass;
        result.mtfDetail = mtf;
      }
      console.log(`  ${symbol} ${scanDate}: pass ${oldPass}→${newPass}  score ${oldScore}→${newScore}`);
      updated++;
    }
  }

  if (updated > 0 && !dryRun) {
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
  }

  console.log(`  ${path.basename(filePath)}: ${updated} 更新, ${skipped} 缺 L1`);
}

async function main() {
  const pattern = `scan-${market}-long-daily-`;
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.startsWith(pattern) && f.endsWith('.json') && !f.includes('intraday'))
    .sort()
    .map(f => path.join(DATA_DIR, f));

  console.log(`找到 ${files.length} 個 ${market} post_close session ${dryRun ? '[DRY RUN]' : ''}`);

  for (const file of files) {
    console.log(`處理: ${path.basename(file)}`);
    await patchSession(file);
  }

  console.log('\n完成。');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
