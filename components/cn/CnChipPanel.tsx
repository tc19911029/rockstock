'use client';

// 陸股籌碼面板（首頁「籌碼」tab，當載入的是陸股時顯示）。
// 股东户数（散戶集中度，對標台股集保）+ 龙虎榜（陸股獨有）。資料源 EastMoney。

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import type { MarginPressure } from '@/lib/chipcost/marginPressure';

interface Shareholder {
  endDate: string; holderNum: number; holderNumRatio: number | null;
  avgHoldNum: number | null; avgMarketCap: number | null;
}
interface DragonTiger {
  tradeDate: string; changeRate: number | null; netAmt: number | null;
  buyAmt: number | null; sellAmt: number | null; reason: string;
  fwdD5: number | null; fwdD10: number | null;
}
interface CapitalFlowDay {
  date: string; mainNet: number; superNet: number | null; largeNet: number | null;
}
interface MarginDay {
  date: string; rzrqYe: number; rzYe: number; rqYe: number | null;
}
interface MainBuySell {
  mainIn: number; mainOut: number; mainNet: number; netPct: number | null;
}
interface Resp {
  ok?: boolean; error?: string;
  shareholders?: Shareholder[]; dragontiger?: DragonTiger[];
  capitalFlow?: CapitalFlowDay[]; capitalFlowToday?: CapitalFlowDay | null;
  mainBuySell?: MainBuySell | null; margin?: MarginDay[];
  /** 融資成本回推 + 平倉/警戒壓力價（估算，純顯示層） */
  marginPressure?: MarginPressure | null;
}

// 陸股交易時段（北京時間=台灣 CST）：平日 09:30-11:30 / 13:00-15:00
function isCnSessionNow(): boolean {
  const now = new Date();
  const bj = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60_000);
  const day = bj.getDay();
  if (day === 0 || day === 6) return false;
  const hm = bj.getHours() * 100 + bj.getMinutes();
  return (hm >= 930 && hm <= 1131) || (hm >= 1300 && hm <= 1501);
}

const yi = (n: number | null | undefined) => (n == null ? '—' : `${(n / 1e8).toFixed(2)}億`);
const yiSigned = (n: number | null | undefined) => (n == null ? '—' : `${n >= 0 ? '+' : '−'}${(Math.abs(n) / 1e8).toFixed(2)}億`);
const wan = (n: number | null | undefined) => (n == null ? '—' : `${(n / 1e4).toFixed(1)}萬`);
const pct = (n: number | null | undefined) => (n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`);
const numfmt = (n: number) => n.toLocaleString('en-US');

export default function CnChipPanel({ symbol }: { symbol: string }) {
  const code = symbol.replace(/\.(SS|SZ)$/i, '');
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  // 首抓 + 盤中自動刷新（每 60s；收盤後停輪詢，只保留首抓）。
  // 主力資金走「今日盤中即時累計」會跳動；其餘（龙虎榜/兩融/股东户数）盤後/期間更新、刷新不變屬正常。
  useEffect(() => {
    let alive = true;
    setLoading(true); setErr(null); setData(null);
    const stamp = () => setUpdatedAt(new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }));
    // 15s timeout：route 抓 6 個東財來源(股東/龍虎/資金流/今日資金流/主買賣/兩融)+host failover，偶爾需更久。
    const fetchOnce = () => fetch(`/api/cn/chips/${code}`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json() as Promise<Resp>);
    // 首抓含退避重試：東財偶爾瞬慢/瞬斷，8s 太緊、收盤後又不輪詢 → 曾永久卡「載入失敗」(2026-06-22 修)。
    (async () => {
      for (let i = 0; i < 3; i++) {
        try {
          const j = await fetchOnce();
          if (!alive) return;
          if (j.error) throw new Error(j.error);
          setData(j); setErr(null); stamp(); setLoading(false);
          return;
        } catch {
          if (!alive) return;
          if (i < 2) { await new Promise((r) => setTimeout(r, 800 * (i + 1))); continue; }
          setErr('讀取失敗（已重試 3 次，東財暫時無回應）'); setLoading(false);
        }
      }
    })();
    // 盤中每 60s 靜默刷新（收盤後停；失敗不洗掉已顯示資料）
    const timer = setInterval(() => {
      if (!alive || !isCnSessionNow()) return;
      fetchOnce().then((j) => { if (alive && !j.error) { setData(j); stamp(); } }).catch(() => {});
    }, 60_000);
    return () => { alive = false; clearInterval(timer); };
  }, [code]);

  if (loading) return <div className="p-4 text-sm text-muted-foreground">載入陸股籌碼中…</div>;
  if (err) return <div className="p-4 text-sm text-rose-400">⚠️ {err}</div>;

  const gd = data?.shareholders ?? [];
  const lhb = data?.dragontiger ?? [];
  const latest = gd[0];
  // 户数变化：负=集中(偏多,绿)、正=分散(偏空,红)
  const concentrating = (latest?.holderNumRatio ?? 0) < 0;

  // 主力資金：今日盤中即時值（分鐘端點）優先當頭，歷史日K 疊在下面（去重同日）
  const cfToday = data?.capitalFlowToday ?? null;
  const cfHist = data?.capitalFlow ?? [];
  const cfLatest = cfToday ?? cfHist[cfHist.length - 1];
  const cfIsLive = cfToday != null && cfLatest === cfToday;
  const histDesc = [...cfHist].reverse();
  const cfTrend = (cfToday && (histDesc.length === 0 || histDesc[0].date !== cfToday.date)
    ? [cfToday, ...histDesc]
    : histDesc).slice(0, 6);
  // 主買/主賣毛額（今日，主力流入/流出）
  const mbs = data?.mainBuySell ?? null;

  const mp = data?.marginPressure ?? null;
  // 兩融（升冪；最後一筆=最新，前一筆算日變化）
  const mg = data?.margin ?? [];
  const mgLatest = mg[mg.length - 1];
  const mgPrev = mg[mg.length - 2];
  const rzChg = mgLatest && mgPrev && mgLatest.rzYe != null && mgPrev.rzYe != null ? mgLatest.rzYe - mgPrev.rzYe : null;
  const rqChg = mgLatest && mgPrev && mgLatest.rqYe != null && mgPrev.rqYe != null ? mgLatest.rqYe - mgPrev.rqYe : null;
  const mgTrend = mg.slice(-6).reverse();

  return (
    <div className="flex flex-col gap-3 p-2.5 text-xs overflow-auto">
      {/* 1. 主力資金流向 */}
      <section>
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="font-semibold text-fuchsia-300">主力資金</span>
          {cfIsLive && isCnSessionNow() && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-red-500/15 text-red-400">● 盤中即時</span>
          )}
          <span className="text-[10px] text-muted-foreground">淨流入=買−賣，紅進綠出</span>
        </div>
        {cfLatest ? (
          <>
            <div className="rounded-xl ring-1 ring-foreground/10 bg-card px-2.5 py-2 flex items-center gap-3">
              <div>
                <div className="text-[10px] text-muted-foreground">{cfLatest.date} 主力淨流入{cfIsLive ? '（今日累計）' : ''}</div>
                <div className={cn('font-mono text-base font-bold', cfLatest.mainNet >= 0 ? 'text-bull' : 'text-bear')}>
                  {yiSigned(cfLatest.mainNet)}
                  {mbs?.netPct != null && <span className="ml-1 text-[10px] font-normal">淨佔比 {mbs.netPct.toFixed(1)}%</span>}
                </div>
              </div>
              <div className="ml-auto text-right text-[10px]">
                <div className={cn('font-mono', (cfLatest.superNet ?? 0) >= 0 ? 'text-bull' : 'text-bear')}>
                  超大單 {yiSigned(cfLatest.superNet)}
                </div>
                <div className={cn('font-mono', (cfLatest.largeNet ?? 0) >= 0 ? 'text-bull' : 'text-bear')}>
                  大單 {yiSigned(cfLatest.largeNet)}
                </div>
              </div>
            </div>
            <div className="mt-1.5 grid grid-cols-1 gap-0.5">
              {cfTrend.map((d) => (
                <div key={d.date} className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span className="w-20 shrink-0 font-mono">{d.date}</span>
                  <span className="text-muted-foreground/60">主力淨流入</span>
                  <span className={cn('ml-auto font-mono', d.mainNet >= 0 ? 'text-bull' : 'text-bear')}>{yiSigned(d.mainNet)}</span>
                </div>
              ))}
            </div>
          </>
        ) : <div className="text-muted-foreground">暂无资金流数据</div>}
      </section>

      {/* 2. 主買資金（主力買入/賣出毛額） */}
      <section>
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="font-semibold text-fuchsia-300">主買資金</span>
          {mbs && isCnSessionNow() && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-red-500/15 text-red-400">● 盤中即時</span>
          )}
          <span className="text-[10px] text-muted-foreground">主力買入/賣出毛額（買−賣=淨流入）</span>
        </div>
        {mbs ? (
          <div className="rounded-xl ring-1 ring-foreground/10 bg-card px-2.5 py-2 grid grid-cols-2 gap-2">
            <div>
              <div className="text-[10px] text-muted-foreground">主買 · 主力流入</div>
              <div className="font-mono text-sm font-bold text-bull">{yi(mbs.mainIn)}</div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground">主賣 · 主力流出</div>
              <div className="font-mono text-sm font-bold text-bear">{yi(mbs.mainOut)}</div>
            </div>
          </div>
        ) : <div className="text-muted-foreground">暂无主买卖数据</div>}
      </section>

      {/* 3. 兩融（融資融券） */}
      <section>
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="font-semibold text-fuchsia-300">兩融</span>
          <span className="text-[10px] text-muted-foreground">融資=做多槓桿 / 融券=做空</span>
        </div>
        {mgLatest ? (
          <>
            <div className="grid grid-cols-2 gap-1.5">
              <div className="rounded-xl ring-1 ring-foreground/10 bg-card px-2.5 py-2">
                <div className="text-[10px] text-muted-foreground">融資餘額 · {mgLatest.date}</div>
                <div className="font-mono text-sm font-bold">{yi(mgLatest.rzYe)}</div>
                {rzChg != null && (
                  <div className={cn('text-[10px] font-mono', rzChg >= 0 ? 'text-bull' : 'text-bear')}>
                    {rzChg >= 0 ? '▲增 ' : '▼減 '}{yi(Math.abs(rzChg))}
                  </div>
                )}
              </div>
              <div className="rounded-xl ring-1 ring-foreground/10 bg-card px-2.5 py-2">
                <div className="text-[10px] text-muted-foreground">融券餘額（做空）</div>
                <div className="font-mono text-sm font-bold">{yi(mgLatest.rqYe)}</div>
                {rqChg != null && (
                  <div className={cn('text-[10px] font-mono', rqChg >= 0 ? 'text-bear' : 'text-bull')}>
                    {rqChg >= 0 ? '▲增 ' : '▼減 '}{yi(Math.abs(rqChg))}
                  </div>
                )}
              </div>
            </div>
            <div className="mt-1.5 grid grid-cols-1 gap-0.5">
              {mgTrend.map((d) => (
                <div key={d.date} className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span className="w-20 shrink-0 font-mono">{d.date}</span>
                  <span>融資 {yi(d.rzYe)}</span>
                  <span className="ml-auto">兩融 {yi(d.rzrqYe)}</span>
                </div>
              ))}
            </div>
          </>
        ) : <div className="text-muted-foreground">暂无两融数据</div>}

        {/* 融資成本回推 + 平倉／警戒壓力價（估算，與台股同一套 weightedCost 數學） */}
        {mp && mp.marginCost != null && mp.liquidationPrice != null && (
          <div className="mt-2 rounded-xl ring-1 ring-rose-500/25 bg-rose-950/10 px-2.5 py-2">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] text-muted-foreground font-medium">💰 融資成本／壓力價（估算）</span>
              {mp.distanceToLiquidationPct != null && (
                <span className={cn(
                  'text-[10px] font-mono',
                  mp.distanceToLiquidationPct < 0 ? 'text-bear font-bold' : 'text-rose-300',
                )}>
                  {mp.distanceToLiquidationPct < 0
                    ? `已破平倉線 ${Math.abs(mp.distanceToLiquidationPct).toFixed(1)}%`
                    : `還要跌 ${mp.distanceToLiquidationPct.toFixed(1)}%`}
                </span>
              )}
            </div>
            <div className="grid grid-cols-3 gap-1 text-[9px] font-mono">
              <div className="bg-card rounded px-1 py-1 text-center">
                <div className="text-muted-foreground/70 text-[8px]">融資成本</div>
                <div className="text-foreground/90 font-bold">{mp.marginCost.toFixed(2)}</div>
              </div>
              <div className="bg-card rounded px-1 py-1 text-center ring-1 ring-yellow-500/25">
                <div className="text-muted-foreground/70 text-[8px]">警戒150%</div>
                <div className="text-yellow-200 font-bold">{mp.marginCallPrice?.toFixed(2) ?? '—'}</div>
              </div>
              <div className="bg-card rounded px-1 py-1 text-center ring-1 ring-rose-500/30">
                <div className="text-muted-foreground/70 text-[8px]">平倉130%</div>
                <div className="text-rose-200 font-bold">{mp.liquidationPrice.toFixed(2)}</div>
              </div>
            </div>
            <div className="mt-1 text-[8px] text-muted-foreground/70 leading-relaxed">
              成本為估算（融資餘額日增額 ÷ 當日均價換股數後加權）。維持擔保比例券商看「整戶」非個股，
              且各家保證金比例不同（此處按交易所下限 100%），壓力價僅供參考。
            </div>
          </div>
        )}
      </section>

      {/* 4. 股东户数 */}
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

      {/* 5. 龙虎榜 */}
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

      <div className="text-[9px] text-muted-foreground/60 mt-1 leading-relaxed">
        資料源：EastMoney{updatedAt ? ` · 更新 ${updatedAt}` : ''}
        {isCnSessionNow() && <span className="text-red-400/70"> · 盤中每 60 秒自動刷新</span>}
        <br />主力/主買資金=今日盤中即時跳動；兩融/股东户数/龙虎榜為盤後/期間資料，盤中不變動屬正常。
      </div>
    </div>
  );
}
