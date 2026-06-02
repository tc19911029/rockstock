// ============================================================
// 台股 L1 成交量「單位斷層」修復（股 ↔ 張）
//
// 病徵：深歷史回補來源用「股」、每日 feed 用「張」(=股/1000) 接在一起，
//   在某根 bar 出現 ~1000× 的成交量跳階，但「價格連續」(沒有同步的價格跳動)。
//   例：2330.TW 2024-04-17 vol=36,616,351(股) → 2024-04-18 vol=45,766(張)，close 804→804。
//   後果：主力狀態「中控」分母 SUM(VOL,480) 被「股」級大量灌爆 → 中控飆到 ~1776(應 ~10)；
//        捕撈季節彩柱(換手率)歷史段也偏。純價指標(短攻/中強/雙B/智能線/MA)不受影響。
//
// 修法：把「股」段(成交量量級大 ~1000× 的那一段) ÷1000 還原成「張」，與每日 feed 對齊。
//   這是確定性單位換算，非價格還權(不碰 OHLC)。當前報價本來就是「張」，不動。
//
// 作法：用 >200× 大跳階把序列切段，取「量級最小的段」當張基準 base，
//   每段 median/base：~1×(<50) = 已是張(不動)；~1000×([200,5000]) = 股(÷1000)；
//   落在中間死區[50,200] 或更怪 = 凌亂(只報不修)。股段長度須 ≥3 且兩側邊界價格連續。
//   ※ midControl 對「一致單位」是尺度不變(vol 同時在分子與 SUM(vol,480) 分母)，
//     只有「同檔混用股+張」才會爆 → 正好就是有內部跳階的這些檔。
//
// 保守條件（全部成立才自動修，否則只報不修）：
//   1. 每一段都能乾淨歸類成「張(~1×)」或「股(~1000×)」，無落在死區的曖昧段。
//   2. 每個「股段」長度 ≥3（排除單根孤立量尖刺，那種留給 repair-isolated-bad-bars）。
//   3. 每個股段的左右邊界「價格連續」：|close 比 -1| < 20%（確認純單位差，非除權/真跳動）。
//
// 安全：先備份到 data/candles/TW-backup-volsplice-<ts>/，直接覆寫(不走 writeCandleFile 的 merge)，
//   再 invalidateEntry 清 L1 cache。保留 sealedDate 等其餘欄位。
//
//   npx tsx scripts/repair-tw-volume-unit-splice.ts            # dry-run，只列出
//   npx tsx scripts/repair-tw-volume-unit-splice.ts --apply    # 備份+覆寫+清 cache
//   npx tsx scripts/repair-tw-volume-unit-splice.ts 2330       # 只看/修單檔(可加 --apply)
// ============================================================
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Candle } from '@/types';

const APPLY = process.argv.includes('--apply');
const ONLY = process.argv.find((a) => /^\d{4,6}$/.test(a));   // 可選：只處理單一裸碼
const STEP = 200;        // 相鄰非零 bar 成交量比 > 200× = 大跳階（切段用）
// 分辨「股」段靠兩條：絕對量級 + 相對張基準。
//  - 全台股單日成交沒有 ≥50 萬張的(2330 史上最高 ~16 萬張) → median ≥ HARD_ABS 一定是股。
//  - 小型股的股段可能只有十幾萬(=幾百張×1000)，靠「相對張基準 ≥ STRONG_RATIO」補抓；
//    單位差是 ~1000×，遠高於量能起伏(數十×)，門檻拉到 300× 避開「熱門爆量」假陽性。
//  - 張基準用「所有疑似張段 bar 的中位數」(robust)，不可用 min(單段中位數)——
//    否則像 8101 這種 9↔4 萬張擺盪的低量全張股，min 會被 9 帶歪、把正常張段誤判成 1000×。
const LOTS_CEIL = 100_000;   // 段中位數 < 此 = 納入「張基準」估計，且為「疑似股」最低量級
const HARD_ABS = 500_000;    // 段中位數 ≥ 此 = 一定是股（超過任何可能的張單日量）
const STRONG_RATIO = 300;    // 100k–500k 段須 median/base ≥ 此才「確定」是股(自動修)
const SOFT_RATIO = 100;      // 100×–300× = 「疑似」(列出待確認，不自動修)
const MIN_SH_LEN = 3;        // 股段長度須 ≥3（排除單根孤立量尖刺）
const PRICE_OK = 0.20;       // 股段邊界須價格連續：|close 比 -1| < 20%
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');

const median = (a: number[]): number => {
  const v = a.filter((x) => x > 0).sort((x, y) => x - y);
  return v.length ? v[Math.floor(v.length / 2)] : 0;
};

type SegKind = 'lots' | 'shares' | 'suspect';
interface Seg { lo: number; hi: number; med: number; kind: SegKind; }
type Verdict =
  | { kind: 'clean'; date: string; base: number; segs: Seg[]; ratio: number; shBars: number }  // shares 段 ÷1000
  | { kind: 'review'; note: string }   // 疑似但不夠確定 / 結構複雜 → 只列出不修
  | { kind: 'none' };

function analyze(cs: Candle[]): Verdict {
  // 1) 用大跳階切段（只看相鄰皆非零 bar）
  const bounds = [0];
  for (let i = 1; i < cs.length; i++) {
    const a = cs[i - 1].volume, b = cs[i].volume;
    if (a > 0 && b > 0 && (a / b > STEP || b / a > STEP)) bounds.push(i);
  }
  bounds.push(cs.length);
  if (bounds.length <= 2) return { kind: 'none' };  // 無內部跳階 = 單一尺度，midControl 不受影響

  const segs: Seg[] = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const lo = bounds[k], hi = bounds[k + 1];
    segs.push({ lo, hi, med: median(cs.slice(lo, hi).map((c) => c.volume)), kind: 'lots' });
  }
  // 2) robust 張基準 = 所有「中位數 < LOTS_CEIL」段內 bar 的整體中位數
  const lotsBars = segs.filter((s) => s.med > 0 && s.med < LOTS_CEIL)
    .flatMap((s) => cs.slice(s.lo, s.hi).map((c) => c.volume));
  const base = median(lotsBars);
  if (!(base > 0)) return { kind: 'none' };  // 整檔都是大量級 = 單位一致(全股)，midControl 仍不受影響

  // 3) 歸類每段：確定股 / 疑似 / 張
  let hasSuspect = false;
  for (const s of segs) {
    const r = s.med / base;
    if (s.med >= HARD_ABS || (s.med >= LOTS_CEIL && r >= STRONG_RATIO)) s.kind = 'shares';
    else if (s.med >= LOTS_CEIL && r >= SOFT_RATIO) { s.kind = 'suspect'; hasSuspect = true; }
    else s.kind = 'lots';
  }
  if (!segs.some((s) => s.kind === 'shares') && !hasSuspect) return { kind: 'none' };
  if (hasSuspect)
    return { kind: 'review', note: `有疑似股段(量級 100k–500k 且 ${SOFT_RATIO}–${STRONG_RATIO}× 之間)，需人工確認` };

  // 4) 確定股段的把關：長度 + 邊界價格連續
  for (const s of segs) {
    if (s.kind !== 'shares') continue;
    if (s.hi - s.lo < MIN_SH_LEN) return { kind: 'review', note: `股段過短(${s.hi - s.lo}根)疑孤立量尖刺` };
    const L = s.lo, R = s.hi;       // 段 [L,R)
    if (L > 0 && cs[L - 1].close > 0 && Math.abs(cs[L].close / cs[L - 1].close - 1) >= PRICE_OK)
      return { kind: 'review', note: `股段左界 ${cs[L].date} 價格也跳(疑除權/真跳動)` };
    if (R < cs.length && cs[R - 1].close > 0 && Math.abs(cs[R].close / cs[R - 1].close - 1) >= PRICE_OK)
      return { kind: 'review', note: `股段右界 ${cs[R].date} 價格也跳(疑除權/真跳動)` };
  }
  const shSegs = segs.filter((s) => s.kind === 'shares');
  const ratio = Math.round(Math.max(...shSegs.map((s) => s.med)) / base);
  const shBars = shSegs.reduce((n, s) => n + (s.hi - s.lo), 0);
  return { kind: 'clean', date: String(cs[shSegs[0].lo].date).replace('*', ''), base, segs, ratio, shBars };
}

(async () => {
  const dir = path.join(process.cwd(), 'data/candles/TW');
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => /^\d{4,6}\.(TW|TWO)\.json$/.test(f));
  } catch { console.error('找不到 data/candles/TW'); process.exit(1); }
  if (ONLY) files = files.filter((f) => f.startsWith(`${ONLY}.`));

  const clean: { sym: string; date: string; shBars: number; ratio: number }[] = [];
  const review: { sym: string; note: string }[] = [];

  for (const f of files) {
    let j: { candles: Candle[] };
    try { j = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!Array.isArray(j.candles) || j.candles.length < 60) continue;
    const v = analyze(j.candles);
    const sym = f.replace('.json', '');
    if (v.kind === 'clean') {
      clean.push({ sym, date: v.date, shBars: v.shBars, ratio: v.ratio });
      if (APPLY) {
        const backupDir = path.join(process.cwd(), 'data/candles', `TW-backup-volsplice-${STAMP}`);
        await fs.mkdir(backupDir, { recursive: true });
        await fs.copyFile(path.join(dir, f), path.join(backupDir, f));
        for (const s of v.segs.filter((x) => x.kind === 'shares'))
          for (let k = s.lo; k < s.hi; k++) {
            const vol = j.candles[k].volume;
            if (vol > 0) j.candles[k].volume = Math.round(vol / 1000);    // 股 → 張
          }
        await fs.writeFile(path.join(dir, f), JSON.stringify(j));
        try { const { invalidateEntry } = await import('@/lib/datasource/L1CandleCache'); invalidateEntry(sym, 'TW'); }
        catch { /* cache 清不到不致命 */ }
      }
    } else if (v.kind === 'review') {
      review.push({ sym, note: v.note });
    }
  }

  console.log(`\n=== 確定股段·自動修：${clean.length} 檔 ${APPLY ? '（股段已 ÷1000 + 備份 + 清 cache）' : '(dry-run)'} ===`);
  console.log('symbol       股段起日     股段根數   股/張比');
  for (const { sym, date, shBars, ratio } of clean.sort((a, b) => b.shBars - a.shBars))
    console.log(`  ${sym.padEnd(11)} ${date}  ${String(shBars).padStart(6)}    ${ratio}×`);

  console.log(`\n=== 疑似/複雜·只列出待確認(不自動修)：${review.length} 檔 ===`);
  for (const { sym, note } of review.slice(0, 80))
    console.log(`  ${sym.padEnd(11)} ${note}`);
  if (review.length > 80) console.log(`  …(其餘 ${review.length - 80} 檔略)`);

  if (!APPLY) console.log('\n(dry-run；加 --apply 才會備份+覆寫+清 L1 cache)');
  else console.log(`\n備份目錄：data/candles/TW-backup-volsplice-${STAMP}/`);
})();
