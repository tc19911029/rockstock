/**
 * 從本地 data/candles/TW/*.json 重建 data/backtest-candles.json
 * 速度快（純本地讀檔，不需要網路）
 */
import fs from 'fs';
import path from 'path';

const candleDir = path.join(process.cwd(), 'data', 'candles', 'TW');
const outputFile = path.join(process.cwd(), 'data', 'backtest-candles.json');

async function main() {
  const files = fs.readdirSync(candleDir).filter(f => f.endsWith('.json'));
  console.log(`讀取 ${files.length} 個本地K線檔案...`);

  const stocks: Record<string, { name: string; candles: any[] }> = {};
  let minDate = '9999', maxDate = '0000';
  let loaded = 0, skipped = 0;

  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(candleDir, file), 'utf-8'));
      const symbol = raw.symbol || file.replace('.json', '');
      const candles = raw.candles;

      // candles 可能是 object (keyed by date) 或 array
      let candleArr: any[];
      if (Array.isArray(candles)) {
        candleArr = candles;
      } else if (candles && typeof candles === 'object') {
        candleArr = Object.values(candles);
      } else {
        skipped++;
        continue;
      }

      if (candleArr.length < 60) {
        skipped++;
        continue;
      }

      // 排序確保日期順序
      candleArr.sort((a: any, b: any) => (a.date || '').localeCompare(b.date || ''));

      const firstDate = candleArr[0]?.date?.slice(0, 10) || '';
      const lastDate = candleArr[candleArr.length - 1]?.date?.slice(0, 10) || '';
      if (firstDate < minDate) minDate = firstDate;
      if (lastDate > maxDate) maxDate = lastDate;

      // 提取名稱
      const name = raw.name || candleArr[0]?.name || symbol;

      stocks[symbol] = {
        name,
        candles: candleArr.map((c: any) => ({
          date: c.date,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        })),
      };
      loaded++;
    } catch {
      skipped++;
    }
  }

  console.log(`  載入: ${loaded} 支，跳過: ${skipped} 支`);
  console.log(`  日期範圍: ${minDate} ~ ${maxDate}`);

  const output = { stocks, meta: { minDate, maxDate, count: loaded, builtAt: new Date().toISOString() } };
  fs.writeFileSync(outputFile, JSON.stringify(output));
  const sizeMB = (fs.statSync(outputFile).size / 1024 / 1024).toFixed(1);
  console.log(`\n✅ 已寫入 ${outputFile} (${sizeMB} MB)`);
}

main().catch(console.error);
