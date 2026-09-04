/**
 * Contract test: 面板顯示 vs applyPanelFilter 一致性
 *
 * 驗證 CLAUDE.md Fundamental Rule R10 — 選股邏輯單一事實
 *
 * 規則：對任何 session date，前端 MTF toggle 過濾結果必須等同於
 *       `applyPanelFilter(session.results, { useMultiTimeframe: true })`。
 *       回測腳本第 1 名必須等同於同一 filter 的第 1 名（有樣本可驗時）。
 */
import fs from 'fs';
import path from 'path';
import { applyPanelFilter, isDisposalVetoed, sortByPanelOrder } from '@/lib/selection/applyPanelFilter';
import { deriveStep1FilterState } from '@/lib/scanner/step1Pool';
import type { StockScanResult } from '@/lib/scanner/types';

interface Session {
  market: string;
  date: string;
  direction: string;
  multiTimeframeEnabled: boolean;
  results: StockScanResult[];
}

function loadSession(fileName: string): Session | null {
  const p = path.join(process.cwd(), 'data', fileName);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

// 取三個有內容且含 MTF 混合樣本的日期
const SAMPLES = [
  'scan-TW-long-mtf-2026-03-19.json',     // 4 筆全 weekly=false
  'scan-TW-long-daily-2026-03-20.json',   // 2 筆
  'scan-TW-long-daily-2026-04-16.json',   // 3 筆
];

describe('Scan panel parity contracts (R10)', () => {
  describe('Step 1 池狀態', () => {
    test('多頭軌：池檔存在但 symbols 為空仍是 applied，不可當成 missing 放行', () => {
      expect(deriveStep1FilterState('B', true)).toBe('applied');
    });

    test('多頭軌缺池才是 missing；反轉軌不論池是否存在皆 bypassed', () => {
      expect(deriveStep1FilterState('B', false)).toBe('missing');
      expect(deriveStep1FilterState('D', false)).toBe('bypassed');
      expect(deriveStep1FilterState('D', true)).toBe('bypassed');
    });
  });

  describe('applyPanelFilter 排序穩定', () => {
    test('空陣列回空陣列', () => {
      expect(applyPanelFilter([], { useMultiTimeframe: false })).toEqual([]);
      expect(applyPanelFilter([], { useMultiTimeframe: true })).toEqual([]);
    });

    test('漲幅 desc 優先，六條件總分次要', () => {
      const mk = (s: string, chg: number, six: number): StockScanResult => ({
        symbol: s, name: s, market: 'TW', industry: '',
        price: 100, changePercent: chg, volume: 0,
        triggeredRules: [], sixConditionsScore: six,
        sixConditionsBreakdown: {
          trend: true, position: true, kbar: true, ma: true, volume: true, indicator: true,
        },
        trendState: '多頭', trendPosition: '',
        scanTime: '2026-04-19T00:00:00.000Z',
        highWinRateScore: 0, highWinRateTypes: [], highWinRateDetails: [],
      } as unknown as StockScanResult);

      const results = [
        mk('A', 3, 5),  // 漲幅 3，六條件 5
        mk('B', 5, 4),  // 漲幅 5（最高）
        mk('C', 3, 6),  // 漲幅 3，六條件 6（比 A 高）
      ];
      const sorted = applyPanelFilter(results, { useMultiTimeframe: false });
      expect(sorted.map(r => r.symbol)).toEqual(['B', 'C', 'A']);
    });

    test('極接近漲幅仍由主鍵決定，不被六條件加權反轉', () => {
      const rows = [
        { symbol: 'higher-change', changePercent: 1.001, sixConditionsScore: 1, trendState: '盤整' },
        { symbol: 'higher-score', changePercent: 1, sixConditionsScore: 6, trendState: '盤整' },
      ] as unknown as StockScanResult[];
      expect(sortByPanelOrder(rows, 'desc').map((r) => r.symbol)).toEqual(['higher-change', 'higher-score']);
      expect(sortByPanelOrder(rows, 'asc').map((r) => r.symbol)).toEqual(['higher-score', 'higher-change']);
    });
  });

  // 2026-05-31 補：合成樣本鎖死 MTF gate 語意，不依賴 data/ 檔是否存在。
  // 這是 backtest-run.ts / backtest-all.ts 兩大 runner 內聯 gate
  // （`candidates.filter(c => c.mtfWeeklyPass === true)`）必須鏡像的「單一事實」。
  // 若哪天有人把 applyPanelFilter 改回 mtfScore>=3，這組會立刻紅燈（鐵律 #10）。
  describe('MTF gate 語意（合成樣本，正例必留 / null+false 必剔）', () => {
    const mkMtf = (sym: string, weekly: boolean | null): StockScanResult => ({
      symbol: sym, name: sym, market: 'TW', industry: '',
      price: 100, changePercent: 1, volume: 0,
      triggeredRules: [], sixConditionsScore: 5,
      sixConditionsBreakdown: {
        trend: true, position: true, kbar: true, ma: true, volume: true, indicator: true,
      },
      trendState: '多頭', trendPosition: '',
      scanTime: '2026-05-31T00:00:00.000Z',
      highWinRateScore: 0, highWinRateTypes: [], highWinRateDetails: [],
      mtfWeeklyPass: weekly,
    } as unknown as StockScanResult);

    const mixed = [mkMtf('PASS1', true), mkMtf('FAIL', false), mkMtf('NULLV', null), mkMtf('PASS2', true)];

    test('MTF on：只留 mtfWeeklyPass === true（null 與 false 都剔除）', () => {
      const filtered = applyPanelFilter(mixed, { useMultiTimeframe: true });
      expect(filtered.map(r => r.symbol).sort()).toEqual(['PASS1', 'PASS2']);
    });

    test('MTF off：全保留（gate 不作用）', () => {
      const filtered = applyPanelFilter(mixed, { useMultiTimeframe: false });
      expect(filtered).toHaveLength(4);
    });

    test('canonical 述詞 === backtest runner 內聯 gate（兩處 filter 同語意）', () => {
      // backtest-run.ts:332 / backtest-all.ts:330 用的就是這個 predicate
      const runnerGate = (c: StockScanResult) =>
        (c as { mtfWeeklyPass?: boolean | null }).mtfWeeklyPass === true;
      const viaPanel = applyPanelFilter(mixed, { useMultiTimeframe: true }).map(r => r.symbol).sort();
      const viaRunner = mixed.filter(runnerGate).map(r => r.symbol).sort();
      expect(viaRunner).toEqual(viaPanel);
    });
  });

  // 2026-06-12 B1：處置股硬排除（合成樣本鎖死語意）。
  // 旗標由 saveScanSession 按官方名單蓋章（lib/market/attentionList.ts），
  // applyPanelFilter / backtestStore 三個結果落地點 / backtest-run·all 的
  // isDisposedOnSync 都必須鏡像「disposalVeto === true 一律剔除」。
  // 注意股（attentionNotice）只警示不排除 — 也在此鎖死。
  describe('處置股 veto gate（disposalVeto 必剔 / attentionNotice 必留）', () => {
    const mkVeto = (sym: string, flags: { disposalVeto?: boolean; attentionNotice?: boolean }): StockScanResult => ({
      symbol: sym, name: sym, market: 'TW', industry: '',
      price: 100, changePercent: 1, volume: 0,
      triggeredRules: [], sixConditionsScore: 5,
      sixConditionsBreakdown: {
        trend: true, position: true, kbar: true, ma: true, volume: true, indicator: true,
      },
      trendState: '多頭', trendPosition: '',
      scanTime: '2026-06-12T00:00:00.000Z',
      highWinRateScore: 0, highWinRateTypes: [], highWinRateDetails: [],
      mtfWeeklyPass: true,
      ...flags,
    } as unknown as StockScanResult);

    const mixed = [
      mkVeto('GOOD', {}),
      mkVeto('DISPO', { disposalVeto: true }),
      mkVeto('NOTICE', { attentionNotice: true }),
      mkVeto('LEGACY', { disposalVeto: undefined }), // 歷史 session 無此欄位
    ];

    test('disposalVeto=true 一律剔除（MTF off）', () => {
      const filtered = applyPanelFilter(mixed, { useMultiTimeframe: false });
      expect(filtered.map(r => r.symbol).sort()).toEqual(['GOOD', 'LEGACY', 'NOTICE']);
    });

    test('disposalVeto=true 一律剔除（MTF on，veto 不受 toggle 影響）', () => {
      const filtered = applyPanelFilter(mixed, { useMultiTimeframe: true });
      expect(filtered.map(r => r.symbol).sort()).toEqual(['GOOD', 'LEGACY', 'NOTICE']);
    });

    test('isDisposalVetoed 述詞 === applyPanelFilter 剔除集（單一事實）', () => {
      const viaPanel = applyPanelFilter(mixed, { useMultiTimeframe: false }).map(r => r.symbol).sort();
      const viaPredicate = mixed.filter(r => !isDisposalVetoed(r)).map(r => r.symbol).sort();
      expect(viaPredicate).toEqual(viaPanel);
    });

    test('attentionNotice 只警示不排除', () => {
      const filtered = applyPanelFilter([mkVeto('N1', { attentionNotice: true })], { useMultiTimeframe: false });
      expect(filtered).toHaveLength(1);
    });
  });

  describe.each(SAMPLES)('對樣本 %s', fileName => {
    const session = loadSession(fileName);
    const testOrSkip = session ? test : test.skip;

    testOrSkip('MTF toggle=off 保留所有 ScanPipeline 產生的 results', () => {
      if (!session) return;
      const filtered = applyPanelFilter(session.results, { useMultiTimeframe: false });
      expect(filtered.length).toBe(session.results.length);
    });

    testOrSkip('MTF toggle=on 只保留 mtfWeeklyPass === true', () => {
      // 2026-05-07 修：原合約用 mtfScore >= 3，與 applyPanelFilter 實作的 mtfWeeklyPass === true 不一致 → 失效。
      // 鐵律 #10：選股邏輯單一事實，合約必須對齊 applyPanelFilter。
      if (!session) return;
      const filtered = applyPanelFilter(session.results, { useMultiTimeframe: true });
      for (const r of filtered) {
        expect((r as { mtfWeeklyPass?: boolean }).mtfWeeklyPass).toBe(true);
      }
      const expected = session.results.filter(r => (r as { mtfWeeklyPass?: boolean }).mtfWeeklyPass === true).length;
      expect(filtered.length).toBe(expected);
    });

    testOrSkip('排序後 #1 六條件總分必為全組最高', () => {
      if (!session || session.results.length === 0) return;
      const sorted = applyPanelFilter(session.results, { useMultiTimeframe: false });
      const maxScore = Math.max(...session.results.map(r => r.sixConditionsScore ?? 0));
      expect(sorted[0].sixConditionsScore ?? 0).toBe(maxScore);
    });
  });
});
