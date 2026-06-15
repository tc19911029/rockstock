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
interface Val {
  name: string | null; price: number | null;
  dynamicPe?: number | null; ttmPe?: number | null; pbRatio?: number | null;
}
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true); setErr(null);
    // 估值頭（價/本益比/PB）來自 EastMoney；冷啟動（server 剛重啟、首抓未暖）常回 valuation=null →
    // 逐季財報照常顯示、但估值整片空白，且早期只 fetch 一次 → 空到使用者手動重整才補回。
    // 故 valuation 為 null 時背景重試（最多 2 次）補回估值頭，財報已先行顯示不被阻塞。
    const load = (attempt: number) => {
      fetch(`/api/cn/financials/${code}`)
        .then((r) => r.json())
        .then((j: Resp) => {
          if (!alive) return;
          if (j.error) { setErr(j.error); return; }
          setData(j);
          if (!j.valuation && attempt < 2) timer = setTimeout(() => load(attempt + 1), 1800);
        })
        .catch(() => { if (alive) setErr('讀取失敗'); })
        .finally(() => { if (alive) setLoading(false); });
    };
    load(0);
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [code]);

  if (loading) return <div className="p-4 text-sm text-muted-foreground">載入陸股基本面中…</div>;
  if (err) return <div className="p-4 text-sm text-rose-400">⚠️ {err}</div>;

  const fin = data?.financials ?? [];
  const val = data?.valuation ?? null;
  const latest = fin[0];
  const price = val?.price ?? null;
  // PB：優先用 EastMoney 權威值（已修正欄位漂移），無則 price/每股淨值 自算
  const pb = val?.pbRatio ?? (price != null && latest?.bps ? price / latest.bps : null);
  const pe = val?.dynamicPe ?? null; // 本益比（動）＝年化最新季
  // 淨利年減幅 >50% → 提示使用者核對原始公告（數值本身已跨源驗證，非錯誤）
  const extremeDrop = fin.some((q) => q.netProfitYoY != null && q.netProfitYoY < -50);

  return (
    <div className="flex flex-col gap-3 p-2.5 text-xs overflow-auto">
      {/* 估值頭 */}
      <section className="rounded-xl ring-1 ring-foreground/10 bg-card px-2.5 py-2.5">
        <div className="text-center">
          <span className="font-semibold text-fuchsia-300">{val?.name ?? code}</span>
          {price != null && <span className="ml-2 font-mono text-base font-bold">{price}</span>}
        </div>
        <div className="mt-2 flex flex-wrap justify-center gap-x-5 gap-y-2 text-[11px]">
          {pe != null && (
            <div className="flex flex-col items-center">
              <span className="text-muted-foreground">本益比<span className="text-[9px]">動</span></span>
              <span className="font-mono text-foreground">{f2(pe)}</span>
            </div>
          )}
          <div className="flex flex-col items-center">
            <span className="text-muted-foreground">PB</span>
            <span className="font-mono text-foreground">{f2(pb)}</span>
          </div>
          {latest?.roe != null && (
            <div className="flex flex-col items-center">
              <span className="text-muted-foreground">ROE</span>
              <span className="font-mono text-foreground">{f2(latest.roe)}%</span>
            </div>
          )}
          {latest?.eps != null && (
            <div className="flex flex-col items-center">
              <span className="text-muted-foreground">EPS</span>
              <span className="font-mono text-foreground">{f2(latest.eps)}</span>
            </div>
          )}
          {latest?.bps != null && (
            <div className="flex flex-col items-center">
              <span className="text-muted-foreground">每股淨值</span>
              <span className="font-mono text-foreground">{f2(latest.bps)}</span>
            </div>
          )}
        </div>
      </section>

      {/* 逐季財報趨勢 */}
      <section>
        <div className="flex items-center justify-center gap-1.5 mb-1.5">
          <span className="font-semibold text-fuchsia-300">逐季財報</span>
          <span className="text-[10px] text-muted-foreground">营收/净利/ROE/毛利（YoY=年增率）</span>
        </div>
        {extremeDrop && (
          <div className="mb-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] leading-snug text-amber-300">
            ⚠ 部分期間淨利年減 &gt;50%；數值已與東財/同花順/新浪核對一致，建議再查原始財報公告確認。
          </div>
        )}
        {fin.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[9px] tracking-tight">
              <thead>
                <tr className="text-muted-foreground border-b border-border/40">
                  <th className="text-center font-normal py-0.5 whitespace-nowrap">報告期</th>
                  <th className="text-center font-normal whitespace-nowrap">营收(YoY)</th>
                  <th className="text-center font-normal whitespace-nowrap">净利(YoY)</th>
                  <th className="text-center font-normal whitespace-nowrap">ROE</th>
                  <th className="text-center font-normal whitespace-nowrap">毛利</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {fin.map((q) => (
                  <tr key={q.reportDate} className="border-b border-border/20">
                    <td className="py-0.5 text-center whitespace-nowrap text-[8px] text-muted-foreground">{q.reportDate}</td>
                    <td className="text-center whitespace-nowrap">
                      {yi(q.revenue)}<span className={cn('ml-0.5 text-[8px]', (q.revenueYoY ?? 0) >= 0 ? 'text-bull' : 'text-bear')}>{pct(q.revenueYoY)}</span>
                    </td>
                    <td className="text-center whitespace-nowrap">
                      {yi(q.netProfit)}<span className={cn('ml-0.5 text-[8px]', (q.netProfitYoY ?? 0) >= 0 ? 'text-bull' : 'text-bear')}>{pct(q.netProfitYoY)}</span>
                    </td>
                    <td className="text-center whitespace-nowrap">{f2(q.roe)}%</td>
                    <td className="text-center whitespace-nowrap">{q.grossMargin != null ? `${q.grossMargin.toFixed(1)}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="text-muted-foreground">暂无財報</div>}
      </section>

      <div className="text-center text-[9px] text-muted-foreground/60 mt-1">
        資料源：EastMoney（财报+估值）→ 新浪AkShare fallback · 本益比(動)=年化最新季
      </div>
    </div>
  );
}
