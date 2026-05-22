'use client';

/**
 * /agents/memory?kind=technical|news|chip|fundamental|risk|debate|decision|conflicts|weekly
 *
 * Memory / Reflect 報告檢視頁
 *
 * §0 紅線：memory 是純報告，**不影響系統行為**。
 * 此頁只負責顯示，使用者親手讀並決定是否要手動調整 source。
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { PageShell } from '@/components/shared';
import type { MemoryFileMeta, MemoryKind } from '@/lib/agents/memory/types';

interface ListResp {
  ok: boolean;
  mode: 'list';
  files: MemoryFileMeta[];
}

interface SingleResp {
  ok: boolean;
  mode: 'single';
  kind: MemoryKind;
  week: string | null;
  exists: boolean;
  content: string | null;
}

const KIND_LABEL: Record<MemoryKind, string> = {
  technical:   '技術面 Agent',
  news:        '消息面 Agent',
  chip:        '籌碼面 Agent',
  fundamental: '基本面 Agent',
  risk:        '風控 Agent',
  debate:      'Bull vs Bear 辯論',
  decision:    'Decision Agent paths',
  conflicts:   '跨 Agent 衝突 case',
  weekly:      '週報',
};

function todayYmd(): string {
  const tpe = new Date(Date.now() + 8 * 3600_000);
  return tpe.toISOString().slice(0, 10);
}

function thirtyDaysAgo(): string {
  const d = new Date(Date.now() + 8 * 3600_000 - 30 * 86400_000);
  return d.toISOString().slice(0, 10);
}

export default function MemoryPage() {
  const searchParams = useSearchParams();
  const initialKind = (searchParams.get('kind') as MemoryKind | null) ?? null;
  const initialWeek = searchParams.get('week') ?? null;
  const [activeKind, setActiveKind] = useState<MemoryKind | null>(initialKind);
  const [activeWeek, setActiveWeek] = useState<string | null>(initialWeek);
  const [files, setFiles] = useState<MemoryFileMeta[]>([]);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [from, setFrom] = useState(thirtyDaysAgo());
  const [to, setTo] = useState(todayYmd());

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/agents/memory');
      const json = await res.json() as ListResp;
      setFiles(json.files ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'list failed');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchContent = useCallback(async (kind: MemoryKind, week?: string | null) => {
    setLoading(true);
    setContent(null);
    setError(null);
    try {
      const url = `/api/agents/memory?kind=${kind}${week ? `&week=${week}` : ''}`;
      const res = await fetch(url);
      const json = await res.json() as SingleResp;
      if (!res.ok) setError(`HTTP ${res.status}`);
      else setContent(json.content);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fetch failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchList(); }, [fetchList]);

  useEffect(() => {
    if (activeKind) fetchContent(activeKind, activeWeek);
  }, [activeKind, activeWeek, fetchContent]);

  const triggerReflect = useCallback(async () => {
    setBusy(true);
    setBanner(null);
    setError(null);
    try {
      const res = await fetch(`/api/agents/reflect/build?from=${from}&to=${to}`, { method: 'POST' });
      const json = await res.json() as {
        ok?: boolean; error?: string;
        questionPath?: string; decisionsCount?: number; conflictCount?: number; backtestDatesIncluded?: number;
      };
      if (!res.ok) setError(json.error ?? `HTTP ${res.status}`);
      else {
        setBanner(
          `✅ Reflect question 已 prepare：${json.decisionsCount} 筆決策 / ${json.conflictCount} 衝突 case / ${json.backtestDatesIncluded} 天 backtest。` +
          ` 請在 Claude Code 對話執行 /agents-reflect 產出 markdown 報告。`,
        );
        await fetchList();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'reflect failed');
    } finally {
      setBusy(false);
    }
  }, [from, to, fetchList]);

  // 按 kind 分組（非 weekly + weekly）
  const nonWeekly = files.filter(f => f.kind !== 'weekly');
  const weekly = files.filter(f => f.kind === 'weekly');

  return (
    <PageShell>
      <div className="space-y-4 p-4 max-w-6xl mx-auto">
        <header className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold">Memory / Reflect 報告</h1>
            <p className="text-sm text-gray-500">
              純報告 · <span className="text-red-700 font-medium">不影響系統行為</span>（§0 紅線）
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
              onClick={triggerReflect}
              disabled={busy}
              className="border rounded px-3 py-1 text-sm bg-blue-50 hover:bg-blue-100 disabled:opacity-50"
            >
              {busy ? 'Preparing…' : 'Prepare Reflect'}
            </button>
            <Link href="/agents" className="text-sm text-blue-600 hover:underline">← 回主頁</Link>
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

        {/* 警示 */}
        <div className="border-l-4 border-red-400 bg-red-50 p-3 text-xs text-red-900 rounded-r">
          <strong>§0 紅線提醒：</strong>memory 是純文字觀察報告，**不會被** 任何 prepare/skill 讀取。
          如果報告顯示某 agent 命中率偏低，請<strong>使用者親手</strong>修改 source（如 lib/agents/agents/*.ts），
          <strong>不要</strong>讓 reflect skill 自動修改 agent 邏輯。
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {/* 左：分頁列表 */}
          <aside className="space-y-1 md:col-span-1">
            <h2 className="text-sm font-semibold mb-1">Agent 報告</h2>
            {nonWeekly.map(f => (
              <button
                key={f.kind}
                onClick={() => { setActiveKind(f.kind); setActiveWeek(null); }}
                className={`w-full text-left px-3 py-2 rounded border text-sm ${
                  activeKind === f.kind && !activeWeek
                    ? 'bg-blue-100 border-blue-400 text-blue-900'
                    : f.exists
                      ? 'bg-white hover:bg-gray-50'
                      : 'bg-gray-50 text-gray-400'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span>{KIND_LABEL[f.kind]}</span>
                  <span className="text-xs">{f.exists ? '✓' : '—'}</span>
                </div>
                {f.exists && f.updatedAt && (
                  <div className="text-xs text-gray-500 mt-0.5">
                    {new Date(f.updatedAt).toLocaleDateString('zh-TW')}
                  </div>
                )}
              </button>
            ))}

            {weekly.length > 0 && (
              <>
                <h2 className="text-sm font-semibold mt-3 mb-1">週報</h2>
                {weekly.map(f => {
                  const week = f.path.match(/week=(\d{4}-W\d{2})/)?.[1] ?? null;
                  return (
                    <button
                      key={f.path}
                      onClick={() => { setActiveKind('weekly'); setActiveWeek(week); }}
                      className={`w-full text-left px-3 py-2 rounded border text-sm ${
                        activeKind === 'weekly' && activeWeek === week
                          ? 'bg-blue-100 border-blue-400 text-blue-900'
                          : 'bg-white hover:bg-gray-50'
                      }`}
                    >
                      <div className="font-mono text-sm">{week ?? f.kind}</div>
                      {f.updatedAt && (
                        <div className="text-xs text-gray-500 mt-0.5">
                          {new Date(f.updatedAt).toLocaleDateString('zh-TW')}
                        </div>
                      )}
                    </button>
                  );
                })}
              </>
            )}
          </aside>

          {/* 右：內容 */}
          <main className="md:col-span-3">
            {!activeKind && (
              <div className="border border-dashed border-gray-300 rounded p-6 text-sm text-gray-500 text-center">
                點左側選擇要查看的 memory 報告
              </div>
            )}

            {activeKind && loading && <p className="text-gray-500">載入中…</p>}

            {activeKind && !loading && !content && (
              <div className="border border-yellow-300 bg-yellow-50 text-yellow-900 rounded p-4 text-sm">
                此 memory 檔尚未生成。請按上方「Prepare Reflect」+ Claude Code 對話執行 <code className="bg-yellow-100 px-1 rounded">/agents-reflect</code>。
              </div>
            )}

            {activeKind && content && (
              <article className="border rounded p-6 bg-white prose prose-sm max-w-none">
                <pre className="whitespace-pre-wrap font-mono text-xs bg-gray-50 p-3 rounded">{content}</pre>
              </article>
            )}
          </main>
        </div>

        {/* 使用流程 */}
        <div className="border border-dashed border-gray-300 rounded p-3 text-xs text-gray-500 space-y-1">
          <p className="font-medium text-gray-700">使用流程（每週執行一次即可）</p>
          <ol className="list-decimal ml-5 space-y-0.5">
            <li>選 from / to 區間（建議 1-4 週）</li>
            <li>點「Prepare Reflect」→ 整理 backtest + 衝突 case 寫 /tmp question</li>
            <li>在 Claude Code 對話執行 <code className="bg-gray-100 px-1 rounded">/agents-reflect</code></li>
            <li>skill 寫 9 份 markdown 到 data/agents/memory/</li>
            <li>回此頁點左側 agent 名稱看報告</li>
            <li>若覺得某 agent 規則需調整，<strong>手動</strong>修改 source（不會自動 fix）</li>
          </ol>
        </div>
      </div>
    </PageShell>
  );
}
