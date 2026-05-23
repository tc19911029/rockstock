'use client';

/**
 * /agents/memory?kind=technical|news|chip|fundamental|risk|debate|decision|conflicts|weekly
 *
 * 記憶 / 反思報告檢視頁
 *
 * §0 紅線：記憶是純報告，**不影響系統行為**。
 * 此頁只負責顯示，使用者親手讀並決定是否要手動調整來源。
 */

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { PageShell, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
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
  technical:   '技術面代理',
  news:        '消息面代理',
  chip:        '籌碼面代理',
  fundamental: '基本面代理',
  risk:        '風控代理',
  debate:      '多空辯論',
  conflicts:   '跨代理衝突案例',
  decision:    '決策代理路徑',
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
      setError(err instanceof Error ? err.message : '讀取列表失敗');
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
      setError(err instanceof Error ? err.message : '讀取失敗');
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
          `✅ 反思題目已準備：${json.decisionsCount} 筆決策 / ${json.conflictCount} 衝突案例 / ${json.backtestDatesIncluded} 天回測。` +
          ` 請到對話視窗執行反思指令產出報告。`,
        );
        await fetchList();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '準備失敗');
    } finally {
      setBusy(false);
    }
  }, [from, to, fetchList]);

  // 按 kind 分組（非 weekly + weekly）
  const nonWeekly = files.filter(f => f.kind !== 'weekly');
  const weekly = files.filter(f => f.kind === 'weekly');

  const headerActions = (
    <Button onClick={triggerReflect} disabled={busy} variant="secondary" size="sm">
      {busy ? '準備中…' : '準備反思'}
    </Button>
  );

  return (
    <PageShell
      headerSlot={
        <PageHeader
          title="🧠 記憶 / 反思報告"
          backButton="/agents"
          subtitle={<span className="text-red-400">純報告 · 不影響系統行為（§0 紅線）</span>}
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

        {/* §0 紅線警示 */}
        <div className="border-l-4 border-red-500 bg-red-900/20 text-red-300 rounded-r-lg p-3 text-xs">
          <strong>§0 紅線提醒：</strong>記憶是純文字觀察報告，<strong>不會被</strong>任何整理流程或對話指令讀取。
          如果報告顯示某代理命中率偏低，請<strong>使用者親手</strong>修改原始碼，
          <strong>不要</strong>讓反思流程自動改代理邏輯。
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 sm:gap-4">
          {/* 左：分頁列表 */}
          <aside className="md:col-span-1 space-y-2">
            <h2 className="text-xs font-semibold tracking-wider text-foreground">▸ 代理報告</h2>
            <div className="space-y-1">
              {nonWeekly.map(f => {
                const active = activeKind === f.kind && !activeWeek;
                return (
                  <button
                    key={f.kind}
                    onClick={() => { setActiveKind(f.kind); setActiveWeek(null); }}
                    className={`w-full text-left px-3 py-2 rounded-lg border text-xs transition-colors cursor-pointer ${
                      active
                        ? 'bg-sky-500/15 border-sky-500/50 text-sky-300'
                        : f.exists
                          ? 'bg-secondary border-border hover:bg-muted text-foreground'
                          : 'bg-muted/30 border-border/60 text-muted-foreground/60'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{KIND_LABEL[f.kind]}</span>
                      <span className="text-[10px] font-mono">{f.exists ? '✓' : '—'}</span>
                    </div>
                    {f.exists && f.updatedAt && (
                      <div className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                        {new Date(f.updatedAt).toLocaleDateString('zh-TW')}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>

            {weekly.length > 0 && (
              <>
                <h2 className="text-xs font-semibold tracking-wider text-foreground mt-4">▸ 週報</h2>
                <div className="space-y-1">
                  {weekly.map(f => {
                    const week = f.path.match(/week=(\d{4}-W\d{2})/)?.[1] ?? null;
                    const active = activeKind === 'weekly' && activeWeek === week;
                    return (
                      <button
                        key={f.path}
                        onClick={() => { setActiveKind('weekly'); setActiveWeek(week); }}
                        className={`w-full text-left px-3 py-2 rounded-lg border text-xs transition-colors cursor-pointer ${
                          active
                            ? 'bg-sky-500/15 border-sky-500/50 text-sky-300'
                            : 'bg-secondary border-border hover:bg-muted text-foreground'
                        }`}
                      >
                        <div className="font-mono">{week ?? f.kind}</div>
                        {f.updatedAt && (
                          <div className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                            {new Date(f.updatedAt).toLocaleDateString('zh-TW')}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </aside>

          {/* 右：內容 */}
          <main className="md:col-span-3">
            {!activeKind && (
              <div className="border-2 border-dashed border-border rounded-lg p-6 text-sm text-muted-foreground text-center">
                點左側選擇要查看的報告
              </div>
            )}

            {activeKind && loading && (
              <div className="border border-border rounded-xl bg-card p-6 text-sm text-muted-foreground text-center animate-pulse">
                載入中…
              </div>
            )}

            {activeKind && !loading && !content && (
              <div className="border border-yellow-500/30 bg-yellow-500/10 text-yellow-300 rounded-lg p-4 text-sm">
                此報告尚未生成。請按上方「準備反思」，然後到對話視窗執行反思指令。
              </div>
            )}

            {activeKind && content && (
              <article className="bg-card border border-border rounded-xl p-4 sm:p-6">
                <pre className="whitespace-pre-wrap font-mono text-xs text-foreground/90 bg-muted/40 border border-border/60 rounded-lg p-3 sm:p-4 overflow-x-auto">
                  {content}
                </pre>
              </article>
            )}
          </main>
        </div>

        {/* 使用流程 */}
        <div className="border-2 border-dashed border-border rounded-lg p-3 text-xs text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">使用流程（每週執行一次即可）</p>
          <ol className="list-decimal ml-5 space-y-0.5">
            <li>選 從 / 到 區間（建議 1-4 週）</li>
            <li>點「準備反思」→ 整理回測與衝突案例寫到暫存區</li>
            <li>到對話視窗執行反思指令</li>
            <li>產生 9 份報告寫到資料夾</li>
            <li>回此頁點左側代理名稱看報告</li>
            <li>若覺得某代理規則需調整，<strong className="text-foreground">手動</strong>改原始碼（不會自動修改）</li>
          </ol>
        </div>
      </div>
    </PageShell>
  );
}
