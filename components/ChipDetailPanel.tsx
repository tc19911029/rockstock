'use client';

import { useState, useEffect } from 'react';
import { fetchWithRetry } from '@/lib/fetchWithRetry';
import { toast } from 'sonner';
import { DAY_TRADE_RATIO_HIGH, DAY_TRADE_RATIO_WARN } from '@/lib/analysis/bookThresholds';
import type { CostBasisSummary } from '@/lib/chipcost/types';

interface TrendInfo {
  direction: 'up' | 'down' | 'flat';
  consecutiveCount: number;
  reversal: boolean;
  label: string;
}

interface ChipInfo {
  symbol: string;
  name?: string;
  foreignBuy: number;
  trustBuy: number;
  dealerBuy: number;
  totalInstitutional: number;
  marginBalance: number;
  marginNet: number;
  shortBalance: number;
  shortNet: number;
  marginUtilRate: number;
  dayTradeVolume: number;
  dayTradeRatio: number;
  largeTraderBuy: number;
  largeTraderSell: number;
  largeTraderNet: number;
  lendingBalance: number;
  lendingNet: number;
  largeHolderPct: number;
  largeHolderChange: number;
  // v4 成本／壓力價摘要（外資/投信/自營/主力/融資/融券/券賣 成本 + 嘎空價 + 斷頭價）
  costBasis?: CostBasisSummary;
  holder100Pct?: number;
  holder200Pct?: number;
  holder400Pct?: number;
  holder400To600Pct?: number;
  holder600To800Pct?: number;
  holder800To1000Pct?: number;
  structureBuilding?: boolean;
  holderTierChange?: {
    h100: number | null; h200: number | null; h400: number | null; h1000: number | null;
    h400To600: number | null; h600To800: number | null; h800To1000: number | null;
  };
  holderTierTrend?: {
    h100?: TrendInfo; h200?: TrendInfo; h400?: TrendInfo; h1000?: TrendInfo;
  };
  tdccDate?: string;
  tdccPrevDate?: string;
  chipScore: number;
  chipGrade: string;
  chipSignal: string;
  chipDetail: string;
  // v2 — 9 區塊 + 趨勢
  composite?: number;
  trends?: {
    foreign?: TrendInfo;
    trust?: TrendInfo;
    dealer?: TrendInfo;
    institutional?: TrendInfo;
    margin?: TrendInfo;
    lending?: TrendInfo;
    composite?: TrendInfo;
    holderLarge?: TrendInfo;
  };
  holder5wChange?: { largePct: number; retailPct: number };
  holder5mChange?: { largePct: number };
  // v3 主力券商分點
  brokerNetBuy?: number;
  brokerConcentration?: number;
  topBuyers?: Array<{ rank: number; name: string; buyVolK: number; sellVolK: number; netVolK: number }>;
  topSellers?: Array<{ rank: number; name: string; buyVolK: number; sellVolK: number; netVolK: number }>;
}

// ── Signal label + color ────────────────────────────────────────────────────
function getSignal(v: number, big: number, small: number) {
  if (v >=  big)   return { label: '大增', cls: 'text-bull' };
  if (v >=  small) return { label: '增',   cls: 'text-bull-light' };
  if (v <= -big)   return { label: '大減', cls: 'text-bear' };
  if (v <= -small) return { label: '小賣', cls: 'text-bear-light' };
  return             { label: '中立', cls: 'text-yellow-400' };
}

function getPctSignal(v: number) {
  if (v >=  1)  return { label: '大增', cls: 'text-bull' };
  if (v >=  0.2) return { label: '增',  cls: 'text-bull-light' };
  if (v <= -1)  return { label: '大減', cls: 'text-bear' };
  if (v <= -0.2) return { label: '小賣', cls: 'text-bear-light' };
  return { label: '中立', cls: 'text-yellow-400' };
}

// ── 集保大戶分層：tier「跟前一週比」週變化（▲/▼ delta，台股慣例增=紅/減=綠）+ 連續週趨勢（連 N 增/減）──
function TierChange({ delta, trend }: { delta?: number | null; trend?: TrendInfo }) {
  return (
    <div className="leading-tight">
      {delta == null ? (
        <div className="text-[7px] text-muted-foreground/40">—</div>
      ) : Math.abs(delta) < 0.005 ? (
        <div className="text-[7px] text-yellow-400/70">±0</div>
      ) : (
        <div className={`text-[7px] font-mono ${delta > 0 ? 'text-bull' : 'text-bear'}`}>
          {delta > 0 ? '▲+' : '▼'}{delta.toFixed(2)}
        </div>
      )}
      {trend && trend.direction !== 'flat' && trend.label && (
        <div className={`text-[7px] leading-tight ${
          trend.direction === 'up'
            ? (trend.reversal ? 'text-bull' : 'text-bull-light')
            : (trend.reversal ? 'text-bear' : 'text-bear-light')
        }`}>
          {trend.label}
        </div>
      )}
    </div>
  );
}

// ── Gauge bar ───────────────────────────────────────────────────────────────
// Shows current value position in a fixed symmetric range
function GaugeBar({ value, range }: { value: number; range: number }) {
  const clamped = Math.max(-range, Math.min(range, value));
  const pct = ((clamped / range) + 1) / 2; // 0..1, 0.5 = center
  const positive = clamped >= 0;

  return (
    <div className="relative w-full h-[3px] bg-muted rounded-full mt-2">
      <div className="absolute left-1/2 top-0 h-full w-px bg-muted-foreground" />
      {positive ? (
        <div
          className="absolute top-0 h-full bg-red-500 rounded-full"
          style={{ left: '50%', width: `${(pct - 0.5) * 100}%` }}
        />
      ) : (
        <div
          className="absolute top-0 h-full bg-green-500 rounded-full"
          style={{ right: '50%', width: `${(0.5 - pct) * 100}%` }}
        />
      )}
      <div
        className="absolute top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-white shadow"
        style={{ left: `calc(${pct * 100}% - 3px)` }}
      />
    </div>
  );
}

// ── Single chip tile ────────────────────────────────────────────────────────
function ChipTile({
  label,
  value,
  signal,
  unit = '張',
  range,
  isPct = false,
  trend,
}: {
  label: string;
  value: number | null;
  signal: { label: string; cls: string };
  unit?: string;
  range: number;
  isPct?: boolean;
  trend?: TrendInfo;
}) {
  const noData = value == null;
  const valColor = noData
    ? 'text-muted-foreground/60'
    : value > 0
    ? 'text-bull'
    : value < 0
    ? 'text-bear'
    : 'text-muted-foreground';

  let displayVal = '—';
  if (!noData) {
    if (isPct) {
      displayVal = (value > 0 ? '+' : '') + value.toFixed(2) + '%';
    } else {
      const abs = Math.abs(value);
      const formatted =
        abs >= 100_000
          ? (value / 1000).toFixed(0) + 'K'
          : value.toLocaleString();
      displayVal = (value > 0 ? '+' : '') + formatted;
    }
  }

  return (
    <div className="bg-secondary/70 rounded-lg p-2 border border-border/40 flex flex-col gap-0.5">
      {/* Header: label + signal */}
      <div className="flex justify-between items-center">
        <span className="text-[9px] text-muted-foreground font-medium">{label}</span>
        {!noData && (
          <span className={`text-[9px] font-bold ${signal.cls}`}>{signal.label}</span>
        )}
      </div>
      {/* Value */}
      <div className={`text-sm font-mono font-bold leading-snug ${valColor}`}>
        {displayVal}
        {!noData && !isPct && (
          <span className="text-[8px] text-muted-foreground/60 ml-0.5">{unit}</span>
        )}
      </div>
      {/* Trend label */}
      {trend && trend.direction !== 'flat' && (
        <span className={`text-[9px] font-bold leading-none ${
          trend.direction === 'up'
            ? (trend.reversal ? 'text-bull' : 'text-bull-light')
            : (trend.reversal ? 'text-bear' : 'text-bear-light')
        }`}>
          {trend.label}
        </span>
      )}
      {/* Gauge */}
      {!noData && <GaugeBar value={value} range={range} />}
    </div>
  );
}

// ── 成本／壓力價摘要 ──────────────────────────────────────────────────────────
const COST_CELLS = [
  { key: 'foreignCost', label: '外資' },
  { key: 'trustCost', label: '投信' },
  { key: 'dealerCost', label: '自營' },
  { key: 'brokerCost', label: '主力' },
  { key: 'marginCost', label: '融資' },
  { key: 'shortCost', label: '融券' },
  { key: 'sblCost', label: '券賣' },
] as const;

function costNum(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? '—' : v.toFixed(1);
}

// ── Grade badge ─────────────────────────────────────────────────────────────
const GRADE_CLS: Record<string, string> = {
  S: 'text-bull border-red-600',
  A: 'text-orange-400 border-orange-600',
  B: 'text-yellow-400 border-yellow-600',
  C: 'text-muted-foreground border-border',
  D: 'text-muted-foreground border-border',
};

// ── Main component ──────────────────────────────────────────────────────────
export default function ChipDetailPanel({ symbol, date }: { symbol: string; date?: string }) {
  const [data, setData] = useState<ChipInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const cleanSym = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!cleanSym) return;
    setLoading(true);
    setError(null);

    // 用 Asia/Taipei TZ 而非 UTC：CST 凌晨時 UTC 還在前一天，會造成籌碼日期偏差
    const chipDate = date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());

    fetchWithRetry(`/api/chip?date=${chipDate}&symbol=${cleanSym}`, { maxRetries: 2 })
      .then(r => r.json())
      .then(j => {
        if (j.error) { setError('查無籌碼資料'); setData(null); }
        else setData(j);
      })
      .catch(() => { setError('載入失敗'); toast.error('籌碼資料載入失敗', { id: 'chip-error', duration: 3000 }); })
      .finally(() => setLoading(false));
  }, [cleanSym, date, retryCount]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (loading) return (
    <div className="space-y-3 p-3">
      <div className="flex items-center gap-2">
        <div className="animate-pulse bg-muted/50 rounded h-8 w-20" />
        <div className="animate-pulse bg-muted/50 rounded h-4 flex-1" />
      </div>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="animate-pulse bg-muted/50 rounded h-4 w-16" />
          <div className="animate-pulse bg-muted/50 rounded h-4 flex-1" />
        </div>
      ))}
      <p className="text-[10px] text-muted-foreground/60 text-center">載入籌碼資料中...</p>
    </div>
  );
  if (error) return (
    <div className="text-xs text-red-400/80 py-6 text-center">
      <p>{error}</p>
      <button onClick={() => setRetryCount(c => c + 1)} className="mt-2 text-sky-400 hover:text-sky-300 transition-colors">重試</button>
    </div>
  );
  if (!data) return (
    <div className="text-xs text-muted-foreground/60 py-6 text-center">無資料</div>
  );

  // ── Tile definitions — 對齊籌碼K線 app 9 區塊 ─────────────────────────────
  const tiles: Array<{
    label: string;
    value: number | null;
    signal: { label: string; cls: string };
    range: number;
    isPct?: boolean;
    trend?: TrendInfo;
  }> = [
    { label: '外資', value: data.foreignBuy, signal: getSignal(data.foreignBuy, 5000, 500),
      range: 20000, trend: data.trends?.foreign },
    { label: '投信', value: data.trustBuy, signal: getSignal(data.trustBuy, 500, 50),
      range: 2000, trend: data.trends?.trust },
    { label: '自營', value: data.dealerBuy, signal: getSignal(data.dealerBuy, 1000, 100),
      range: 3000, trend: data.trends?.dealer },
    { label: '法人', value: data.totalInstitutional, signal: getSignal(data.totalInstitutional, 8000, 800),
      range: 25000, trend: data.trends?.institutional },
    { label: '融資', value: data.marginNet, signal: getSignal(data.marginNet, 2000, 200),
      range: 8000, trend: data.trends?.margin },
    { label: '融券', value: data.shortNet, signal: getSignal(data.shortNet, 500, 50),
      range: 2000 },
    // 主力 = v3 用 Yahoo 主力券商分點（前 15 大買 − 前 15 大賣）對齊籌碼K線「主力 -102」
    { label: '主力',
      value: data.brokerNetBuy ?? data.composite ?? data.totalInstitutional,
      signal: getSignal(data.brokerNetBuy ?? data.composite ?? data.totalInstitutional, 500, 50),
      range: 500,
      trend: data.trends?.composite },
    // 券賣（借券放空當日淨成交，flow）
    { label: '券賣', value: data.lendingNet !== 0 ? data.lendingNet : null,
      signal: getSignal(data.lendingNet, 500, 50), range: 2000,
      trend: data.trends?.lending },
    // 借券餘額（累積借出股票總量，stock；張）— flow vs stock 分開
    { label: '借券餘額', value: data.lendingBalance > 0 ? data.lendingBalance : null,
      signal: { label: '張', cls: 'text-muted-foreground' },
      range: 100000 },
    // 大戶 5 週累計變化（取代舊「當週變化」）
    { label: '大戶 5 週',
      value: data.holder5wChange?.largePct ?? null,
      signal: getPctSignal(data.holder5wChange?.largePct ?? 0),
      range: 5, isPct: true,
      trend: data.trends?.holderLarge },
    { label: '散戶 5 週',
      value: data.holder5wChange?.retailPct ?? null,
      signal: getPctSignal(data.holder5wChange?.retailPct ?? 0),
      range: 5, isPct: true },
  ];

  const gradeCls = GRADE_CLS[data.chipGrade] ?? GRADE_CLS['D'];
  const signalBg =
    data.chipSignal === '主力進場' ? 'bg-red-900/50 text-red-300' :
    data.chipSignal === '法人偏多' ? 'bg-orange-900/50 text-orange-300' :
    data.chipSignal === '大戶加碼' ? 'bg-yellow-900/50 text-yellow-300' :
    data.chipSignal === '主力出貨' ? 'bg-green-900/50 text-green-300' :
    data.chipSignal === '散戶追高' ? 'bg-amber-900/50 text-amber-300' :
    data.chipSignal === '法人偏空' ? 'bg-blue-900/50 text-blue-300' :
    'bg-secondary text-muted-foreground';

  return (
    <div className="space-y-2.5">
      {/* ── Score header ── */}
      <div className="flex items-center justify-between px-0.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">籌碼面評分</span>
          <span className={`text-base font-bold border-2 rounded px-1.5 py-0.5 leading-none ${gradeCls}`}>
            {data.chipGrade}
          </span>
          <span className="text-sm font-mono text-foreground/80">{data.chipScore}</span>
        </div>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${signalBg}`}>
          {data.chipSignal}
        </span>
      </div>

      {/* ── 籌碼面一句結論（提到評分下方更醒目）── */}
      {data.chipDetail && data.chipDetail !== '中性' && (
        <div className="text-[11px] text-foreground/85 bg-secondary/40 rounded px-2.5 py-1.5 border border-border/30 leading-relaxed">
          {data.chipDetail}
        </div>
      )}

      {/* ── 3-column grid ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
        {tiles.map(t => (
          <ChipTile
            key={t.label}
            label={t.label}
            value={t.value}
            signal={t.signal}
            range={t.range}
            isPct={t.isPct}
            trend={t.trend}
          />
        ))}
      </div>

      {/* ── 主力券商分點（v3 Yahoo scraper）── */}
      {data.brokerNetBuy != null && data.topBuyers && data.topSellers && (
        <details className="bg-secondary/40 rounded px-2 py-1.5 border border-border/30">
          <summary className="cursor-pointer select-none flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground font-medium">主力券商前 15 大</span>
            <span className="flex items-center gap-2">
              <span className={`text-[10px] font-mono ${data.brokerNetBuy >= 0 ? 'text-bull' : 'text-bear'}`}>
                {data.brokerNetBuy >= 0 ? '+' : ''}{data.brokerNetBuy.toLocaleString()} 張
              </span>
              {data.brokerConcentration != null && (
                <span className={`text-[10px] font-mono ${data.brokerConcentration >= 0 ? 'text-bull' : 'text-bear'}`}>
                  集中 {data.brokerConcentration >= 0 ? '+' : ''}{data.brokerConcentration.toFixed(2)}%
                </span>
              )}
            </span>
          </summary>
          <div className="grid grid-cols-2 gap-2 mt-2">
            <div>
              <div className="text-[9px] text-bull font-medium mb-1">前 15 大買進</div>
              <div className="space-y-0.5">
                {data.topBuyers.slice(0, 8).map(b => (
                  <div key={`b${b.rank}`} className="flex justify-between text-[10px]">
                    <span className="text-foreground/80 truncate" title={b.name}>{b.rank}. {b.name}</span>
                    <span className="text-bull font-mono shrink-0">+{b.netVolK}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[9px] text-bear font-medium mb-1">前 15 大賣出</div>
              <div className="space-y-0.5">
                {data.topSellers.slice(0, 8).map(s => (
                  <div key={`s${s.rank}`} className="flex justify-between text-[10px]">
                    <span className="text-foreground/80 truncate" title={s.name}>{s.rank}. {s.name}</span>
                    <span className="text-bear font-mono shrink-0">{s.netVolK}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </details>
      )}

      {/* ── 集保大戶分層（依股價選 tier；千金股看 100 張、平價看 1000 張）── */}
      {(data.holder100Pct != null || data.holder400Pct != null) && (
        <div className="bg-secondary/40 rounded px-2 py-1.5 border border-border/30 space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground font-medium">
              集保大戶分層
              {data.tdccPrevDate && (
                <span className="text-[8px] text-muted-foreground/60 ml-1">資料 {data.tdccDate?.slice(5)}｜週變化 vs {data.tdccPrevDate.slice(5)}</span>
              )}
            </span>
            {data.structureBuilding && (
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-900/50 text-red-300 border border-red-700/50">
                ✨ 主力卡位
              </span>
            )}
          </div>
          <div className="grid grid-cols-4 gap-1 text-[9px] font-mono">
            <div className="bg-secondary/60 rounded px-1 py-1 text-center">
              <div className="text-muted-foreground/70 text-[8px]">100張↑</div>
              <div className="text-foreground/90 font-bold">{data.holder100Pct?.toFixed(1) ?? '—'}%</div>
              <TierChange delta={data.holderTierChange?.h100} trend={data.holderTierTrend?.h100} />
            </div>
            <div className="bg-secondary/60 rounded px-1 py-1 text-center">
              <div className="text-muted-foreground/70 text-[8px]">200張↑</div>
              <div className="text-foreground/90 font-bold">{data.holder200Pct?.toFixed(1) ?? '—'}%</div>
              <TierChange delta={data.holderTierChange?.h200} trend={data.holderTierTrend?.h200} />
            </div>
            <div className="bg-secondary/60 rounded px-1 py-1 text-center">
              <div className="text-muted-foreground/70 text-[8px]">400張↑</div>
              <div className="text-foreground/90 font-bold">{data.holder400Pct?.toFixed(1) ?? '—'}%</div>
              <TierChange delta={data.holderTierChange?.h400} trend={data.holderTierTrend?.h400} />
            </div>
            <div className="bg-secondary/60 rounded px-1 py-1 text-center">
              <div className="text-muted-foreground/70 text-[8px]">1000張↑</div>
              <div className="text-foreground/90 font-bold">{data.largeHolderPct.toFixed(1)}%</div>
              <TierChange delta={data.holderTierChange?.h1000} trend={data.holderTierTrend?.h1000} />
            </div>
          </div>
          {data.structureBuilding && (
            <div className="grid grid-cols-3 gap-1 text-[8px] font-mono text-muted-foreground/80">
              <div className="text-center">
                <div>400-600: {data.holder400To600Pct?.toFixed(2)}%</div>
                <TierChange delta={data.holderTierChange?.h400To600} />
              </div>
              <div className="text-center">
                <div>600-800: {data.holder600To800Pct?.toFixed(2)}%</div>
                <TierChange delta={data.holderTierChange?.h600To800} />
              </div>
              <div className="text-center">
                <div>800-1000: {data.holder800To1000Pct?.toFixed(2)}%</div>
                <TierChange delta={data.holderTierChange?.h800To1000} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Margin detail ── */}
      <div className="grid grid-cols-2 gap-1.5 text-[9px] text-muted-foreground">
        <div className="bg-secondary/40 rounded px-2 py-1 border border-border/30">
          <span>融資餘額</span>
          <span className="float-right text-muted-foreground font-mono">{data.marginBalance.toLocaleString()}張</span>
          <div className="clear-both" />
          <span>使用率</span>
          <span className="float-right text-muted-foreground font-mono">{data.marginUtilRate}%</span>
        </div>
        <div className="bg-secondary/40 rounded px-2 py-1 border border-border/30">
          <span>融券餘額</span>
          <span className="float-right text-muted-foreground font-mono">{data.shortBalance.toLocaleString()}張</span>
          <div className="clear-both" />
          <span>當沖比例</span>
          <span className={`float-right font-mono ${data.dayTradeRatio > DAY_TRADE_RATIO_HIGH ? 'text-bull' : data.dayTradeRatio > DAY_TRADE_RATIO_WARN ? 'text-yellow-400' : 'text-muted-foreground'}`}>
            {data.dayTradeRatio}%
          </span>
        </div>
      </div>

      {/* ── 成本／壓力價摘要（估算；外資/投信/自營/主力/融資/融券/券賣 + 嘎空價 + 斷頭價）── */}
      {data.costBasis && (
        <details className="bg-secondary/40 rounded px-2 py-1.5 border border-border/30">
          <summary className="cursor-pointer select-none flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground font-medium">💰 成本／壓力價（估算）</span>
            {data.costBasis.marginLiquidationPrice != null && (
              <span className="text-[10px] font-mono text-rose-300">
                斷頭 {data.costBasis.marginLiquidationPrice.toFixed(1)}
                {data.costBasis.distanceToLiquidationPct != null && (
                  <span className="text-muted-foreground ml-1">
                    ({data.costBasis.distanceToLiquidationPct < 0 ? '已破' : '距'}{Math.abs(data.costBasis.distanceToLiquidationPct).toFixed(1)}%)
                  </span>
                )}
              </span>
            )}
          </summary>
          <div className="grid grid-cols-4 gap-1 mt-2 text-[9px] font-mono">
            {COST_CELLS.map(c => {
              const brokerNone = c.key === 'brokerCost' && data.costBasis!.brokerCostMethod === 'none';
              const brokerComposite = c.key === 'brokerCost' && data.costBasis!.brokerCostMethod === 'composite';
              return (
                <div key={c.key} className="bg-secondary/60 rounded px-1 py-1 text-center">
                  <div className="text-muted-foreground/70 text-[8px]">{c.label}{brokerComposite && '*'}</div>
                  <div className="text-foreground/90 font-bold">
                    {brokerNone ? <span className="text-amber-400 text-[8px]">累積中</span> : costNum(data.costBasis![c.key])}
                  </div>
                </div>
              );
            })}
            <div className="bg-rose-950/20 border border-rose-500/30 rounded px-1 py-1 text-center">
              <div className="text-muted-foreground/70 text-[8px]">斷頭130%</div>
              <div className="text-rose-200 font-bold">{costNum(data.costBasis.marginLiquidationPrice)}</div>
            </div>
            <div className="bg-fuchsia-950/20 border border-fuchsia-500/30 rounded px-1 py-1 text-center">
              <div className="text-muted-foreground/70 text-[8px]">嘎空價</div>
              <div className="text-fuchsia-200 font-bold">{costNum(data.costBasis.squeezePrice)}</div>
            </div>
          </div>
          <div className="mt-1 text-[8px] text-muted-foreground/70 leading-relaxed">
            成本皆為估算（淨增張數×當日均價加權）。融資維持率券商看「整戶」非個股，斷頭價僅供參考。{data.costBasis.brokerCostMethod === 'composite' && '＊主力=綜合估算（分點歷史累積中）。'}完整版見個股頁。
          </div>
        </details>
      )}
    </div>
  );
}
