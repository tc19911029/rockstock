'use client';

/**
 * /risk — Risk Dashboard
 *
 * 對 7000萬→3億 用戶，回答 4 件事：
 *   1. 我目前曝險多少 NT$ + 占總資金 %？
 *   2. 單檔集中度有沒有過高？同產業有沒有疊一起？
 *   3. 本月實際 drawdown vs growth-path 預期？
 *   4. 還有多少風險預算可用？
 *
 * 資料：
 *   - holdings.json open 持倉
 *   - growth-status currentCapital
 *   - 每持倉現價（fetch /api/stock）→ 算未實現損益 + 距停損 %
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PageShell, PageHeader } from '@/components/shared';
import { useTotalCapital, formatNT } from '@/lib/portfolio/useTotalCapital';
import { stockDisplayName } from '@/lib/stocks/stockIdentity';

interface Holding {
  symbol: string; name: string; market: 'TW' | 'CN';
  entryDate: string; entryPrice: number; shares: number;
  stopLoss?: number; industry?: string; status: string;
}

interface GrowthState {
  currentCapital: number;
  startCapital: number;
  currentMonthTarget: number;
  gapPct: number;
  status: 'green' | 'yellow' | 'red';
}

export default function RiskDashboardPage() {
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [growth, setGrowth] = useState<GrowthState | null>(null);
  const [loading, setLoading] = useState(true);
  const totalCapital = useTotalCapital();

  useEffect(() => {
    let canceled = false;
    (async () => {
      setLoading(true);
      const [holdRes, growthRes] = await Promise.all([
        fetch('/api/agents/portfolio?status=open').then(r => r.json()).catch(() => null),
        fetch('/api/portfolio/growth-status').then(r => r.json()).catch(() => null),
      ]);
      if (canceled) return;
      const hold = ((holdRes?.holdings ?? []) as Holding[]).filter(h => h.market === 'TW' && h.status === 'open');
      setHoldings(hold);
      const gp = growthRes?.progress;
      if (gp && growthRes?.path) {
        setGrowth({
          currentCapital: gp.currentCapital,
          startCapital: growthRes.path.startCapital,
          currentMonthTarget: gp.currentMonthTarget,
          gapPct: gp.gapPct,
          status: gp.status,
        });
      }
      // 先解除 loading：畫面先用成本價墊著 render，報價回來再補，
      // 避免整頁卡死等報價（D-1：原本逐檔 await /api/stock 歷史鏈，DNS 異常時卡 70s）
      setLoading(false);
      // 撈每檔最新報價 — 走輕量 quotes 端點（同 /portfolio，有逾時與負快取、上限約 10s），
      // 不走會在 DNS 異常時卡 70s 的 /api/stock?period=1mo 歷史 K 線鏈
      if (hold.length > 0) {
        const symbols = hold.map(h => h.symbol);
        fetch(`/api/portfolio/quotes?symbols=${encodeURIComponent(symbols.join(','))}`)
          .then(r => (r.ok ? r.json() : null))
          .then(json => {
            if (canceled || !json) return;
            const quotes = (json.quotes ?? []) as Array<{ symbol: string; price: number; stale?: boolean }>;
            const priceMap: Record<string, number> = {};
            for (const q of quotes) if (q.price > 0 && !q.stale) priceMap[q.symbol] = q.price;
            setPrices(priceMap);
          })
          .catch(() => {});
      }
    })();
    return () => { canceled = true; };
  }, []);

  const analysis = useMemo(() => {
    if (holdings.length === 0 || !totalCapital) return null;

    const rows = holdings.map(h => {
      const close = prices[h.symbol] ?? h.entryPrice;  // 報價未到先用成本價墊（不顯示 -100%）
      const cost = h.entryPrice * h.shares;
      const marketValue = close * h.shares;
      const concentrationPct = (marketValue / totalCapital) * 100;
      const riskAmount = h.stopLoss ? Math.max(0, (close - h.stopLoss) * h.shares) : 0;
      const riskPct = (riskAmount / totalCapital) * 100;
      const distToStopPct = h.stopLoss && close > 0 ? ((close - h.stopLoss) / close) * 100 : null;
      const unrealizedPnL = marketValue - cost;
      const unrealizedPct = cost > 0 ? (unrealizedPnL / cost) * 100 : 0;
      return {
        symbol: h.symbol,
        name: h.name,
        industry: h.industry ?? '未分類',
        shares: h.shares,
        entryPrice: h.entryPrice,
        close,
        stopLoss: h.stopLoss,
        cost,
        marketValue,
        concentrationPct,
        riskAmount,
        riskPct,
        distToStopPct,
        unrealizedPnL,
        unrealizedPct,
      };
    });

    const totalMarketValue = rows.reduce((s, r) => s + r.marketValue, 0);
    const totalRisk = rows.reduce((s, r) => s + r.riskAmount, 0);
    const totalUnrealized = rows.reduce((s, r) => s + r.unrealizedPnL, 0);
    const totalConcentrationPct = (totalMarketValue / totalCapital) * 100;
    const totalRiskPct = (totalRisk / totalCapital) * 100;

    // 集中度：最大單檔 / Herfindahl
    const sortedByConc = [...rows].sort((a, b) => b.concentrationPct - a.concentrationPct);
    const topPos = sortedByConc[0];
    const herf = rows.reduce((s, r) => s + (r.concentrationPct / 100) ** 2, 0);  // 0-1
    const effectiveN = herf > 0 ? 1 / herf : 0;

    // 產業集中
    const byIndustry: Record<string, number> = {};
    for (const r of rows) byIndustry[r.industry] = (byIndustry[r.industry] ?? 0) + r.concentrationPct;
    const sortedIndustry = Object.entries(byIndustry).sort((a, b) => b[1] - a[1]);
    const topIndustry = sortedIndustry[0];

    // MDD：current vs startCapital
    const ddFromStart = growth
      ? ((growth.currentCapital - growth.startCapital) / growth.startCapital) * 100
      : null;

    return {
      rows: sortedByConc,
      totalMarketValue, totalRisk, totalUnrealized,
      totalConcentrationPct, totalRiskPct,
      topPos, herf, effectiveN,
      sortedIndustry, topIndustry,
      ddFromStart,
    };
  }, [holdings, prices, totalCapital, growth]);

  const header = <PageHeader title="🛡 風險面板" backButton subtitle="曝險 / 集中度 / 產業重疊 / drawdown" />;

  return (
    <PageShell headerSlot={header}>
      <div className="px-4 py-4 space-y-4">

        {loading && <p className="text-sm text-muted-foreground text-center py-8">載入中…</p>}

        {!loading && holdings.length === 0 && (
          <div className="text-center py-12 text-sm text-muted-foreground space-y-2">
            <p className="text-4xl">🛡</p>
            <p>無 server 持倉，無風險可算</p>
            <p className="text-xs">
              到 <Link href="/portfolio" className="underline text-sky-400">/portfolio</Link> 新增持倉
            </p>
          </div>
        )}

        {!loading && analysis && (
          <>
            {/* 風險預算 + 集中度 hero */}
            <section className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <BigStat
                label="本週風險敞口"
                value={formatNT(analysis.totalRisk)}
                sub={`${analysis.totalRiskPct.toFixed(2)}% 總資`}
                tone={analysis.totalRiskPct > 5 ? 'red' : analysis.totalRiskPct > 3 ? 'amber' : 'green'}
                hint="持倉的所有 (現價 - 停損) × 股數加總"
              />
              <BigStat
                label="持股市值"
                value={formatNT(analysis.totalMarketValue)}
                sub={`${analysis.totalConcentrationPct.toFixed(1)}% 部位率`}
                tone={analysis.totalConcentrationPct > 90 ? 'amber' : 'green'}
              />
              <BigStat
                label="未實現損益"
                value={formatNT(analysis.totalUnrealized)}
                sub={`${(analysis.totalUnrealized / analysis.rows.reduce((s, r) => s + r.cost, 0) * 100).toFixed(2)}% 平均`}
                tone={analysis.totalUnrealized >= 0 ? 'green' : 'red'}
              />
              <BigStat
                label="自起點 drawdown"
                value={analysis.ddFromStart != null ? `${analysis.ddFromStart >= 0 ? '+' : ''}${analysis.ddFromStart.toFixed(2)}%` : '—'}
                sub={growth ? `${formatNT(growth.startCapital)} → ${formatNT(growth.currentCapital)}` : ''}
                tone={analysis.ddFromStart != null && analysis.ddFromStart < -5 ? 'red' : 'green'}
              />
            </section>

            {/* 集中度警示 */}
            <section className="rounded-xl ring-1 ring-foreground/10 bg-card p-4 space-y-2">
              <h2 className="text-sm font-semibold flex items-center gap-1.5">🎯 集中度分析</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div>
                  <div className="text-muted-foreground mb-1">單檔最大</div>
                  <div className="font-mono">
                    <span className="font-bold text-base">{stockDisplayName(analysis.topPos.name, analysis.topPos.symbol)}</span>
                    <span className="text-muted-foreground ml-2">{analysis.topPos.symbol}</span>
                  </div>
                  <div className={`text-2xl font-bold font-mono mt-0.5 ${
                    analysis.topPos.concentrationPct > 50 ? 'text-red-300' :
                    analysis.topPos.concentrationPct > 30 ? 'text-amber-300' : 'text-foreground'
                  }`}>
                    {analysis.topPos.concentrationPct.toFixed(1)}%
                  </div>
                  {analysis.topPos.concentrationPct > 50 && (
                    <p className="text-[10px] text-red-300/80 mt-1">⚠ 單檔 &gt; 50% 過度集中、單檔停損就吃掉一大塊</p>
                  )}
                </div>
                <div>
                  <div className="text-muted-foreground mb-1">分散度（effective N）</div>
                  <div className="text-2xl font-bold font-mono">{analysis.effectiveN.toFixed(2)}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    Herfindahl 倒數 — 若 = 3 表示等同於 3 檔等權；越接近 1 越集中
                  </div>
                </div>
              </div>

              {analysis.sortedIndustry.length > 0 && (
                <div className="border-t border-border pt-2 mt-1">
                  <div className="text-muted-foreground text-xs mb-1">同產業重疊</div>
                  <div className="flex gap-2 flex-wrap text-xs">
                    {analysis.sortedIndustry.map(([ind, pct]) => (
                      <span key={ind} className={`px-2 py-1 rounded border font-mono ${
                        pct > 50 ? 'border-red-700/50 bg-red-900/20 text-red-300' :
                        pct > 30 ? 'border-amber-700/50 bg-amber-900/20 text-amber-300' :
                        'border-border bg-secondary text-foreground'
                      }`}>
                        {ind}: {pct.toFixed(1)}%
                      </span>
                    ))}
                  </div>
                  {analysis.topIndustry && analysis.topIndustry[1] > 50 && (
                    <p className="text-[10px] text-amber-300/80 mt-1">
                      ⚠ 「{analysis.topIndustry[0]}」&gt; 50% — 該產業大跌（如政策黑天鵝）會吃整個倉
                    </p>
                  )}
                </div>
              )}
            </section>

            {/* 風險預算 vs 朱書建議 */}
            <section className="rounded-xl ring-1 ring-foreground/10 bg-card p-4 space-y-2">
              <h2 className="text-sm font-semibold">💰 風險預算 vs 書本建議</h2>
              <div className="text-xs space-y-1 text-foreground/80">
                <p>朱書建議單筆風險 1-2% 總資金（書本《活用技術分析寶典》p.488）</p>
                <p>你目前累計風險 <span className="font-mono font-bold text-amber-300">{analysis.totalRiskPct.toFixed(2)}%</span></p>
                {analysis.totalRiskPct > 6 && (
                  <p className="text-red-300">🔴 累計風險 &gt; 6%：建議拉緊某些持倉停損 or 減半某檔</p>
                )}
                {analysis.totalRiskPct >= 3 && analysis.totalRiskPct <= 6 && (
                  <p className="text-amber-300">🟡 累計風險 3-6%：在書本紅黃線間，盯緊每日停損距離</p>
                )}
                {analysis.totalRiskPct < 3 && (
                  <p className="text-emerald-300">🟢 累計風險 &lt; 3%：在書本綠燈內，仍有 sizing 空間進新倉</p>
                )}
              </div>
            </section>

            {/* 每檔細節 */}
            <section className="rounded-xl ring-1 ring-foreground/10 bg-card p-4">
              <h2 className="text-sm font-semibold mb-2">📋 每檔細節</h2>
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground border-b border-border">
                      <th className="px-2 py-1 text-left">名稱</th>
                      <th className="px-2 py-1 text-right">市值</th>
                      <th className="px-2 py-1 text-right">集中度</th>
                      <th className="px-2 py-1 text-right">未實現</th>
                      <th className="px-2 py-1 text-right">風險金額</th>
                      <th className="px-2 py-1 text-right">風險 %</th>
                      <th className="px-2 py-1 text-right">距停損</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.rows.map(r => {
                      const dangerStop = r.distToStopPct != null && r.distToStopPct < 3;
                      return (
                        <tr key={r.symbol} className="border-b border-border/40 align-middle">
                          <td className="px-2 py-1.5">
                            <span className="font-medium">{stockDisplayName(r.name, r.symbol)}</span>
                            <span className="font-mono text-muted-foreground ml-1.5 text-[10px]">{r.symbol}</span>
                            <span className="text-muted-foreground/70 ml-1.5 text-[10px]">{r.industry}</span>
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono">{formatNT(r.marketValue)}</td>
                          <td className={`px-2 py-1.5 text-right font-mono ${
                            r.concentrationPct > 50 ? 'text-red-300' :
                            r.concentrationPct > 30 ? 'text-amber-300' : ''
                          }`}>
                            {r.concentrationPct.toFixed(1)}%
                          </td>
                          <td className={`px-2 py-1.5 text-right font-mono ${
                            r.unrealizedPnL >= 0 ? 'text-bull' : 'text-bear'
                          }`}>
                            {r.unrealizedPnL >= 0 ? '+' : ''}{formatNT(r.unrealizedPnL)}
                            <span className="text-muted-foreground/70 ml-1 text-[10px]">({r.unrealizedPct.toFixed(1)}%)</span>
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono">
                            {r.stopLoss ? formatNT(r.riskAmount) : '—'}
                          </td>
                          <td className={`px-2 py-1.5 text-right font-mono ${
                            r.riskPct > 2 ? 'text-amber-300' : ''
                          }`}>
                            {r.stopLoss ? `${r.riskPct.toFixed(2)}%` : '—'}
                          </td>
                          <td className={`px-2 py-1.5 text-right font-mono ${dangerStop ? 'text-red-300 font-bold' : ''}`}>
                            {r.distToStopPct != null ? `${r.distToStopPct.toFixed(1)}%` : '—'}
                            {dangerStop && ' 🛑'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Links */}
            <nav className="flex gap-2 flex-wrap text-xs pt-2 border-t border-border">
              <Link href="/today" className="text-sky-400 hover:underline">🌅 今日決策</Link>
              <Link href="/portfolio" className="text-sky-400 hover:underline">💼 持倉</Link>
              <Link href="/sizer" className="text-sky-400 hover:underline">📐 部位試算</Link>
              <Link href="/journal" className="text-sky-400 hover:underline">📓 交易日誌</Link>
              <Link href="/growth" className="text-sky-400 hover:underline">📈 進度</Link>
            </nav>
          </>
        )}
      </div>
    </PageShell>
  );
}

function BigStat({ label, value, sub, tone, hint }: {
  label: string; value: string; sub?: string;
  tone: 'green' | 'amber' | 'red'; hint?: string;
}) {
  const cls = {
    green: 'border-emerald-700/40 bg-emerald-900/15',
    amber: 'border-amber-700/40 bg-amber-900/15',
    red:   'border-red-700/40 bg-red-900/15',
  }[tone];
  const valCls = {
    green: 'text-emerald-300',
    amber: 'text-amber-300',
    red:   'text-red-300',
  }[tone];
  return (
    <div className={`rounded-lg border p-3 ${cls}`} title={hint}>
      <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-2xl font-bold font-mono ${valCls}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}
