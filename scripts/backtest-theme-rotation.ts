/**
 * 題材輪動回測（誠實 edge 版）
 *
 * 問題：用「題材排名」抓輪動到底有沒有用？
 *   - 買進「剛輪入🟢」的題材（排名爬升 + 近段動能加速）→ 之後贏大盤嗎？
 *   - 避開「退潮🔴」的題材（排名下滑 + 動能轉弱）→ 之後真的比較差（= 避雷有料）嗎？
 *
 * 做法（純歷史重建，無前視）：
 *   - 題材成分固定（lib/themes/themeMap 的 25 題材），L1 日K 重建任何過去日的題材動能。
 *   - 每個交易日 t：每個題材算
 *       r5    = 成分股近 5 日漲幅均值（as-of t）
 *       r5prev= 成分股前一個 5 日漲幅均值（as-of t-5）
 *       rankNow / rankPrev = 用 r5 / r5prev 跨題材排名（高在前）
 *       rankDelta = rankPrev - rankNow（正=名次爬升=資金轉入）
 *       accel     = r5 - r5prev（正=動能加速）
 *     分桶：輪入🟢(rankΔ≥3 且 accel>0) / 退潮🔴(rankΔ≤-3 且 accel<0) / 主流🟡(其餘)
 *   - 前瞻報酬：題材成分股之後 H 日均報酬（H=5/10/20）；超額 = 題材 − ^TWII 同期。
 *   - train/test：日期中位數切兩半，看每桶超額正負是否一致（不一致 = 不可信）。
 *
 * 紅線：這是「顯示層→是否升級成排序/推薦」的驗證關卡（CLAUDE.md 升級規則）。
 *       結論進記憶，過了才把 🟢🟡🔴 做成排序/推薦。
 *
 * 跑法：npx tsx scripts/backtest-theme-rotation.ts
 */
import { THEME_MAP } from '../lib/themes/themeMap';
import { readCandleFile } from '../lib/datasource/CandleStorageAdapter';

const LOOKBACK = 5;          // 近段/前段視窗
const FWD_HORIZONS = [5, 10, 20];
const RANK_DELTA_TH = 3;     // 排名爬升/下滑門檻（25 題材中爬/掉 ≥3 名）
const MIN_MEMBERS = 3;       // 題材至少幾檔有資料才計入

type CloseMap = Map<string, number>;

async function loadCloses(code: string): Promise<CloseMap | null> {
  // 指數（^TWII）無 .TW 後綴，個股則用 .TW/.TWO
  const file = (await readCandleFile(code, 'TW'))
    ?? (await readCandleFile(`${code}.TW`, 'TW'))
    ?? (await readCandleFile(`${code}.TWO`, 'TW'));
  if (!file?.candles?.length) return null;
  const m: CloseMap = new Map();
  for (const c of file.candles) if (c.close > 0) m.set(c.date, c.close);
  return m;
}

function mean(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/** 題材成分股在 [dFrom→dTo] 的平均報酬（只算兩端都有價的成分） */
function themeRet(members: string[], closeMaps: Map<string, CloseMap>, dFrom: string, dTo: string): number | null {
  const rets: number[] = [];
  for (const code of members) {
    const m = closeMaps.get(code);
    if (!m) continue;
    const a = m.get(dFrom); const b = m.get(dTo);
    if (a && b && a > 0) rets.push(b / a - 1);
  }
  return rets.length >= MIN_MEMBERS ? mean(rets) : null;
}

interface Bucket { name: string; ex: Record<number, number[]> }

function newBuckets(): Record<string, Bucket> {
  const mk = (name: string): Bucket => ({ name, ex: Object.fromEntries(FWD_HORIZONS.map((h) => [h, []])) });
  return { in: mk('輪入🟢'), mid: mk('主流🟡'), out: mk('退潮🔴') };
}

function summarize(buckets: Record<string, Bucket>, label: string) {
  console.log(`\n── ${label} ──`);
  console.log('桶        樣本   ' + FWD_HORIZONS.map((h) => `超額d${h}(勝率)`).join('   '));
  for (const key of ['in', 'mid', 'out']) {
    const b = buckets[key];
    const n = b.ex[FWD_HORIZONS[0]].length;
    const cells = FWD_HORIZONS.map((h) => {
      const arr = b.ex[h];
      const m = mean(arr);
      const win = arr.length ? arr.filter((x) => x > 0).length / arr.length : 0;
      return m == null ? '  —        ' : `${(m * 100 >= 0 ? '+' : '')}${(m * 100).toFixed(2)}%(${(win * 100).toFixed(0)}%)`;
    });
    console.log(`${b.name.padEnd(8)} ${String(n).padStart(5)}   ${cells.join('   ')}`);
  }
}

async function main() {
  // 1. 載入所有題材成分股收盤序列（去重）+ 大盤
  const codes = [...new Set(Object.values(THEME_MAP).flatMap((s) => s.map((x) => x.code)))];
  console.log(`載入 ${codes.length} 檔成分股 + ^TWII …`);
  const closeMaps = new Map<string, CloseMap>();
  for (const code of codes) {
    const m = await loadCloses(code);
    if (m) closeMaps.set(code, m);
  }
  const twii = await loadCloses('^TWII');
  if (!twii) { console.error('找不到 ^TWII，無法算超額'); process.exit(1); }

  // 2. 交易日曆 = ^TWII 日期
  const dates = [...twii.keys()].sort();
  const maxH = Math.max(...FWD_HORIZONS);
  console.log(`交易日 ${dates.length} 天（${dates[0]} ~ ${dates[dates.length - 1]}）\n`);

  const themeNames = Object.keys(THEME_MAP);
  const rows: Array<{ date: string; bucket: 'in' | 'mid' | 'out'; ex: Record<number, number> }> = [];
  const betaVsIndex: Record<number, number[]> = Object.fromEntries(FWD_HORIZONS.map((h) => [h, []]));

  // 3. 逐日重建排名 + 分桶 + 前瞻超額
  for (let i = 2 * LOOKBACK; i < dates.length - maxH; i++) {
    const dT = dates[i], dT5 = dates[i - LOOKBACK], dT10 = dates[i - 2 * LOOKBACK];

    // 每個題材的 r5(as-of t) 與 r5prev(as-of t-5)
    const r5: Record<string, number | null> = {};
    const r5p: Record<string, number | null> = {};
    for (const th of themeNames) {
      const members = THEME_MAP[th].map((s) => s.code);
      r5[th] = themeRet(members, closeMaps, dT5, dT);
      r5p[th] = themeRet(members, closeMaps, dT10, dT5);
    }
    const rankOf = (vals: Record<string, number | null>) => {
      const ordered = themeNames.filter((t) => vals[t] != null).sort((a, b) => (vals[b]! - vals[a]!));
      const r: Record<string, number> = {};
      ordered.forEach((t, idx) => (r[t] = idx + 1));
      return r;
    };
    const rankNow = rankOf(r5), rankPrev = rankOf(r5p);

    // 大盤前瞻（beta 對照用）
    const idxFwd: Record<number, number | null> = {};
    for (const h of FWD_HORIZONS) {
      const a = twii.get(dT); const b = twii.get(dates[i + h]);
      idxFwd[h] = a && b ? b / a - 1 : null;
    }

    // 先算每個題材的前瞻報酬 + 分桶
    type Cand = { th: string; bucket: 'in' | 'mid' | 'out'; fwd: Record<number, number> };
    const cands: Cand[] = [];
    for (const th of themeNames) {
      if (r5[th] == null || r5p[th] == null || rankNow[th] == null || rankPrev[th] == null) continue;
      const rankDelta = rankPrev[th] - rankNow[th];
      const accel = r5[th]! - r5p[th]!;
      let bucket: 'in' | 'mid' | 'out' = 'mid';
      if (rankDelta >= RANK_DELTA_TH && accel > 0) bucket = 'in';
      else if (rankDelta <= -RANK_DELTA_TH && accel < 0) bucket = 'out';

      const members = THEME_MAP[th].map((s) => s.code);
      const fwd: Record<number, number> = {};
      let ok = true;
      for (const h of FWD_HORIZONS) {
        const f = themeRet(members, closeMaps, dT, dates[i + h]);
        if (f == null) { ok = false; break; }
        fwd[h] = f;
      }
      if (ok) cands.push({ th, bucket, fwd });
    }
    if (cands.length < 5) continue;

    // 基準 = 當天全部題材等權平均前瞻（隔離 beta，純看「選哪個題材」）
    const basketFwd: Record<number, number> = {};
    for (const h of FWD_HORIZONS) basketFwd[h] = mean(cands.map((c) => c.fwd[h]))!;

    // beta 對照：全題材籃 vs ^TWII（記一次/天）
    for (const h of FWD_HORIZONS) if (idxFwd[h] != null) betaVsIndex[h].push(basketFwd[h] - idxFwd[h]!);

    // 每個題材超額 = 題材前瞻 − 全題材平均
    for (const c of cands) {
      const ex: Record<number, number> = {};
      for (const h of FWD_HORIZONS) ex[h] = c.fwd[h] - basketFwd[h];
      rows.push({ date: dT, bucket: c.bucket, ex });
    }
  }

  console.log(`總樣本（題材×日）= ${rows.length}`);
  console.log('\n── 背景 beta：全 25 題材等權籃 vs ^TWII（非輪動，純基底）──');
  console.log('  ' + FWD_HORIZONS.map((h) => `d${h} ${((mean(betaVsIndex[h]) ?? 0) * 100 >= 0 ? '+' : '')}${((mean(betaVsIndex[h]) ?? 0) * 100).toFixed(2)}%`).join('   '));
  console.log('  （下面各桶超額 = 題材 − 當天全題材平均，已隔離這個 beta）');

  // 4. 全期 + train/test
  const all = newBuckets();
  for (const r of rows) for (const h of FWD_HORIZONS) all[r.bucket].ex[h].push(r.ex[h]);
  summarize(all, '全期');

  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const mid = sorted[Math.floor(sorted.length / 2)].date;
  const train = newBuckets(), test = newBuckets();
  for (const r of sorted) {
    const dst = r.date < mid ? train : test;
    for (const h of FWD_HORIZONS) dst[r.bucket].ex[h].push(r.ex[h]);
  }
  summarize(train, `前半 train（< ${mid}）`);
  summarize(test, `後半 test（≥ ${mid}）`);

  // 5. 一句話結論（看 d10 超額 + train/test 同號）
  const ex10 = (b: Record<string, Bucket>, k: string) => mean(b[k].ex[10]) ?? 0;
  const inAll = ex10(all, 'in'), outAll = ex10(all, 'out');
  const inConsist = Math.sign(ex10(train, 'in')) === Math.sign(ex10(test, 'in'));
  const outConsist = Math.sign(ex10(train, 'out')) === Math.sign(ex10(test, 'out'));
  console.log('\n══ 結論（d10 超額）══');
  console.log(`輪入🟢: ${(inAll * 100).toFixed(2)}%  train/test ${inConsist ? '同號✅' : '不一致❌'}`);
  console.log(`退潮🔴: ${(outAll * 100).toFixed(2)}%  train/test ${outConsist ? '同號✅' : '不一致❌'}`);
  console.log(`→ 追輪入有料? ${inAll > 0.003 && inConsist ? '是' : '弱/否'}　|　避退潮有料? ${outAll < -0.003 && outConsist ? '是（退潮確實較弱）' : '弱/否'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
