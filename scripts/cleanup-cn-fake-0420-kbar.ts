/**
 * 清掉 CN L1 中「lastDate=2026-04-20 但 CN 今天還沒收盤」的假 K 棒
 * 成因：repair-cn-0415-batch.ts 的 fetchCandles 抓到盤中 L2 報價合成假今日 K
 */

import { readdirSync, readFileSync, writeFileSync } from 'fs';

const L1_DIR = '/Users/tzu-chienhsu/Desktop/rockstock/data/candles/CN';
const BAD_DATE = '2026-04-20';

function main() {
  const files = readdirSync(L1_DIR);
  let fixed = 0;
  let skipped = 0;

  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const p = `${L1_DIR}/${f}`;
    try {
      const obj = JSON.parse(readFileSync(p, 'utf-8'));
      const cs: Array<{ date: string }> = obj.candles;
      if (!cs?.length) continue;
      if (cs[cs.length - 1].date !== BAD_DATE) continue;

      // 移除所有 4/20 的 K 棒（通常只有最後一根，也可能更多）
      const cleaned = cs.filter(c => c.date !== BAD_DATE);
      if (cleaned.length === cs.length) { skipped++; continue; }

      obj.candles = cleaned;
      writeFileSync(p, JSON.stringify(obj));
      fixed++;
      const code = f.replace('.json', '');
      const newLast = cleaned.length > 0 ? cleaned[cleaned.length - 1].date : '(empty)';
      console.log(`✓ ${code} 移除 ${cs.length - cleaned.length} 根 4/20 K棒，新 lastDate=${newLast}`);
    } catch (err) {
      console.warn(`✗ ${f}: ${(err as Error).message}`);
    }
  }

  console.log(`\n✅ 清理完成：修正 ${fixed} 支，其他 ${skipped} 支未動`);
}

main();
