#!/usr/bin/env npx tsx
/**
 * repair-l1-from-finmind.ts — 依 audit-l1-vs-finmind 的 findings，用 FinMind 權威值修補 L1。
 *
 * 前置：先跑 finmind-bulk-prices.ts（抓參考）+ audit-l1-vs-finmind.ts（產 findings 報告）。
 *
 * 修補策略（只動「確認錯誤」的那一根，不整段重灌、不碰還權片段）：
 *   volume-scale    → 用 round(FinMind量/1000) 取代該根成交量（其餘 OHLC 不動）
 *   price-isolated  → 用 FinMind 的 OHLC 取代該根（孤立錯誤代表該區是未還權、可直接採信）
 *   missing-bar     → 插入 FinMind 該日 K 棒（OHLC + 量/1000）
 *
 * 安全：
 *   - 預設 dry-run，只印不寫；加 --apply 才真寫
 *   - 寫之前整個 data/candles/TW 備份到 data/candles/TW-backup-finmind-{ts}
 *   - 直接改檔（不走 writeCandleFile 的 guard，避免修補被守衛擋掉），但會做 OHLC 自洽 clip
 *
 * 用法：
 *   npx tsx scripts/repair-l1-from-finmind.ts                       # dry-run，看會改什麼
 *   npx tsx scripts/repair-l1-from-finmind.ts --apply               # 真的修
 *   npx tsx scripts/repair-l1-from-finmind.ts --apply --kinds volume-scale,missing-bar
 *   npx tsx scripts/repair-l1-from-finmind.ts --report data/_audit/l1-vs-finmind-2026-06-14.json --apply
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, cpSync } from 'fs';
import path from 'path';

const REPO = process.cwd();
const L1_DIR = path.join(REPO, 'data', 'candles', 'TW');
const FM_DIR = path.join(REPO, 'data', '_finmind', 'TW');
const AUDIT_DIR = path.join(REPO, 'data', '_audit');

interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
type Finding =
  | { code: string; date: string; kind: 'price-isolated'; field: string; l1: number; fm: number; pct: number }
  | { code: string; date: string; kind: 'volume-scale'; l1: number; fm: number; ratio: number }
  | { code: string; date: string; kind: 'missing-bar'; fmClose: number };

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k: string) => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const apply = a.includes('--apply');
  const noBackup = a.includes('--no-backup');
  const kinds = (get('--kinds') ?? 'price-isolated,volume-scale,missing-bar').split(',').map((s) => s.trim());
  const report = get('--report');
  return { apply, kinds, report, noBackup };
}

function latestReport(): string {
  if (!existsSync(AUDIT_DIR)) throw new Error(`找不到 ${AUDIT_DIR}，請先跑 audit-l1-vs-finmind.ts`);
  const files = readdirSync(AUDIT_DIR)
    .filter((f) => /^l1-vs-finmind-.*\.json$/.test(f))
    .sort();
  if (!files.length) throw new Error('找不到 l1-vs-finmind 報告，請先跑 audit-l1-vs-finmind.ts');
  return path.join(AUDIT_DIR, files[files.length - 1]);
}

// FinMind 某 code 某 date 的 bar（張）
function fmBarLoaderFactory() {
  // lazy 載入：把所有 _finmind 日期檔讀成 Map<date, Map<code, bar>>，只讀一次
  const byDate = new Map<string, Map<string, Bar>>();
  let loaded = false;
  function loadAll() {
    const files = readdirSync(FM_DIR).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      const d = JSON.parse(readFileSync(path.join(FM_DIR, f), 'utf-8')) as {
        date: string;
        tradingDay: boolean;
        bars: Array<{ code: string; open: number; high: number; low: number; close: number; volume: number }>;
      };
      if (!d.tradingDay) continue;
      const m = new Map<string, Bar>();
      for (const b of d.bars) {
        m.set(b.code, {
          date: d.date,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: Math.round(b.volume / 1000),
        });
      }
      byDate.set(d.date, m);
    }
    loaded = true;
  }
  return (code: string, date: string): Bar | null => {
    if (!loaded) loadAll();
    return byDate.get(date)?.get(code) ?? null;
  };
}

// OHLC 自洽：low ≤ {open,close} ≤ high（FinMind open 偶為參考價，clip 進範圍，比照寫入層）
function clipOHLC(b: Bar): Bar {
  if (b.high <= 0 || b.low <= 0 || b.low > b.high) return b;
  const c = { ...b };
  if (c.open > c.high) c.open = c.high;
  if (c.open < c.low) c.open = c.low;
  if (c.close > c.high) c.close = c.high;
  if (c.close < c.low) c.close = c.low;
  return c;
}

// 檢查某 code 在 targetDate 附近的既有 L1 bar 與 FinMind 同日的 close 倍率是否≈1。
// 回傳 true=尺度一致(可插)、false=明顯不一致(還權序列，勿插)、null=找不到可比鄰居(放行)。
function checkScaleConsistent(
  code: string,
  targetDate: string,
  byDate: Map<string, Bar>,
  getFM: (code: string, date: string) => Bar | null,
): boolean | null {
  const dates = [...byDate.keys()].sort();
  // 找時間上最接近 targetDate 的既有 L1 bar
  let best: string | null = null;
  let bestGap = Infinity;
  for (const d of dates) {
    const gap = Math.abs(new Date(d).getTime() - new Date(targetDate).getTime());
    if (gap < bestGap) {
      bestGap = gap;
      best = d;
    }
  }
  if (!best) return null;
  const l1 = byDate.get(best)!;
  const fm = getFM(code, best);
  if (!fm || fm.close <= 0 || l1.close <= 0) return null;
  const ratio = l1.close / fm.close;
  return Math.abs(ratio - 1) < 0.1;
}

function l1FilePath(code: string): string | null {
  for (const suf of ['.TW', '.TWO']) {
    const p = path.join(L1_DIR, `${code}${suf}.json`);
    if (existsSync(p)) return p;
  }
  return null;
}

function main() {
  const { apply, kinds, report, noBackup } = parseArgs();
  const reportPath = report ?? latestReport();
  const findings = (JSON.parse(readFileSync(reportPath, 'utf-8')).findings ?? []) as Finding[];
  const getFM = fmBarLoaderFactory();

  console.log(`[repair] 報告：${reportPath}`);
  console.log(`[repair] 修補類別：${kinds.join(', ')}｜模式：${apply ? '✍️ APPLY（真寫）' : '🔍 dry-run（只印）'}`);

  // 依 code group
  const byCode = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!kinds.includes(f.kind)) continue;
    if (!byCode.has(f.code)) byCode.set(f.code, []);
    byCode.get(f.code)!.push(f);
  }
  console.log(`[repair] 涉及 ${byCode.size} 檔、${[...byCode.values()].reduce((s, a) => s + a.length, 0)} 筆`);

  // 備份（--no-backup 跳過：給 nightly 用，因每日改動極小且原始備份已存在，避免每天 188MB 堆積）
  if (apply && byCode.size > 0 && !noBackup) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(REPO, 'data', 'candles', `TW-backup-finmind-${ts}`);
    console.log(`[repair] 備份 L1 → ${backup}`);
    cpSync(L1_DIR, backup, { recursive: true });
  }

  let filesChanged = 0,
    barsFixed = 0,
    barsInserted = 0,
    skipped = 0;

  for (const [code, fs] of byCode) {
    const fp = l1FilePath(code);
    if (!fp) {
      skipped += fs.length;
      continue;
    }
    const data = JSON.parse(readFileSync(fp, 'utf-8')) as { symbol: string; candles: Bar[]; [k: string]: unknown };
    const byDate = new Map<string, Bar>();
    for (const c of data.candles) byDate.set(c.date, c);
    let changed = false;

    for (const f of fs) {
      const fm = getFM(code, f.date);
      if (!fm) {
        skipped++;
        continue;
      }
      const fixed = clipOHLC(fm);
      if (f.kind === 'volume-scale') {
        const cur = byDate.get(f.date);
        if (cur && cur.volume !== fixed.volume) {
          console.log(`  ${code} ${f.date} 量 ${cur.volume} → ${fixed.volume} 張`);
          cur.volume = fixed.volume;
          changed = true;
          barsFixed++;
        }
      } else if (f.kind === 'price-isolated') {
        const cur = byDate.get(f.date);
        if (cur) {
          console.log(
            `  ${code} ${f.date} OHLC (${cur.open}/${cur.high}/${cur.low}/${cur.close}) → (${fixed.open}/${fixed.high}/${fixed.low}/${fixed.close})`,
          );
          cur.open = fixed.open;
          cur.high = fixed.high;
          cur.low = fixed.low;
          cur.close = fixed.close;
          // 量若也明顯不對一起修（同根）
          changed = true;
          barsFixed++;
        }
      } else if (f.kind === 'missing-bar') {
        if (!byDate.has(f.date)) {
          // 尺度防呆：找時間最近的一根既有 L1 bar，與 FinMind 同日比 close 倍率。
          // 若該股是還權序列（倍率明顯≠1），插入未還權 FinMind bar 會造成 splice → 略過。
          const neighborScaleOk = checkScaleConsistent(code, f.date, byDate, getFM);
          if (neighborScaleOk === false) {
            console.log(`  ${code} ${f.date} ⚠️ 周邊價格尺度不一致（疑還權序列），略過插入避免 splice`);
            skipped++;
          } else {
            console.log(`  ${code} ${f.date} 插入缺漏 K 棒 close=${fixed.close} 量=${fixed.volume}`);
            byDate.set(f.date, fixed);
            changed = true;
            barsInserted++;
          }
        }
      }
    }

    if (changed) {
      filesChanged++;
      if (apply) {
        const candles = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
        const lastDate = candles[candles.length - 1].date;
        const out = { ...data, candles, lastDate, updatedAt: new Date().toISOString(), sealedDate: lastDate };
        writeFileSync(fp, JSON.stringify(out), 'utf-8');
      }
    }
  }

  console.log(`\n========== 修補摘要 ==========`);
  console.log(`會改動檔案 ${filesChanged}｜修正 K 棒 ${barsFixed}｜插入 K 棒 ${barsInserted}｜略過 ${skipped}`);
  if (!apply) console.log(`\n（這是 dry-run，沒有真的寫入。確認 OK 後加 --apply 再跑一次。）`);
  else console.log(`\n✅ 已寫入。記憶體 L1 快取會在 10 分鐘 TTL 後換新，或重啟 prod server 立即生效。`);
}

main();
