'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { findETF, chartLoadSymbol, shortETFName } from '@/lib/etf/etfList';
import {
  ETF_FOUR_PITFALLS,
  ETF_SCREENING_POINTS,
  ETF_ALLOCATION_2026,
  ACTIVE_ETF_ADVANTAGES,
  ACTIVE_ETF_SELECTION_CRITERIA,
  ETF_MA20_SOP,
  overlapLevel,
  type SharedHoldingEntry,
  type OverlapPair,
} from '@/lib/etf/ch12Diagnostics';
import { Skeleton } from '@/components/ui/skeleton';
import { stockDisplayName } from '@/lib/stocks/stockIdentity';

interface DiagData {
  asOfDate: string | null;
  earliestDate?: string | null;
  etfCount: number;
  topN: number;
  sharedHoldings: SharedHoldingEntry[];
  overlapPairs: OverlapPair[];
  note?: string;
}

const OVERLAP_BADGE: Record<string, string> = {
  high: 'bg-rose-500/15 text-rose-400',
  medium: 'bg-amber-500/15 text-amber-500',
  low: 'bg-emerald-500/15 text-emerald-500',
};

function StockLink({ symbol, name }: { symbol: string; name?: string }) {
  const ls = chartLoadSymbol(symbol);
  const label = stockDisplayName(name, symbol);
  return ls
    ? <Link href={`/?load=${ls}`} className="hover:text-sky-400">{label}</Link>
    : <span>{label}</span>;
}

export function ETFDiagnosticsTab() {
  const [data, setData] = useState<DiagData | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/etf/diagnostics?topN=10&minOverlap=40')
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        // API 500 回 { error }（無 sharedHoldings/overlapPairs）→ 正規化成安全形狀，避免 render 崩
        setData({
          asOfDate: d.asOfDate ?? null,
          earliestDate: d.earliestDate ?? null,
          etfCount: d.etfCount ?? 0,
          topN: d.topN ?? 10,
          sharedHoldings: d.sharedHoldings ?? [],
          overlapPairs: d.overlapPairs ?? [],
          note: d.note ?? (d.error ? String(d.error) : undefined),
        });
      })
      .catch(() => { if (!cancelled) setData({ asOfDate: null, etfCount: 0, topN: 10, sharedHoldings: [], overlapPairs: [], note: '查詢失敗' }); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="mt-4 space-y-6">
      {/* 導言：CH12 核心觀念 */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="text-sm font-medium mb-1">📊 ETF 體檢（課程 CH12）</div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          投資的本質是「總報酬率」＝資本利得＋股息收入，不該為追求配息率而犧牲資產增長。
          下方用手上追蹤的台股型主動 ETF 最新持股，實際檢查「成分股是否高度重疊」（誤區三）——
          買好幾支卻壓在同一批股票上，等於沒分散、單一產業回檔會集體重挫。
        </p>
      </div>

      {/* 一、成分股集中榜（真數字） */}
      <section>
        <div className="flex items-baseline justify-between mb-2">
          <h3 className="text-sm font-medium">🔍 成分股集中榜</h3>
          {data?.asOfDate && (
            <span className="text-xs text-muted-foreground">
              {data.etfCount} 檔 ETF · 前 {data.topN} 大 · 各檔最新揭露
              {data.earliestDate && data.earliestDate !== data.asOfDate
                ? `（${data.earliestDate}~${data.asOfDate}）`
                : `（${data.asOfDate}）`}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mb-3">被最多檔 ETF 前十大同時重壓的個股 → 越集中，分散效果越差。</p>
        {!data ? (
          <Skeleton className="h-48 w-full" />
        ) : data.sharedHoldings.length === 0 ? (
          <div className="border border-dashed border-border rounded-lg p-6 text-center text-sm text-muted-foreground">
            {data.note ?? '無重疊持股資料'}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2">個股</th>
                  <th className="px-3 py-2 text-center">被幾檔壓</th>
                  <th className="px-3 py-2 text-right">加總權重</th>
                  <th className="px-3 py-2 text-right">平均權重</th>
                </tr>
              </thead>
              <tbody>
                {data.sharedHoldings.map((s) => (
                  <tr key={s.symbol} className="border-t border-border hover:bg-muted/30 align-top">
                    <td className="px-3 py-2">
                      <div className="font-mono text-xs text-muted-foreground">{s.symbol}</div>
                      <StockLink symbol={s.symbol} name={s.name} />
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className="inline-flex items-center justify-center min-w-6 h-6 px-2 rounded-md bg-sky-500/15 text-sky-400 text-xs font-medium">
                        {s.count}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{s.totalWeight.toFixed(1)}%</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{s.avgWeight.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 二、高重疊 ETF 配對 */}
      <section>
        <h3 className="text-sm font-medium mb-2">🔗 高重疊 ETF 配對</h3>
        <p className="text-xs text-muted-foreground mb-3">前十大重疊度 ≥40% 的配對；≥70% 屬課程口徑「高度重疊」，一起買等於沒分散。</p>
        {!data ? (
          <Skeleton className="h-32 w-full" />
        ) : data.overlapPairs.length === 0 ? (
          <div className="border border-dashed border-border rounded-lg p-6 text-center text-sm text-muted-foreground">
            無達 40% 重疊的配對（分散度良好）
          </div>
        ) : (
          <div className="space-y-2">
            {data.overlapPairs.map((p) => {
              const lvl = overlapLevel(p.overlapPct);
              return (
                <div key={`${p.aCode}-${p.bCode}`} className="rounded-lg border border-border bg-card p-3">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="text-sm">
                      <span className="font-mono text-xs text-muted-foreground">{p.aCode}</span> {shortETFName(p.aName)}
                      <span className="text-muted-foreground mx-1">×</span>
                      <span className="font-mono text-xs text-muted-foreground">{p.bCode}</span> {shortETFName(p.bName)}
                    </div>
                    <span className={`shrink-0 px-2 py-0.5 rounded-md text-xs font-medium ${OVERLAP_BADGE[lvl]}`}>
                      重疊 {p.overlapPct}%
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    前十大共 {p.sharedCount} 檔重複：{p.sharedNames.join('、')}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 三、四大誤區（教學） */}
      <section>
        <h3 className="text-sm font-medium mb-2">⚠️ ETF 四大誤區</h3>
        <div className="space-y-2">
          {ETF_FOUR_PITFALLS.map((p) => (
            <details key={p.id} className="rounded-lg border border-border bg-card">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium select-none">{p.title}</summary>
              <div className="px-3 pb-3 space-y-1.5 text-xs">
                <p><span className="text-muted-foreground">迷思：</span>{p.myth}</p>
                <p><span className="text-rose-400">真相：</span>{p.truth}</p>
                <ul className="list-disc list-inside text-muted-foreground space-y-0.5">
                  {p.checks.map((c, i) => <li key={i}>{c}</li>)}
                </ul>
              </div>
            </details>
          ))}
        </div>
      </section>

      {/* 四、篩選要點 */}
      <section>
        <h3 className="text-sm font-medium mb-2">✅ 篩選 ETF 要點</h3>
        <div className="space-y-2">
          {ETF_SCREENING_POINTS.map((s, i) => (
            <div key={i} className="rounded-lg border border-border bg-card p-3">
              <div className="text-sm font-medium mb-0.5">{s.title}</div>
              <div className="text-xs text-muted-foreground leading-relaxed">{s.detail}</div>
            </div>
          ))}
        </div>
      </section>

      {/* 四之二、月線進出場 SOP（課程 12-5 口述，投影片沒有） */}
      <section>
        <h3 className="text-sm font-medium mb-1">📉 ETF 月線進出場（課程 12-5）</h3>
        <p className="text-xs text-muted-foreground mb-2">
          這段投影片上沒有，是老師口述講的。跟現有「週線轉空提示」互補，不衝突。
        </p>
        <div className="space-y-2">
          {ETF_MA20_SOP.map((s, i) => (
            <div key={i} className="rounded-lg border border-border bg-card p-3">
              <div className="text-sm font-medium mb-0.5">{s.title}</div>
              <div className="text-xs text-muted-foreground leading-relaxed">{s.detail}</div>
            </div>
          ))}
        </div>
      </section>

      {/* 五、2026 建議配置 */}
      <section>
        <h3 className="text-sm font-medium mb-2">🧭 2026 建議配置（課程參考，非投資建議）</h3>
        <div className="space-y-2">
          {ETF_ALLOCATION_2026.map((a) => (
            <div key={a.tier} className="rounded-lg border border-border bg-card p-3">
              <div className="flex items-center justify-between mb-1">
                <div className="text-sm font-medium">{a.tier} · {a.goal}</div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">風險 {a.risk}</span>
                  <span className="px-2 py-0.5 rounded-md bg-sky-500/15 text-sky-400 text-xs font-medium">{a.weightPct}%</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-1 mb-1.5">
                {a.tickers.map((t) => {
                  const ls = chartLoadSymbol(t);
                  return ls
                    ? <Link key={t} href={`/?load=${ls}`} className="font-mono text-xs px-1.5 py-0.5 rounded bg-secondary hover:text-sky-400">{t}</Link>
                    : <span key={t} className="text-xs px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">{t}</span>;
                })}
              </div>
              <div className="text-xs text-muted-foreground leading-relaxed">{a.strategy}</div>
            </div>
          ))}
        </div>
      </section>

      {/* 六、主動式 ETF 優勢 + 挑選標準 */}
      <section>
        <details className="rounded-lg border border-border bg-card">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium select-none">🚀 主動式 ETF：五大優勢 + 挑選標準</summary>
          <div className="px-3 pb-3 space-y-3 text-xs">
            <div>
              <div className="text-muted-foreground mb-1">五大優勢</div>
              <ul className="space-y-1">
                {ACTIVE_ETF_ADVANTAGES.map((a, i) => (
                  <li key={i}><span className="font-medium">{a.title}</span>：{a.detail}</li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-muted-foreground mb-1">挑選標準</div>
              <ul className="space-y-1">
                {ACTIVE_ETF_SELECTION_CRITERIA.map((c, i) => (
                  <li key={i}><span className="font-medium">{c.title}</span>：{c.detail}</li>
                ))}
              </ul>
            </div>
          </div>
        </details>
      </section>
    </div>
  );
}
