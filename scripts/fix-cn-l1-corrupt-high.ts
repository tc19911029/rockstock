/**
 * 修復 2026-04-16 CN L1 被 Tencent 欄位錯位污染的 K 棒
 *
 * 兩種污染：
 * 1. high = YYYYMMDDHHMMSS 時間戳（> 1e5，明顯異常）
 * 2. low = 漲跌幅%（正數但 < min(open, close)，看似合理實則錯）
 *
 * 修復：若 high/low 不滿足 low <= open,close <= high，用 max/min(open, close) 修正。
 * 後續 EODHD/FinMind 抓到真實 K 時會覆蓋。
 */
import fs from 'fs';
import path from 'path';

const CANDLES_DIR = path.join(process.cwd(), 'data', 'candles', 'CN');
const TARGET_DATE = '2026-04-16';

function fixCandle(c: any): boolean {
  const { open, close, high, low } = c;
  const minOC = Math.min(open, close);
  const maxOC = Math.max(open, close);
  let changed = false;
  // high 必須 >= max(open, close)，且不應遠超（時間戳判斷用 1e5 保守閾值）
  if (high < maxOC || high > 1e5) {
    c.high = maxOC;
    changed = true;
  }
  // low 必須 <= min(open, close)，且不應遠低於（< minOC * 0.5 視為垃圾值）
  if (low > minOC || low < minOC * 0.5) {
    c.low = minOC;
    changed = true;
  }
  return changed;
}

const files = fs.readdirSync(CANDLES_DIR).filter(f => f.endsWith('.json'));
let fixed = 0;
for (const f of files) {
  const full = path.join(CANDLES_DIR, f);
  const data = JSON.parse(fs.readFileSync(full, 'utf8'));
  const arr = data.candles ?? data;
  if (!Array.isArray(arr)) continue;
  const target = arr.find((c: any) => c.date === TARGET_DATE);
  if (!target) continue;
  if (fixCandle(target)) {
    fs.writeFileSync(full, JSON.stringify(data, null, 2));
    fixed++;
  }
}
console.log(`共 ${files.length} 檔，修復 ${fixed} 檔 K 棒`);
