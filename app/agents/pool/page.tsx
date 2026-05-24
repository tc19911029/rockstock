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
import { TrustStageBadge } from './_components/TrustStageBadge';
import { useSearchParams } from 'next/navigation';
import { PageShell, PageHeader } from '@/components/shared';
import type { Candidate, SourceName } from '@/lib/agents/candidates/types';
import { DatePicker } from '@/components/ui/DatePicker';
import { formatLetters } from '@/lib/scanner/buyMethodTracks';
import { signalOf } from '@/lib/i18n/fundamentalLabels';
import { lastBusinessDayYmd } from '@/lib/dateDefaults';

/** YouTube sentiment 英文 → 中文 */
function sentimentZh(s: string | null | undefined): string {
  const map: Record<string, string> = {
    bullish: '多方',
    bearish: '空方',
    mixed: '多空混雜',
    mentioned_only: '僅提及',
    neutral: '中立',
  };
  return (s && map[s]) ? map[s] : (s ?? '');
}

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

const SOURCE_LABEL: Record<SourceName, string> = {
  technical: '技術',
  youtube: '消息',
  chip: '籌碼',
  fundamental: '基本',
};

const SOURCE_COLOR: Record<SourceName, string> = {
  technical:   'bg-blue-700/40 text-blue-300 border-blue-500/50',
  youtube:     'bg-purple-700/40 text-purple-300 border-purple-500/50',
  chip:        'bg-orange-700/40 text-orange-300 border-orange-500/50',
  fundamental: 'bg-teal-700/40 text-teal-300 border-teal-500/50',
};

export default function CandidatesPoolPage() {
  const searchParams = useSearchParams();
  // 預設用「最近工作日」而非今天 — 週末/早上打開時，今天通常沒有 scan 資料
  // URL ?date= 仍可 override
  const initialDate = searchParams.get('date') ?? lastBusinessDayYmd();
  const [date, setDate] = useState(initialDate);
  const [minSourceCount, setMinSourceCount] = useState(1);
  const [limit, setLimit] = useState(50);
  const [data, setData] = useState<PoolResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  // server-side open holdings symbols（用來在 pool 列表標記「已持有」）
  const [heldSymbols, setHeldSymbols] = useState<Set<string>>(new Set());
  useEffect(() => {
    fetch('/api/agents/portfolio?status=open')
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        const syms = (j?.holdings ?? []).map((h: { symbol: string }) => h.symbol);
        setHeldSymbols(new Set(syms));
      })
      .catch(() => setHeldSymbols(new Set()));
  }, []);

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
          `✅ 已建立候選池：${json.total} 檔候選 (${json.elapsedMs}ms)。` +
          `四／三／兩／單面向 = ${json.distribution?.sourceCount4}／${json.distribution?.sourceCount3}／${json.distribution?.sourceCount2}／${json.distribution?.sourceCount1}`,
        );
        await fetchPool();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'build failed');
    } finally {
      setBusy(false);
    }
  }, [date, fetchPool]);

  const poolPageHeader = (
    <PageHeader
      title="📋 候選股票池"
      backButton="/agents"
      subtitle={
        <span className="hidden md:inline font-mono">
          {date} · {data?.exists ? `${data.total} 檔` : '未建立'}
        </span>
      }
    />
  );

  return (
    <PageShell headerSlot={poolPageHeader}>
      <div className="min-h-full">
        {/* ───────── CONTROL BAR ───────── */}
        <header className="border-b border-border bg-card sticky top-12 z-10">
          <div className="max-w-[1600px] mx-auto px-6 pt-3 pb-1 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-muted-foreground text-xs font-mono">
                {date} · {data?.exists ? `${data.total} 檔候選` : '候選池尚未建立'}
              </span>
            </div>
          </div>
          {/* Date pill grid（仿策略掃描）— 獨佔一行 */}
          <div className="max-w-[1600px] mx-auto px-6 py-1">
            <DatePicker value={date} onChange={setDate} size="md" />
          </div>
          <div className="max-w-[1600px] mx-auto px-6 pt-1 pb-3 flex items-center justify-end gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-sm flex-wrap">
              <label className="text-muted-foreground text-xs flex items-center gap-1">
                ≥
                <select
                  value={minSourceCount}
                  onChange={(e) => setMinSourceCount(Number(e.target.value))}
                  className="bg-secondary border border-border rounded px-1.5 py-1 text-xs"
                  title="只看至少這幾個面向同時看好的股票"
                >
                  <option value={1}>1 個面向</option>
                  <option value={2}>2 個面向</option>
                  <option value={3}>3 個面向</option>
                  <option value={4}>4 個面向</option>
                </select>
              </label>
              <label className="text-muted-foreground text-xs flex items-center gap-1">
                上限
                <input
                  type="number"
                  value={limit}
                  min={1}
                  max={500}
                  onChange={(e) => setLimit(Math.max(1, Math.min(500, Number(e.target.value) || 50)))}
                  className="bg-secondary border border-border rounded px-2 py-1 w-16 font-mono text-xs"
                  title="最多顯示幾檔候選"
                />
              </label>
              <button
                onClick={buildPool}
                disabled={busy}
                className="bg-sky-500 hover:bg-sky-400 text-white px-3 py-1 rounded text-xs font-medium transition disabled:opacity-50"
              >
                {busy ? '建立中…' : '⚡ 建立候選池'}
              </button>
              <button
                onClick={fetchPool}
                disabled={loading}
                className="border border-border hover:bg-secondary px-3 py-1 rounded text-xs transition disabled:opacity-50"
              >
                ⟲ 重整
              </button>
              <Link href={`/agents?date=${date}`} className="text-sky-500 hover:text-sky-400 text-xs">
                多代理分析 →
              </Link>
            </div>
          </div>
        </header>

        <div className="max-w-[1600px] mx-auto px-6 py-4 space-y-4">

          {/* 說明 */}
          <p className="text-xs text-muted-foreground max-w-3xl leading-relaxed">
            候選股票池 = 經 4 個面向（<span className="font-semibold text-foreground">技術策略</span>／<span className="font-semibold text-foreground">YouTube 節目共識</span>／<span className="font-semibold text-foreground">籌碼面</span>／<span className="font-semibold text-foreground">基本面</span>）每日匯總的「今日值得進多代理分析的股票清單」。每檔股票記錄面向命中、技術買法、節目提及等資訊，按命中面向數排序。
          </p>

          {/* Banner / Error */}
          {banner && (
            <div className="border border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300 rounded p-3 text-sm">
              {banner}
            </div>
          )}
          {error && (
            <div className="border border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300 rounded p-3 text-sm whitespace-pre-wrap">
              {error}
            </div>
          )}

          {loading && !data && <p className="text-muted-foreground text-sm">載入中…</p>}

          {data && !data.exists && !error && (
            <div className="border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-200 rounded-lg p-4 text-sm space-y-2">
              <p className="font-medium">此日尚未建立候選池。</p>
              <p>點上方「⚡ 建立候選池」（系統會跑 4 個面向掃描並合併匯總）。</p>
            </div>
          )}

          {data?.exists && (
            <>
              {/* Source 狀態 — PipelineStage 風格深色卡片 */}
              <PoolPanel title="四面向資料狀態">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  {(Object.keys(SOURCE_LABEL) as SourceName[]).map((s) => {
                    const stat = data.sourceStatus?.[s];
                    const hasData = stat?.ran && (stat?.count ?? 0) > 0;
                    const stateClass = hasData
                      ? 'border-emerald-500/50 bg-emerald-900/30 shadow-[0_0_12px_rgb(16_185_129/0.2)]'
                      : stat?.ran
                        ? 'border-slate-600 bg-slate-800/60'
                        : 'border-slate-700/50 bg-slate-800/30 opacity-60';
                    return (
                      <div key={s} className={`border rounded-lg p-3 transition ${stateClass}`}>
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className={`inline-flex px-2 py-0.5 rounded border text-xs font-medium ${SOURCE_COLOR[s]}`}>
                            {SOURCE_LABEL[s]}
                          </span>
                          <span className={`text-sm font-mono font-semibold ${hasData ? 'text-emerald-300' : 'text-slate-300'}`}>
                            {stat?.count ?? 0} 檔
                          </span>
                        </div>
                        {stat?.error && <p className="text-xs text-rose-400">{stat.error}</p>}
                        {!stat?.ran && !stat?.error && <p className="text-xs text-slate-500">⏳ 未跑</p>}
                        {stat?.ran && !hasData && !stat?.error && <p className="text-xs text-slate-500">無資料</p>}
                      </div>
                    );
                  })}
                </div>
              </PoolPanel>

              {/* 多源分布 — PipelineStage chip 風格 */}
              {data.distribution && (
                <PoolPanel title="今天有幾個面向同時看好這檔股票？">
                  <p className="text-xs text-slate-400 mb-3 leading-relaxed">
                    系統每天從 <span className="text-blue-300">技術</span>、<span className="text-purple-300">消息</span>（YouTube 節目）、<span className="text-orange-300">籌碼</span>、<span className="text-teal-300">基本面</span> 4 個面向各自挑出值得看的股票，再合併計票。
                    <span className="block mt-1 text-slate-500">同一檔股票被越多面向挑中，信號越強。建議用控制列的「≥ 2 個面向」過濾掉只有單面向的雜訊。</span>
                  </p>
                  <div className="flex gap-2 flex-wrap text-sm">
                    <span className="inline-flex items-center px-3 py-1.5 rounded-lg border bg-rose-700/40 border-rose-500/50 text-rose-300 font-medium shadow-[0_0_12px_rgb(244_63_94/0.15)]">
                      🌟 四面向共識：
                      <span className="font-mono font-semibold ml-1">{data.distribution.sourceCount4}</span>
                      <span className="text-xs ml-1 text-rose-300/70">檔</span>
                    </span>
                    <span className="inline-flex items-center px-3 py-1.5 rounded-lg border bg-orange-700/40 border-orange-500/50 text-orange-300 font-medium">
                      ⭐ 三面向共識：
                      <span className="font-mono font-semibold ml-1">{data.distribution.sourceCount3}</span>
                      <span className="text-xs ml-1 text-orange-300/70">檔</span>
                    </span>
                    <span className="inline-flex items-center px-3 py-1.5 rounded-lg border bg-amber-700/40 border-amber-500/50 text-amber-300 font-medium">
                      ✨ 兩面向共識：
                      <span className="font-mono font-semibold ml-1">{data.distribution.sourceCount2}</span>
                      <span className="text-xs ml-1 text-amber-300/70">檔</span>
                    </span>
                    <span className="inline-flex items-center px-3 py-1.5 rounded-lg border bg-slate-700/40 border-slate-500/50 text-slate-400 font-medium">
                      · 單面向訊號（雜訊多）：
                      <span className="font-mono font-semibold ml-1">{data.distribution.sourceCount1}</span>
                      <span className="text-xs ml-1 text-slate-500">檔</span>
                    </span>
                  </div>
                </PoolPanel>
              )}

              {/* 候選表格 — Panel deep card */}
              <PoolPanel title={`候選列表（${data.returned}/${data.total}）`}>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-700 text-slate-400 text-xs">
                        <th className="px-2 py-2 text-left font-medium">股票</th>
                        <th className="px-2 py-2 text-left font-medium">產業</th>
                        <th className="px-2 py-2 text-center font-medium" title="幾個面向同時看好">面向</th>
                        <th className="px-2 py-2 text-left font-medium">命中面向</th>
                        <th className="px-2 py-2 text-center font-medium" title="陳威良 3比8 動向 proxy（最近 30 天投信淨買 ÷ 已發行股數）">投信動向</th>
                        <th className="px-2 py-2 text-left font-medium">進入理由摘要</th>
                        <th className="px-2 py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.candidates?.map((c) => (
                        <tr key={c.symbol} className={`border-b border-slate-800 align-top hover:bg-slate-800/40 transition-colors ${heldSymbols.has(c.symbol) ? 'bg-sky-900/15' : ''}`}>
                          <td className="px-2 py-2">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-slate-200 font-medium">{c.name}</span>
                              {heldSymbols.has(c.symbol) && (
                                <span
                                  title="已持有（server holdings.json open）"
                                  className="inline-flex items-center px-1.5 py-0.5 rounded border bg-sky-900/40 border-sky-500/50 text-sky-300 text-[10px] font-semibold"
                                >
                                  💼 已持有
                                </span>
                              )}
                              {c.sources.technical?.prohibitionHit && (
                                <span
                                  title="技術面：戒律觸發（禁止做多）。點「分析 →」看書本戒律細項"
                                  className="inline-flex items-center px-1.5 py-0.5 rounded border bg-red-900/40 border-red-500/50 text-red-300 text-[10px] font-semibold"
                                >
                                  🚫 戒律
                                </span>
                              )}
                              {c.sources.technical?.eliminationHit && (
                                <span
                                  title="技術面：淘汰法觸發（不應進場）。點「分析 →」看淘汰原因"
                                  className="inline-flex items-center px-1.5 py-0.5 rounded border bg-orange-900/40 border-orange-500/50 text-orange-300 text-[10px] font-semibold"
                                >
                                  ⛔ 淘汰
                                </span>
                              )}
                              {!c.sources.technical && (
                                <span
                                  title="本檔僅由消息/籌碼/基本面入池，未經技術面戒律檢核。可能仍觸發書本戒律 — 點「分析 →」會在個股頁顯示完整技術判定"
                                  className="inline-flex items-center px-1.5 py-0.5 rounded border bg-slate-800/60 border-slate-600/50 text-slate-400 text-[10px]"
                                >
                                  ⚠ 技術未檢
                                </span>
                              )}
                            </div>
                            <div className="font-mono text-xs text-slate-500">{c.symbol}</div>
                          </td>
                          <td className="px-2 py-2 text-xs text-slate-400">{c.industry ?? '—'}</td>
                          <td className="px-2 py-2 text-center">
                            <span className="font-mono font-semibold text-slate-200">{c.sourceCount}</span>
                          </td>
                          <td className="px-2 py-2">
                            <div className="flex gap-1 flex-wrap items-center">
                              {(Object.keys(c.sources) as SourceName[]).map((s) => {
                                // YouTube 高共識（≥2 節目同向）：chip 加 ★ + 亮邊
                                // §0 隔離：consensus 是 YouTube source 的 boost，不是新 source
                                const youtubeHighConsensus = s === 'youtube' && c.sources.youtube?.inHighConsensus === true;
                                return (
                                  <span
                                    key={s}
                                    title={youtubeHighConsensus
                                      ? `高共識：${c.sources.youtube?.mentionCount} 節目同向（${sentimentZh(c.sources.youtube?.sentiment)}）`
                                      : undefined}
                                    className={`inline-flex items-center px-2 py-0.5 rounded border text-xs ${
                                      youtubeHighConsensus
                                        ? 'bg-purple-500/50 text-purple-100 border-purple-300 shadow-[0_0_6px_rgb(192_132_252/0.4)] font-semibold'
                                        : SOURCE_COLOR[s]
                                    }`}
                                  >
                                    {youtubeHighConsensus && <span className="mr-0.5">★</span>}
                                    {SOURCE_LABEL[s]}
                                  </span>
                                );
                              })}
                            </div>
                          </td>
                          <td className="px-2 py-2 text-center">
                            <TrustStageBadge symbol={c.symbol} date={date} />
                          </td>
                          <td className="px-2 py-2 text-xs text-slate-300">
                            <ReasonsSummary candidate={c} />
                          </td>
                          <td className="px-2 py-2">
                            <Link
                              href={`/agents/${encodeURIComponent(c.symbol)}?date=${date}`}
                              className="text-sky-400 hover:text-sky-300 text-sm"
                            >
                              分析 →
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </PoolPanel>
            </>
          )}

          {/* 使用流程 */}
          <div className="border border-dashed border-border rounded p-3 text-xs text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">使用流程</p>
            <ol className="list-decimal ml-5 space-y-0.5">
              <li>點「⚡ 建立候選池」執行四面向掃描（技術 / 消息 / 籌碼 / 基本面），合併去重</li>
              <li>觀察命中強度：≥ 2 個面向的候選通常更值得進多代理分析</li>
              <li>到 <Link href={`/agents?date=${date}`} className="text-sky-500 hover:text-sky-400 underline">多代理分析</Link> 對候選池跑批次準備</li>
              <li>每檔點「分析 →」看技術／消息／籌碼／基本面四個獨立判定</li>
            </ol>
          </div>
        </div>
      </div>
    </PageShell>
  );
}

/** Deep-card Panel — 與 /agents 主頁 Panel 風格一致 */
function PoolPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-cyan-700/40 bg-slate-900 rounded-lg p-4">
      <div className="text-xs font-semibold tracking-wider text-cyan-400 mb-3">📌 {title}</div>
      {children}
    </div>
  );
}

function ReasonsSummary({ candidate }: { candidate: Candidate }) {
  const items: string[] = [];
  const t = candidate.sources.technical;
  if (t) items.push(`技術：命中 ${formatLetters(t.tracks) || '—'}｜六條件 ${t.sixConditionsScore}/6`);
  const y = candidate.sources.youtube;
  if (y) items.push(`消息：${y.mentionCount} 節目${y.inHighConsensus ? '（高共識）' : ''}｜${sentimentZh(y.sentiment)}`);
  const ch = candidate.sources.chip;
  if (ch && ch.signals.length > 0) items.push(`籌碼：${ch.signals.map(signalOf).join(' / ')}`);
  const f = candidate.sources.fundamental;
  if (f && f.signals.length > 0) items.push(`基本面：${f.signals.map(signalOf).join(' / ')}`);
  return (
    <div className="space-y-0.5">
      {items.map((i, idx) => <div key={idx}>{i}</div>)}
    </div>
  );
}
