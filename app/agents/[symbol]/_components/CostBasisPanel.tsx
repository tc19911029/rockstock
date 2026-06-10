'use client';

/**
 * 成本／壓力價總覽面板（/agents/[symbol] 專用）
 *
 * 9 項：外資/投信/自營/主力/融資/融券/券賣 加權平均成本（5/10/20/60d）
 *      + 嘎空價（融券追繳）+ 融資斷頭/追繳價 + 融資斷頭壓力分數 + 解讀 + 風險提示。
 *
 * 全部為「估算」、純顯示用，不進選股 gate。配色用 rose 區別軋空面板（fuchsia）。
 */

import { useEffect, useState } from 'react';
import { isIndexSymbol } from '@/lib/utils/symbols';
import type { CostBasisBundle, CostBucket } from '@/lib/chipcost/types';

export function CostBasisPanel({ symbol, date }: { symbol: string; date: string }) {
  const [data, setData] = useState<CostBasisBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isIndexSymbol(symbol)) { setLoading(false); return; }  // 指數無成本資料
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/cost-basis?symbol=${encodeURIComponent(symbol)}&date=${date}`, { signal: AbortSignal.timeout(8000) })
      .then(r => r.json())
      .then((j: { ok?: boolean; costBasis?: CostBasisBundle; error?: string }) => {
        if (cancelled) return;
        if (!j.ok || !j.costBasis) setError(j.error ?? '成本分析載入失敗');
        else setData(j.costBasis);
      })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'fetch failed'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [symbol, date]);

  if (isIndexSymbol(symbol)) return <Panel><div className="text-sm text-muted-foreground">指數無成本資料</div></Panel>;
  if (loading) return <Panel><div className="text-sm text-muted-foreground">成本分析載入中…</div></Panel>;
  if (error || !data) return <Panel><div className="text-sm text-red-400">成本分析：{error ?? '無資料'}</div></Panel>;

  return (
    <Panel>
      <div className="space-y-4">
        <Header data={data} />
        <CostTable data={data} />
        <PriceRow data={data} />
        <ScoreBlock data={data} />
        <Interpretation text={data.interpretation} />
        <Warnings list={data.warnings} />
      </div>
    </Panel>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-rose-500/30 bg-rose-950/10 p-4">
      <div className="mb-2 text-sm font-semibold text-rose-300">成本／壓力價總覽 · Cost Basis（估算）</div>
      {children}
    </section>
  );
}

function Header({ data }: { data: CostBasisBundle }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
      <span className="text-base font-mono font-semibold text-rose-200">{data.symbol}</span>
      <span className="text-foreground">{data.name}</span>
      <span className="text-muted-foreground">{data.asOfDate}</span>
      <span className="ml-auto text-foreground">收盤 <span className="font-mono font-semibold">{fmt(data.close)}</span></span>
    </div>
  );
}

const WINDOWS = [
  { key: 'd5', label: '5d' },
  { key: 'd10', label: '10d' },
  { key: 'd20', label: '20d' },
  { key: 'd60', label: '60d' },
] as const;

const COST_ROWS = [
  { key: 'foreign', label: '外資成本' },
  { key: 'trust', label: '投信成本' },
  { key: 'dealer', label: '自營商成本' },
  { key: 'broker', label: '主力成本' },
  { key: 'margin', label: '融資成本' },
  { key: 'short', label: '融券成本' },
  { key: 'sbl', label: '券賣成本' },
] as const;

function CostTable({ data }: { data: CostBasisBundle }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted-foreground">
            <th className="px-2 py-1 text-left font-medium">加權平均成本</th>
            {WINDOWS.map(w => <th key={w.key} className="px-2 py-1 text-right font-medium">{w.label}</th>)}
            <th className="px-2 py-1 text-right font-medium">vs 現價</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {COST_ROWS.map(row => {
            const bucket = data.costs[row.key] as CostBucket;
            const vs = data.vsClosePct[row.key];
            const brokerNote = row.key === 'broker'
              ? (data.brokerCostMethod === 'composite' ? '綜合估算'
                : data.brokerCostMethod === 'none' ? '歷史累積中' : '')
              : '';
            return (
              <tr key={row.key} className="border-t border-border/30">
                <td className="px-2 py-1 text-foreground">
                  {row.label}
                  {brokerNote && <span className="ml-1 text-[9px] text-amber-400">{brokerNote}</span>}
                </td>
                {WINDOWS.map(w => <td key={w.key} className="px-2 py-1 text-right">{fmt(bucket[w.key])}</td>)}
                <td className={`px-2 py-1 text-right ${pctClass(vs)}`}>{fmtPct(vs)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-1 text-[10px] text-muted-foreground">vs 現價：正=現價在該成本之上（該方獲利）；負=現價在成本之下（該方套牢）。</div>
      {data.brokerCostMethod === 'composite' && (
        <div className="mt-0.5 text-[10px] text-amber-400/80">主力成本為「綜合估算」（法人+融資+借券合成），非分點實值；分點歷史累積 ≥20 日後自動切換為較純口徑。</div>
      )}
    </div>
  );
}

function PriceRow({ data }: { data: CostBasisBundle }) {
  const distTxt = data.distanceToLiquidationPct !== null
    ? (data.distanceToLiquidationPct < 0 ? `已跌破 ${Math.abs(data.distanceToLiquidationPct).toFixed(1)}%` : `距現價 ${data.distanceToLiquidationPct.toFixed(1)}%`)
    : '—';
  return (
    <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
      <Stat label="嘎空價（融券追繳）" value={fmt(data.squeezePrice)} sub="價漲觸發回補" />
      <Stat label="融資追繳價（140%）" value={fmt(data.marginCallPrice140)} sub={`融資成數 ${(data.marginRatio * 100).toFixed(0)}%`} />
      <Stat label="融資斷頭價（130%）" value={fmt(data.marginLiquidationPrice)} sub={distTxt} highlight />
      <Stat label="融資成本（綜合）" value={fmt(refOf(data.costs.margin))} sub={`資料 ${data.dataCompleteness.marginDays}d`} />
    </div>
  );
}

function Stat({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-2 ${highlight ? 'border-rose-500/40 bg-rose-950/20' : 'border-border/40 bg-background/40'}`}>
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={`mt-0.5 font-mono text-sm ${highlight ? 'text-rose-200 font-semibold' : 'text-foreground'}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function ScoreBlock({ data }: { data: CostBasisBundle }) {
  const s = data.marginScore;
  const color = levelColor(s.level);
  return (
    <div className="rounded border border-border/40 bg-background/40 p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <div className="text-xs text-muted-foreground">融資斷頭壓力分數</div>
        <div className="flex items-baseline gap-2">
          <span className={`font-mono text-2xl font-bold ${color}`}>{s.total}</span>
          <span className="text-xs text-muted-foreground">/ 100</span>
          <span className={`ml-2 rounded px-2 py-0.5 text-xs font-semibold ${color}`} style={{ backgroundColor: 'rgba(255,255,255,0.04)' }}>{s.levelLabel}</span>
        </div>
      </div>
      <div className="grid grid-cols-5 gap-1 text-[10px]">
        <SubScore label="融資累積" v={s.marginAccumulation} />
        <SubScore label="使用率" v={s.utilizationHigh} />
        <SubScore label="跌破成本" v={s.belowMarginCost} />
        <SubScore label="斷頭壓力" v={s.liquidationPressure} />
        <SubScore label="量價走弱" v={s.breakdownVolume} />
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
        <div className="h-full rounded-full bg-rose-400" style={{ width: `${pct}%` }} />
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

// ── helpers ────────────────────────────────────────────────────

const refOf = (b: CostBucket): number | null => b.d20 ?? b.d10 ?? b.d5 ?? b.d60 ?? null;

function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toFixed(2);
}
function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}
function pctClass(v: number | null): string {
  if (v === null) return 'text-muted-foreground';
  if (v > 0) return 'text-emerald-400';
  if (v < 0) return 'text-rose-400';
  return 'text-muted-foreground';
}
function levelColor(level: CostBasisBundle['marginScore']['level']): string {
  switch (level) {
    case 'extreme': return 'text-rose-400';
    case 'high': return 'text-orange-400';
    case 'potential': return 'text-amber-300';
    case 'mild': return 'text-sky-300';
    case 'low': return 'text-muted-foreground';
  }
}
