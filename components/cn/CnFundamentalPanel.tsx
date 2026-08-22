'use client';

// 陸股基本面板（首頁「基本面」tab，當載入的是陸股時顯示）。
// 與台股共用歷史趨勢面板；A 股累計報表先在 API 還原為單季，再顯示 QoQ / YoY。

import { useState, useEffect } from 'react';
import { FundamentalSidebarPanel } from '@/components/FundamentalSidebarPanel';
import { FundamentalTrendPanel } from '@/components/fundamentals/FundamentalTrendPanel';
import type { FundamentalTrendHistory } from '@/lib/fundamentals/trends';
import { stockDisplayName } from '@/lib/stocks/stockIdentity';

interface Fin {
  reportDate: string; revenue: number | null; revenueYoY: number | null;
  netProfit: number | null; netProfitYoY: number | null; roe: number | null;
  eps: number | null; bps: number | null; grossMargin: number | null;
}
interface Val {
  name: string | null; price: number | null;
  dynamicPe?: number | null; ttmPe?: number | null; pbRatio?: number | null;
}
interface Resp { ok?: boolean; error?: string; financials?: Fin[]; history?: FundamentalTrendHistory; valuation?: Val | null }

const f2 = (n: number | null) => (n == null ? '—' : n.toFixed(2));

interface Props {
  symbol: string;
  /** 走圖游標所在 K 棒收盤價；估值必須以這個價格重算，不能混用 API 快照價。 */
  currentPrice?: number;
  /** 歷史走圖的 as-of 日期。 */
  date?: string;
  isHistorical?: boolean;
}

export default function CnFundamentalPanel({ symbol, currentPrice, date, isHistorical }: Props) {
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
      fetch(`/api/cn/financials/${code}`, { signal: AbortSignal.timeout(10_000) })
        .then((r) => r.json())
        .then((j: Resp) => {
          if (!alive) return;
          if (j.error) { setErr(j.error); return; }
          setData(j);
          if (!j.valuation && attempt < 2) timer = setTimeout(() => load(attempt + 1), 1800);
        })
        .catch((error: Error) => {
          if (alive && error.name !== 'AbortError') setErr(error.name === 'TimeoutError' ? '讀取逾時，請稍後重試' : '讀取失敗');
        })
        .finally(() => { if (alive) setLoading(false); });
    };
    load(0);
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [code]);

  if (loading) return <div className="p-4 text-sm text-muted-foreground">載入陸股基本面中…</div>;
  if (err) return <div role="alert" className="p-4 text-sm text-rose-400">⚠️ {err}</div>;

  const fin = data?.financials ?? [];
  const val = data?.valuation ?? null;
  const latest = fin[0];
  const price = currentPrice && currentPrice > 0 ? currentPrice : (val?.price ?? null);
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
          <span className="font-semibold text-fuchsia-300">{stockDisplayName(val?.name, symbol)}</span>
          <span className="ml-1 font-mono text-[10px] text-muted-foreground">{code}</span>
          {price != null && <span className="ml-2 font-mono text-base font-bold">{price}</span>}
          {isHistorical && date && <span className="ml-2 text-[9px] text-amber-300">歷史價 {date}</span>}
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

      {extremeDrop && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] leading-snug text-amber-300">
          ⚠ 部分期間累計淨利年減 &gt;50%；建議再查原始財報公告確認一次性損益。
        </div>
      )}

      {data?.history
        ? <FundamentalTrendPanel history={data.history} />
        : <div className="rounded border border-amber-500/25 bg-amber-500/10 px-2 py-2 text-[10px] text-amber-200">目前未取得季度歷史，不以即時估值資料代替財報。</div>}

      {/* 陸股也共用單檔估值工作流：業績預告、同業 PE、稀釋與三情境不可只留在 API。 */}
      <section className="border-t border-border/40 pt-2">
        <FundamentalSidebarPanel
          symbol={symbol}
          currentPrice={price ?? undefined}
          date={date}
          isHistorical={isHistorical}
        />
      </section>

      <div className="text-center text-[9px] text-muted-foreground/60 mt-1">
        財報資料源：EastMoney → 新浪 AkShare fallback；價格與上漲空間以目前走圖 K 棒重算
      </div>
    </div>
  );
}
