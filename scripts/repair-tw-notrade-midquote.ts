/**
 * 修「無成交日被填中間價假 K」（2026-07-23）。
 *
 * 病灶：上櫃某檔當天沒成交 → TPEx bulk 不列它 → 封存鏈路落到報價型 vendor，
 * 拿回「(最佳買價+最佳賣價)/2」當收盤，寫成一根 volume=0 但價格會動的假 K。
 * 實案 2026-07-22：8 檔；8077.TWO 連 3 天（44.775 / 45.225 / 45.025），
 * 官方/Yahoo 一致顯示這 3 天都沒成交、價格應停在 44.05。
 *
 * 判準（四條同時成立才動，避免誤殺真實 vol=0 資料）：
 *   1. volume === 0（沒有成交）
 *   2. close 不在合法檔位上（= 中間價，證明它不是撮合出來的價）
 *   3. close ≠ 前一根 close（沒成交本來就不該變價）
 *   4. **前後兩根都在合法檔位上** —— 這條是防誤殺的關鍵：被除權還原過的序列
 *      （如 1235.TW 的 82.9166…、5274.TWO 的 15586.36）整段價位本來就不在檔位網格上，
 *      「次檔位」對它們毫無意義。只有前後鄰居都合法（= 未還原的原始價序列）時，
 *      夾在中間那根的次檔位才真的是中間價污染。
 *   5. 偏離前一根收盤 < 5% —— 沒成交日的中間價一定貼著前收（就在最佳買賣價之間）。
 *      偏離更大代表遇到的是還原因子換檔之類的別種現象，寧可放著也不亂改。
 * 修法：整根改成前一根收盤的平盤（O=H=L=C=prevClose, V=0）——與 Yahoo 對無成交日的表示一致。
 *
 * 用法：npx tsx scripts/repair-tw-notrade-midquote.ts [--apply]
 */
import fs from 'fs';
import path from 'path';
import { isValidTwTick, isTwEtf } from '../lib/datasource/twTick';

const APPLY = process.argv.includes('--apply');
const DIR = path.join(process.cwd(), 'data/candles/TW');

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number }

let files = 0, fixedBars = 0, fixedFiles = 0, skippedFar = 0;
const samples: string[] = [];

for (const f of fs.readdirSync(DIR)) {
  if (!/\.(TW|TWO)\.json$/.test(f)) continue;
  const sym = f.replace('.json', '');
  let d: { candles?: Bar[] };
  try { d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
  const cs = d.candles;
  if (!Array.isArray(cs)) continue;
  files++;
  const etf = isTwEtf(sym);
  let touched = 0;
  for (let i = 1; i < cs.length; i++) {
    const b = cs[i], prev = cs[i - 1];
    if (b.volume !== 0) continue;
    if (isValidTwTick(b.close, etf)) continue;
    if (!(prev.close > 0) || Math.abs(b.close - prev.close) < 1e-9) continue;
    // 條件 4：前後鄰居都必須落在合法檔位（證明這是原始價序列、不是還原價序列）
    if (!isValidTwTick(prev.close, etf)) continue;
    // 往後找第一根「有成交」的 bar 當鄰居基準 —— 連續無成交日會串成一條假 K 鏈
    // （8077.TWO 2026-07-20~22 連 3 天），直接看 i+1 會被鏈上的下一根假 K 擋住。
    const next = cs.slice(i + 1).find((x) => x.volume > 0);
    if (next && !isValidTwTick(next.close, etf)) continue;
    // 條件 5：偏離前收 <5%（沒成交的中間價必然貼著前收）
    if (Math.abs(b.close - prev.close) / prev.close >= 0.05) { skippedFar++; continue; }
    if (samples.length < 12) samples.push(`  ${sym} ${b.date}  ${b.close} → ${prev.close}（前一根收盤，V=0）`);
    b.open = b.high = b.low = b.close = prev.close;
    touched++; fixedBars++;
  }
  if (touched > 0) {
    fixedFiles++;
    if (APPLY) fs.writeFileSync(path.join(DIR, f), JSON.stringify(d, null, 2));
  }
}

console.log(`掃 ${files} 檔；命中 ${fixedFiles} 檔 / ${fixedBars} 根${APPLY ? '（已寫入）' : ' [dry-run，加 --apply 才寫]'}；偏離前收 ≥5% 保守跳過 ${skippedFar} 根`);
if (samples.length) console.log(samples.join('\n'));
