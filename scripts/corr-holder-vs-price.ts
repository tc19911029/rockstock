/**
 * 純相關性檢查：大戶持股比「增加」 vs 股價「漲跌」
 *
 * 使用者要的就一件事：大戶持股增加，股價是不是正相關地跟著漲？
 * 不算超額報酬、不比大盤。純看個股自己。
 *
 * 資料：
 *  - 大戶持股週資料 data/chips/TW/tdcc/{code}.json  → holder400Pct / holder1000Pct
 *  - 日K           data/candles/TW/{code}.TW.json   → close
 */
import { promises as fs } from 'fs';
import path from 'path';

const TDCC_DIR = path.join(process.cwd(), 'data/chips/TW/tdcc');
const CANDLE_DIR = path.join(process.cwd(), 'data/candles/TW');

interface Cdl { date: string; close: number }

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i];
    sxx += xs[i] * xs[i]; syy += ys[i] * ys[i]; sxy += xs[i] * ys[i];
  }
  const cov = sxy - sx * sy / n;
  const vx = sxx - sx * sx / n;
  const vy = syy - sy * sy / n;
  if (vx <= 0 || vy <= 0) return NaN;
  return cov / Math.sqrt(vx * vy);
}

async function main() {
  const tdccFiles = (await fs.readdir(TDCC_DIR)).filter(f => f.endsWith('.json'));

  // 觀測值：每一筆 = 某檔某週的 (大戶持股變化, 同期股價%, 未來20日股價%|null)
  const obs: Array<{ dH: number; same: number; fwd: number | null }> = [];

  // bucket：依「大戶增加 / 持平 / 減少」分組，看未來 20 日平均漲幅
  const buckets = {
    up:   { n: 0, sumFwd: 0, win: 0 },   // 大戶增加 ≥ +0.3pp
    flat: { n: 0, sumFwd: 0, win: 0 },   // -0.3 ~ +0.3pp
    down: { n: 0, sumFwd: 0, win: 0 },   // 大戶減少 ≤ -0.3pp
  };

  let stocksUsed = 0;

  for (const tf of tdccFiles) {
    const code = tf.replace('.json', '');
    if (!/^\d{4}$/.test(code)) continue; // 只取 4 位數台股代號

    let tdcc: any, cdl: any;
    try {
      tdcc = JSON.parse(await fs.readFile(path.join(TDCC_DIR, tf), 'utf8'));
      cdl = JSON.parse(await fs.readFile(path.join(CANDLE_DIR, `${code}.TW.json`), 'utf8'));
    } catch { continue; }

    const weeks: any[] = (tdcc.data || []).filter((w: any) => w.holder400Pct != null);
    const candles: Cdl[] = (cdl.candles || []).filter((c: Cdl) => c.close > 0);
    if (weeks.length < 5 || candles.length < 30) continue;

    // 日K 日期 → index，方便「往後數 N 個交易日」
    const dates = candles.map(c => c.date);
    // closeAtOrBefore(date)：找 <= date 的最後一根
    const idxAtOrBefore = (d: string): number => {
      let lo = 0, hi = candles.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (dates[mid] <= d) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return ans;
    };

    let usedThis = false;
    for (let i = 1; i < weeks.length; i++) {
      const prev = weeks[i - 1], cur = weeks[i];
      const dH = cur.holder400Pct - prev.holder400Pct;
      if (!isFinite(dH)) continue;

      const iCur = idxAtOrBefore(cur.date);
      const iPrev = idxAtOrBefore(prev.date);
      if (iCur < 0 || iPrev < 0 || iCur === iPrev) continue;

      const cClose = candles[iCur].close;
      const pClose = candles[iPrev].close;
      const same = (cClose / pClose - 1) * 100;

      // 未來 20 個交易日
      const iFwd = iCur + 20;
      let fwd: number | null = null;
      if (iFwd < candles.length) fwd = (candles[iFwd].close / cClose - 1) * 100;

      // 過濾明顯壞 bar / 除權息跳階（|單週| > 40% 或 |20日| > 60% 視為髒資料）
      if (Math.abs(same) > 40) continue;
      if (fwd != null && Math.abs(fwd) > 60) continue;

      obs.push({ dH, same, fwd });
      if (fwd != null) {
        const b = dH >= 0.3 ? buckets.up : dH <= -0.3 ? buckets.down : buckets.flat;
        b.n++; b.sumFwd += fwd; if (fwd > 0) b.win++;
      }
      usedThis = true;
    }
    if (usedThis) stocksUsed++;
  }

  // 相關係數（乾淨配對）
  const rSame = pearson(obs.map(o => o.dH), obs.map(o => o.same));
  const fwdObs = obs.filter(o => o.fwd != null);
  const rFwd = pearson(fwdObs.map(o => o.dH), fwdObs.map(o => o.fwd as number));

  console.log('========================================');
  console.log('大戶持股(400張↑)增加 vs 股價  —  純相關性');
  console.log('========================================');
  console.log(`採用股票數: ${stocksUsed} 檔`);
  console.log(`觀測筆數: ${obs.length.toLocaleString()} 筆 (每筆=某檔某週)`);
  console.log('');
  console.log('【相關係數 r】  (+1=完全正相關, 0=無關, -1=反相關)');
  console.log(`  大戶持股變化  vs  同一週股價%      r = ${rSame.toFixed(3)}`);
  console.log(`  大戶持股變化  vs  之後20日股價%    r = ${rFwd.toFixed(3)}`);
  console.log('');
  console.log('【分組看未來 20 個交易日(約一個月)平均漲幅】');
  const fmt = (b: {n:number;sumFwd:number;win:number}) =>
    `${b.n.toLocaleString().padStart(8)} 筆 | 平均 ${(b.sumFwd/b.n>=0?'+':'')}${(b.sumFwd/b.n).toFixed(2)}% | 上漲比例 ${(100*b.win/b.n).toFixed(1)}%`;
  console.log(`  大戶增加(≥+0.3pp): ${fmt(buckets.up)}`);
  console.log(`  大戶持平(±0.3pp ): ${fmt(buckets.flat)}`);
  console.log(`  大戶減少(≤-0.3pp): ${fmt(buckets.down)}`);
  console.log('');
  console.log('解讀：若「大戶增加」那組未來漲幅 > 「大戶減少」那組，就是正相關。');
}

main().catch(e => { console.error(e); process.exit(1); });
