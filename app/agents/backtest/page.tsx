'use client';

/**
 * /agents/backtest?from=&to=
 *
 * Backtest 表現頁：
 *   - 區間查詢：from / to → summary
 *   - 顯示 buy/watch/skip 平均 d1/d5/d20 報酬 + 勝率
 *   - 各 Agent verdict → 平均收益 / 勝率（用於判斷哪個 Agent 命中最高）
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { PageShell } from '@/components/shared';
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
      setError(err instanceof Error ? err.message : 'fetch failed');
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
        setBanner(`✅ 已 build ${to}: ${json.total} 筆 (through ${json.computedThrough ?? 'no data'})`);
        await fetchSummary();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'build failed');
    } finally {
      setBusy(false);
    }
  }, [to, fetchSummary]);

  const summary = data?.summary;

  return (
    <PageShell>
      <div className="space-y-4 p-4 max-w-6xl mx-auto">
        <header className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold">Backtest 回測</h1>
            <p className="text-sm text-gray-500">
              {summary ? `${summary.totalDecisions} 筆決策 · ${data?.datesIncluded.length ?? 0} 天區間` : '尚無資料'}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-sm flex items-center gap-1">
              from
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="border rounded px-2 py-1 text-sm" />
            </label>
            <label className="text-sm flex items-center gap-1">
              to
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="border rounded px-2 py-1 text-sm" />
            </label>
            <button
              onClick={buildBacktest}
              disabled={busy}
              className="border rounded px-3 py-1 text-sm bg-blue-50 hover:bg-blue-100 disabled:opacity-50"
              title="對 to 日期跑 ForwardAnalyzer 算 d1-d20"
            >
              {busy ? 'Building…' : 'Build (to 日期)'}
            </button>
            <button
              onClick={fetchSummary}
              disabled={loading}
              className="border rounded px-3 py-1 text-sm hover:bg-gray-50 disabled:opacity-50"
            >
              重整
            </button>
            <Link href={`/agents`} className="text-sm text-blue-600 hover:underline">
              ← 回主頁
            </Link>
          </div>
        </header>

        {banner && (
          <div className="border border-blue-300 bg-blue-50 text-blue-900 rounded p-3 text-sm">
            {banner}
          </div>
        )}
        {error && (
          <div className="border border-red-300 bg-red-50 text-red-800 rounded p-3 text-sm">
            {error}
          </div>
        )}

        {!summary && !loading && (
          <div className="border border-dashed border-gray-300 rounded p-6 text-sm text-gray-500 text-center space-y-2">
            <p>此區間尚無 backtest 資料。</p>
            <p>對某日跑 Multi-Agent decision 後（P4 完整 4 phase），到此頁按「Build (to 日期)」算 d1-d20。</p>
          </div>
        )}

        {summary && summary.totalDecisions === 0 && (
          <div className="border border-yellow-300 bg-yellow-50 text-yellow-800 rounded p-3 text-sm">
            區間內無 backtest entries — 確認 data/agents/runs/{'{date}'}/{'{symbol}'}/decision.json 是否存在。
          </div>
        )}

        {summary && summary.totalDecisions > 0 && (
          <>
            {/* Final Action 統計 */}
            <section className="space-y-2">
              <h2 className="font-semibold text-sm">Final Action 績效</h2>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm border">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="border px-3 py-2 text-left">Action</th>
                      <th className="border px-3 py-2 text-center">樣本</th>
                      <th className="border px-3 py-2 text-center">avg d1</th>
                      <th className="border px-3 py-2 text-center">avg d5</th>
                      <th className="border px-3 py-2 text-center">avg d20</th>
                      <th className="border px-3 py-2 text-center">勝率 d5</th>
                      <th className="border px-3 py-2 text-center">勝率 d20</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(['buy', 'watch', 'skip'] as const).map(action => {
                      const s = summary.byAction[action];
                      const cls = action === 'buy' ? 'bg-green-50' : action === 'skip' ? 'bg-red-50' : 'bg-yellow-50';
                      return (
                        <tr key={action} className={cls}>
                          <td className="border px-3 py-2 font-semibold">{action.toUpperCase()}</td>
                          <td className="border px-3 py-2 text-center font-mono">{s.sampleSize}</td>
                          <td className="border px-3 py-2 text-center font-mono">{fmtPct(s.avgD1Return)}</td>
                          <td className="border px-3 py-2 text-center font-mono">{fmtPct(s.avgD5Return)}</td>
                          <td className="border px-3 py-2 text-center font-mono">{fmtPct(s.avgD20Return)}</td>
                          <td className="border px-3 py-2 text-center font-mono">{fmtRate(s.winRateD5)}</td>
                          <td className="border px-3 py-2 text-center font-mono">{fmtRate(s.winRateD20)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            {/* 各 Agent verdict 命中率（§0 — 每個 agent 各自統計，不混合）*/}
            <section className="space-y-2">
              <h2 className="font-semibold text-sm">各 Agent verdict 命中率（§0 — 各自獨立統計）</h2>
              <div className="space-y-3">
                {summary.agentAccuracy.map(a => (
                  <div key={a.agent} className="border rounded p-3">
                    <h3 className="font-medium text-sm mb-2 capitalize">{a.agent} Agent</h3>
                    <table className="min-w-full text-xs border">
                      <thead className="bg-gray-100">
                        <tr>
                          <th className="border px-2 py-1 text-left">Verdict</th>
                          <th className="border px-2 py-1 text-center">樣本</th>
                          <th className="border px-2 py-1 text-center">avg d1</th>
                          <th className="border px-2 py-1 text-center">avg d5</th>
                          <th className="border px-2 py-1 text-center">avg d20</th>
                          <th className="border px-2 py-1 text-center">勝率 d5</th>
                          <th className="border px-2 py-1 text-center">勝率 d20</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(a.byVerdict).map(([verdict, s]) => (
                          <tr key={verdict}>
                            <td className="border px-2 py-1 font-mono">{verdict}</td>
                            <td className="border px-2 py-1 text-center font-mono">{s.sampleSize}</td>
                            <td className="border px-2 py-1 text-center font-mono">{fmtPct(s.avgD1Return)}</td>
                            <td className="border px-2 py-1 text-center font-mono">{fmtPct(s.avgD5Return)}</td>
                            <td className="border px-2 py-1 text-center font-mono">{fmtPct(s.avgD20Return)}</td>
                            <td className="border px-2 py-1 text-center font-mono">{fmtRate(s.winRateD5)}</td>
                            <td className="border px-2 py-1 text-center font-mono">{fmtRate(s.winRateD20)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            </section>

            {/* 區間內納入的日期 */}
            <details className="border rounded p-3 text-xs">
              <summary className="font-medium cursor-pointer">
                納入的日期（{data?.datesIncluded.length}）
              </summary>
              <div className="mt-2 flex gap-1 flex-wrap">
                {data?.datesIncluded.map(d => <span key={d} className="font-mono bg-gray-100 px-2 py-0.5 rounded">{d}</span>)}
              </div>
            </details>
          </>
        )}

        {/* 使用流程 */}
        <div className="border border-dashed border-gray-300 rounded p-3 text-xs text-gray-500 space-y-1">
          <p className="font-medium text-gray-700">使用流程</p>
          <ol className="list-decimal ml-5 space-y-0.5">
            <li>跑 Multi-Agent 對某日做決策（pool → prepare-batch → /multi-agent-decide 完成 4 phase）</li>
            <li>等 T+1 ~ T+20 個交易日資料累積</li>
            <li>到此頁按「Build」對該日跑 ForwardAnalyzer 算 d1-d20 收益</li>
            <li>看 buy/watch/skip 平均收益是否符合預期</li>
            <li>看哪個 Agent 的 verdict 對 d5 收益最敏感 → 之後可調整權重（P6）</li>
          </ol>
        </div>
      </div>
    </PageShell>
  );
}
