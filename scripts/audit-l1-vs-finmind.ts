#!/usr/bin/env npx tsx
/**
 * audit-l1-vs-finmind.ts — 拿 FinMind 全市場日K（data/_finmind/TW/）當獨立權威來源，
 * 交叉比對我們的 L1（data/candles/TW/），找出「錯的 K 棒」與「錯的成交量」。
 *
 * 前置：先跑 scripts/finmind-bulk-prices.ts 把參考資料下下來。
 *
 * 還權問題的處理（關鍵）：
 *   我們 L1 深歷史有 Yahoo 還權片段，FinMind 是未還權 → 直接比深歷史會在每個除息日
 *   出現一整段系統性偏移（不是 bug）。所以價格只「硬判」孤立偏差：
 *   某根與 FinMind 差很多、但它前後兩根都吻合 → 才算真錯（污染/錯位/複製/尖刺）。
 *   還權造成的偏移是「一整段連續」偏，前後鄰居也偏 → 不會被誤判為孤立錯誤。
 *
 *   成交量單位錯（×1000 / ×100）是「整段」的、與還權無關 → 用倍率門檻直接抓。
 *
 * 分類：
 *   price-isolated   單根價格孤立偏差（次檔位污染 / MI_INDEX 錯位 / 整根複製 / 尖刺）
 *   volume-scale     成交量倍率離譜（單位錯）
 *   missing-bar      FinMind 有該交易日、L1 缺（且落在 L1 既有日期範圍內）
 *
 * 用法：
 *   npx tsx scripts/audit-l1-vs-finmind.ts                 # 全範圍
 *   npx tsx scripts/audit-l1-vs-finmind.ts --since 2026-01-01
 *   npx tsx scripts/audit-l1-vs-finmind.ts --code 2330     # 只查單檔（debug）
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { isZeroVolumeFlatBar } from '../lib/datasource/candleSanitizers';

const REPO = process.cwd();
const FM_DIR = path.join(REPO, 'data', '_finmind', 'TW');
const L1_DIR = path.join(REPO, 'data', 'candles', 'TW');
const OUT_DIR = path.join(REPO, 'data', '_audit');

// ── 門檻 ───────────────────────────────────────────────────────────────────────
const PRICE_THR = 0.001; // 0.1% — clean-zone 應幾乎全等；次檔位污染(~0.16%)抓得到
const VOL_SCALE_HI = 8; // 成交量倍率 ≥8× 或 ≤1/8 視為單位/尺度錯（避開正常 split ≤~10× 的少數情況用孤立判斷）
const VOL_SCALE_LO = 1 / 8;

interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
interface FMBar {
  open: number;
  high: number;
  low: number;
  close: number;
  volumeLots: number; // 已 ÷1000 換成張
}

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k: string) => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return { since: get('--since'), onlyCode: get('--code') };
}

// 讀 FinMind 參考：Map<code, Map<date, FMBar>> + 全域日期範圍
function loadFinMind(): {
  byCode: Map<string, Map<string, FMBar>>;
  minDate: string;
  maxDate: string;
  tradingDays: Set<string>;
} {
  const byCode = new Map<string, Map<string, FMBar>>();
  const tradingDays = new Set<string>();
  let minDate = '9999',
    maxDate = '0000';
  if (!existsSync(FM_DIR)) {
    console.error(`❌ 找不到 ${FM_DIR}，請先跑 scripts/finmind-bulk-prices.ts`);
    process.exit(1);
  }
  const files = readdirSync(FM_DIR).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const d = JSON.parse(readFileSync(path.join(FM_DIR, f), 'utf-8')) as {
      date: string;
      tradingDay: boolean;
      bars: Array<{ code: string; open: number; high: number; low: number; close: number; volume: number }>;
    };
    if (!d.tradingDay || !d.bars?.length) continue;
    tradingDays.add(d.date);
    if (d.date < minDate) minDate = d.date;
    if (d.date > maxDate) maxDate = d.date;
    for (const b of d.bars) {
      let m = byCode.get(b.code);
      if (!m) {
        m = new Map();
        byCode.set(b.code, m);
      }
      const normalized = {
        open: b.high > 0 && b.low > 0 ? Math.min(b.high, Math.max(b.low, b.open)) : b.open,
        high: b.high,
        low: b.low,
        close: b.high > 0 && b.low > 0 ? Math.min(b.high, Math.max(b.low, b.close)) : b.close,
        volumeLots: b.volume / 1000,
      };
      // 與 L1 共用交易 K 定義：換算成整張後為零且 OHLC 平盤者是占位，不列為缺 K。
      if (isZeroVolumeFlatBar({ date: d.date, ...normalized, volume: Math.round(normalized.volumeLots) })) continue;
      m.set(d.date, normalized);
    }
  }
  return { byCode, minDate, maxDate, tradingDays };
}

type Finding =
  | { code: string; date: string; kind: 'price-isolated'; field: string; l1: number; fm: number; pct: number }
  | { code: string; date: string; kind: 'volume-scale'; l1: number; fm: number; ratio: number }
  | { code: string; date: string; kind: 'missing-bar'; fmClose: number };

function relDiff(a: number, b: number): number {
  if (b === 0) return a === 0 ? 0 : 1;
  return Math.abs(a - b) / Math.abs(b);
}

function main() {
  const { since, onlyCode } = parseArgs();
  const { byCode, minDate, maxDate, tradingDays } = loadFinMind();
  console.log(
    `[audit] FinMind 參考：${byCode.size} 檔，日期 ${minDate} ~ ${maxDate}，${tradingDays.size} 個交易日`,
  );
  const lo = since && since > minDate ? since : minDate;
  console.log(`[audit] 比對窗：${lo} ~ ${maxDate}`);

  const l1Files = readdirSync(L1_DIR).filter((f) => f.endsWith('.json'));
  const findings: Finding[] = [];
  // 統計：clean-zone close 偏差分佈（calibration），看 0.1% 門檻是否合理
  const diffBuckets = { exact: 0, lt05: 0, lt1: 0, lt5: 0, ge5: 0 };
  let comparedBars = 0;
  let stocksAudited = 0;
  let stocksNoFM = 0;

  for (const f of l1Files) {
    const code = f.replace(/\.(TW|TWO)\.json$/i, '').replace(/\.json$/i, '');
    if (onlyCode && code !== onlyCode) continue;
    const fmSeries = byCode.get(code);
    let raw: { candles?: Bar[] };
    try {
      raw = JSON.parse(readFileSync(path.join(L1_DIR, f), 'utf-8'));
    } catch {
      continue;
    }
    const candles = (raw.candles ?? []).filter((c) => c.date >= lo && c.date <= maxDate);
    if (candles.length === 0) continue;
    if (!fmSeries) {
      stocksNoFM++;
      continue;
    }
    stocksAudited++;

    // 建 L1 date → bar，方便取鄰居
    const l1Map = new Map<string, Bar>();
    for (const c of candles) l1Map.set(c.date, c);
    const l1Dates = candles.map((c) => c.date); // 已是排序（L1 寫入時 sort）

    // 每檔分類（pre-pass）：在「尺度≈1」(ratio∈[0.99,1.01]) 的 bar 中，diff>門檻 的比例。
    //   壞比例 < 10% 且樣本夠 → 「污染型」未還權股：scale-1 上每根差異都是真錯（FinMind=官方）→ 全抓，不必孤立。
    //   壞比例 ≥ 10% → 「微還權型」：差異是還權造成、整段性 → 只走孤立判定（保守，不誤改還權）。
    // 解決「連續兩天都錯互為壞鄰居」逃過孤立判定的盲點。
    let scale1Total = 0, scale1Bad = 0;
    for (const c of candles) {
      const f = fmSeries.get(c.date);
      if (!f || f.close <= 0 || c.close <= 0) continue;
      const r = c.close / f.close;
      if (r >= 0.99 && r <= 1.01) {
        scale1Total++;
        if (relDiff(c.close, f.close) > PRICE_THR) scale1Bad++;
      }
    }
    const isContamType = scale1Total >= 20 && scale1Bad > 0 && scale1Bad / scale1Total < 0.1;

    for (let i = 0; i < l1Dates.length; i++) {
      const date = l1Dates[i];
      const l1 = l1Map.get(date)!;
      const fm = fmSeries.get(date);
      if (!fm) continue; // FinMind 無此日（停牌/未涵蓋）→ 不比
      // FinMind 該日 OHLC=0 = 冷門股沒成交/缺值，非權威 → 不可拿來判我們錯（會誤報 100% 差異）
      if (fm.close <= 0 || fm.high <= 0 || fm.low <= 0) continue;
      comparedBars++;

      // ── 價格：孤立偏差判定（close 為主）──────────────────────────────────
      const dClose = relDiff(l1.close, fm.close);
      if (dClose === 0) diffBuckets.exact++;
      else if (dClose < 0.005) diffBuckets.lt05++;
      else if (dClose < 0.01) diffBuckets.lt1++;
      else if (dClose < 0.05) diffBuckets.lt5++;
      else diffBuckets.ge5++;

      // 觸發只看 close/high/low（不看 open）：open 出界多為 TWSE 競價/除權息參考價，
      // 我們寫入層已刻意 clip，與 FinMind 原始參考價不同屬「正常差異」非 bug。
      const dHigh = relDiff(l1.high, fm.high);
      const dLow = relDiff(l1.low, fm.low);
      const triggerDiff = Math.max(dClose, dHigh, dLow);
      if (triggerDiff > PRICE_THR) {
        // 看前後鄰居是否吻合（兩源都有的相鄰交易日）
        const prevD = i > 0 ? l1Dates[i - 1] : undefined;
        const nextD = i < l1Dates.length - 1 ? l1Dates[i + 1] : undefined;
        const neighborOk = (nd?: string): boolean | null => {
          if (!nd) return null;
          const fl = l1Map.get(nd);
          const ff = fmSeries.get(nd);
          if (!fl || !ff || ff.close <= 0) return null;
          return relDiff(fl.close, ff.close) <= PRICE_THR;
        };
        const prevOk = neighborOk(prevD);
        const nextOk = neighborOk(nextD);
        // 孤立 = 至少一邊有可比鄰居，且所有可比鄰居都吻合
        const comparable = [prevOk, nextOk].filter((x) => x !== null) as boolean[];
        const isolatedByNeighbor = comparable.length > 0 && comparable.every((x) => x === true);
        // 污染型未還權股 + 本根尺度≈1 → 直接認定為錯（FinMind=官方），不必孤立（解連續壞日盲點）。
        const barRatio = fm.close > 0 ? l1.close / fm.close : 1;
        const barScale1 = barRatio >= 0.99 && barRatio <= 1.01;
        const isolated = isolatedByNeighbor || (isContamType && barScale1);
        if (isolated) {
          // 找出偏最多的欄位回報（只在 close/high/low 中挑，open 不算）
          const fields: Array<[string, number, number]> = [
            ['close', l1.close, fm.close],
            ['high', l1.high, fm.high],
            ['low', l1.low, fm.low],
          ];
          let worst = fields[0];
          let worstPct = dClose;
          for (const fld of fields) {
            const p = relDiff(fld[1], fld[2]);
            if (p > worstPct) {
              worstPct = p;
              worst = fld;
            }
          }
          findings.push({
            code,
            date,
            kind: 'price-isolated',
            field: worst[0],
            l1: worst[1],
            fm: worst[2],
            pct: Number((worstPct * 100).toFixed(3)),
          });
        }
      }

      // ── 成交量：倍率離譜（單位錯）─────────────────────────────────────────
      // 但要排除「還權/split」造成的量偏：若價格也同步反向偏移（priceRatio×volRatio≈1），
      // 代表我們 L1 該股是還權序列、FinMind 未還權 → 內部一致、不是 bug，跳過。
      // 只有「價格吻合、量卻偏」才是真的量錯。
      if (fm.volumeLots > 1 && l1.volume > 1) {
        const ratio = l1.volume / fm.volumeLots;
        if (ratio >= VOL_SCALE_HI || ratio <= VOL_SCALE_LO) {
          const priceRatio = fm.close > 0 ? l1.close / fm.close : 1;
          const splitConsistent = Math.abs(priceRatio * ratio - 1) < 0.15;
          const priceMatches = Math.abs(priceRatio - 1) < 0.02;
          if (!splitConsistent && priceMatches) {
            findings.push({
              code,
              date,
              kind: 'volume-scale',
              l1: l1.volume,
              fm: Math.round(fm.volumeLots),
              ratio: Number(ratio.toFixed(2)),
            });
          }
        }
      }
    }

    // ── 缺 K 棒：FinMind 有此交易日且落在 L1 既有範圍內、L1 卻沒有 ──────────
    const l1First = l1Dates[0];
    const l1Last = l1Dates[l1Dates.length - 1];
    for (const [d, fm] of fmSeries) {
      if (d < l1First || d > l1Last) continue;
      if (d < lo) continue;
      if (fm.close <= 0) continue; // FinMind 該日沒成交 → 不算我們缺
      if (!l1Map.has(d)) {
        findings.push({ code, date: d, kind: 'missing-bar', fmClose: fm.close });
      }
    }
  }

  // ── 彙整 ───────────────────────────────────────────────────────────────────
  const byKind = { 'price-isolated': 0, 'volume-scale': 0, 'missing-bar': 0 };
  const byStock = new Map<string, number>();
  for (const fnd of findings) {
    byKind[fnd.kind]++;
    byStock.set(fnd.code, (byStock.get(fnd.code) ?? 0) + 1);
  }

  console.log(`\n========== 交叉比對結果 ==========`);
  console.log(`比對股票 ${stocksAudited} 檔（FinMind 無涵蓋 ${stocksNoFM} 檔）｜比對 K 棒 ${comparedBars} 根`);
  console.log(`\nclean-zone close 偏差分佈（看門檻是否合理）：`);
  console.log(
    `  完全相等 ${diffBuckets.exact}｜<0.5% ${diffBuckets.lt05}｜0.5-1% ${diffBuckets.lt1}｜1-5% ${diffBuckets.lt5}｜≥5% ${diffBuckets.ge5}`,
  );
  console.log(`\n錯誤分類：`);
  console.log(`  🔴 單根價格孤立偏差 price-isolated : ${byKind['price-isolated']}`);
  console.log(`  🟠 成交量倍率離譜   volume-scale    : ${byKind['volume-scale']}`);
  console.log(`  🟡 缺 K 棒          missing-bar     : ${byKind['missing-bar']}`);

  const topStocks = [...byStock.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  if (topStocks.length) {
    console.log(`\n問題最多的股票（前 25）：`);
    for (const [c, n] of topStocks) console.log(`  ${c.padEnd(8)} ${n}`);
  }

  // 各類各印幾筆樣本
  const sample = (kind: Finding['kind'], n = 12) => findings.filter((f) => f.kind === kind).slice(0, n);
  const pi = sample('price-isolated');
  if (pi.length) {
    console.log(`\n— price-isolated 樣本 —`);
    for (const f of pi as Extract<Finding, { kind: 'price-isolated' }>[])
      console.log(`  ${f.code} ${f.date} ${f.field}: L1=${f.l1} FinMind=${f.fm} (差 ${f.pct}%)`);
  }
  const vs = sample('volume-scale');
  if (vs.length) {
    console.log(`\n— volume-scale 樣本 —`);
    for (const f of vs as Extract<Finding, { kind: 'volume-scale' }>[])
      console.log(`  ${f.code} ${f.date}: L1=${f.l1} 張 FinMind=${f.fm} 張 (倍率 ${f.ratio}×)`);
  }
  const mb = sample('missing-bar');
  if (mb.length) {
    console.log(`\n— missing-bar 樣本 —`);
    for (const f of mb as Extract<Finding, { kind: 'missing-bar' }>[])
      console.log(`  ${f.code} ${f.date}: FinMind close=${f.fmClose}`);
  }

  // 寫報告
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const outPath = path.join(OUT_DIR, `l1-vs-finmind-${today}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        window: { from: lo, to: maxDate },
        stocksAudited,
        stocksNoFM,
        comparedBars,
        diffBuckets,
        byKind,
        topStocks,
        findings,
      },
      null,
      2,
    ),
    'utf-8',
  );
  console.log(`\n報告已寫入：${outPath}（共 ${findings.length} 筆 findings）`);
}

main();
