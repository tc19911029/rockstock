'use client';

/**
 * /agents?date=YYYY-MM-DD
 *
 * 多代理決策中心 — TradingAgents 風格深色 dashboard
 *
 * Layout（3 欄）：
 *   - 左 3/12：各代理進度（4 階段 team 分組）+ 判定統計
 *   - 中 5/12：個股卡片列表（點擊切換選取，自動載 detail）
 *   - 右 4/12：選取個股的多空對立卡 + 4 面向 reasoning
 *
 * 深色主題：slate-950 底 + cyan 邊框 + emerald/amber/rose verdict 高對比
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { PageShell, PageHeader } from '@/components/shared';
import { DatePicker } from '@/components/ui/DatePicker';
import { lastBusinessDayYmd } from '@/lib/dateDefaults';
import type {
  AgentRunMeta, AgentPhaseState,
  BearThesis, BullThesis,
  ChipAnswer, ChipReasoningItem, ChipSection,
  FinalAction, FinalDecision,
  FundamentalAnswer, FundamentalReasoningItem, FundamentalSection,
  NewsAnswer, NewsReasoningItem, NewsSection,
  RiskAnswer,
  TechnicalAnswer, TechnicalReasoningItem, TechnicalSection,
} from '@/lib/agents/types';
import type { Candidate } from '@/lib/agents/candidates/types';

type Verdict = 'pass' | 'watch' | 'fail';

interface VerdictSummary { verdict: Verdict; overview: string }

interface RunListItem {
  symbol: string;
  name: string | null;
  status: 'pending' | 'completed';
  /** P1+P2 修：每階段獨立狀態（解決 completed 定義不一致）*/
  phaseStatus: {
    phase1Done: boolean;
    phase2Done: boolean;
    phase3Done: boolean;
    phase4Done: boolean;
  };
  runId: string | null;
  market: string | null;
  startedAt: string | null;
  verdicts: {
    technical:   VerdictSummary | null;
    news:        VerdictSummary | null;
    chip:        VerdictSummary | null;
    fundamental: VerdictSummary | null;
  };
  risk: { verdict: 'green' | 'yellow' | 'red'; overview: string } | null;
  decision: {
    action: FinalAction;
    decisionPath: string;
    overview: string;
    bullScore: number;
    bearScore: number;
    sizeHint: number;
  } | null;
}

interface ListResponse {
  ok: boolean;
  date: string;
  runs: RunListItem[];
  count: number;
  error?: string;
}

interface DetailPayload {
  ok: boolean;
  date: string;
  symbol: string;
  meta: AgentRunMeta | null;
  phase: AgentPhaseState | null;
  candidate: Candidate | null;
  technical:   TechnicalAnswer | null;
  news:        NewsAnswer | null;
  chip:        ChipAnswer | null;
  fundamental: FundamentalAnswer | null;
  risk:        RiskAnswer | null;
  bull:        BullThesis | null;
  bear:        BearThesis | null;
  decision:    FinalDecision | null;
  error?: string;
}

const TECH_SECTION_LABELS: Record<TechnicalSection, string> = {
  trend: '① 趨勢', kbar: '② K 線', ma: '③ 均線',
  volume: '④ 量能', kd: '⑤ KD / MACD', mtf: '⑥ 長線保護短線',
};
const NEWS_SECTION_LABELS: Record<NewsSection, string> = {
  youtube_consensus: 'YouTube 跨節目共識',
  rss_news: 'RSS 新聞情緒',
  event_risk: '事件風險',
};
const CHIP_SECTION_LABELS: Record<ChipSection, string> = {
  institutional: '三大法人', margin: '融資融券', lending: '借券', large_holders: '大戶持股',
};
const FUNDAMENTAL_SECTION_LABELS: Record<FundamentalSection, string> = {
  revenue: '月營收 / YoY', profit: '獲利能力', valuation: '估值', industry: '產業',
};

/**
 * FIX-3：第一階段完成定義 — 4 個 analyst answer 都寫好（AND 邏輯）
 *
 * 優先用 list API 提供的 phaseStatus.phase1Done（精確），fallback 用 verdict OR 邏輯（向後相容舊 API）
 */
function isPhase1Done(r: RunListItem): boolean {
  if (r.phaseStatus) return r.phaseStatus.phase1Done;
  return Boolean(r.verdicts.technical && r.verdicts.news && r.verdicts.chip && r.verdicts.fundamental);
}

function isPhase2Done(r: RunListItem): boolean {
  return Boolean(r.phaseStatus?.phase2Done);
}
function isPhase3Done(r: RunListItem): boolean {
  return Boolean(r.phaseStatus?.phase3Done);
}
function isPhase4Done(r: RunListItem): boolean {
  return Boolean(r.phaseStatus?.phase4Done);
}

function findDp(dps: Array<{ label: string; value: string }> | undefined, label: string): string | null {
  return dps?.find((d) => d.label === label)?.value ?? null;
}

/**
 * Pipeline stage 視覺狀態：
 *   - done   = 全部個股本階段已完成（綠光）
 *   - active = 部分完成 OR 已可進入下一階段（cyan 光）
 *   - pending = 完全沒跑
 */
function stageStatus(total: number, thisPhase: number, nextPhase: number): 'done' | 'active' | 'pending' {
  if (total === 0) return 'pending';
  if (thisPhase === total) return 'done';
  if (thisPhase > 0 || nextPhase > 0) return 'active';
  return 'pending';
}

/** 目前流水線最大階段 ∈ [0, 4] */
function maxStageCompleted(counts: { phase1Done: number; phase2Done: number; phase3Done: number; phase4Done: number }): number {
  if (counts.phase4Done > 0) return 4;
  if (counts.phase3Done > 0) return 3;
  if (counts.phase2Done > 0) return 2;
  if (counts.phase1Done > 0) return 1;
  return 0;
}

// ────────────────────────────────────────────────────────────────────────────
// Page
// ────────────────────────────────────────────────────────────────────────────

const HELP_DISMISSED_KEY = 'multi-agent-help-dismissed-v1';

export default function AgentsListPage() {
  const searchParams = useSearchParams();
  // 預設用「最近工作日」而非今天 — 週末/早上打開時，今天通常沒有 scan 資料
  // URL ?date= 仍可 override
  const initialDate = searchParams.get('date') ?? lastBusinessDayYmd();
  const [date, setDate] = useState(initialDate);
  const [top, setTop] = useState(10);
  const [minSourceCount, setMinSourceCount] = useState(1);
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailPayload | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // 使用說明預設展開，使用者按收起後寫 localStorage 記住
  const [helpOpen, setHelpOpen] = useState(true);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.localStorage.getItem(HELP_DISMISSED_KEY) === '1') setHelpOpen(false);
  }, []);
  const dismissHelp = useCallback(() => {
    setHelpOpen(false);
    if (typeof window !== 'undefined') window.localStorage.setItem(HELP_DISMISSED_KEY, '1');
  }, []);
  const reopenHelp = useCallback(() => {
    setHelpOpen(true);
    if (typeof window !== 'undefined') window.localStorage.removeItem(HELP_DISMISSED_KEY);
  }, []);

  const fetchList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/decisions?date=${date}`);
      const json = (await res.json()) as ListResponse;
      if (!res.ok) { setError(json.error ?? `HTTP ${res.status}`); setData(null); }
      else setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fetch failed');
    } finally { setLoading(false); }
  }, [date]);

  useEffect(() => { fetchList(); }, [fetchList]);

  // 自動選第一支已完成個股
  useEffect(() => {
    if (selectedSymbol || !data?.runs.length) return;
    const first = data.runs.find((r) => r.status === 'completed') ?? data.runs[0];
    if (first) setSelectedSymbol(first.symbol);
  }, [data, selectedSymbol]);

  // 選取改變時抓 detail
  useEffect(() => {
    if (!selectedSymbol) { setDetail(null); return; }
    let cancelled = false;
    setDetailLoading(true);
    fetch(`/api/agents/decisions/${encodeURIComponent(selectedSymbol)}?date=${date}`)
      .then((r) => r.json())
      .then((d: DetailPayload) => { if (!cancelled) setDetail(d); })
      .catch(() => { if (!cancelled) setDetail(null); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selectedSymbol, date]);

  const runBatchPrepare = useCallback(async () => {
    setBusy(true);
    setBanner(null);
    setError(null);
    try {
      const res = await fetch(
        `/api/agents/prepare-batch?date=${date}&top=${top}&minSourceCount=${minSourceCount}`,
        { method: 'POST' },
      );
      const json = await res.json() as {
        ok?: boolean; error?: string;
        prepared?: Array<{ symbol: string; name: string }>;
        failed?: Array<{ symbol: string; error: string }>;
      };
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
      } else {
        const ok = json.prepared?.length ?? 0;
        const fail = json.failed?.length ?? 0;
        setBanner(`✅ 已準備 ${ok} 檔分析提示${fail > 0 ? `（${fail} 檔失敗）` : ''}。請在 Claude Code 對話中輸入 /multi-agent-decide 才會實際跑分析。`);
        await fetchList();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'prepare-batch failed');
    } finally { setBusy(false); }
  }, [date, top, minSourceCount, fetchList]);

  const counts = useMemo(() => {
    const runs = data?.runs ?? [];
    const byAgent = (k: 'technical' | 'news' | 'chip' | 'fundamental') => ({
      pass:  runs.filter((r) => r.verdicts[k]?.verdict === 'pass').length,
      watch: runs.filter((r) => r.verdicts[k]?.verdict === 'watch').length,
      fail:  runs.filter((r) => r.verdicts[k]?.verdict === 'fail').length,
    });
    return {
      total: runs.length,
      // FIX-3：4 個階段精確計數
      phase1Done: runs.filter(isPhase1Done).length,
      phase2Done: runs.filter(isPhase2Done).length,
      phase3Done: runs.filter(isPhase3Done).length,
      phase4Done: runs.filter(isPhase4Done).length,
      // 全 4 階段都完成（= 有 decision.json）
      allDone: runs.filter((r) => r.status === 'completed').length,
      pending: runs.filter((r) => !isPhase1Done(r)).length,
      technical:   byAgent('technical'),
      news:        byAgent('news'),
      chip:        byAgent('chip'),
      fundamental: byAgent('fundamental'),
      finalAction: {
        buy:   runs.filter((r) => r.decision?.action === 'buy').length,
        watch: runs.filter((r) => r.decision?.action === 'watch').length,
        skip:  runs.filter((r) => r.decision?.action === 'skip').length,
      },
    };
  }, [data]);

  const agentsPageHeader = (
    <PageHeader
      title="🤖 多代理決策中心"
      backButton
      subtitle={
        <span className="hidden md:inline font-mono">
          {date} · {counts.total} 檔 · P1 {counts.phase1Done}/{counts.total}
        </span>
      }
    />
  );

  return (
    <PageShell headerSlot={agentsPageHeader}>
      <div className="min-h-full">
        {/* ───────── CONTROL BAR ───────── */}
        <header className="border-b border-border bg-card sticky top-12 z-10">
          <div className="max-w-[1600px] mx-auto px-6 py-3 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-muted-foreground text-xs font-mono">
                {date} · 共 {counts.total} 檔 ·
                第一 {counts.phase1Done}/{counts.total} ·
                第二 {counts.phase2Done}/{counts.total} ·
                第三 {counts.phase3Done}/{counts.total} ·
                第四 {counts.phase4Done}/{counts.total}
              </span>
            </div>
            <div className="flex items-center gap-2 text-sm flex-wrap">
              <label className="text-muted-foreground text-xs flex items-center gap-1" title="候選池按面向命中數排序，這裡選最強的前 N 個訊號跑分析">
                前
                <input
                  type="number" value={top} min={1} max={50}
                  onChange={(e) => setTop(Math.max(1, Math.min(50, Number(e.target.value) || 10)))}
                  className="bg-secondary border border-border rounded px-2 py-1 w-14 font-mono text-xs"
                />
                檔
              </label>
              <label className="text-muted-foreground text-xs flex items-center gap-1">
                ≥
                <select
                  value={minSourceCount}
                  onChange={(e) => setMinSourceCount(Number(e.target.value))}
                  className="bg-secondary border border-border rounded px-1.5 py-1 text-xs"
                  title="只對至少這幾個面向同時看好的候選跑分析"
                >
                  <option value={1}>1 個面向</option>
                  <option value={2}>2 個面向</option>
                  <option value={3}>3 個面向</option>
                  <option value={4}>4 個面向</option>
                </select>
              </label>
              <button
                onClick={runBatchPrepare} disabled={busy || loading}
                className="bg-sky-500 hover:bg-sky-400 text-white px-3 py-1 rounded text-xs font-medium transition disabled:opacity-50"
                title="對前 N 檔候選產生分析提示檔（在 Claude Code 對話輸入 /multi-agent-decide 才實際跑）"
              >
                {busy ? '處理中…' : '⚡ 批次準備（產生分析提示）'}
              </button>
              <button
                onClick={fetchList} disabled={loading}
                className="border border-border hover:bg-secondary px-3 py-1 rounded text-xs transition disabled:opacity-50"
              >
                ⟲ 重整
              </button>
              {!helpOpen && (
                <button
                  onClick={reopenHelp}
                  className="border border-border hover:bg-secondary px-3 py-1 rounded text-xs transition"
                  title="重新展開使用說明"
                >
                  📘 說明
                </button>
              )}
              <Link href={`/agents/pool?date=${date}`} className="text-sky-500 hover:text-sky-400 text-xs">候選池 →</Link>
            </div>
          </div>
          {/* Date pill grid（仿策略掃描）— 獨佔一行 */}
          <div className="max-w-[1600px] mx-auto px-6 pb-3">
            <DatePicker value={date} onChange={setDate} size="md" />
          </div>
        </header>

        {/* ───────── 使用說明（預設展開、可收起；收起後 control bar 出現「📘 說明」按鈕重新打開）───────── */}
        {helpOpen && (
          <div className="max-w-[1600px] mx-auto px-6 pt-4">
            <div className="border border-sky-700/40 bg-sky-950/30 rounded-lg p-4 text-sm">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="font-semibold text-sky-300">📘 多代理決策中心怎麼用？</div>
                <button
                  onClick={dismissHelp}
                  className="text-xs text-muted-foreground hover:text-foreground border border-border rounded px-2 py-0.5"
                  title="不再顯示（之後可從控制列「📘 說明」按鈕重新打開）"
                >
                  收起
                </button>
              </div>
              <ol className="list-decimal ml-5 space-y-1.5 text-slate-300 text-xs leading-relaxed">
                <li><span className="text-foreground font-medium">這頁做什麼：</span>對「今日候選池」裡的股票，跑 4 階段獨立分析，最後產出 進場 / 觀察 / 跳過 建議。</li>
                <li><span className="text-foreground font-medium">分析哪些股票：</span>選上方日期，系統會撈該日候選池前 N 檔（預設 10 檔）。</li>
                <li><span className="text-foreground font-medium">根據什麼資料：</span>技術指標 + YouTube 節目共識 + 籌碼面 + 基本面，四個面向各自獨立分析（§0 隔離原則）。</li>
                <li><span className="text-foreground font-medium">「前 N 檔」是什麼：</span>候選池按多面向命中數排序，前 N 檔即最強的 N 個訊號。</li>
                <li><span className="text-foreground font-medium">按下「⚡ 批次準備」會：</span>產生 N 個分析提示檔，接著在 Claude Code 對話輸入 <code className="bg-secondary text-sky-300 px-1 rounded">/multi-agent-decide</code> 才會實際跑分析。</li>
                <li><span className="text-foreground font-medium">結果在哪看：</span>跑完後，下方列表會列出每檔的 最終建議 / 多空比 / 部位建議 / 四面向判定，點卡片進入個股完整詳情。</li>
                <li><span className="text-foreground font-medium">跟其他頁的關係：</span>
                  <ul className="list-disc ml-5 mt-0.5 text-slate-400">
                    <li><Link href="/agents/pool" className="text-sky-400 hover:underline">候選池</Link> = 多代理的「輸入」（先有候選才能跑）</li>
                    <li>掃描策略 / YouTube 提及 / 籌碼 / 基本面 = 候選池的「來源」</li>
                    <li>個股詳情頁 = 多代理的「輸出」（包含四面向理由）</li>
                  </ul>
                </li>
              </ol>
            </div>
          </div>
        )}

        {/* ───────── PIPELINE BAR ───────── */}
        <div className="max-w-[1600px] mx-auto px-6 pt-4">
          <Panel title="決策流程 — 四階段多代理流水線">
            <div className="flex items-center gap-2 flex-wrap">
              <PipelineStage
                label="① 分析師團隊"
                status={stageStatus(counts.total, counts.phase1Done, counts.phase2Done)}
                summary={`${counts.phase1Done === counts.total ? '✓' : '⏳'} ${counts.phase1Done}/${counts.total}`}
                chips={[
                  { label: '技術', tone: 'emerald' },
                  { label: '消息', tone: 'emerald' },
                  { label: '籌碼', tone: 'emerald' },
                  { label: '基本', tone: 'emerald' },
                ]}
              />
              <Arrow done={counts.phase1Done > 0} />
              <PipelineStage
                label="② 風控團隊"
                status={stageStatus(counts.total, counts.phase2Done, counts.phase3Done)}
                summary={counts.phase2Done > 0 ? `${counts.phase2Done === counts.total ? '✓' : '⏳'} ${counts.phase2Done}/${counts.total}` : '⏳ 待跑'}
                chips={[
                  { label: '積極派', tone: counts.phase2Done > 0 ? 'amber' : 'slate' },
                  { label: '中立派', tone: counts.phase2Done > 0 ? 'amber' : 'slate' },
                  { label: '保守派', tone: counts.phase2Done > 0 ? 'amber' : 'slate' },
                ]}
              />
              <Arrow done={counts.phase2Done > 0} />
              <PipelineStage
                label="③ 多空研究"
                status={stageStatus(counts.total, counts.phase3Done, counts.phase4Done)}
                summary={counts.phase3Done > 0 ? `${counts.phase3Done === counts.total ? '✓' : '⏳'} ${counts.phase3Done}/${counts.total}` : '⏳ 待跑'}
                chips={[
                  { label: '🟢 多方', tone: 'emerald' },
                  { label: '🔴 空方', tone: 'rose' },
                ]}
              />
              <Arrow done={counts.phase3Done > 0} />
              <PipelineStage
                label="④ 最終決策"
                status={counts.phase4Done === counts.total && counts.total > 0 ? 'done' : counts.phase4Done > 0 ? 'active' : 'pending'}
                summary={counts.phase4Done > 0 ? `${counts.phase4Done === counts.total ? '✓' : '⏳'} ${counts.phase4Done}/${counts.total}` : '⏳ 待跑'}
                description="投資經理人裁決 + 部位建議"
              />
            </div>
          </Panel>
        </div>

        {/* Banner / Error */}
        {(banner || error) && (
          <div className="max-w-[1600px] mx-auto px-6 pt-4 space-y-2">
            {banner && (
              <div className="border border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300 rounded p-3 text-sm">{banner}</div>
            )}
            {error && (
              <div className="border border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300 rounded p-3 text-sm whitespace-pre-wrap">{error}</div>
            )}
          </div>
        )}

        {/* ───────── 3-COLUMN DASHBOARD ───────── */}
        <div className="max-w-[1600px] mx-auto px-6 pt-4 pb-6 grid grid-cols-12 gap-4">

          {/* 左：Agent Progress + 統計 */}
          <aside className="col-span-12 lg:col-span-3 space-y-4">
            <Panel title="各代理進度">
              <div className="space-y-3 text-sm">
                <TeamGroup
                  title="① 分析師團隊" active={counts.phase1Done > 0}
                  agents={[
                    { label: '技術分析師',   status: `✓ ${counts.technical.pass + counts.technical.watch + counts.technical.fail}` },
                    { label: '消息分析師',   status: `✓ ${counts.news.pass + counts.news.watch + counts.news.fail}` },
                    { label: '籌碼分析師',   status: `✓ ${counts.chip.pass + counts.chip.watch + counts.chip.fail}` },
                    { label: '基本面分析師', status: `✓ ${counts.fundamental.pass + counts.fundamental.watch + counts.fundamental.fail}` },
                  ]}
                />
                <Divider />
                <TeamGroup
                  title="② 風控團隊" active={counts.phase2Done > 0}
                  agents={[
                    { label: '積極派', status: counts.phase2Done > 0 ? `✓ ${counts.phase2Done}` : '⏳ 待跑' },
                    { label: '中立派', status: counts.phase2Done > 0 ? `✓ ${counts.phase2Done}` : '⏳ 待跑' },
                    { label: '保守派', status: counts.phase2Done > 0 ? `✓ ${counts.phase2Done}` : '⏳ 待跑' },
                  ]}
                />
                <Divider />
                <TeamGroup
                  title="③ 多空研究員" active={counts.phase3Done > 0}
                  agents={[
                    { label: '多方研究員', status: counts.phase3Done > 0 ? `✓ ${counts.phase3Done}` : '⏳ 待跑' },
                    { label: '空方研究員', status: counts.phase3Done > 0 ? `✓ ${counts.phase3Done}` : '⏳ 待跑' },
                  ]}
                />
                <Divider />
                <TeamGroup
                  title="④ 最終決策" active={counts.phase4Done > 0}
                  agents={[
                    { label: '投資經理人', status: counts.phase4Done > 0 ? `✓ ${counts.phase4Done}` : '⏳ 待跑' },
                  ]}
                />
              </div>
            </Panel>

            <Panel title="判定統計">
              <div className="space-y-2 text-xs">
                <StatRow label="技術" c={counts.technical} />
                <StatRow label="消息" c={counts.news} />
                <StatRow label="籌碼" c={counts.chip} />
                <StatRow label="基本" c={counts.fundamental} />
                <p className="text-[10px] text-slate-500 italic mt-2 leading-relaxed">
                  §0 隔離原則 — 四面向各自獨立、不混合加權；要等最終決策階段才整合。
                </p>
              </div>
            </Panel>
          </aside>

          {/* 中：個股列表 */}
          <main className="col-span-12 lg:col-span-5 space-y-3">
            <div className="text-xs font-semibold tracking-wider text-sky-500">📌 個股列表 · 點卡片看完整分析 →</div>

            {loading && !data && <p className="text-muted-foreground text-sm">載入中…</p>}

            {data && data.runs.length === 0 && !error && (
              <div className="border-2 border-dashed border-border rounded-lg p-8 text-sm text-muted-foreground text-center space-y-2">
                <p className="text-foreground font-medium">此日尚未跑任何多代理分析</p>
                <p>點上方「⚡ 批次準備」對前 {top} 檔候選產生分析提示，接著在 Claude Code 對話輸入 <code className="bg-secondary text-sky-500 px-1.5 py-0.5 rounded font-mono text-xs">/multi-agent-decide</code> 才會實際跑。</p>
              </div>
            )}

            {data?.runs.map((r) => (
              <StockCard
                key={r.symbol} run={r}
                active={r.symbol === selectedSymbol}
                onClick={() => setSelectedSymbol(r.symbol)}
              />
            ))}
          </main>

          {/* 右：選取個股完整分析 */}
          <aside className="col-span-12 lg:col-span-4 space-y-3">
            {!selectedSymbol && (
              <div className="border-2 border-dashed border-border rounded-lg p-8 text-sm text-muted-foreground text-center">
                點左側個股卡片以查看完整分析
              </div>
            )}
            {selectedSymbol && detailLoading && !detail && (
              <div className="border border-border rounded-lg p-6 text-sm text-muted-foreground text-center">載入分析中…</div>
            )}
            {selectedSymbol && detail && (
              <DetailColumn detail={detail} date={date} />
            )}
          </aside>
        </div>

        {/* ───────── 底部即時指標 ───────── */}
        <footer className="border-t border-border bg-card">
          <div className="max-w-[1600px] mx-auto px-6 py-2 flex items-center justify-between text-xs font-mono text-muted-foreground flex-wrap gap-2">
            <div className="flex gap-4 flex-wrap">
              <span><span className="text-sky-500">流程進度：</span>{maxStageCompleted(counts)} / 4 階段</span>
              <span><span className="text-sky-500">個股完成：</span>P1 {counts.phase1Done} · P2 {counts.phase2Done} · P3 {counts.phase3Done} · P4 {counts.phase4Done} / {counts.total} 檔</span>
              <span><span className="text-sky-500">已產報告：</span>{counts.phase1Done * 4 + counts.phase2Done + counts.phase3Done * 2 + counts.phase4Done} 份</span>
              <span><span className="text-sky-500">LLM 呼叫：</span>0 次（檔案橋接 /multi-agent-decide）</span>
            </div>
            <div>最後更新：<span className="text-foreground">{date}</span></div>
          </div>
        </footer>
      </div>
    </PageShell>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────────────────

function Panel({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`border border-cyan-700/40 bg-slate-900 rounded-lg p-4 ${className}`}>
      <div className="text-xs font-semibold tracking-wider text-cyan-400 mb-3">📌 {title}</div>
      {children}
    </div>
  );
}

function Divider() { return <div className="h-px bg-slate-800" />; }

type ChipTone = 'emerald' | 'amber' | 'rose' | 'slate';

function PipelineStage({
  label, status, summary, chips, description,
}: {
  label: string;
  status: 'done' | 'active' | 'pending';
  summary?: string;
  chips?: Array<{ label: string; tone: ChipTone }>;
  description?: string;
}) {
  const cls =
    status === 'done'    ? 'bg-emerald-900/30 border-emerald-500/50 shadow-[0_0_12px_rgb(52_211_153/0.4)]' :
    status === 'active'  ? 'bg-cyan-900/30 border-cyan-500/50 shadow-[0_0_12px_rgb(34_211_238/0.5)]' :
                           'bg-slate-800/50 border-slate-700';
  const titleCls = status === 'done' ? 'text-emerald-300' : status === 'active' ? 'text-cyan-300' : 'text-slate-400';
  const summaryCls = status === 'done' ? 'text-emerald-400' : status === 'active' ? 'text-cyan-400' : 'text-slate-500';
  return (
    <div className={`flex-1 min-w-[180px] border rounded p-2.5 ${cls}`}>
      <div className="flex items-center justify-between mb-1.5">
        <span className={`text-xs font-bold tracking-wider ${titleCls}`}>{label}</span>
        {summary && <span className={`text-xs ${summaryCls}`}>{summary}</span>}
      </div>
      {chips && (
        <div className="flex gap-1 flex-wrap">
          {chips.map((c, i) => <PillTiny key={i} tone={c.tone} dim={status !== 'done'}>{c.label}</PillTiny>)}
        </div>
      )}
      {description && <div className="text-[10px] text-slate-500">{description}</div>}
    </div>
  );
}

function PillTiny({ children, tone, dim }: { children: React.ReactNode; tone: ChipTone; dim?: boolean }) {
  const cls: Record<ChipTone, string> = {
    emerald: dim ? 'bg-emerald-900/40 text-emerald-400/50' : 'bg-emerald-700/40 text-emerald-200',
    amber:   dim ? 'bg-amber-900/40 text-amber-400/50'     : 'bg-amber-700/40 text-amber-200',
    rose:    dim ? 'bg-rose-900/40 text-rose-400/50'       : 'bg-rose-700/40 text-rose-200',
    slate:   'bg-slate-700/40 text-slate-500',
  };
  return <span className={`px-1.5 py-0.5 rounded text-[10px] ${cls[tone]}`}>{children}</span>;
}

function Arrow({ done }: { done: boolean }) {
  return <div className={done ? 'text-cyan-600' : 'text-slate-700'}>→</div>;
}

function TeamGroup({
  title, agents, active,
}: {
  title: string;
  agents: Array<{ label: string; status: string }>;
  active?: boolean;
}) {
  return (
    <div>
      <div className={`text-xs font-bold tracking-wider mb-1.5 ${active ? 'text-emerald-400' : 'text-slate-500'}`}>{title}</div>
      <div className="space-y-1 ml-2 text-xs">
        {agents.map((a, i) => (
          <div key={i} className="flex justify-between">
            <span className={active ? 'text-slate-300' : 'text-slate-500'}>▪ {a.label}</span>
            <span className={`font-mono ${active ? 'text-emerald-400' : 'text-slate-600'}`}>{a.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatRow({ label, c }: { label: string; c: { pass: number; watch: number; fail: number } }) {
  const isZero = (n: number) => n === 0;
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-slate-400 w-12 shrink-0">{label}</span>
      <Pill tone="emerald" dim={isZero(c.pass)}>✓ 通過 {c.pass}</Pill>
      <Pill tone="amber"   dim={isZero(c.watch)}>👀 觀察 {c.watch}</Pill>
      <Pill tone="rose"    dim={isZero(c.fail)}>⛔ 不通過 {c.fail}</Pill>
    </div>
  );
}

function Pill({ children, tone, dim }: { children: React.ReactNode; tone: ChipTone; dim?: boolean }) {
  const cls: Record<ChipTone, string> = {
    emerald: dim ? 'bg-emerald-900/30 text-emerald-400/60 border-emerald-700/30' : 'bg-emerald-900/50 text-emerald-300 border-emerald-700/50',
    amber:   dim ? 'bg-amber-900/30 text-amber-400/60 border-amber-700/30'       : 'bg-amber-900/50 text-amber-300 border-amber-700/50',
    rose:    dim ? 'bg-rose-900/30 text-rose-400/60 border-rose-700/30'         : 'bg-rose-900/50 text-rose-300 border-rose-700/50',
    slate:   'bg-slate-800 text-slate-400 border-slate-700',
  };
  return <span className={`px-2 py-0.5 rounded border font-mono ${cls[tone]}`}>{children}</span>;
}

function StockCard({ run, active, onClick }: { run: RunListItem; active: boolean; onClick: () => void }) {
  const hasAnyVerdict = isPhase1Done(run);

  // 全空：尚未跑任何分析師（minimal pending 卡）
  if (!hasAnyVerdict) {
    return (
      <div
        onClick={onClick}
        className={`border rounded-lg p-3 transition cursor-pointer ${active ? 'border-cyan-500 bg-cyan-900/20' : 'border-cyan-700/40 bg-slate-900 opacity-60 hover:opacity-100'}`}
      >
        <div className="flex items-center justify-between text-sm">
          <div>
            <span className="font-bold text-slate-300">{run.name ?? '（無名稱）'}</span>
            <span className="font-mono text-xs text-slate-500 ml-2">{run.symbol}</span>
          </div>
          <span className="text-xs text-slate-500">⏳ 等待對話內 /multi-agent-decide</span>
        </div>
      </div>
    );
  }

  // 至少一個分析師有 verdict（即使 P4 還沒跑也顯示完整 verdict 卡）
  return (
    <div
      onClick={onClick}
      className={`border rounded-lg p-4 transition cursor-pointer ${active ? 'border-cyan-500 bg-gradient-to-br from-slate-900 to-cyan-950 shadow-[0_0_12px_rgb(34_211_238/0.2)]' : 'border-cyan-700/40 bg-slate-900 hover:border-cyan-700/80'}`}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0 flex-1">
          <h3 className={`text-lg font-bold ${active ? 'text-cyan-300' : 'text-slate-100'}`}>
            {run.name ?? '（無名稱）'} <span className="font-mono text-sm text-slate-400 font-normal">{run.symbol}</span>
          </h3>
          {run.verdicts.technical?.overview && (
            <div className="text-xs text-slate-400 mt-0.5 line-clamp-1">{run.verdicts.technical.overview}</div>
          )}
        </div>
        <FinalChip action={run.decision?.action ?? null} />
      </div>
      <div className="grid grid-cols-4 gap-2 text-xs">
        <VerdictMini v={run.verdicts.technical?.verdict ?? null} label="技術" />
        <VerdictMini v={run.verdicts.news?.verdict ?? null} label="消息" />
        <VerdictMini v={run.verdicts.chip?.verdict ?? null} label="籌碼" />
        <VerdictMini v={run.verdicts.fundamental?.verdict ?? null} label="基本" />
      </div>
    </div>
  );
}

function VerdictMini({ v, label }: { v: Verdict | null; label: string }) {
  const cfg: Record<Verdict, { txt: string; cls: string }> = {
    pass:  { txt: '✓ 通過',   cls: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50' },
    watch: { txt: '👀 觀察',   cls: 'bg-amber-900/40 text-amber-300 border-amber-700/50' },
    fail:  { txt: '⛔ 不通過', cls: 'bg-rose-900/40 text-rose-300 border-rose-700/50' },
  };
  if (!v) {
    return (
      <div className="text-center bg-slate-800/40 text-slate-500 border border-slate-700 px-2 py-1.5 rounded">
        <div className="font-bold">—</div>
        <div className="text-[10px] text-slate-600 mt-0.5">{label}</div>
      </div>
    );
  }
  const c = cfg[v];
  return (
    <div className={`text-center border px-2 py-1.5 rounded ${c.cls}`}>
      <div className="font-bold">{c.txt}</div>
      <div className="text-[10px] opacity-80 mt-0.5">{label}</div>
    </div>
  );
}

function FinalChip({ action }: { action: FinalAction | null }) {
  if (!action) return <span className="bg-slate-700/50 text-slate-400 px-2 py-0.5 rounded text-xs whitespace-nowrap">最終決策 —</span>;
  const cfg: Record<FinalAction, { label: string; cls: string }> = {
    buy:   { label: '✅ 建議買',   cls: 'bg-emerald-900/60 text-emerald-200 border-emerald-600' },
    watch: { label: '👀 觀察',     cls: 'bg-amber-900/60 text-amber-200 border-amber-600' },
    skip:  { label: '⛔ 不進場',   cls: 'bg-rose-900/60 text-rose-200 border-rose-600' },
  };
  const c = cfg[action];
  return <span className={`border px-2 py-0.5 rounded text-xs whitespace-nowrap font-semibold ${c.cls}`}>{c.label}</span>;
}

// ────────────────────────────────────────────────────────────────────────────
// Right column: Detail
// ────────────────────────────────────────────────────────────────────────────

function DetailColumn({ detail, date }: { detail: DetailPayload; date: string }) {
  const { candidate, symbol, technical, news, chip, fundamental, bull, bear, decision } = detail;
  const completedCount = [technical, news, chip, fundamental].filter(Boolean).length;
  const phaseLabel = decision ? '✅ 全部階段完成' : completedCount === 4 ? '第一階段完成 · 後三階段尚未跑' : `${completedCount}/4 個分析師完成`;

  // 從 technical.dataPoints 撈價格 / 漲幅 / 成交量（answer 寫入時就在這）
  const price          = findDp(technical?.dataPoints, 'price');
  const changePercent  = findDp(technical?.dataPoints, 'changePercent');
  const volume         = findDp(technical?.dataPoints, 'volume');
  const industry       = candidate?.industry;

  return (
    <>
      {/* Selected stock header */}
      <div className="border border-cyan-500/60 bg-slate-900 rounded-lg p-4">
        <div className="flex items-baseline justify-between mb-1 gap-2 flex-wrap">
          <h2 className="text-xl font-bold text-cyan-300">
            {candidate?.name ?? '（未知名稱）'} <span className="font-mono text-sm text-slate-400 font-normal">{symbol}</span>
          </h2>
          <span className="text-[10px] text-slate-500">{phaseLabel}</span>
        </div>
        {(industry || price || changePercent || volume) && (
          <div className="text-xs text-slate-400 font-mono">
            {[industry, price, changePercent, volume && `量 ${volume}`].filter(Boolean).join(' · ')}
          </div>
        )}
        <Link
          href={`/agents/${encodeURIComponent(symbol)}?date=${date}`}
          className="inline-block mt-2 text-xs text-cyan-400 hover:text-cyan-300 hover:underline"
        >
          開啟完整詳情頁 →
        </Link>
      </div>

      {/* Bull vs Bear */}
      <Panel title="多空對立（第二階段）">
        <div className="grid grid-cols-2 gap-2 mb-2">
          <BullCard bull={bull} />
          <BearCard bear={bear} />
        </div>
        <div className="text-[10px] text-slate-500 text-center">↓ 交易員整合 ↓</div>
        <div className={`border rounded p-2 mt-1 ${decision ? 'border-cyan-500 bg-cyan-900/30' : 'bg-slate-800/40 border-slate-700 opacity-40'}`}>
          <div className="text-xs text-slate-300 text-center">
            {decision
              ? `${decision.action.toUpperCase()} · 部位 ${decision.sizeHint}%`
              : '⏳ 最終決策 · 第四階段尚未跑'}
          </div>
        </div>
      </Panel>

      {/* Technical reasoning */}
      <AgentReasoningPanel
        title="技術面" sections={6} answer={technical}
        labelOf={(r) => TECH_SECTION_LABELS[(r as TechnicalReasoningItem).section]}
        codesOf={(r) => (r as TechnicalReasoningItem).ruleIds}
      />

      {/* News */}
      <AgentReasoningPanel
        title="消息面" sections={3} answer={news}
        labelOf={(r) => NEWS_SECTION_LABELS[(r as NewsReasoningItem).section]}
        codesOf={(r) => (r as NewsReasoningItem).sources}
      />

      {/* Chip */}
      <AgentReasoningPanel
        title="籌碼面" sections={4} answer={chip}
        labelOf={(r) => CHIP_SECTION_LABELS[(r as ChipReasoningItem).section]}
        codesOf={(r) => (r as ChipReasoningItem).sources}
      />

      {/* Fundamental */}
      <AgentReasoningPanel
        title="基本面" sections={4} answer={fundamental}
        labelOf={(r) => FUNDAMENTAL_SECTION_LABELS[(r as FundamentalReasoningItem).section]}
        codesOf={(r) => (r as FundamentalReasoningItem).sources}
      />
    </>
  );
}

function BullCard({ bull }: { bull: BullThesis | null }) {
  if (!bull) {
    return (
      <div className="bg-emerald-900/20 border border-emerald-700/30 rounded p-3 opacity-40">
        <div className="flex items-center justify-between mb-1">
          <span className="text-emerald-300 text-xs font-bold">🟢 多方研究員</span>
          <span className="text-emerald-400/60 text-xs font-mono">分數 —</span>
        </div>
        <div className="text-[10px] text-slate-500 italic">第二階段研究員代理尚未實作</div>
      </div>
    );
  }
  return (
    <div className="bg-emerald-900/30 border border-emerald-500/50 rounded p-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-emerald-300 text-xs font-bold">🟢 多方研究員</span>
      </div>
      <div className="text-[10px] text-emerald-200/80 italic">已完成</div>
    </div>
  );
}

function BearCard({ bear }: { bear: BearThesis | null }) {
  if (!bear) {
    return (
      <div className="bg-rose-900/20 border border-rose-700/30 rounded p-3 opacity-40">
        <div className="flex items-center justify-between mb-1">
          <span className="text-rose-300 text-xs font-bold">🔴 空方研究員</span>
          <span className="text-rose-400/60 text-xs font-mono">分數 —</span>
        </div>
        <div className="text-[10px] text-slate-500 italic">第二階段研究員代理尚未實作</div>
      </div>
    );
  }
  return (
    <div className="bg-rose-900/30 border border-rose-500/50 rounded p-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-rose-300 text-xs font-bold">🔴 空方研究員</span>
      </div>
      <div className="text-[10px] text-rose-200/80 italic">已完成</div>
    </div>
  );
}

interface ReasoningCommon {
  verdict?: Verdict;
  overview?: string;
  caveat?: string;
  reasoning: unknown[];
}

function AgentReasoningPanel({
  title, sections, answer, labelOf, codesOf,
}: {
  title: string;
  sections: number;
  answer: ReasoningCommon | null;
  labelOf: (r: unknown) => string;
  codesOf: (r: unknown) => string[] | undefined;
}) {
  return (
    <Panel title={`${title} · ${sections} 段論述`}>
      <div className="flex items-center justify-end mb-2 -mt-1">
        <VerdictBadgeMini v={answer?.verdict ?? null} />
      </div>
      {answer?.overview && (
        <div className="text-[11px] text-slate-300 italic mb-3">{answer.overview}</div>
      )}
      {!answer && (
        <div className="text-[11px] text-slate-500 italic">尚未產出 — 待 /multi-agent-decide</div>
      )}
      {answer && (
        <div className="space-y-1">
          {answer.reasoning.map((r, i) => {
            const codes = codesOf(r) ?? [];
            return (
              <details key={i} {...(i === 0 ? { open: true } : {})} className="text-xs text-slate-300">
                <summary className="cursor-pointer text-cyan-400 hover:text-cyan-300 select-none">
                  {labelOf(r)}
                  {codes.length > 0 && (
                    <span className="font-mono text-[10px] text-slate-500 ml-1">
                      [{codes.slice(0, 3).join(', ')}{codes.length > 3 ? '…' : ''}]
                    </span>
                  )}
                </summary>
                <div className="ml-3 mt-1 text-slate-400 text-[11px] leading-relaxed">
                  {(r as { text: string }).text}
                </div>
              </details>
            );
          })}
        </div>
      )}
      {answer?.caveat && (
        <div className="mt-3 pt-2 border-t border-slate-800 text-[11px] text-amber-300/80 italic">⚠ {answer.caveat}</div>
      )}
    </Panel>
  );
}

function VerdictBadgeMini({ v }: { v: Verdict | null }) {
  const cfg: Record<Verdict, { txt: string; cls: string }> = {
    pass:  { txt: '✓ 通過',   cls: 'bg-emerald-900/50 text-emerald-300 border-emerald-700/50' },
    watch: { txt: '👀 觀察',   cls: 'bg-amber-900/50 text-amber-300 border-amber-700/50' },
    fail:  { txt: '⛔ 不通過', cls: 'bg-rose-900/50 text-rose-300 border-rose-700/50' },
  };
  if (!v) return <span className="bg-slate-800 text-slate-500 border border-slate-700 px-2 py-0.5 rounded text-xs">—</span>;
  const c = cfg[v];
  return <span className={`border px-2 py-0.5 rounded text-xs font-mono ${c.cls}`}>{c.txt}</span>;
}
