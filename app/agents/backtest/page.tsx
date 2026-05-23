'use client';

/**
 * /agents/backtest?from=&to=
 *
 * 回測表現頁：
 *   - 區間查詢：from / to → summary
 *   - 顯示 買/觀察/略過 平均 1日/5日/20日報酬 + 勝率
 *   - 各代理判定 → 平均收益 / 勝率（用於判斷哪個代理命中最高）
 */

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { PageShell, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import type { BacktestSummary } from '@/lib/agents/backtest/types';

interface SummaryResp {
  ok: boolean;
  mode: 'range';
  market: string;
  from?: string;
  to?: string;
  datesIncluded: string[];
  summary: BacktestSummary | null;
}

const ACTION_LABEL: Record<'buy' | 'watch' | 'skip', string> = {
  buy: '買',
  watch: '觀察',
  skip: '略過',
};

const VERDICT_LABEL: Record<string, string> = {
  pass: '通過',
  watch: '觀察',
  fail: '不通過',
};

const AGENT_LABEL: Record<string, string> = {
  technical: '技術',
  news: '消息',
  chip: '籌碼',
  fundamental: '基本面',
  risk: '風控',
};

function fmtPct(v: number | null): string {
  if (v == null) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function fmtRate(v: number | null): string {
  if (v == null) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

function defaultFrom(): string {
  const d = new Date(Date.now() + 8 * 3600_000 - 30 * 86400_000);
  return d.toISOString().slice(0, 10);
}

function defaultTo(): string {
  const d = new Date(Date.now() + 8 * 3600_000);
  return d.toISOString().slice(0, 10);
}

export default function BacktestPage() {
  const searchParams = useSearchParams();
  const [from, setFrom] = useState(searchParams.get('from') ?? defaultFrom());
  const [to, setTo] = useState(searchParams.get('to') ?? defaultTo());
  const [data, setData] = useState<SummaryResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/backtest?from=${from}&to=${to}`);
      const json = await res.json() as SummaryResp;
      if (!res.ok) setError(`HTTP ${res.status}`);
      else setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : '讀取失敗');
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { fetchSummary(); }, [fetchSummary]);

  const buildBacktest = useCallback(async () => {
    setBusy(true);
    setBanner(null);
    setError(null);
    try {
      const res = await fetch(`/api/agents/backtest/build?date=${to}`, { method: 'POST' });
      const json = await res.json() as { ok?: boolean; error?: string; total?: number; computedThrough?: string; byAction?: Record<string, number> };
      if (!res.ok) setError(json.error ?? `HTTP ${res.status}`);
      else {
        setBanner(`✅ 已建立 ${to}：${json.total} 筆（計算至 ${json.computedThrough ?? '無資料'}）`);
        await fetchSummary();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '建立失敗');
    } finally {
      setBusy(false);
    }
  }, [to, fetchSummary]);

  const summary = data?.summary;

  const headerActions = (
    <>
      <Button onClick={buildBacktest} disabled={busy} variant="secondary" size="sm" title="對 to 日期跑前向分析算 1-20 日報酬">
        {busy ? '建立中…' : '建立'}
      </Button>
      <Button onClick={fetchSummary} disabled={loading} variant="ghost" size="sm">
        重整
      </Button>
    </>
  );

  return (
    <PageShell
      headerSlot={
        <PageHeader
          title="📊 回測"
          backButton="/agents"
          subtitle={summary ? `${summary.totalDecisions} 筆 · ${data?.datesIncluded.length ?? 0} 天` : '尚無資料'}
          actions={headerActions}
        />
      }
    >
      <div className="max-w-6xl mx-auto p-3 sm:p-4 space-y-3 sm:space-y-4">

        {/* 日期區間 */}
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <label className="flex items-center gap-1 text-muted-foreground">
            從
            <input
              type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              className="bg-secondary border border-border rounded px-2 py-1 text-foreground font-mono focus:outline-none focus:border-sky-500"
            />
          </label>
          <label className="flex items-center gap-1 text-muted-foreground">
            到
            <input
              type="date" value={to} onChange={(e) => setTo(e.target.value)}
              className="bg-secondary border border-border rounded px-2 py-1 text-foreground font-mono focus:outline-none focus:border-sky-500"
            />
          </label>
        </div>

        {banner && (
          <div className="border border-sky-500/40 bg-sky-500/10 text-sky-300 rounded-lg p-3 text-sm">
            {banner}
          </div>
        )}
        {error && (
          <div className="border border-red-700/50 bg-red-900/30 text-red-300 rounded-lg p-3 text-sm">
            {error}
          </div>
        )}

        {!summary && !loading && (
          <div className="border-2 border-dashed border-border rounded-lg p-6 text-sm text-muted-foreground text-center space-y-2">
            <p>此區間尚無回測資料。</p>
            <p>對某日跑完多代理四階段決策後，到此頁按「建立」算 1-20 日報酬。</p>
          </div>
        )}

        {summary && summary.totalDecisions === 0 && (
          <div className="border border-yellow-500/30 bg-yellow-500/10 text-yellow-300 rounded-lg p-3 text-sm">
            區間內無回測資料 — 確認{' '}
            <code className="bg-secondary text-sky-400 px-1.5 py-0.5 rounded font-mono text-xs">data/agents/runs/{'{date}'}/{'{symbol}'}/decision.json</code>
            {' '}是否存在。
          </div>
        )}

        {summary && summary.totalDecisions > 0 && (
          <>
            {/* 最終決策統計 */}
            <section className="bg-card border border-border rounded-xl p-4 space-y-3">
              <h2 className="text-xs font-semibold tracking-wider text-foreground">▸ 最終決策績效</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground border-b border-border">
                    <tr className="text-center">
                      <th className="py-2 px-2">動作</th>
                      <th className="py-2 px-2">樣本</th>
                      <th className="py-2 px-2">1日均報酬</th>
                      <th className="py-2 px-2">5日均報酬</th>
                      <th className="py-2 px-2">20日均報酬</th>
                      <th className="py-2 px-2">5日勝率</th>
                      <th className="py-2 px-2">20日勝率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(['buy', 'watch', 'skip'] as const).map(action => {
                      const s = summary.byAction[action];
                      const cls =
                        action === 'buy'  ? 'bg-emerald-900/30'
                        : action === 'skip' ? 'bg-rose-900/30'
                        : 'bg-amber-900/30';
                      const accentText =
                        action === 'buy'  ? 'text-emerald-300'
                        : action === 'skip' ? 'text-rose-300'
                        : 'text-amber-300';
                      return (
                        <tr key={action} className={`border-b border-border/40 hover:bg-muted/30 text-center ${cls}`}>
                          <td className={`py-2 px-2 font-semibold ${accentText}`}>{ACTION_LABEL[action]}</td>
                          <td className="py-2 px-2 font-mono">{s.sampleSize}</td>
                          <td className="py-2 px-2 font-mono">{fmtPct(s.avgD1Return)}</td>
                          <td className="py-2 px-2 font-mono">{fmtPct(s.avgD5Return)}</td>
                          <td className="py-2 px-2 font-mono">{fmtPct(s.avgD20Return)}</td>
                          <td className="py-2 px-2 font-mono">{fmtRate(s.winRateD5)}</td>
                          <td className="py-2 px-2 font-mono">{fmtRate(s.winRateD20)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            {/* 各代理判定命中率（§0 — 每個代理各自統計，不混合）*/}
            <section className="bg-card border border-border rounded-xl p-4 space-y-3">
              <h2 className="text-xs font-semibold tracking-wider text-foreground">
                ▸ 各代理判定命中率 <span className="text-muted-foreground font-normal">（§0 — 各自獨立統計）</span>
              </h2>
              <div className="space-y-3">
                {summary.agentAccuracy.map(a => (
                  <div key={a.agent} className="bg-muted/40 border border-border/60 rounded-lg p-3">
                    <h3 className="text-xs font-semibold text-foreground mb-2">
                      {AGENT_LABEL[a.agent] ?? a.agent} 代理
                    </h3>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead className="text-muted-foreground border-b border-border">
                          <tr className="text-center">
                            <th className="py-1.5 px-2">判定</th>
                            <th className="py-1.5 px-2">樣本</th>
                            <th className="py-1.5 px-2">1日均</th>
                            <th className="py-1.5 px-2">5日均</th>
                            <th className="py-1.5 px-2">20日均</th>
                            <th className="py-1.5 px-2">5日勝率</th>
                            <th className="py-1.5 px-2">20日勝率</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(a.byVerdict).map(([verdict, s]) => (
                            <tr key={verdict} className="border-b border-border/40 hover:bg-muted/30 last:border-0 text-center">
                              <td className="py-1.5 px-2">{VERDICT_LABEL[verdict] ?? verdict}</td>
                              <td className="py-1.5 px-2 font-mono">{s.sampleSize}</td>
                              <td className="py-1.5 px-2 font-mono">{fmtPct(s.avgD1Return)}</td>
                              <td className="py-1.5 px-2 font-mono">{fmtPct(s.avgD5Return)}</td>
                              <td className="py-1.5 px-2 font-mono">{fmtPct(s.avgD20Return)}</td>
                              <td className="py-1.5 px-2 font-mono">{fmtRate(s.winRateD5)}</td>
                              <td className="py-1.5 px-2 font-mono">{fmtRate(s.winRateD20)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* 區間內納入的日期 */}
            <details className="bg-card border border-border rounded-xl p-4 text-xs">
              <summary className="cursor-pointer text-foreground font-medium select-none">
                納入的日期（{data?.datesIncluded.length}）
              </summary>
              <div className="mt-3 flex gap-1 flex-wrap">
                {data?.datesIncluded.map(d => (
                  <span key={d} className="font-mono bg-secondary border border-border/60 text-foreground/80 px-2 py-0.5 rounded">{d}</span>
                ))}
              </div>
            </details>
          </>
        )}

        {/* 使用流程 */}
        <div className="border-2 border-dashed border-border rounded-lg p-3 text-xs text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">使用流程</p>
          <ol className="list-decimal ml-5 space-y-0.5">
            <li>跑多代理對某日做決策（候選池 → 批次準備 → 對話執行多代理決策完成 4 階段）</li>
            <li>等 1 ~ 20 個交易日資料累積</li>
            <li>到此頁按「建立」對該日跑前向分析算 1-20 日收益</li>
            <li>看 買/觀察/略過 平均收益是否符合預期</li>
            <li>看哪個代理的判定對 5 日收益最敏感 → 之後可調整權重</li>
          </ol>
        </div>
      </div>
    </PageShell>
  );
}
