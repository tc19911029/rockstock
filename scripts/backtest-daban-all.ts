/**
 * 台股+陸股打板策略：全因子 × 全出場策略 批量回測
 *
 * 組合：
 *   2市場 × 8排序因子 × 4出場策略 = 64組
 *
 * 出場策略：
 *   E1 止盈7%  / 止損-3% / 持20天
 *   E2 止盈10% / 止損-5% / 持20天
 *   E3 止盈15% / 止損-5% / 持30天
 *   E4 S1（固定止損-5% + 曾漲超10%後跌破MA5）
 *
 * Usage:
 *   cd /Users/tzu-chienhsu/Desktop/rockstock
 *   NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/backtest-daban-all.ts
 *
 *   只跑台股：MARKET=TW NODE_OPTIONS=... npx tsx scripts/backtest-daban-all.ts
 */

import fs   from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import type { CandleWithIndicators } from '@/types';

// ══════════════════════════════════════════════════════════════
// 全局設定
// ══════════════════════════════════════════════════════════════

const PERIOD   = {
  start: process.env.PERIOD_START ?? '2025-04-16',
  end:   process.env.PERIOD_END   ?? '2026-04-16',
};
const CAPITAL  = 100_000;      // 10萬

const TW_COST  = (0.001425 * 0.6 * 2 + 0.003) * 100;  // ≈ 0.471%
const CN_COST  = 0.16;

const LIMIT_UP = 9.5;          // 漲停判斷門檻 %
const MIN_TO   = 5_000_000;    // 最低昨日成交額

// 高開區間（固定用最常見的）
const GAP_MIN  = 2.0;
const GAP_MAX  = 8.0;

// S1 出場參數
const S1_SL      = -5;
const S1_GATE    = 10;
const S1_MAXHOLD = 60;

// 哪些市場
const MARKETS_TO_RUN: ('TW' | 'CN')[] = (() => {
  const env = process.env.MARKET;
  if (env === 'TW') return ['TW'];
  if (env === 'CN') return ['CN'];
  return ['TW', 'CN'];
})();

// ══════════════════════════════════════════════════════════════
// 排序因子 & 出場策略定義
// ══════════════════════════════════════════════════════════════

type DabanSort =
  | '純成交額' | '封板力度' | '多因子' | '連板優先'
  | '量比優先' | '動能優先' | '高開幅度' | '封板+高開';

interface ExitDef {
  label:   string;
  tp:      number;   // 止盈 %（999 = 不設止盈）
  sl:      number;   // 止損 % (負數)
  maxHold: number;   // 最長持有天數
  s1Mode:  boolean;  // true = 用S1邏輯
}

const ALL_SORTS: DabanSort[] = [
  '純成交額', '封板力度', '多因子', '連板優先',
  '量比優先', '動能優先', '高開幅度', '封板+高開',
];

const ALL_EXITS: ExitDef[] = [
  // ── 閃電線（2天，之前v4最佳組合）─────────────────────────
  { label: 'E1 止盈5% /止損-2%/持2天',     tp: 5,   sl: -2, maxHold: 2,          s1Mode: false },
  { label: 'E2 止盈7% /止損-3%/持2天',     tp: 7,   sl: -3, maxHold: 2,          s1Mode: false },
  { label: 'E3 止盈5% /止損-3%/持2天',     tp: 5,   sl: -3, maxHold: 2,          s1Mode: false },
  { label: 'E4 止盈3% /止損-2%/持2天',     tp: 3,   sl: -2, maxHold: 2,          s1Mode: false },
  // ── 超短線（5~10天）──────────────────────────────────────
  { label: 'E5 止盈5% /止損-2%/持5天',     tp: 5,   sl: -2, maxHold: 5,          s1Mode: false },
  { label: 'E6 止盈7% /止損-3%/持10天',    tp: 7,   sl: -3, maxHold: 10,         s1Mode: false },
  // ── 短線（20天）────────────────────────────────────────
  { label: 'E7 止盈7% /止損-3%/持20天',    tp: 7,   sl: -3, maxHold: 20,         s1Mode: false },
  { label: 'E8 止盈10%/止損-3%/持20天',    tp: 10,  sl: -3, maxHold: 20,         s1Mode: false },
  { label: 'E9 止盈10%/止損-5%/持20天',    tp: 10,  sl: -5, maxHold: 20,         s1Mode: false },
  // ── 中線（30天）────────────────────────────────────────
  { label: 'E10止盈15%/止損-5%/持30天',    tp: 15,  sl: -5, maxHold: 30,         s1Mode: false },
  { label: 'E11止盈20%/止損-7%/持30天',    tp: 20,  sl: -7, maxHold: 30,         s1Mode: false },
  // ── 動態出場 ────────────────────────────────────────────
  { label: 'E12 S1（漲超10%後跌破MA5）',   tp: 999, sl: -5, maxHold: S1_MAXHOLD, s1Mode: true },
];

// ══════════════════════════════════════════════════════════════
// 型別
// ══════════════════════════════════════════════════════════════

interface StockData {
  name:    string;
  candles: CandleWithIndicators[];
}

interface DabanFeatures {
  symbol: string; name: string; idx: number; candles: CandleWithIndicators[];
  entryPrice: number;
  gapUp: number; boards: number;
  yestTurnover: number; yestVR: number; seal: number; mom5: number;
  rankScore: number;
}

interface ExitResult {
  exitIdx: number; exitPrice: number; exitReason: string;
}

interface Trade {
  netPct: number; pnl: number; capitalAfter: number; holdDays: number;
}

interface ComboResult {
  market:      'TW' | 'CN';
  sortBy:      DabanSort;
  exit:        ExitDef;
  totalReturn: number;
  tradeCount:  number;
  winRate:     number;
  maxDD:       number;
  avgHold:     number;
  finalCapital:number;
}

// ══════════════════════════════════════════════════════════════
// 排序因子定義
// ══════════════════════════════════════════════════════════════

const SORT_DEFS: Record<DabanSort, (f: DabanFeatures) => number> = {
  '純成交額':  f => Math.log10(Math.max(f.yestTurnover, 1)),
  '封板力度':  f => f.seal * 10 + Math.log10(Math.max(f.yestTurnover, 1)) / 10,
  '多因子':    f => f.seal * 2 + Math.min(f.yestVR, 5) / 5
                    + Math.max(0, f.mom5) / 20
                    + Math.log10(Math.max(f.yestTurnover, 1)) / 10,
  '連板優先':  f => f.boards * 3 + Math.log10(Math.max(f.yestTurnover, 1)) / 10,
  '量比優先':  f => Math.min(f.yestVR, 5) * 2 + Math.log10(Math.max(f.yestTurnover, 1)) / 10,
  '動能優先':  f => Math.max(0, f.mom5) / 5 + Math.log10(Math.max(f.yestTurnover, 1)) / 10,
  '高開幅度':  f => f.gapUp * 2 + Math.log10(Math.max(f.yestTurnover, 1)) / 10,
  '封板+高開': f => f.seal * 3 + f.gapUp,
};

// ══════════════════════════════════════════════════════════════
// 資料載入
// ══════════════════════════════════════════════════════════════

function loadStocks(market: 'TW' | 'CN'): Map<string, StockData> {
  const stocks = new Map<string, StockData>();

  if (market === 'TW') {
    const dir = path.join(process.cwd(), 'data', 'candles', 'TW');
    if (!fs.existsSync(dir)) { console.error('TW candles 目錄不存在'); return stocks; }
    process.stdout.write('  讀取TW K線...');
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        const c: CandleWithIndicators[] = Array.isArray(raw) ? raw : raw.candles ?? raw;
        if (!c || c.length < 60) continue;
        stocks.set(f.replace('.json', ''), {
          name:    (raw as { name?: string }).name ?? f.replace('.json', ''),
          candles: computeIndicators(c),
        });
      } catch { /* 略 */ }
    }
    console.log(` ${stocks.size} 支`);
    return stocks;
  }

  // CN
  const cacheFile = path.join(process.cwd(), 'data', 'backtest-candles-cn.json');
  if (fs.existsSync(cacheFile)) {
    process.stdout.write('  讀取CN bulk cache...');
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    let n = 0;
    for (const [sym, d] of Object.entries(raw.stocks as Record<string, { name: string; candles: unknown[] }>)) {
      if (!d.candles || d.candles.length < 60 || d.name.includes('ST')) continue;
      try {
        stocks.set(sym, { name: d.name, candles: computeIndicators(d.candles as CandleWithIndicators[]) });
        n++;
      } catch { /* 略 */ }
    }
    console.log(` ${n} 支`);
  }
  const perDir = path.join(process.cwd(), 'data', 'candles', 'CN');
  if (fs.existsSync(perDir)) {
    process.stdout.write('  補充CN per-symbol...');
    let u = 0;
    for (const f of fs.readdirSync(perDir).filter(f => f.endsWith('.json'))) {
      const sym = f.replace('.json', '');
      try {
        const raw2 = JSON.parse(fs.readFileSync(path.join(perDir, f), 'utf-8'));
        const c2: CandleWithIndicators[] = Array.isArray(raw2) ? raw2 : raw2.candles ?? raw2;
        if (!c2 || c2.length < 60) continue;
        const existing = stocks.get(sym);
        const lastE = existing?.candles.at(-1)?.date?.slice(0, 10) ?? '';
        const lastN = c2.at(-1)?.date?.slice(0, 10) ?? '';
        if (lastN > lastE) {
          const nm = (raw2 as { name?: string }).name ?? existing?.name ?? sym;
          if (typeof nm === 'string' && nm.includes('ST')) continue;
          stocks.set(sym, { name: nm, candles: computeIndicators(c2) });
          u++;
        }
      } catch { /* 略 */ }
    }
    console.log(` 更新 ${u} 支，共 ${stocks.size} 支`);
  }
  return stocks;
}

// ══════════════════════════════════════════════════════════════
// 工具函式
// ══════════════════════════════════════════════════════════════

function dayGain(candles: CandleWithIndicators[], idx: number): number {
  if (idx <= 0) return 0;
  const p = candles[idx - 1].close;
  return p > 0 ? (candles[idx].close - p) / p * 100 : 0;
}

function consecutiveLimitUp(candles: CandleWithIndicators[], idx: number): number {
  let n = 0;
  for (let i = idx; i >= 1; i--) {
    if (dayGain(candles, i) >= LIMIT_UP) n++; else break;
  }
  return n;
}

// ══════════════════════════════════════════════════════════════
// 打板候選建立
// ══════════════════════════════════════════════════════════════

function buildCandidate(
  symbol: string, name: string,
  candles: CandleWithIndicators[], idx: number,
  sortFn: (f: DabanFeatures) => number,
): DabanFeatures | null {
  if (idx < 10 || idx + 3 >= candles.length) return null;

  const today = candles[idx];
  const yest  = candles[idx - 1];
  const db    = candles[idx - 2];

  // 昨日漲停
  const yestGain = db.close > 0 ? (yest.close - db.close) / db.close * 100 : 0;
  if (yestGain < LIMIT_UP) return null;

  // 昨天不能是一字板
  if (yest.open === yest.high && yest.high === yest.close) return null;

  const yestVol      = yest.volume ?? 0;
  const yestTurnover = yestVol * yest.close;
  if (yestTurnover < MIN_TO) return null;

  const gapUp = yest.close > 0 ? (today.open - yest.close) / yest.close * 100 : 0;
  if (gapUp < GAP_MIN || gapUp >= LIMIT_UP || gapUp > GAP_MAX) return null;

  const boards      = consecutiveLimitUp(candles, idx - 1);
  const vols5       = Array.from({ length: 5 }, (_, i) => candles[idx - 1 - i]?.volume ?? 0);
  const avgVol5     = vols5.reduce((a, b) => a + b, 0) / vols5.length;
  const yestVR      = avgVol5 > 0 ? yestVol / avgVol5 : 1;
  const yRange      = yest.high - yest.low;
  const upperShadow = yest.high - Math.max(yest.open, yest.close);
  const seal        = yRange > 0 ? 1 - upperShadow / yRange : 1;
  const mom5        = idx >= 6 ? (yest.close / candles[idx - 6].close - 1) * 100 : 0;

  const f: DabanFeatures = {
    symbol, name, idx, candles,
    entryPrice: today.open,
    gapUp: +gapUp.toFixed(2),
    boards, yestTurnover, yestVR, seal, mom5, rankScore: 0,
  };
  f.rankScore = sortFn(f);
  return f;
}

// ══════════════════════════════════════════════════════════════
// 出場策略
// ══════════════════════════════════════════════════════════════

function simulateExit(
  candles: CandleWithIndicators[],
  entryIdx: number,
  entryPrice: number,
  exitDef: ExitDef,
): ExitResult | null {
  const { tp, sl, maxHold, s1Mode } = exitDef;
  let maxGain = 0;

  for (let d = 0; d <= maxHold; d++) {
    const fi = entryIdx + d;
    if (fi >= candles.length) break;
    const c    = candles[fi];
    const prev = fi > 0 ? candles[fi - 1] : null;

    const highRet  = entryPrice > 0 ? (c.high  - entryPrice) / entryPrice * 100 : 0;
    const lowRet   = entryPrice > 0 ? (c.low   - entryPrice) / entryPrice * 100 : 0;
    const closeRet = entryPrice > 0 ? (c.close - entryPrice) / entryPrice * 100 : 0;
    if (closeRet > maxGain) maxGain = closeRet;

    // 進場日只看收盤
    if (d === 0) {
      if (closeRet <= sl) return { exitIdx: fi, exitPrice: c.close, exitReason: `止損${sl}%（進場日）` };
      if (!s1Mode && closeRet >= tp) return { exitIdx: fi, exitPrice: c.close, exitReason: `止盈${tp}%（進場日）` };
      continue;
    }

    // ① 止損
    if (lowRet <= sl) {
      return { exitIdx: fi, exitPrice: +(entryPrice * (1 + sl / 100)).toFixed(2), exitReason: `止損${sl}%` };
    }

    // ② 止盈（非S1模式）
    if (!s1Mode && highRet >= tp) {
      return { exitIdx: fi, exitPrice: +(entryPrice * (1 + tp / 100)).toFixed(2), exitReason: `止盈${tp}%` };
    }

    // S1 模式附加條件
    if (s1Mode) {
      // 漲超10%後跌破MA5
      if (maxGain >= S1_GATE && c.ma5 != null && c.close < c.ma5) {
        return { exitIdx: fi, exitPrice: c.close, exitReason: '漲超10%後跌破MA5' };
      }
      // 急漲後大量長黑K
      const vols5  = Array.from({ length: 5 }, (_, i) => candles[Math.max(0, fi - 1 - i)]?.volume ?? 0);
      const avgVol = vols5.reduce((a, b) => a + b, 0) / vols5.length;
      const volRatio = avgVol > 0 ? (c.volume ?? 0) / avgVol : 0;
      const body = Math.abs(c.close - c.open);
      if (fi >= 3) {
        const prev3Up     = [candles[fi-1], candles[fi-2], candles[fi-3]].every(x => x.close > x.open);
        const isLongBlack = c.close < c.open && body / c.open >= 0.02;
        if (prev3Up && isLongBlack && volRatio > 1.5) {
          return { exitIdx: fi, exitPrice: c.close, exitReason: '急漲後長黑K' };
        }
      }
      // 強覆蓋
      if (prev && prev.close > prev.open && c.close < c.open) {
        const midPrice = (prev.open + prev.close) / 2;
        const kdDown   = c.kdK != null && prev.kdK != null && c.kdK < prev.kdK;
        if (c.close < midPrice && kdDown) {
          return { exitIdx: fi, exitPrice: c.close, exitReason: '強覆蓋' };
        }
      }
      // 頭頭低
      if (fi >= 10) {
        const rh: number[] = [];
        for (let i = fi - 1; i >= Math.max(1, fi - 20) && rh.length < 2; i--) {
          const ci = candles[i], pi = candles[i-1], ni = candles[i+1];
          if (ci && pi && ni && ci.high > pi.high && ci.high > ni.high) rh.push(ci.high);
        }
        if (rh.length >= 2 && rh[0] < rh[1] && c.close < rh[0]) {
          return { exitIdx: fi, exitPrice: c.close, exitReason: '頭頭低' };
        }
      }
      // KD高位死叉
      if (c.kdK != null && c.kdD != null && prev?.kdK != null && prev.kdD != null) {
        if (prev.kdK > 70 && prev.kdK >= prev.kdD && c.kdK < c.kdD) {
          return { exitIdx: fi, exitPrice: c.close, exitReason: 'KD高位死叉' };
        }
      }
    }

    // 安全網
    if (d === maxHold) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: `持股${maxHold}天到期` };
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// 預計算：每天最佳候選（按排序因子）
// 只跑一次，所有出場策略共用
// ══════════════════════════════════════════════════════════════

interface DailySnapshot {
  /** key = sortBy，value = 當天該排序第1的候選（null = 無候選或市場冷） */
  best: Partial<Record<DabanSort, DabanFeatures | null>>;
}

function precompute(
  allStocks: Map<string, StockData>,
  tradingDays: string[],
  coldThreshold: number,
): Map<string, DailySnapshot> {
  // 每支股的 date→idx 快速查詢（避免重複 findIndex）
  const stockDateIdx = new Map<string, Map<string, number>>();
  for (const [symbol, sd] of allStocks) {
    const m = new Map<string, number>();
    for (let i = 0; i < sd.candles.length; i++) {
      const d = sd.candles[i].date?.slice(0, 10);
      if (d) m.set(d, i);
    }
    stockDateIdx.set(symbol, m);
  }

  const snapshots = new Map<string, DailySnapshot>();

  for (const date of tradingDays) {
    // 市場冷度
    let limitUpCount = 0;
    for (const [symbol, sd] of allStocks) {
      const idx = stockDateIdx.get(symbol)?.get(date);
      if (idx == null || idx < 2) continue;
      if (dayGain(sd.candles, idx - 1) >= LIMIT_UP) limitUpCount++;
    }

    const snap: DailySnapshot = { best: {} };

    if (limitUpCount >= coldThreshold) {
      // 每個排序因子各找第1名
      for (const sortBy of ALL_SORTS) {
        const sortFn = SORT_DEFS[sortBy];
        let topCand: DabanFeatures | null = null;

        for (const [symbol, sd] of allStocks) {
          const idx = stockDateIdx.get(symbol)?.get(date);
          if (idx == null) continue;
          const cand = buildCandidate(symbol, sd.name, sd.candles, idx, sortFn);
          if (!cand) continue;
          if (!topCand || cand.rankScore > topCand.rankScore) topCand = cand;
        }
        snap.best[sortBy] = topCand;
      }
    }

    snapshots.set(date, snap);
  }

  return snapshots;
}

// ══════════════════════════════════════════════════════════════
// 單一組合回測（使用預計算快照，速度大幅提升）
// ══════════════════════════════════════════════════════════════

function runCombo(
  market: 'TW' | 'CN',
  sortBy: DabanSort,
  exitDef: ExitDef,
  snapshots: Map<string, DailySnapshot>,
  tradingDays: string[],
): ComboResult {
  const costPct = market === 'TW' ? TW_COST : CN_COST;
  const trades: Trade[] = [];
  let capital = CAPITAL;
  let holdingUntilDayIdx = -1;

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    if (dayIdx <= holdingUntilDayIdx) continue;

    const date   = tradingDays[dayIdx];
    const snap   = snapshots.get(date);
    const picked = snap?.best[sortBy];
    if (!picked) continue;  // 市場冷 or 無候選

    const entryDayIdx = picked.idx;
    const exitResult  = simulateExit(picked.candles, entryDayIdx, picked.entryPrice, exitDef);
    if (!exitResult) continue;

    const { exitIdx, exitPrice } = exitResult;
    const exitDate   = picked.candles[exitIdx]?.date?.slice(0, 10) ?? '';
    const exitDayIdx = tradingDays.indexOf(exitDate);

    const grossPct = (exitPrice - picked.entryPrice) / picked.entryPrice * 100;
    const netPct   = grossPct - costPct;
    const pnl      = capital * netPct / 100;
    capital        = Math.max(0, capital + pnl);

    trades.push({
      netPct:       +netPct.toFixed(3),
      pnl:          +pnl.toFixed(0),
      capitalAfter: +capital.toFixed(0),
      holdDays:     exitIdx - entryDayIdx,
    });

    holdingUntilDayIdx = exitDayIdx >= 0 ? exitDayIdx : dayIdx + (exitIdx - entryDayIdx);
  }

  const finalCapital = trades.at(-1)?.capitalAfter ?? CAPITAL;
  const totalReturn  = (finalCapital - CAPITAL) / CAPITAL * 100;
  const wins         = trades.filter(t => t.netPct > 0);
  const winRate      = trades.length > 0 ? wins.length / trades.length * 100 : 0;
  const avgHold      = trades.length > 0 ? trades.reduce((s, t) => s + t.holdDays, 0) / trades.length : 0;

  let peak = CAPITAL, maxDD = 0, cap = CAPITAL;
  for (const t of trades) {
    cap = t.capitalAfter;
    if (cap > peak) peak = cap;
    const dd = (peak - cap) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  return { market, sortBy, exit: exitDef, totalReturn, tradeCount: trades.length, winRate, maxDD, avgHold, finalCapital };
}

// ══════════════════════════════════════════════════════════════
// 排行榜輸出
// ══════════════════════════════════════════════════════════════

function printLeaderboard(results: ComboResult[], market: 'TW' | 'CN'): void {
  const filtered = results.filter(r => r.market === market);
  filtered.sort((a, b) => b.totalReturn - a.totalReturn);

  console.log('\n' + '═'.repeat(100));
  console.log(`  【${market}打板】排行榜（共 ${filtered.length} 組）`);
  console.log('═'.repeat(100));
  console.log(
    '  排名  ' +
    '總報酬  '.padEnd(10) +
    '勝率   '.padEnd(8) +
    '最大回撤  '.padEnd(11) +
    '交易  '.padEnd(7) +
    '均持天  '.padEnd(8) +
    '出場策略                      排序因子'
  );
  console.log('─'.repeat(100));

  filtered.forEach((r, i) => {
    const ret = (r.totalReturn >= 0 ? '+' : '') + r.totalReturn.toFixed(1) + '%';
    const wr  = r.winRate.toFixed(0) + '%';
    const dd  = r.maxDD.toFixed(1) + '%';
    console.log(
      `  ${(i + 1).toString().padStart(3)}   ` +
      `${ret.padEnd(10)}${wr.padEnd(8)}${dd.padEnd(11)}` +
      `${r.tradeCount.toString().padEnd(7)}${r.avgHold.toFixed(1).padEnd(8)}` +
      `${r.exit.label.padEnd(30)}${r.sortBy}`
    );
  });

  const best = filtered[0];
  if (best) {
    console.log('\n  ★ 冠軍：');
    console.log(`    市場：${best.market}`);
    console.log(`    排序因子：${best.sortBy}`);
    console.log(`    出場策略：${best.exit.label}`);
    console.log(`    總報酬：${(best.totalReturn >= 0 ? '+' : '') + best.totalReturn.toFixed(2)}%`);
    console.log(`    勝率：${best.winRate.toFixed(1)}%`);
    console.log(`    最大回撤：${best.maxDD.toFixed(1)}%`);
    console.log(`    交易筆數：${best.tradeCount}`);
    console.log(`    最終資金：${best.finalCapital.toLocaleString()} 元`);
  }
  console.log('═'.repeat(100));
}

// ══════════════════════════════════════════════════════════════
// 主程式
// ══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const total = MARKETS_TO_RUN.length * ALL_SORTS.length * ALL_EXITS.length;

  console.log('\n  ╔══════════════════════════════════════╗');
  console.log('  ║   打板策略：全因子×全出場批量回測    ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log(`  週期：${PERIOD.start} ～ ${PERIOD.end}`);
  console.log(`  初始籌碼：${CAPITAL.toLocaleString()} 元`);
  console.log(`  高開區間：${GAP_MIN}~${GAP_MAX}%`);
  console.log(`  總組合數：${total}\n`);
  console.log('  出場策略：');
  for (const e of ALL_EXITS) console.log(`    ${e.label}`);

  const results: ComboResult[] = [];

  for (const market of MARKETS_TO_RUN) {
    console.log(`\n━━━ 載入 ${market} 資料 ━━━`);
    const allStocks = loadStocks(market);

    const tradingDaySet = new Set<string>();
    for (const [, sd] of allStocks) {
      for (const c of sd.candles) {
        const d = c.date?.slice(0, 10);
        if (d && d >= PERIOD.start && d <= PERIOD.end) tradingDaySet.add(d);
      }
    }
    const tradingDays = [...tradingDaySet].sort();
    console.log(`  交易日：${tradingDays[0]} ～ ${tradingDays.at(-1)} 共 ${tradingDays.length} 天`);

    const coldThreshold = market === 'CN' ? 15 : 5;
    process.stdout.write('  預計算每日最佳候選...');
    const snapshots = precompute(allStocks, tradingDays, coldThreshold);
    const activeDays = [...snapshots.values()].filter(s => Object.keys(s.best).length > 0).length;
    console.log(` 完成（有效交易日 ${activeDays}/${tradingDays.length} 天）`);

    const marketTotal = ALL_SORTS.length * ALL_EXITS.length;
    console.log(`  開始跑 ${marketTotal} 組合...\n`);

    let done = 0;
    for (const exitDef of ALL_EXITS) {
      for (const sortBy of ALL_SORTS) {
        const result = runCombo(market, sortBy, exitDef, snapshots, tradingDays);
        results.push(result);
        done++;
        process.stdout.write(`  進度：${done}/${marketTotal}\r`);
      }
    }
    process.stdout.write('\n');

    printLeaderboard(results, market);
  }

  // 跨市場 Top 10
  if (MARKETS_TO_RUN.length > 1) {
    const sorted = [...results].sort((a, b) => b.totalReturn - a.totalReturn);
    console.log('\n' + '═'.repeat(100));
    console.log('  【全市場 Top 10】');
    console.log('═'.repeat(100));
    sorted.slice(0, 10).forEach((r, i) => {
      const ret = (r.totalReturn >= 0 ? '+' : '') + r.totalReturn.toFixed(1) + '%';
      console.log(
        `  ${(i+1).toString().padStart(2)}. ${r.market}  ${ret.padEnd(10)}` +
        `${r.sortBy.padEnd(14)}${r.exit.label}`
      );
    });
    console.log('═'.repeat(100));
  }
}

main().catch(console.error);
