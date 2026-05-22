'use client';

/**
 * /agents/pool?date=&minSourceCount=&limit=
 *
 * 顯示當日 Candidates Pool：
 *   - 4 個 Source 的命中數 & 狀態
 *   - 多源交集分布（sourceCount 4/3/2/1）
 *   - 候選表格：每檔列出進入 sources + 各自 attribution 摘要
 *
 * UX：先看 pool（為何進入候選）→ 點任一檔開 /agents/[symbol] 看 4 Agent 分析
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { PageShell } from '@/components/shared';
import type { Candidate, SourceName } from '@/lib/agents/candidates/types';

interface PoolResponse {
  ok: boolean;
  date: string;
  market: string;
  exists: boolean;
  generatedAt?: string;
  sourceStatus?: Record<SourceName, { ran: boolean; error?: string; count: number }>;
  total?: number;
  returned?: number;
  minSourceCount?: number;
  distribution?: { sourceCount4: number; sourceCount3: number; sourceCount2: number; sourceCount1: number };
  candidates?: Candidate[];
  error?: string;
}

function todayYmd(): string {
  const tpe = new Date(Date.now() + 8 * 3600_000);
  return tpe.toISOString().slice(0, 10);
}

const SOURCE_LABEL: Record<SourceName, string> = {
  technical: '技術',
  youtube: '消息',
  chip: '籌碼',
  fundamental: '基本',
};

const SOURCE_COLOR: Record<SourceName, string> = {
  technical:   'bg-blue-100 text-blue-800 border-blue-300',
  youtube:     'bg-purple-100 text-purple-800 border-purple-300',
  chip:        'bg-orange-100 text-orange-800 border-orange-300',
  fundamental: 'bg-teal-100 text-teal-800 border-teal-300',
};

export default function CandidatesPoolPage() {
  const searchParams = useSearchParams();
  const initialDate = searchParams.get('date') ?? todayYmd();
  const [date, setDate] = useState(initialDate);
  const [minSourceCount, setMinSourceCount] = useState(1);
  const [limit, setLimit] = useState(50);
  const [data, setData] = useState<PoolResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const fetchPool = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/pool?date=${date}&minSourceCount=${minSourceCount}&limit=${limit}`);
      const json = await res.json() as PoolResponse;
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        setData(null);
      } else {
        setData(json);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fetch failed');
    } finally {
      setLoading(false);
    }
  }, [date, minSourceCount, limit]);

  useEffect(() => { fetchPool(); }, [fetchPool]);

  const buildPool = useCallback(async () => {
    setBusy(true);
    setBanner(null);
    setError(null);
    try {
      const res = await fetch(`/api/agents/pool/build?date=${date}`, { method: 'POST' });
      const json = await res.json() as {
        ok?: boolean; error?: string;
        total?: number; elapsedMs?: number;
        distribution?: { sourceCount4: number; sourceCount3: number; sourceCount2: number; sourceCount1: number };
      };
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
      } else {
        setBanner(
          `✅ 已建立 pool：${json.total} 檔候選 (${json.elapsedMs}ms)。` +
          `多源 4/3/2/1 = ${json.distribution?.sourceCount4}/${json.distribution?.sourceCount3}/${json.distribution?.sourceCount2}/${json.distribution?.sourceCount1}`,
        );
        await fetchPool();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'build failed');
    } finally {
      setBusy(false);
    }
  }, [date, fetchPool]);

  return (
    <PageShell>
      <div className="space-y-6 p-4 max-w-6xl mx-auto">
        <header className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold">Candidates Pool</h1>
            <p className="text-sm text-gray-500">
              {date} · {data?.exists ? `${data.total} 檔候選` : 'Pool 尚未建立'}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="border rounded px-2 py-1 text-sm"
            />
            <label className="text-sm flex items-center gap-1">
              ≥
              <select
                value={minSourceCount}
                onChange={(e) => setMinSourceCount(Number(e.target.value))}
                className="border rounded px-2 py-1 text-sm"
              >
                <option value={1}>1 源</option>
                <option value={2}>2 源</option>
                <option value={3}>3 源</option>
                <option value={4}>4 源</option>
              </select>
            </label>
            <label className="text-sm flex items-center gap-1">
              limit
              <input
                type="number"
                value={limit}
                min={1}
                max={500}
                onChange={(e) => setLimit(Math.max(1, Math.min(500, Number(e.target.value) || 50)))}
                className="border rounded px-2 py-1 text-sm w-16"
              />
            </label>
            <button
              onClick={buildPool}
              disabled={busy}
              className="border rounded px-3 py-1 text-sm bg-blue-50 hover:bg-blue-100 disabled:opacity-50"
            >
              {busy ? '建立中…' : '建立 Pool'}
            </button>
            <button
              onClick={fetchPool}
              disabled={loading}
              className="border rounded px-3 py-1 text-sm hover:bg-gray-50 disabled:opacity-50"
            >
              重整
            </button>
            <Link href={`/agents?date=${date}`} className="text-sm text-blue-600 hover:underline">
              → Multi-Agent 分析
            </Link>
          </div>
        </header>

        {banner && (
          <div className="border border-blue-300 bg-blue-50 text-blue-900 rounded p-3 text-sm">
            {banner}
          </div>
        )}
        {error && (
          <div className="border border-red-300 bg-red-50 text-red-800 rounded p-3 text-sm whitespace-pre-wrap">
            {error}
          </div>
        )}

        {loading && !data && <p className="text-gray-500">載入中…</p>}

        {data && !data.exists && !error && (
          <div className="border border-yellow-300 bg-yellow-50 text-yellow-900 rounded p-4 text-sm space-y-2">
            <p className="font-medium">此日尚無 Candidates Pool。</p>
            <p>點上方「建立 Pool」（會跑 4 個 Source extractor 並合併寫 data/agents/pool/）。</p>
          </div>
        )}

        {data?.exists && (
          <>
            {/* Source 狀態 */}
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Source 狀態</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {(Object.keys(SOURCE_LABEL) as SourceName[]).map((s) => {
                  const stat = data.sourceStatus?.[s];
                  return (
                    <div key={s} className={`border rounded p-2 ${stat?.ran ? 'bg-white' : 'bg-gray-100 opacity-60'}`}>
                      <div className="flex items-center justify-between">
                        <span className={`inline-flex px-2 py-0.5 rounded border text-xs ${SOURCE_COLOR[s]}`}>
                          {SOURCE_LABEL[s]}
                        </span>
                        <span className="text-sm font-mono">{stat?.count ?? 0} 檔</span>
                      </div>
                      {stat?.error && <p className="text-xs text-red-600 mt-1">{stat.error}</p>}
                      {!stat?.ran && !stat?.error && <p className="text-xs text-gray-500 mt-1">未跑</p>}
                    </div>
                  );
                })}
              </div>
            </section>

            {/* 多源分布 */}
            {data.distribution && (
              <section className="space-y-2">
                <h2 className="text-sm font-semibold">多源命中強度</h2>
                <div className="flex gap-2 flex-wrap text-sm">
                  <span className="inline-flex items-center px-3 py-1 rounded border bg-red-50 border-red-300">
                    🌟 4 源: {data.distribution.sourceCount4}
                  </span>
                  <span className="inline-flex items-center px-3 py-1 rounded border bg-orange-50 border-orange-300">
                    ⭐ 3 源: {data.distribution.sourceCount3}
                  </span>
                  <span className="inline-flex items-center px-3 py-1 rounded border bg-yellow-50 border-yellow-300">
                    ✨ 2 源: {data.distribution.sourceCount2}
                  </span>
                  <span className="inline-flex items-center px-3 py-1 rounded border bg-gray-50 border-gray-300">
                    · 1 源: {data.distribution.sourceCount1}
                  </span>
                </div>
              </section>
            )}

            {/* 候選表格 */}
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">候選列表（{data.returned}/{data.total}）</h2>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm border">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="border px-2 py-2 text-left">股票</th>
                      <th className="border px-2 py-2 text-left">產業</th>
                      <th className="border px-2 py-2 text-center">多源</th>
                      <th className="border px-2 py-2 text-left">Sources</th>
                      <th className="border px-2 py-2 text-left">進入理由摘要</th>
                      <th className="border px-2 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.candidates?.map((c) => (
                      <tr key={c.symbol} className="align-top">
                        <td className="border px-2 py-2 font-mono">
                          <div>{c.symbol}</div>
                          <div className="text-xs text-gray-500">{c.name}</div>
                        </td>
                        <td className="border px-2 py-2 text-xs text-gray-600">{c.industry ?? '—'}</td>
                        <td className="border px-2 py-2 text-center">
                          <span className="font-mono font-semibold">{c.sourceCount}</span>
                        </td>
                        <td className="border px-2 py-2">
                          <div className="flex gap-1 flex-wrap">
                            {(Object.keys(c.sources) as SourceName[]).map((s) => (
                              <span
                                key={s}
                                className={`inline-flex px-2 py-0.5 rounded border text-xs ${SOURCE_COLOR[s]}`}
                              >
                                {SOURCE_LABEL[s]}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="border px-2 py-2 text-xs text-gray-700">
                          <ReasonsSummary candidate={c} />
                        </td>
                        <td className="border px-2 py-2">
                          <Link
                            href={`/agents/${encodeURIComponent(c.symbol)}?date=${date}`}
                            className="text-blue-600 hover:underline text-sm"
                          >
                            分析 →
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {/* 使用流程 */}
        <div className="border border-dashed border-gray-300 rounded p-3 text-xs text-gray-500 space-y-1">
          <p className="font-medium text-gray-700">使用流程</p>
          <ol className="list-decimal ml-5 space-y-0.5">
            <li>點「建立 Pool」跑 4 個 Source extractor（Technical/YouTube/Chip/Fundamental），合併去重</li>
            <li>觀察多源命中強度：≥2 源的候選通常更值得 Multi-Agent 分析</li>
            <li>到 <Link href={`/agents?date=${date}`} className="text-blue-600 hover:underline">Multi-Agent 分析</Link> 對 pool 跑 prepare-batch + skill</li>
            <li>每檔點「分析 →」看 4 個 Agent 獨立 verdict 並列</li>
          </ol>
        </div>
      </div>
    </PageShell>
  );
}

function ReasonsSummary({ candidate }: { candidate: Candidate }) {
  const items: string[] = [];
  const t = candidate.sources.technical;
  if (t) items.push(`技術: 命中 ${t.tracks.join('/')} 軌 + 六條件 ${t.sixConditionsScore}/6`);
  const y = candidate.sources.youtube;
  if (y) items.push(`消息: ${y.mentionCount} 節目${y.inHighConsensus ? ' 高共識' : ''}（${y.sentiment}）`);
  const ch = candidate.sources.chip;
  if (ch && ch.signals.length > 0) items.push(`籌碼: ${ch.signals.join('/')}`);
  const f = candidate.sources.fundamental;
  if (f && f.signals.length > 0) items.push(`基本: ${f.signals.join('/')}`);
  return (
    <div className="space-y-0.5">
      {items.map((i, idx) => <div key={idx}>{i}</div>)}
    </div>
  );
}
