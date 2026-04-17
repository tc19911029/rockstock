/**
 * fix-cn-volume-unit.ts
 *
 * 修正 CN A股 L1 歷史 K 線的成交量單位問題。
 *
 * 背景：EastMoneyHistProvider 曾對 CN 做 volume × 100（手→股），
 *       導致 2026-04-14 以前的資料存的是「股」，而之後存的是「手/張」。
 *       用戶要求統一以「張」（手）存儲，故對舊資料 ÷100。
 *
 * 邏輯：
 *   - 若某根 K 棒的 volume 比後一根大 10 倍以上（即相鄰異常大），視為舊格式（股），÷100
 *   - 使用「斷點偵測」：找到第一根 volume 突然縮小 ≥ 50 倍的日期，之前的全部 ÷100
 *   - 若找不到斷點（全部一致），則取樣比較最後一筆 vs L2 快照判斷
 *
 * Usage:
 *   npx tsx scripts/fix-cn-volume-unit.ts             # 實際修改
 *   npx tsx scripts/fix-cn-volume-unit.ts --dry-run   # 只顯示，不存檔
 */

import fs from 'fs';
import path from 'path';

const DRY_RUN = process.argv.includes('--dry-run');
const CN_DIR = path.join(process.cwd(), 'data/candles/CN');

interface Candle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  [key: string]: unknown;
}

interface CandleFile {
  symbol: string;
  candles: Candle[];
  [key: string]: unknown;
}

function detectBreakpoint(candles: Candle[]): number {
  /**
   * 找斷點：第一個 candles[i].volume * 50 < candles[i-1].volume 的 i
   * 代表 candles[i] 開始已是「張」，之前是「股」
   * 返回斷點 index（從此 index 開始是「張」），找不到返回 -1
   */
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].volume;
    const curr = candles[i].volume;
    if (prev > 0 && curr > 0 && prev > curr * 50) {
      return i; // candles[i] 開始是「張」，之前 ÷100
    }
  }
  return -1;
}

async function main() {
  if (!fs.existsSync(CN_DIR)) {
    console.error(`CN candles dir not found: ${CN_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(CN_DIR).filter(f => f.endsWith('.json'));
  console.log(`找到 ${files.length} 支 CN 股票\n`);

  let fixed = 0;
  let alreadyOk = 0;
  let noBreak = 0;

  for (const file of files) {
    const filePath = path.join(CN_DIR, file);
    let data: CandleFile;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      console.warn(`跳過（解析失敗）: ${file}`);
      continue;
    }

    const candles = data.candles;
    if (!candles || candles.length < 5) {
      alreadyOk++;
      continue;
    }

    const breakIdx = detectBreakpoint(candles);

    if (breakIdx === -1) {
      // 沒找到斷點：可能全部都是張（已正確），或全部都是股
      // 判斷方式：最後一筆 volume 如果 < 5,000,000 → 視為已是張，跳過
      const lastVol = candles[candles.length - 1].volume;
      if (lastVol < 5_000_000) {
        alreadyOk++;
        continue;
      }
      // 全部都是股，全部 ÷100
      if (!DRY_RUN) {
        data.candles = candles.map(c => ({ ...c, volume: Math.round(c.volume / 100) }));
        fs.writeFileSync(filePath, JSON.stringify(data));
      }
      console.log(`[全部÷100] ${file}: ${candles.length} 根`);
      fixed++;
      noBreak++;
      continue;
    }

    // 找到斷點：breakIdx 之前的 ÷100
    const beforeCount = breakIdx;
    const afterCount = candles.length - breakIdx;
    const sampleBefore = candles[breakIdx - 1].volume;
    const sampleAfter = candles[breakIdx].volume;

    if (!DRY_RUN) {
      data.candles = candles.map((c, i) => {
        if (i < breakIdx) {
          return { ...c, volume: Math.round(c.volume / 100) };
        }
        return c;
      });
      fs.writeFileSync(filePath, JSON.stringify(data));
    }

    console.log(
      `[斷點] ${file}: 前${beforeCount}根÷100 (${sampleBefore}→${Math.round(sampleBefore/100)}), 後${afterCount}根保留 (${sampleAfter})`
    );
    fixed++;
  }

  console.log('\n==============================');
  console.log(`✅ 修正: ${fixed} 支`);
  console.log(`⏭️  已是張（跳過）: ${alreadyOk} 支`);
  if (DRY_RUN) console.log('\n[DRY RUN] 沒有實際寫入。去掉 --dry-run 才會存檔。');
}

main().catch(console.error);
