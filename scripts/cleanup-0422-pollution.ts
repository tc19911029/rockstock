/**
 * 清理 2026-04-22 凌晨誤跑 append-today-from-snapshot.ts 造成的污染
 *
 * 影響範圍：
 *   1. data/candles/TW/*.json 最後一根是 2026-04-22 → 移除該 bar，lastDate 改回上一天
 *   2. data/intraday-TW-2026-04-22.json → 刪除（凌晨產生的假 snapshot）
 *
 * 根因：凌晨 01:13 跑了腳本，TWSE API 回傳 4/21 收盤數據當成 4/22 的資料
 */

import { promises as fs } from 'fs';
import path from 'path';

const TARGET_BAD_DATE = '2026-04-22';

async function main(): Promise<void> {
  // 1. 清理 TW L1
  const twDir = 'data/candles/TW';
  const files = await fs.readdir(twDir);
  let cleaned = 0;
  let unchanged = 0;
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(twDir, f);
    const raw = await fs.readFile(full, 'utf-8');
    const data = JSON.parse(raw) as { candles: Array<{ date: string }>; lastDate?: string; sealedDate?: string };
    const last = data.candles[data.candles.length - 1];
    if (!last || last.date !== TARGET_BAD_DATE) { unchanged++; continue; }
    // 移除最後一根
    data.candles.pop();
    const newLast = data.candles[data.candles.length - 1];
    data.lastDate = newLast?.date ?? '';
    data.sealedDate = newLast?.date ?? '';
    await fs.writeFile(full, JSON.stringify(data));
    cleaned++;
  }
  console.log(`[TW L1] cleaned=${cleaned}  unchanged=${unchanged}`);

  // 2. 刪除假 snapshot
  const snapPath = `data/intraday-TW-${TARGET_BAD_DATE}.json`;
  try {
    await fs.unlink(snapPath);
    console.log(`[L2] 已刪除 ${snapPath}`);
  } catch {
    console.log(`[L2] ${snapPath} 不存在或已刪`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
