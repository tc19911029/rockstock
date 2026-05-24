'use client';

/**
 * /realtime — 即時分鐘 K + 爆量警示
 *
 * 左側 K 線（1m/5m/15m 可切），右側監控池切換 + 警示時間軸。
 * 自動 30s polling 拉 /api/realtime/bars。
 *
 * ⚠ 警告：所有警示為「分時類推、非書本日 K 原文規則」，僅供觀察。
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { PageShell } from '@/components/shared/PageShell';
import AlertTimeline, { type AlertItem } from '@/components/realtime/AlertTimeline';
import { POLLING } from '@/lib/config';
import { cn } from '@/lib/utils';
import type { CandleWithIndicators } from '@/types';

const CandleChart = dynamic(() => import('@/components/CandleChart'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full bg-card flex items-center justify-center">
      <span className="text-muted-foreground text-sm animate-pulse">載入中…</span>
    </div>
  ),
});

interface MinuteBarLike {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface PoolItem {
  symbol: string;
  market: 'TW' | 'CN';
  source: 'holding' | 'watchlist' | 'scan';
  isHolding: boolean;
}

interface BarsResponse {
  ok: boolean;
  symbol: string;
  bars: MinuteBarLike[];
  alerts: AlertItem[];
}

interface PoolResponse {
  ok: boolean;
  pool: PoolItem[];
}

type Timeframe = '1m' | '5m' | '15m';
const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m'];

export default function RealtimePage() {
  const [pool, setPool] = useState<PoolItem[]>([]);
  const [symbol, setSymbol] = useState<string | null>(null);
  const [tf, setTf] = useState<Timeframe>('1m');
  const [bars, setBars] = useState<MinuteBarLike[]>([]);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [loading, setLoading] = useState(false);

  // load pool once
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/realtime/pool');
        const j = (await r.json()) as PoolResponse;
        if (j.ok) {
          setPool(j.pool);
          if (j.pool.length > 0 && !symbol) {
            setSymbol(j.pool[0].symbol);
          }
        }
      } catch (err) {
        console.warn('[/realtime] load pool failed:', err);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // load bars (initial + polling)
  const loadBars = useCallback(async () => {
    if (!symbol) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/realtime/bars?symbol=${encodeURIComponent(symbol)}&tf=${tf}`);
      const j = (await r.json()) as BarsResponse;
      if (j.ok) {
        setBars(j.bars ?? []);
        setAlerts(j.alerts ?? []);
      }
    } catch (err) {
      console.warn('[/realtime] load bars failed:', err);
    } finally {
      setLoading(false);
    }
  }, [symbol, tf]);

  useEffect(() => {
    loadBars();
    const id = setInterval(loadBars, POLLING.QUOTE_INTERVAL);
    return () => clearInterval(id);
  }, [loadBars]);

  // 把 ts (epoch ms) 轉成 "YYYY-MM-DD HH:mm" (台北或上海)
  const market = useMemo(() => pool.find(p => p.symbol === symbol)?.market ?? 'TW', [pool, symbol]);
  const candles = useMemo<CandleWithIndicators[]>(() => {
    const tz = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
    // 加上 MA5/10/20 給 CandleChart 畫
    const out = bars.map(b => ({
      date: formatDateTime(b.ts, tz),
      open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
    })) as CandleWithIndicators[];
    return enrichMA(out);
  }, [bars, market]);

  const grouped = useMemo(() => groupPool(pool), [pool]);

  return (
    <PageShell fullViewport>
      <div className="h-full flex flex-col">
        {/* Caveat banner */}
        <div className="shrink-0 px-3 py-1.5 bg-amber-500/10 border-b border-amber-500/30 text-[11px] text-amber-200/90 flex items-center gap-2">
          <span>⚠️</span>
          <span>
            分時版推論，非朱老師日 K 原文規則（書本「爆量長黑/末升段」原文為日 K，此處為分鐘 K 類推、未經回測），僅供觀察。
          </span>
        </div>

        {/* Top control bar */}
        <div className="shrink-0 px-3 py-2 border-b border-border flex items-center gap-3 flex-wrap">
          <span className="text-xs text-muted-foreground">監控:</span>
          <select
            value={symbol ?? ''}
            onChange={e => setSymbol(e.target.value || null)}
            className="bg-secondary text-foreground text-sm px-2 py-1 rounded border border-border min-w-[180px]"
          >
            {grouped.holding.length > 0 && (
              <optgroup label="持股">
                {grouped.holding.map(p => (
                  <option key={p.symbol} value={p.symbol}>{p.symbol}</option>
                ))}
              </optgroup>
            )}
            {grouped.scan.length > 0 && (
              <optgroup label="當日候選">
                {grouped.scan.map(p => (
                  <option key={p.symbol} value={p.symbol}>{p.symbol}</option>
                ))}
              </optgroup>
            )}
            {pool.length === 0 && <option value="">(無監控標的)</option>}
          </select>

          <div className="flex items-center gap-1">
            {TIMEFRAMES.map(t => (
              <button
                key={t}
                type="button"
                onClick={() => setTf(t)}
                className={cn(
                  'text-xs px-2 py-1 rounded transition-colors',
                  tf === t
                    ? 'bg-sky-500/20 text-sky-400 border border-sky-500/40'
                    : 'text-muted-foreground hover:text-foreground border border-transparent',
                )}
              >
                {t}
              </button>
            ))}
          </div>

          <div className="ml-auto text-[10px] text-muted-foreground">
            {loading ? '更新中…' : `${candles.length} 根 / 自動 ${POLLING.QUOTE_INTERVAL / 1000}s 刷新`}
          </div>
        </div>

        {/* Main: chart + side */}
        <div className="flex-1 min-h-0 flex">
          {/* Chart */}
          <div className="flex-1 min-w-0 bg-card border-r border-border">
            {candles.length === 0 ? (
              <div className="w-full h-full flex items-center justify-center text-sm text-muted-foreground">
                {symbol ? <NoBarsHint /> : '請選擇一檔標的'}
              </div>
            ) : (
              <div className="w-full h-full">
                <CandleChart
                  candles={candles}
                  signals={[]}
                  fillContainer
                  maToggles={{ ma5: true, ma10: true, ma20: true, ma60: false, ma240: false }}
                />
              </div>
            )}
          </div>

          {/* Side: alerts */}
          <aside className="w-[280px] shrink-0 overflow-y-auto bg-background">
            <div className="px-3 py-2 border-b border-border text-xs text-muted-foreground font-semibold uppercase tracking-wider">
              最近警示
            </div>
            <AlertTimeline
              alerts={alerts}
              onSelectSymbol={s => setSymbol(s)}
              emptyHint="這檔目前無警示"
            />
          </aside>
        </div>
      </div>
    </PageShell>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────

function formatDateTime(ms: number, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function enrichMA(candles: CandleWithIndicators[]): CandleWithIndicators[] {
  const closes = candles.map(c => c.close);
  return candles.map((c, i) => ({
    ...c,
    ma5: sma(closes, i, 5),
    ma10: sma(closes, i, 10),
    ma20: sma(closes, i, 20),
  }));
}

function sma(arr: number[], i: number, n: number): number | undefined {
  if (i + 1 < n) return undefined;
  let sum = 0;
  for (let k = i - n + 1; k <= i; k++) sum += arr[k];
  return sum / n;
}

function groupPool(pool: PoolItem[]): { holding: PoolItem[]; scan: PoolItem[] } {
  return {
    holding: pool.filter(p => p.isHolding),
    scan: pool.filter(p => !p.isHolding),
  };
}

// 友善的「無分鐘 K 資料」提示 — 判斷台北時間目前是否盤中
function NoBarsHint() {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  });
  const parts = fmt.formatToParts(new Date());
  const h = Number(parts.find(p => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find(p => p.type === 'minute')?.value ?? '0');
  const wd = parts.find(p => p.type === 'weekday')?.value ?? '';
  const mins = h * 60 + m;
  const marketOpen = 9 * 60;
  const marketClose = 13 * 60 + 30;
  const isWeekend = wd === 'Sat' || wd === 'Sun';

  if (isWeekend) {
    return (
      <div className="text-center space-y-1">
        <div>📅 週末休市</div>
        <div className="text-xs text-muted-foreground/60">下個交易日 09:00 開盤後盤中分鐘 K 才會載入</div>
      </div>
    );
  }
  if (mins < marketOpen) {
    const minsToOpen = marketOpen - mins;
    const hh = Math.floor(minsToOpen / 60);
    const mm = minsToOpen % 60;
    return (
      <div className="text-center space-y-1">
        <div>🌅 尚未開盤</div>
        <div className="text-xs text-muted-foreground/60">
          距 09:00 開盤 {hh > 0 ? `${hh}h ` : ''}{mm}m
        </div>
      </div>
    );
  }
  if (mins > marketClose) {
    return (
      <div className="text-center space-y-1">
        <div>🌙 已收盤</div>
        <div className="text-xs text-muted-foreground/60">明日 09:00 開盤後盤中分鐘 K 才會載入</div>
      </div>
    );
  }
  // 盤中但無資料 — backfill 中
  return (
    <div className="text-center space-y-1">
      <div>⏳ 載入中</div>
      <div className="text-xs text-muted-foreground/60">盤中即時資料 backfill 中、稍候幾秒</div>
    </div>
  );
}
