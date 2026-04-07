/**
 * A股打板掃描 CLI
 *
 * 掃描指定日期的漲停股，輸出明天的買入候選清單。
 *
 * Usage:
 *   npx tsx scripts/scan-cn-daban.ts                    # 掃描最近交易日
 *   npx tsx scripts/scan-cn-daban.ts --date 2026-04-01  # 指定日期
 */

import { scanDabanFromCache } from '../lib/scanner/DabanScanner';
import { saveDabanSession } from '../lib/storage/dabanStorage';

const args = process.argv.slice(2);
const dateFlag = args.indexOf('--date');
const date = dateFlag >= 0 && args[dateFlag + 1] ? args[dateFlag + 1] : '';

async function main() {
  // 如果沒指定日期，用快取裡最後一個交易日
  let scanDate = date;
  if (!scanDate) {
    const fs = await import('fs');
    const path = await import('path');
    const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'backtest-candles-cn.json'), 'utf-8'));
    const firstStock = Object.values(raw.stocks as Record<string, { candles: { date: string }[] }>)[0];
    if (firstStock?.candles?.length) {
      scanDate = firstStock.candles[firstStock.candles.length - 1].date.slice(0, 10);
    }
  }

  if (!scanDate) {
    console.error('❌ 請指定日期: --date YYYY-MM-DD');
    process.exit(1);
  }

  console.log(`\n═══════════════════════════════════════════════`);
  console.log(`  A股打板掃描 — ${scanDate}`);
  console.log(`═══════════════════════════════════════════════\n`);

  const session = await scanDabanFromCache(scanDate);

  // 顯示結果
  const buyable = session.results.filter(r => !r.isYiZiBan);
  const locked = session.results.filter(r => r.isYiZiBan);

  console.log(`  漲停股: ${session.results.length} 檔`);
  console.log(`  可買入: ${buyable.length} 檔（排除一字板 ${locked.length} 檔）\n`);

  if (buyable.length > 0) {
    console.log('  ┌─ 明日買入候選清單（按排序分數）─────────────────────────────────────────┐');
    console.log('  │ 排名  代碼         名稱      收盤    漲幅    類型  成交額(萬)  量比  買入門檻  分數 │');
    console.log('  ├────────────────────────────────────────────────────────────────────────┤');

    for (let i = 0; i < Math.min(buyable.length, 20); i++) {
      const r = buyable[i];
      const turnoverWan = (r.turnover / 10000).toFixed(0);
      console.log(
        '  │ ' +
        (i + 1).toString().padStart(3) + '   ' +
        r.symbol.padEnd(12) + ' ' +
        r.name.slice(0, 6).padEnd(8) +
        r.closePrice.toFixed(2).padStart(7) + ' ' +
        ('+' + r.limitUpPct.toFixed(1) + '%').padStart(7) + ' ' +
        r.limitUpType.padEnd(4) + ' ' +
        turnoverWan.padStart(9) + ' ' +
        r.volumeRatio.toFixed(1).padStart(5) + ' ' +
        r.buyThresholdPrice.toFixed(2).padStart(8) + ' ' +
        r.rankScore.toFixed(1).padStart(5) + ' │'
      );
    }

    console.log('  └────────────────────────────────────────────────────────────────────────┘');
    console.log('\n  📋 操作方式：');
    console.log('  1. 明天 09:25 看集合競價，找高開 ≥ 買入門檻的');
    console.log('  2. 選排名最前面那檔，開盤價買入');
    console.log('  3. 止盈 +5% / 止損 -3% / 收黑隔天開盤走 / 最多持 2 天');
  }

  if (locked.length > 0) {
    console.log(`\n  ⛔ 一字板（買不到）: ${locked.length} 檔`);
    for (const r of locked.slice(0, 5)) {
      console.log(`     ${r.symbol} ${r.name.slice(0, 6)} ${r.closePrice.toFixed(2)} +${r.limitUpPct.toFixed(1)}%`);
    }
  }

  // 儲存結果
  await saveDabanSession(session);
  console.log(`\n  💾 已儲存至 data/daban-CN-${scanDate}.json`);
}

main().catch(console.error);
