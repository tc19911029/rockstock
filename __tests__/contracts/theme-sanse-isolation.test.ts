/**
 * Contract test：題材熱度 × 三色策略 交叉選股
 *
 * 1. import 隔離 — lib/theme-sanse/** 不可 import 書本選股鏈
 *    （applyPanelFilter / ScanPipeline / MarketScanner / backtestStore）。
 *    只掃實際 import 指定符（from '…' / import('…')），不掃註解，避免檔頭說明誤判。
 * 2. crossSelect golden（純函式）：cross = 交集、sanse = 全過 gate、theme = 熱題材成分；
 *    passesSanse 遵守 minComboRank/excludeVerdicts；降 minComboRank 必單調放大 cross/sanse。
 */
import fs from 'fs';
import path from 'path';
import {
  COMBO_LABEL,
  COMBO_RANK,
  type Cond,
  type ComboGrade,
  type ConditionReport,
  type GroupReport,
  type MainStage,
} from '@/lib/cn-sanse/conditions';
import type { ResonanceRecord } from '@/lib/cn-sanse/scan';
import { computeEventReturns } from '@/lib/backtest/eventReturns';
import type { BaselineCandle, RecoBaseline } from '@/lib/backtest/eventBaseline';
import { crossSelect, passesSanse } from '@/lib/theme-sanse/crossSelect';
import { mergePreservingBaseline } from '@/lib/theme-sanse/events';
import { aggregateCohort, type ThemeSanseEventWithReturns } from '@/lib/theme-sanse/stats';
import {
  DEFAULT_CROSS_THRESHOLDS,
  THEME_SANSE_SCHEMA_VERSION,
  type HotTheme,
  type ThemeRef,
  type ThemeSanseEvent,
  type ThemeSanseEventsFile,
} from '@/lib/theme-sanse/types';

// ── 1. import 隔離 ──────────────────────────────────────────────────────────

const FORBIDDEN = [
  'selection/applyPanelFilter',
  'scanner/ScanPipeline',
  'scanner/MarketScanner',
  'store/backtestStore',
];

function importSpecifiers(src: string): string[] {
  const specs: string[] = [];
  for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) specs.push(m[1]);
  for (const m of src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
  return specs;
}

describe('theme-sanse import 隔離（不碰書本選股鏈）', () => {
  const dir = path.join(process.cwd(), 'lib', 'theme-sanse');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.ts')) : [];

  test('lib/theme-sanse 有檔案', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    test(`${f} 不 import 書本選股鏈`, () => {
      const src = fs.readFileSync(path.join(dir, f), 'utf-8');
      const specs = importSpecifiers(src);
      const offenders = specs.filter((s) => FORBIDDEN.some((bad) => s.includes(bad)));
      expect(offenders).toEqual([]);
    });
  }
});

// ── 2. crossSelect golden ───────────────────────────────────────────────────

const sig = (id: string, label: string, met: boolean): Cond => ({ id, label, met, kind: 'signal' });

function mkReport(opts: { grade: ComboGrade; mainStage?: MainStage; exitSignal?: boolean }): ConditionReport {
  const exit = !!opts.exitSignal;
  const doubleB: GroupReport = {
    buy: [],
    sell: exit ? [sig('b_dead', '黃紅死叉', true)] : [],
    buyHit: false,
    sellHit: exit,
  };
  const empty: GroupReport = { buy: [], sell: [], buyHit: false, sellHit: false };
  const grade = opts.grade;
  return {
    doubleB,
    mainforce: empty,
    catch: empty,
    mainStage: opts.mainStage ?? 'develop',
    groupBuyCount: 2,
    level: 'medium',
    selected: true,
    conflict: exit,
    sellWarnings: exit ? ['黃紅死叉'] : [],
    scores: { shortAttack: 1, midStrength: 2, midControl: 1, kongPan: 50 },
    combo: {
      grade,
      rank: COMBO_RANK[grade],
      label: COMBO_LABEL[grade],
      redGate: true,
      trigger: true,
      bottomReversal: false,
      midline: grade === 'mid',
    },
  };
}

function mkRecord(code: string, report: ConditionReport): ResonanceRecord {
  return { symbol: code, name: `股${code}`, industry: '測試', price: 100, changePct: 1, report };
}

const records: ResonanceRecord[] = [
  mkRecord('A1', mkReport({ grade: 'prime' })),                  // 過 gate, in T1
  mkRecord('A2', mkReport({ grade: 'top', mainStage: 'full' })), // 過 gate, in T1
  mkRecord('A3', mkReport({ grade: 'mid' })),                    // rank3 < 4 → 預設不過
  mkRecord('B1', mkReport({ grade: 'prime' })),                  // 過 gate 但題材非 top
  mkRecord('C1', mkReport({ grade: 'prime', exitSignal: true })),// 有賣訊 → conflict → 永遠不過
];

const T1ref: ThemeRef = { themeId: 'T1', themeName: '熱題材一', heatRank: 1 };
const T9ref: ThemeRef = { themeId: 'T9', themeName: '冷題材九', heatRank: 9 };
const codeToThemes = new Map<string, ThemeRef[]>([
  ['A1', [T1ref]], ['A2', [T1ref]], ['A3', [T1ref]], ['C1', [T1ref]],
  ['B1', [T9ref]],
]);

const hotThemes: HotTheme[] = [
  {
    id: 'T1', name: '熱題材一', kind: 'tw_theme', heatScore: 90, heatRank: 1,
    why: { avgRet: 8, limitUpCount: null, maxConsecBoard: null, volExpansion: 2, mainNetInflow: 5, popularity: null, lhbNetBuy: null, breadth: 0.7 },
    members: [
      { code: 'A1', name: '股A1', symbol: 'A1.TW', score: 5 },
      { code: 'A2', name: '股A2', symbol: 'A2.TW', score: 3 },
      { code: 'X9', name: '股X9', symbol: 'X9.TW', score: 1 },
    ],
    memberCount: 3, leaderCode: 'A1', source: 'tw_sector', degraded: false,
  },
  {
    id: 'T9', name: '冷題材九', kind: 'tw_theme', heatScore: 10, heatRank: 9,
    why: { avgRet: -2, limitUpCount: null, maxConsecBoard: null, volExpansion: 1, mainNetInflow: -3, popularity: null, lhbNetBuy: null, breadth: 0.3 },
    members: [{ code: 'B1', name: '股B1', symbol: 'B1.TW', score: 2 }],
    memberCount: 1, leaderCode: 'B1', source: 'tw_sector', degraded: false,
  },
];

describe('crossSelect golden', () => {
  test('passesSanse 遵守 minComboRank（prime/top 過、mid 不過）', () => {
    expect(passesSanse(mkReport({ grade: 'prime' }), DEFAULT_CROSS_THRESHOLDS)).toBe(true);
    expect(passesSanse(mkReport({ grade: 'top' }), DEFAULT_CROSS_THRESHOLDS)).toBe(true);
    expect(passesSanse(mkReport({ grade: 'mid' }), DEFAULT_CROSS_THRESHOLDS)).toBe(false);
    expect(passesSanse(mkReport({ grade: 'watch' }), DEFAULT_CROSS_THRESHOLDS)).toBe(false);
  });

  test('passesSanse 排除 sell/conflict（有賣訊的 prime 不過）', () => {
    expect(passesSanse(mkReport({ grade: 'prime', exitSignal: true }), DEFAULT_CROSS_THRESHOLDS)).toBe(false);
  });

  test('預設門檻：sanse = 全過 gate；cross = 過 gate ∩ 前 N 熱題材', () => {
    const { cross, sanse, theme } = crossSelect('TW', hotThemes, records, codeToThemes);
    expect(new Set(sanse.map((c) => c.code))).toEqual(new Set(['A1', 'A2', 'B1']));
    expect(new Set(cross.map((c) => c.code))).toEqual(new Set(['A1', 'A2']));
    // cross ⊆ sanse（membership 不變式）
    const sanseCodes = new Set(sanse.map((c) => c.code));
    for (const c of cross) expect(sanseCodes.has(c.code)).toBe(true);
    // theme-only = 前 N 熱題材成分（不要求三色）— 含未過三色的 X9；
    // B1 的題材 T9(熱度#9) 不在前 8 → 不入 theme-only
    expect(new Set(theme.map((c) => c.code))).toEqual(new Set(['A1', 'A2', 'X9']));
  });

  test('cross 帶完整註記（題材 ref + 三色狀態 + 一眼結論）', () => {
    const { cross } = crossSelect('TW', hotThemes, records, codeToThemes);
    const a2 = cross.find((c) => c.code === 'A2')!;
    expect(a2.bestThemeRank).toBe(1);
    expect(a2.themes[0].themeId).toBe('T1');
    expect(a2.sanseState).toBe('full');
    expect(a2.verdict).toBe('buy');
    expect(a2.themeSanseCoverage).toBe('full'); // TW 無創業板覆蓋問題
  });

  test('降 minComboRank → cross / sanse 單調放大（mid 進場）', () => {
    const loose = { ...DEFAULT_CROSS_THRESHOLDS, minComboRank: 3 };
    const base = crossSelect('TW', hotThemes, records, codeToThemes);
    const wide = crossSelect('TW', hotThemes, records, codeToThemes, loose);
    const sub = (a: { code: string }[], b: { code: string }[]) =>
      a.every((x) => b.some((y) => y.code === x.code));
    expect(sub(base.cross, wide.cross)).toBe(true);
    expect(sub(base.sanse, wide.sanse)).toBe(true);
    expect(wide.cross.length).toBeGreaterThan(base.cross.length); // A3 進來
    expect(new Set(wide.cross.map((c) => c.code))).toEqual(new Set(['A1', 'A2', 'A3']));
  });

  test('topThemes 收緊（只取 1 個）→ B1 永遠不入 cross（題材非 top）', () => {
    const { cross } = crossSelect('TW', hotThemes, records, codeToThemes, { ...DEFAULT_CROSS_THRESHOLDS, topThemes: 1 });
    expect(cross.some((c) => c.code === 'B1')).toBe(false);
  });
});

// ── 3. 防前視（cohort 路徑透傳 visibleUntil 給 computeEventReturns） ──────────

describe('防前視 anti-lookahead', () => {
  const candles: BaselineCandle[] = [
    { date: '2026-06-01', open: 99, high: 100, low: 98, close: 99, volume: 1 }, // 提及日 D
    { date: '2026-06-02', open: 100, high: 110, low: 95, close: 105, volume: 1 }, // base_date（進場）
    { date: '2026-06-03', open: 106, high: 112, low: 104, close: 108, volume: 1 },
    { date: '2026-06-04', open: 108, high: 115, low: 107, close: 113, volume: 1 },
    { date: '2026-06-05', open: 113, high: 120, low: 112, close: 118, volume: 1 },
    { date: '2026-06-06', open: 118, high: 125, low: 117, close: 123, volume: 1 },
  ];
  const baseline: RecoBaseline = { status: 'filled', base_date: '2026-06-02', entry_open: 100, mention_close: 99, settled_at: 'x' };

  test('站在進場日 D+0：d1（自身收盤）可見，d2..d5 未走完 → null', () => {
    const r = computeEventReturns({ baseline }, candles, null, { visibleUntil: '2026-06-02' });
    expect(r).not.toBeNull();
    expect(r!.d1).not.toBeNull();   // d1 = base_date 收盤（visibleUntil 當天）
    expect(r!.d2).toBeNull();       // 06-03 > visibleUntil
    expect(r!.d5).toBeNull();
  });

  test('看全歷史（無 asOf）：d1..d5 都走完', () => {
    const r = computeEventReturns({ baseline }, candles, null);
    expect(r!.d1).not.toBeNull();
    expect(r!.d5).not.toBeNull();
  });
});

// ── 4. idempotency：重建保留已結算 baseline，pending 不保留 ──────────────────

function mkEvent(id: string, baseline: RecoBaseline | null): ThemeSanseEvent {
  return {
    id, market: 'TW', date: '2026-06-01', cohort: 'cross',
    code: id, symbol: `${id}.TW`, name: id,
    themeIds: [], themeNames: [], bestThemeRank: null,
    namedStrategies: [], sanseState: null, comboGrade: null, verdict: null, verdictReversal: false,
    reason: '', baseline,
  };
}
function mkFile(events: ThemeSanseEvent[]): ThemeSanseEventsFile {
  return { schemaVersion: THEME_SANSE_SCHEMA_VERSION, market: 'TW', date: '2026-06-01', generatedAt: 'x', thresholds: DEFAULT_CROSS_THRESHOLDS, events };
}

describe('mergePreservingBaseline 冪等', () => {
  const filled: RecoBaseline = { status: 'filled', base_date: '2026-06-02', entry_open: 100, mention_close: 99, settled_at: 'x' };
  const pending: RecoBaseline = { status: 'pending', base_date: null, entry_open: null, mention_close: 99, settled_at: null };

  test('已結算(filled) baseline 重建後保留；pending 不保留；新事件 baseline=null', () => {
    const old = mkFile([mkEvent('A', filled), mkEvent('B', pending)]);
    const fresh = mkFile([mkEvent('A', null), mkEvent('B', null), mkEvent('C', null)]);
    const merged = mergePreservingBaseline(old, fresh);
    expect(merged.events.find((e) => e.id === 'A')!.baseline).toEqual(filled);
    expect(merged.events.find((e) => e.id === 'B')!.baseline).toBeNull();
    expect(merged.events.find((e) => e.id === 'C')!.baseline).toBeNull();
  });

  test('old=null → 原樣回傳 fresh', () => {
    const fresh = mkFile([mkEvent('A', null)]);
    expect(mergePreservingBaseline(null, fresh)).toBe(fresh);
  });
});

// ── 5. aggregateCohort 指標數學 ───────────────────────────────────────────────

function mkReturns(d5: number): ThemeSanseEventWithReturns['returns'] {
  return {
    d1: null, d2: null, d3: null, d4: null, d5, d10: null, d20: null, d60: null,
    mfe: Math.abs(d5) + 2, mae: -(Math.abs(d5) + 1),
    excess: { d1: null, d2: null, d3: null, d4: null, d5: d5 - 1, d10: null, d20: null, d60: null },
    isOpen: true, lastTrackedDate: '2026-06-05', holdReturn: d5, holdExcess: d5 - 1,
  };
}
function mkWithReturns(id: string, status: RecoBaseline['status'], d5: number | null): ThemeSanseEventWithReturns {
  const base: RecoBaseline = { status, base_date: '2026-06-02', entry_open: 100, mention_close: 99, settled_at: 'x' };
  return { ...mkEvent(id, base), returns: status === 'filled' && d5 != null ? mkReturns(d5) : null };
}

describe('aggregateCohort 指標', () => {
  test('winRate / avg / profitFactor / 樣本計數', () => {
    const events = [
      mkWithReturns('a', 'filled', 5),
      mkWithReturns('b', 'filled', -3),
      mkWithReturns('c', 'filled', 2),
      mkWithReturns('d', 'no_fill', null),
    ];
    const s = aggregateCohort('sanse', events);
    expect(s.n).toBe(4);
    expect(s.filled).toBe(3);
    expect(s.unfillable).toBe(1);
    expect(s.winRate.d5).toBeCloseTo(2 / 3, 2);          // 2 正 / 3 有效
    expect(s.avg.d5).toBeCloseTo((5 - 3 + 2) / 3, 2);    // 1.33
    expect(s.profitFactor).toBeCloseTo((5 + 2) / 3, 2);  // 賺7 / 賠3 = 2.33
    expect(s.maxDrawdown).not.toBeNull();
  });

  test('無虧損樣本 → profitFactor = null（不報 Infinity）', () => {
    const s = aggregateCohort('cross', [mkWithReturns('a', 'filled', 5), mkWithReturns('b', 'filled', 3)]);
    expect(s.profitFactor).toBeNull();
  });
});
