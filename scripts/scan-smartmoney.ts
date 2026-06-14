/**
 * 盤後掃描「跌 + 大戶逆勢買超」並存檔 → data/smartmoney/{date}.json
 * 用法：npx tsx scripts/scan-smartmoney.ts
 * launchd 盤後排程呼叫此腳本。
 */
import { runScan } from '../lib/smartmoney/scan';
import { writeDay } from '../lib/smartmoney/storage';

async function main() {
  const day = await runScan();
  if (!day.date || day.date === '0') {
    console.error('無有效資料日，略過存檔');
    process.exit(1);
  }
  await writeDay(day);
  console.log(`✅ ${day.date} 已存檔：掃 ${day.universe} 檔，命中 ${day.hits.length} 檔`);
  for (const h of day.hits.slice(0, 30)) {
    console.log(`  ${h.code} ${h.name}  跌${h.drop5.toFixed(1)}%  法人集中度+${h.instConc.toFixed(1)}%  買${h.inst5K.toLocaleString()}張`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
