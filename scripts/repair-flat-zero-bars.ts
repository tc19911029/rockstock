/**
 * 全市場清除「volume=0 且 O=H=L=C」的非交易日占位 K。
 *
 * 這類 bar 是 vendor 用昨收補出的停牌／無成交日期，不是交易所日 K，不能占用 MA 樣本。
 * 預設 dry-run；--apply 才會逐檔備份後原子覆寫。
 *
 * 用法：
 *   npx tsx scripts/repair-flat-zero-bars.ts
 *   npx tsx scripts/repair-flat-zero-bars.ts --market TW --apply
 *   npx tsx scripts/repair-flat-zero-bars.ts --market all --apply
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isZeroVolumeFlatBar } from '@/lib/datasource/candleSanitizers';
import type { Candle } from '@/types';

type Market = 'TW' | 'CN';
interface CandleFile {
  symbol: string;
  lastDate: string;
  updatedAt: string;
  sealedDate?: string;
  candles: Candle[];
}

const APPLY = process.argv.includes('--apply');
const marketIndex = process.argv.indexOf('--market');
const marketArg = marketIndex >= 0 ? process.argv[marketIndex + 1] : 'all';
const markets: Market[] = marketArg === 'TW' || marketArg === 'CN' ? [marketArg] : ['TW', 'CN'];
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = path.join(process.cwd(), 'data', 'candles');

async function atomicWrite(file: string, value: string): Promise<void> {
  const temporary = `${file}.repair-flat-zero-${process.pid}.tmp`;
  await fs.writeFile(temporary, value, 'utf8');
  await fs.rename(temporary, file);
}

async function repairMarket(market: Market): Promise<{ files: number; affected: number; removed: number }> {
  const dir = path.join(root, market);
  const files = (await fs.readdir(dir)).filter((file) => file.endsWith('.json'));
  const backupDir = path.join(root, `${market}-backup-flat-zero-${stamp}`);
  let affected = 0;
  let removed = 0;

  for (const file of files) {
    const fullPath = path.join(dir, file);
    let data: CandleFile;
    try {
      data = JSON.parse(await fs.readFile(fullPath, 'utf8')) as CandleFile;
    } catch {
      continue;
    }
    if (!Array.isArray(data.candles) || data.candles.length === 0) continue;
    const candles = data.candles.filter((c) => !isZeroVolumeFlatBar(c));
    const count = data.candles.length - candles.length;
    if (count === 0 || candles.length === 0) continue;
    affected++;
    removed += count;

    if (APPLY) {
      await fs.mkdir(backupDir, { recursive: true });
      await fs.copyFile(fullPath, path.join(backupDir, file));
      const repaired: CandleFile = {
        ...data,
        candles,
        lastDate: candles[candles.length - 1].date,
        updatedAt: new Date().toISOString(),
      };
      await atomicWrite(fullPath, JSON.stringify(repaired));
    }
  }

  console.log(
    `[${market}] ${files.length} 檔；命中 ${affected} 檔，${APPLY ? '已移除' : '待移除'} ${removed} 根` +
    (APPLY ? `；備份 ${path.basename(backupDir)}` : ''),
  );
  return { files: files.length, affected, removed };
}

async function main(): Promise<void> {
  console.log(APPLY ? 'APPLY' : 'DRY-RUN');
  const results = [];
  for (const market of markets) results.push(await repairMarket(market));
  const total = results.reduce((sum, result) => sum + result.removed, 0);
  console.log(`總計 ${APPLY ? '移除' : '待移除'} ${total} 根零量扁平占位 K`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
