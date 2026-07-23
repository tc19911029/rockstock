/**
 * 修「無成交日被填了假價」（2026-07-23）。
 *
 * 封存鏈路在該檔缺官方 bulk 資料時會退到報價型 vendor，把「當下的報價」寫成收盤。
 * 只修**兩種能證明不是真實成交價**的假 K，其餘一律不動：
 *
 *   A. 中間價：(最佳買+最佳賣)/2 → 落在兩個檔位中間，撮合不可能產生這種價
 *      （2026-07-22 有 89 檔 .TWO 中招；8077.TWO 連 3 天）
 *      防誤殺：被還原過的序列整段本來就不在檔位網格上（5274.TWO 的 15586.36 是正常的）
 *      → 要求前後鄰居都在合法檔位，且偏離前收 <5%。
 *
 *   B. 孤立尖刺：整根跳離前收 >3%，但**下一根有成交的 bar 又回到前收附近（<3%）**。
 *      來源沒套用還原（4806.TWO 2025-09-18 寫 15.40 = 2×7.70，下一根成交日回到 7.89）。
 *      「有沒有回來」是尺度無關的判準 —— 不必知道 L1 用哪種還原慣例。
 *
 * ⚠️ 為什麼不用「volume=0 就一律延用前收」這種更簡單的規則：**會誤殺**。
 *    台股 volume 單位是張，盤中零股成交 <500 股會四捨五入成 0 張，那天是真的有成交、
 *    價格也真的會動（1236.TW 2025-05-23 收 22.65 v=0，Yahoo 同樣是 22.65 不是前收 22.60）。
 *
 * 用法：npx tsx scripts/repair-tw-notrade-midquote.ts [--apply]
 */
import fs from 'fs';
import path from 'path';
import { isValidTwTick, isTwEtf } from '../lib/datasource/twTick';

const APPLY = process.argv.includes('--apply');
const DIR = path.join(process.cwd(), 'data/candles/TW');
const NOISE = 0.0005;       // 相對差小於此視為浮點雜訊（Yahoo float32）
const MIDQUOTE_MAX_DEV = 0.05;
const SPIKE_MIN_DEV = 0.03;  // 孤立尖刺門檻
const SPIKE_RETURN_TOL = 0.03; // 下一根成交價回到前收的容差

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number }

let files = 0, fixA = 0, fixB = 0, fixedFiles = 0;
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
    if (b.volume !== 0 || !(prev.close > 0) || !(b.close > 0)) continue;
    const dev = Math.abs(b.close - prev.close) / prev.close;
    if (dev < NOISE) continue;

    let rule = '';
    // A：中間價
    if (dev < MIDQUOTE_MAX_DEV && !isValidTwTick(b.close, etf) && isValidTwTick(prev.close, etf)) {
      const nextTraded = cs.slice(i + 1).find((x) => x.volume > 0 && x.close > 0);
      if (!nextTraded || isValidTwTick(nextTraded.close, etf)) rule = 'A中間價';
    }
    // B：孤立尖刺（下一根成交價回到前收附近）
    if (!rule && dev > SPIKE_MIN_DEV) {
      const nextTraded = cs.slice(i + 1).find((x) => x.volume > 0 && x.close > 0);
      if (nextTraded && Math.abs(nextTraded.close - prev.close) / prev.close < SPIKE_RETURN_TOL) rule = 'B孤立尖刺';
    }
    if (!rule) continue;

    if (samples.length < 10) samples.push(`  [${rule}] ${sym} ${b.date}  ${b.close} → ${prev.close}`);
    b.open = b.high = b.low = b.close = prev.close;
    if (rule.startsWith('A')) fixA++; else fixB++;
    touched++;
  }
  if (touched > 0) { fixedFiles++; if (APPLY) fs.writeFileSync(path.join(DIR, f), JSON.stringify(d, null, 2)); }
}

console.log(`掃 ${files} 檔；修 ${fixedFiles} 檔 / ${fixA + fixB} 根（A中間價 ${fixA}、B孤立尖刺 ${fixB}）${APPLY ? '（已寫入）' : ' [dry-run]'}`);
if (samples.length) console.log(samples.join('\n'));
