import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { StockScanResult, ScanSession, MarketId } from '@/lib/scanner/types';

const TW_STOCK_NAMES = [
  '台積電','聯發科','日月光投控','聯電','聯詠','瑞昱','矽力','華邦電','力積電','旺宏',
  '南亞科','京元電子','創意','力成','信驊','同欣電','環球晶','中美晶','鴻海','廣達',
  '台達電','緯穎','緯創','和碩','英業達','研華','臻鼎','光寶科','聯強','奇鋐',
];
const CN_STOCK_NAMES = [
  '貴州茅台','中國平安','招商銀行','工商銀行','長江電力','農業銀行','建設銀行',
  '中國銀行','紫金礦業','伊利股份','中國石化','恆瑞醫藥','五糧液','美的集團',
  '比亞迪','格力電器','平安銀行','中信證券','興業銀行','海康威視',
];

const MAX_HISTORY = 30;

// ── Per-market scan state ──────────────────────────────────────────────────────
interface MarketScanState {
  isScanning: boolean;
  progress: number;
  scanningStock: string;
  scanningIndex: number;
  scanningTotal: number;
  results: StockScanResult[];
  lastScanTime: string | null;
  error: string | null;
}

const DEFAULT_TW: MarketScanState = {
  isScanning: false, progress: 0, scanningStock: '', scanningIndex: 0,
  scanningTotal: 500, results: [], lastScanTime: null, error: null,
};
const DEFAULT_CN: MarketScanState = {
  isScanning: false, progress: 0, scanningStock: '', scanningIndex: 0,
  scanningTotal: 500, results: [], lastScanTime: null, error: null,
};

interface ScannerStore {
  activeMarket: MarketId;
  tw: MarketScanState;
  cn: MarketScanState;
  twHistory: ScanSession[];
  cnHistory: ScanSession[];

  setActiveMarket: (market: MarketId) => void;
  runScan: (market: MarketId) => Promise<void>;
  getHistory: (market: MarketId) => ScanSession[];
  getMarket: (market: MarketId) => MarketScanState;
}

export const useScannerStore = create<ScannerStore>()(
  persist(
    (set, get) => ({
      activeMarket: 'TW',
      tw: DEFAULT_TW,
      cn: DEFAULT_CN,
      twHistory: [],
      cnHistory: [],

      setActiveMarket: (market) => set({ activeMarket: market }),
      getHistory: (market) => market === 'TW' ? get().twHistory : get().cnHistory,
      getMarket: (market) => market === 'TW' ? get().tw : get().cn,

      runScan: async (market) => {
        const mKey  = market === 'TW' ? 'tw' : 'cn';
        const names = market === 'TW' ? TW_STOCK_NAMES : CN_STOCK_NAMES;

        set(s => ({
          [mKey]: { ...s[mKey], isScanning: true, progress: 0, scanningStock: '取得股票清單中...', scanningIndex: 0, scanningTotal: 0, error: null },
        }));

        try {
          // ── Step 1: Fetch complete stock list ──────────────────────────────
          const listRes = await fetch(`/api/scanner/list?market=${market}`);
          if (!listRes.ok) throw new Error('無法取得股票清單');
          const listJson = await listRes.json() as { stocks: Array<{ symbol: string; name: string }> };
          const stocks = listJson.stocks ?? [];
          const total  = stocks.length;

          set(s => ({
            [mKey]: { ...s[mKey], scanningStock: '分析股票中...', scanningTotal: total, scanningIndex: 0 },
          }));

          // ── Step 2: Split into 2 parallel chunks ───────────────────────────
          const half   = Math.ceil(total / 2);
          const chunk1 = stocks.slice(0, half);
          const chunk2 = stocks.slice(half);

          // Progress simulation over ~90s (typical scan duration)
          const estMs = 90_000;
          let elapsed = 0;
          const TICK  = 1500;
          const timer = setInterval(() => {
            elapsed += TICK;
            const pct = Math.min(88, Math.round((elapsed / estMs) * 88));
            const ni  = Math.min(Math.floor((elapsed / estMs) * names.length), names.length - 1);
            const ai  = Math.min(Math.round((elapsed / estMs) * total), total - 1);
            set(s => ({ [mKey]: { ...s[mKey], progress: pct, scanningStock: names[ni], scanningIndex: ai + 1 } }));
          }, TICK);

          const scanChunk = async (chunk: Array<{ symbol: string; name: string }>) => {
            const res = await fetch('/api/scanner/chunk', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ market, stocks: chunk }),
            });
            if (!res.ok) {
              const j = await res.json().catch(() => ({}));
              throw new Error((j as { error?: string }).error ?? '掃描失敗');
            }
            const j = await res.json() as { results?: StockScanResult[] };
            return j.results ?? [];
          };

          // ── Step 3: Run both chunks in parallel ────────────────────────────
          const [r1, r2] = await Promise.allSettled([
            scanChunk(chunk1),
            scanChunk(chunk2),
          ]);
          clearInterval(timer);

          const results: StockScanResult[] = [
            ...(r1.status === 'fulfilled' ? r1.value : []),
            ...(r2.status === 'fulfilled' ? r2.value : []),
          ].sort((a, b) =>
            b.sixConditionsScore !== a.sixConditionsScore
              ? b.sixConditionsScore - a.sixConditionsScore
              : b.changePercent - a.changePercent
          );

          // Log if either chunk failed
          if (r1.status === 'rejected') console.warn('[scanner] chunk1 failed:', r1.reason);
          if (r2.status === 'rejected') console.warn('[scanner] chunk2 failed:', r2.reason);

          const now = new Date().toISOString();
          const session: ScanSession = {
            id:          `${market}-${now}`,
            market,
            date:        now.split('T')[0],
            scanTime:    now,
            resultCount: results.length,
            results,
          };

          const histKey = market === 'TW' ? 'twHistory' : 'cnHistory';
          const prev    = market === 'TW' ? get().twHistory : get().cnHistory;
          const newHist = [session, ...prev].slice(0, MAX_HISTORY);

          set(s => ({
            [mKey]:    { ...s[mKey], isScanning: false, progress: 100, scanningStock: '', results, lastScanTime: now, error: null },
            [histKey]: newHist,
          }));
        } catch (err) {
          set(s => ({
            [mKey]: { ...s[mKey], isScanning: false, error: err instanceof Error ? err.message : '未知錯誤' },
          }));
        }
      },
    }),
    {
      name: 'scanner-v3',
      partialize: (s) => ({
        twHistory:    s.twHistory,
        cnHistory:    s.cnHistory,
        twResults:    s.tw.results,
        cnResults:    s.cn.results,
        twLastScan:   s.tw.lastScanTime,
        cnLastScan:   s.cn.lastScanTime,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Merge persisted flat fields back into nested market state
        const p = state as unknown as Record<string, unknown>;
        const twResults = Array.isArray(p.twResults) ? (p.twResults as StockScanResult[]) : [];
        const cnResults = Array.isArray(p.cnResults) ? (p.cnResults as StockScanResult[]) : [];
        const twLastScan = typeof p.twLastScan === 'string' ? p.twLastScan : null;
        const cnLastScan = typeof p.cnLastScan === 'string' ? p.cnLastScan : null;
        state.tw = { ...DEFAULT_TW, results: twResults, lastScanTime: twLastScan };
        state.cn = { ...DEFAULT_CN, results: cnResults, lastScanTime: cnLastScan };
      },
    }
  )
);
