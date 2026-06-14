'use client';

// 陸股籌碼面板（首頁「籌碼」tab，當載入的是陸股時顯示）。
// 股东户数（散戶集中度，對標台股集保）+ 龙虎榜（陸股獨有）。資料源 EastMoney。

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';

interface Shareholder {
  endDate: string; holderNum: number; holderNumRatio: number | null;
  avgHoldNum: number | null; avgMarketCap: number | null;
}
interface DragonTiger {
  tradeDate: string; changeRate: number | null; netAmt: number | null;
  buyAmt: number | null; sellAmt: number | null; reason: string;
  fwdD5: number | null; fwdD10: number | null;
}
interface Resp { ok?: boolean; error?: string; shareholders?: Shareholder[]; dragontiger?: DragonTiger[] }

const yi = (n: number | null | undefined) => (n == null ? '—' : `${(n / 1e8).toFixed(2)}億`);
const wan = (n: number | null | undefined) => (n == null ? '—' : `${(n / 1e4).toFixed(1)}萬`);
const pct = (n: number | null | undefined) => (n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`);
const numfmt = (n: number) => n.toLocaleString('en-US');

export default function CnChipPanel({ symbol }: { symbol: string }) {
  const code = symbol.replace(/\.(SS|SZ)$/i, '');
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setErr(null);
    fetch(`/api/cn/chips/${code}`, { signal: AbortSignal.timeout(8000) })
      .then((r) => r.json())
      .then((j: Resp) => { if (!alive) return; if (j.error) setErr(j.error); else setData(j); })
      .catch(() => { if (alive) setErr('讀取失敗'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [code]);

  if (loading) return <div className="p-4 text-sm text-muted-foreground">載入陸股籌碼中…</div>;
  if (err) return <div className="p-4 text-sm text-rose-400">⚠️ {err}</div>;

  const gd = data?.shareholders ?? [];
  const lhb = data?.dragontiger ?? [];
  const latest = gd[0];
  // 户数变化：负=集中(偏多,绿)、正=分散(偏空,红)
  const concentrating = (latest?.holderNumRatio ?? 0) < 0;

  return (
    <div className="flex flex-col gap-3 p-2.5 text-xs overflow-auto">
      {/* 股东户数 */}
      <section>
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="font-semibold text-fuchsia-300">股东户数</span>
          <span className="text-[10px] text-muted-foreground">散戶集中度（對標台股集保）</span>
        </div>
        {latest ? (
          <>
            <div className="rounded-xl ring-1 ring-foreground/10 bg-card px-2.5 py-2 flex items-center gap-3">
              <div>
                <div className="text-[10px] text-muted-foreground">{latest.endDate} 股东户数</div>
                <div className="font-mono text-base font-bold">{numfmt(latest.holderNum)} 户</div>
              </div>
              <div className={cn('font-mono text-sm font-bold', concentrating ? 'text-bull' : 'text-bear')}>
                {pct(latest.holderNumRatio)}
                <div className="text-[10px] font-normal">{concentrating ? '↓ 籌碼集中（偏多）' : '↑ 籌碼分散（偏空）'}</div>
              </div>
              <div className="ml-auto text-right text-[10px] text-muted-foreground">
                <div>户均 {latest.avgHoldNum != null ? Math.round(latest.avgHoldNum).toLocaleString() : '—'} 股</div>
                <div>户均市值 {wan(latest.avgMarketCap)}</div>
              </div>
            </div>
            {/* 近幾期趨勢 */}
            <div className="mt-1.5 grid grid-cols-1 gap-0.5">
              {gd.slice(0, 6).map((q) => {
                const conc = (q.holderNumRatio ?? 0) < 0;
                return (
                  <div key={q.endDate} className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span className="w-20 shrink-0 font-mono">{q.endDate}</span>
                    <span className="font-mono">{numfmt(q.holderNum)} 户</span>
                    <span className={cn('ml-auto font-mono', conc ? 'text-bull' : 'text-bear')}>{pct(q.holderNumRatio)}</span>
                  </div>
                );
              })}
            </div>
          </>
        ) : <div className="text-muted-foreground">暂无股东户数</div>}
      </section>

      {/* 龙虎榜 */}
      <section>
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="font-semibold text-fuchsia-300">龙虎榜</span>
          <span className="text-[10px] text-muted-foreground">陸股獨有 · 主力席位買賣</span>
        </div>
        {lhb.length ? (
          <div className="flex flex-col gap-1">
            {lhb.map((d) => {
              const buy = (d.netAmt ?? 0) >= 0;
              return (
                <div key={d.tradeDate} className="rounded-xl ring-1 ring-foreground/10 bg-card px-2.5 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[11px]">{d.tradeDate}</span>
                    <span className={cn('font-mono text-[11px] font-bold', (d.changeRate ?? 0) >= 0 ? 'text-bull' : 'text-bear')}>
                      {pct(d.changeRate)}
                    </span>
                    <span className={cn('ml-auto font-mono text-[11px] font-bold', buy ? 'text-bull' : 'text-bear')}>
                      {buy ? '主力淨買 ' : '主力淨賣 '}{yi(Math.abs(d.netAmt ?? 0))}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-[9px] text-muted-foreground mt-0.5">
                    <span className="truncate flex-1">{d.reason}</span>
                    {d.fwdD5 != null && <span className={cn(d.fwdD5 >= 0 ? 'text-bull' : 'text-bear')}>後5日 {pct(d.fwdD5)}</span>}
                    {d.fwdD10 != null && <span className={cn(d.fwdD10 >= 0 ? 'text-bull' : 'text-bear')}>後10日 {pct(d.fwdD10)}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        ) : <div className="text-muted-foreground">近期无上榜</div>}
      </section>

      <div className="text-[9px] text-muted-foreground/60 mt-1">資料源：EastMoney datacenter</div>
    </div>
  );
}
