import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  MarketId, StockScanResult, StockForwardPerformance, BacktestSession,
} from '@/lib/scanner/types';
import { calcBacktestSummary } from '@/lib/backtest/ForwardAnalyzer';
import {
  BacktestTrade, BacktestStats, BacktestStrategyParams,
  DEFAULT_STRATEGY, runBatchBacktest, calcBacktestStats,
} from '@/lib/backtest/BacktestEngine';

// ── Types ──────────────────────────────────────────────────────────────────────

export type BacktestHorizon = 'open' | 'd1' | 'd2' | 'd3' | 'd4' | 'd5' | 'd10' | 'd20';

export interface BacktestSummary {
  count: number; wins: number; losses: number;
  winRate: number; avgReturn: number;
  median: number; maxGain: number; maxLoss: number;
}

interface BacktestState {
  // controls
  market:   MarketId;
  scanDate: string;
  strategy: BacktestStrategyParams;

  // scan phase
  isScanning:   boolean;
  scanProgress: number;
  scanError:    string | null;
  scanResults:  StockScanResult[];

  // forward phase
  isFetchingForward: boolean;
  forwardError:  string | null;
  performance:   StockForwardPerformance[];

  // engine phase (v2 — strict backtest)
  trades: BacktestTrade[];
  stats:  BacktestStats | null;

  // history
  sessions: BacktestSession[];

  // actions
  setMarket:    (m: MarketId) => void;
  setScanDate:  (d: string)   => void;
  setStrategy:  (s: Partial<BacktestStrategyParams>) => void;
  runBacktest:  () => Promise<void>;
  loadSession:  (id: string)  => void;
  clearCurrent: () => void;

  // helpers (legacy horizon stats)
  getSummary: (horizon: BacktestHorizon) => BacktestSummary | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function todayMinus1(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

// ── Store ──────────────────────────────────────────────────────────────────────

export const useBacktestStore = create<BacktestState>()(
  persist(
    (set, get) => ({
      market:   'TW',
      scanDate: todayMinus1(),
      strategy: DEFAULT_STRATEGY,

      isScanning:   false,
      scanProgress: 0,
      scanError:    null,
      scanResults:  [],

      isFetchingForward: false,
      forwardError:  null,
      performance:   [],

      trades: [],
      stats:  null,

      sessions: [],

      setMarket:   (market)   => set({ market }),
      setScanDate: (scanDate) => set({ scanDate }),
      setStrategy: (partial)  => set(s => ({ strategy: { ...s.strategy, ...partial } })),

      clearCurrent: () => set({
        scanResults: [], performance: [], trades: [], stats: null,
        scanError: null, forwardError: null,
        isScanning: false, isFetchingForward: false,
      }),

      getSummary: (horizon) => {
        const { performance } = get();
        if (!performance.length) return null;
        return calcBacktestSummary(performance, horizon) as BacktestSummary | null;
      },

      runBacktest: async () => {
        const { market, scanDate, strategy } = get();

        // ── Phase 1: Get stock list ──────────────────────────────────────────
        set({ isScanning: true, scanProgress: 5, scanError: null,
              scanResults: [], performance: [], trades: [], stats: null });

        let stocks: Array<{ symbol: string; name: string }>;
        try {
          const listRes = await fetch(`/api/scanner/list?market=${market}`);
          if (!listRes.ok) throw new Error('無法取得股票清單');
          const listJson = await listRes.json() as { stocks: Array<{ symbol: string; name: string }> };
          stocks = listJson.stocks ?? [];
        } catch (e) {
          set({ isScanning: false, scanError: String(e) });
          return;
        }

        set({ scanProgress: 15 });

        // ── Phase 2: Split into 2 chunks, scan in parallel ───────────────────
        const half   = Math.ceil(stocks.length / 2);
        const chunk1 = stocks.slice(0, half);
        const chunk2 = stocks.slice(half);

        const scanChunk = async (chunk: typeof stocks) => {
          const res = await fetch('/api/backtest/scan', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ market, date: scanDate, stocks: chunk }),
          });
          if (!res.ok) throw new Error(`掃描失敗 (${res.status})`);
          const json = await res.json() as { results?: StockScanResult[]; error?: string };
          if (json.error) throw new Error(json.error);
          return json.results ?? [];
        };

        set({ scanProgress: 30 });

        const [r1, r2] = await Promise.allSettled([scanChunk(chunk1), scanChunk(chunk2)]);

        if (r1.status === 'rejected' && r2.status === 'rejected') {
          set({ isScanning: false, scanError: `掃描失敗：${r1.reason}` });
          return;
        }

        const combined: StockScanResult[] = [
          ...(r1.status === 'fulfilled' ? r1.value : []),
          ...(r2.status === 'fulfilled' ? r2.value : []),
        ].sort((a, b) =>
          b.sixConditionsScore !== a.sixConditionsScore
            ? b.sixConditionsScore - a.sixConditionsScore
            : b.changePercent - a.changePercent
        );

        set({ scanResults: combined, isScanning: false, scanProgress: 100 });

        if (combined.length === 0) return;

        // ── Phase 3: Forward performance ─────────────────────────────────────
        set({ isFetchingForward: true, forwardError: null });

        try {
          const forwardPayload = combined.map(r => ({
            symbol:    r.symbol,
            name:      r.name,
            scanPrice: r.price,
          }));
          const fwdRes = await fetch('/api/backtest/forward', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ scanDate, stocks: forwardPayload }),
          });
          if (!fwdRes.ok) throw new Error('無法取得後續績效資料');
          const fwdJson = await fwdRes.json() as { performance?: StockForwardPerformance[] };
          const performance = fwdJson.performance ?? [];

          // ── Phase 4: Run strict BacktestEngine ────────────────────────────
          // Build forward candles map: symbol → ForwardCandle[]
          const candlesMap: Record<string, typeof performance[0]['forwardCandles']> = {};
          for (const p of performance) {
            candlesMap[p.symbol] = p.forwardCandles;
          }

          const trades = runBatchBacktest(combined, candlesMap, strategy);
          const stats  = calcBacktestStats(trades);

          // ── Save session ──────────────────────────────────────────────────
          const session: BacktestSession = {
            id:          `${market}-${scanDate}-${Date.now()}`,
            market,
            scanDate,
            createdAt:   new Date().toISOString(),
            scanResults: combined,
            performance,
            trades,
            stats:       stats ?? undefined,
            strategyVersion: `holdDays=${strategy.holdDays},sl=${strategy.stopLoss ?? 'off'},tp=${strategy.takeProfit ?? 'off'}`,
          };

          set(s => ({
            performance,
            trades,
            stats,
            isFetchingForward: false,
            sessions: [session, ...s.sessions].slice(0, 20),
          }));
        } catch (e) {
          set({ isFetchingForward: false, forwardError: String(e) });
        }
      },

      loadSession: (id) => {
        const session = get().sessions.find(s => s.id === id);
        if (!session) return;
        set({
          market:      session.market,
          scanDate:    session.scanDate,
          scanResults: session.scanResults,
          performance: session.performance,
          trades:      session.trades ?? [],
          stats:       session.stats  ?? null,
        });
      },
    }),
    {
      name: 'backtest-v2',
      partialize: (s) => ({
        market: s.market, scanDate: s.scanDate,
        strategy: s.strategy, sessions: s.sessions,
      }),
    }
  )
);
