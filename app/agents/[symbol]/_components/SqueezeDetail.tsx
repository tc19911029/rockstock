'use client';

/**
 * 軋空壓力分析面板（/agents/[symbol] 專用）
 *
 * 顯示：
 *   1. 基本資料（代號 / 名稱 / 最新收盤）
 *   2. 空方成本表（5/10/20/60d × 融券/借券/綜合）
 *   3. 壓力指標（vs 成本 %、追繳壓力價、餘額及變化）
 *   4. 軋空分數 + 等級燈號 + 規則式文字解讀
 *   5. 6 條風險提示
 */

import { useEffect, useState } from 'react';
import { isIndexSymbol } from '@/lib/utils/symbols';
import type { SqueezeAnalysis } from '@/lib/squeeze/types';

export function SqueezeDetail({ symbol, date }: { symbol: string; date: string }) {
  const [data, setData] = useState<SqueezeAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isIndexSymbol(symbol)) { setLoading(false); return; }  // 指數無軋空資料
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/squeeze?symbol=${encodeURIComponent(symbol)}&date=${date}`, { signal: AbortSignal.timeout(8000) })
      .then(r => r.json())
      .then((j: { ok?: boolean; squeeze?: SqueezeAnalysis; error?: string }) => {
        if (cancelled) return;
        if (!j.ok || !j.squeeze) {
          setError(j.error ?? '軋空分析載入失敗');
        } else {
          setData(j.squeeze);
        }
      })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'fetch failed'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [symbol, date]);

  if (isIndexSymbol(symbol)) return <Panel><div className="text-sm text-muted-foreground">指數無軋空資料</div></Panel>;
  if (loading) return <Panel><div className="text-sm text-muted-foreground">軋空分析載入中…</div></Panel>;
  if (error || !data) return <Panel><div className="text-sm text-red-400">軋空分析：{error ?? '無資料'}</div></Panel>;

  return (
    <Panel>
      <div className="space-y-4">
        <Header data={data} />
        <CostTable data={data} />
        <PressureRow data={data} />
        <ScoreBlock data={data} />
        <Interpretation text={data.interpretation} />
        <Warnings list={data.warnings} />
      </div>
    </Panel>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-fuchsia-500/30 bg-fuchsia-950/10 p-4">
      <div className="mb-2 text-sm font-semibold text-fuchsia-300">軋空壓力分析 · Short-Squeeze Pressure</div>
      {children}
    </section>
  );
}

function Header({ data }: { data: SqueezeAnalysis }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
      <span className="text-base font-mono font-semibold text-fuchsia-200">{data.symbol}</span>
      <span className="text-foreground">{data.name}</span>
      <span className="text-muted-foreground">{data.asOfDate}</span>
      <span className="ml-auto text-foreground">收盤 <span className="font-mono font-semibold">{fmt(data.close)}</span></span>
    </div>
  );
}

const WINDOWS = [
  { key: 'd5',  label: '5d' },
  { key: 'd10', label: '10d' },
  { key: 'd20', label: '20d' },
  { key: 'd60', label: '60d' },
] as const;

function CostTable({ data }: { data: SqueezeAnalysis }) {
  const c = data.shortCosts;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted-foreground">
            <th className="px-2 py-1 text-left font-medium">空方加權平均成本</th>
            {WINDOWS.map(w => <th key={w.key} className="px-2 py-1 text-right font-medium">{w.label}</th>)}
          </tr>
        </thead>
        <tbody className="font-mono">
          <tr className="border-t border-border/30">
            <td className="px-2 py-1 text-foreground">融券</td>
            {WINDOWS.map(w => <td key={w.key} className="px-2 py-1 text-right">{fmt(c.margin[w.key])}</td>)}
          </tr>
          <tr className="border-t border-border/30">
            <td className="px-2 py-1 text-foreground">借券</td>
            {WINDOWS.map(w => <td key={w.key} className="px-2 py-1 text-right">{fmt(c.sbl[w.key])}</td>)}
          </tr>
          <tr className="border-t border-border/30 bg-fuchsia-950/20">
            <td className="px-2 py-1 font-semibold text-fuchsia-200">綜合</td>
            {WINDOWS.map(w => <td key={w.key} className="px-2 py-1 text-right font-semibold text-fuchsia-200">{fmt(c.combined[w.key])}</td>)}
          </tr>
          <tr className="border-t border-border/30">
            <td className="px-2 py-1 text-muted-foreground">vs 收盤</td>
            {WINDOWS.map(w => {
              const v = data.vsCostPct[w.key];
              return <td key={w.key} className={`px-2 py-1 text-right ${pctClass(v)}`}>{fmtPct(v)}</td>;
            })}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function PressureRow({ data }: { data: SqueezeAnalysis }) {
  return (
    <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
      <Stat label="融券餘額（張）" value={data.shortBalance.toLocaleString()} sub={`Δ5d ${signed(data.shortBalanceChange5d)} / Δ20d ${signed(data.shortBalanceChange20d)}`} />
      <Stat label="借券賣出餘額（張）" value={data.lendingBalance.toLocaleString()} sub={`Δ5d ${signed(data.lendingBalanceChange5d)} / Δ20d ${signed(data.lendingBalanceChange20d)}`} />
      <Stat label="融券追繳壓力價" value={fmt(data.marginCallPrice)} sub={data.distanceToMarginCallPct !== null ? `距當前 ${fmtPct(data.distanceToMarginCallPct)}` : '—'} />
      <Stat label="融資餘額（張）" value={data.marginBalance.toLocaleString()} sub={`資料 ${data.dataCompleteness.marginDays}d / SBL ${data.dataCompleteness.sblDays}d`} />
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded border border-border/40 bg-background/40 p-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono text-sm text-foreground">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function ScoreBlock({ data }: { data: SqueezeAnalysis }) {
  const s = data.score;
  const color = levelColor(s.level);
  return (
    <div className="rounded border border-border/40 bg-background/40 p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <div className="text-xs text-muted-foreground">軋空壓力分數</div>
        <div className="flex items-baseline gap-2">
          <span className={`font-mono text-2xl font-bold ${color}`}>{s.total}</span>
          <span className="text-xs text-muted-foreground">/ 100</span>
          <span className={`ml-2 rounded px-2 py-0.5 text-xs font-semibold ${color} bg-current/10`} style={{ backgroundColor: 'rgba(255,255,255,0.04)' }}>{s.levelLabel}</span>
        </div>
      </div>
      <div className="grid grid-cols-5 gap-1 text-[10px]">
        <SubScore label="空單累積" v={s.shortAccumulation} />
        <SubScore label="跌不下去" v={s.priceFloorRising} />
        <SubScore label="站上成本" v={s.aboveShortCost} />
        <SubScore label="回補壓力" v={s.marginCallPressure} />
        <SubScore label="量價突破" v={s.breakoutVolume} />
      </div>
    </div>
  );
}

function SubScore({ label, v }: { label: string; v: number }) {
  const pct = (v / 20) * 100;
  return (
    <div>
      <div className="mb-0.5 flex items-baseline justify-between">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono text-foreground">{v}/20</span>
      </div>
      <div className="h-1 rounded-full bg-border/30">
        <div className="h-full rounded-full bg-fuchsia-400" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Interpretation({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="rounded border border-border/40 bg-background/40 p-3 text-sm leading-relaxed text-foreground whitespace-pre-line">
      {text}
    </div>
  );
}

function Warnings({ list }: { list: string[] }) {
  return (
    <details className="text-[11px] text-muted-foreground">
      <summary className="cursor-pointer">⚠️ 風險提示（{list.length} 條）</summary>
      <ul className="mt-1 list-disc pl-5 space-y-0.5">
        {list.map((w, i) => <li key={i}>{w}</li>)}
      </ul>
    </details>
  );
}

// ── format helpers ────────────────────────────────────────────

function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toFixed(2);
}
function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}
function signed(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toLocaleString()}`;
}
function pctClass(v: number | null): string {
  if (v === null) return 'text-muted-foreground';
  if (v > 0) return 'text-emerald-400';
  if (v < 0) return 'text-rose-400';
  return 'text-muted-foreground';
}
function levelColor(level: SqueezeAnalysis['score']['level']): string {
  switch (level) {
    case 'extreme': return 'text-rose-400';
    case 'high': return 'text-orange-400';
    case 'potential': return 'text-amber-300';
    case 'mild': return 'text-sky-300';
    case 'low': return 'text-muted-foreground';
  }
}
