'use client';

// 陸股基本面板（首頁「基本面」tab，當載入的是陸股時顯示）。
// 逐季財報（营收/净利/ROE/毛利+YoY）+ 股價 + PB（price/每股净资产 自算，不用 EastMoney 已壞的 PE/PB 欄）。

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';

interface Fin {
  reportDate: string; revenue: number | null; revenueYoY: number | null;
  netProfit: number | null; netProfitYoY: number | null; roe: number | null;
  eps: number | null; bps: number | null; grossMargin: number | null;
}
interface Val { name: string | null; price: number | null }
interface Resp { ok?: boolean; error?: string; financials?: Fin[]; valuation?: Val | null }

const yi = (n: number | null) => (n == null ? '—' : `${(n / 1e8).toFixed(1)}億`);
const pct = (n: number | null) => (n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`);
const f2 = (n: number | null) => (n == null ? '—' : n.toFixed(2));

export default function CnFundamentalPanel({ symbol }: { symbol: string }) {
  const code = symbol.replace(/\.(SS|SZ)$/i, '');
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setErr(null);
    fetch(`/api/cn/financials/${code}`)
      .then((r) => r.json())
      .then((j: Resp) => { if (!alive) return; if (j.error) setErr(j.error); else setData(j); })
      .catch(() => { if (alive) setErr('讀取失敗'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [code]);

  if (loading) return <div className="p-4 text-sm text-muted-foreground">載入陸股基本面中…</div>;
  if (err) return <div className="p-4 text-sm text-rose-400">⚠️ {err}</div>;

  const fin = data?.financials ?? [];
  const val = data?.valuation ?? null;
  const latest = fin[0];
  const price = val?.price ?? null;
  const pb = price != null && latest?.bps ? price / latest.bps : null; // 自算 PB

  return (
    <div className="flex flex-col gap-3 p-2.5 text-xs overflow-auto">
      {/* 估值頭 */}
      <section className="rounded-lg border border-border bg-card px-2.5 py-2">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-fuchsia-300">{val?.name ?? code}</span>
          {price != null && <span className="font-mono text-base font-bold">{price}</span>}
        </div>
        <div className="flex gap-4 mt-1 text-[11px]">
          <span className="text-muted-foreground">PB <span className="font-mono text-foreground">{f2(pb)}</span></span>
          {latest?.roe != null && <span className="text-muted-foreground">ROE <span className="font-mono text-foreground">{f2(latest.roe)}%</span></span>}
          {latest?.eps != null && <span className="text-muted-foreground">EPS <span className="font-mono text-foreground">{f2(latest.eps)}</span></span>}
          {latest?.bps != null && <span className="text-muted-foreground">每股淨值 <span className="font-mono text-foreground">{f2(latest.bps)}</span></span>}
        </div>
      </section>

      {/* 逐季財報趨勢 */}
      <section>
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="font-semibold text-fuchsia-300">逐季財報</span>
          <span className="text-[10px] text-muted-foreground">营收/净利/ROE/毛利（YoY=年增率）</span>
        </div>
        {fin.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="text-muted-foreground border-b border-border/40">
                  <th className="text-left font-normal py-0.5">報告期</th>
                  <th className="text-right font-normal">营收(YoY)</th>
                  <th className="text-right font-normal">净利(YoY)</th>
                  <th className="text-right font-normal">ROE</th>
                  <th className="text-right font-normal">毛利</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {fin.map((q) => (
                  <tr key={q.reportDate} className="border-b border-border/20">
                    <td className="py-0.5">{q.reportDate}</td>
                    <td className="text-right">
                      {yi(q.revenue)}<span className={cn('ml-1', (q.revenueYoY ?? 0) >= 0 ? 'text-bull' : 'text-bear')}>{pct(q.revenueYoY)}</span>
                    </td>
                    <td className="text-right">
                      {yi(q.netProfit)}<span className={cn('ml-1', (q.netProfitYoY ?? 0) >= 0 ? 'text-bull' : 'text-bear')}>{pct(q.netProfitYoY)}</span>
                    </td>
                    <td className="text-right">{f2(q.roe)}%</td>
                    <td className="text-right">{q.grossMargin != null ? `${q.grossMargin.toFixed(1)}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="text-muted-foreground">暂无財報</div>}
      </section>

      <div className="text-[9px] text-muted-foreground/60 mt-1">
        資料源：EastMoney（财报）→ 新浪AkShare fallback · PB=股價/每股淨值自算
      </div>
    </div>
  );
}
