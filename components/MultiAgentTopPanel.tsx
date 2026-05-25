'use client';

/**
 * MultiAgentTopPanel — 首頁右側「Multi-Agent Top」tab
 *
 * 從 /api/agents/decisions?date=YYYY-MM-DD 拉今日已完成 Multi-Agent 4-phase 的股票，
 * 顯示 action（buy/watch/skip）+ bull/bear score + sizeHint。
 *
 * 點任一檔 → onSelectStock(symbol) 跳轉左側 K 線。
 * 排序：API 已預先按 action(buy→watch→skip) → verdict → symbol 排好，這裡直接展示。
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import Link from 'next/link';
import { lastBusinessDayYmd } from '@/lib/dateDefaults';
import { DatePicker, type DateMeta } from '@/components/ui/DatePicker';
import { GradeBadge, UnscoredBadge } from '@/components/agents/ScoreLightBadge';
import type { ScoreLight, StockGrade, SuitableFor } from '@/lib/agents/scoringTypes';

type Verdict = 'pass' | 'watch' | 'fail';
type FinalAction = 'buy' | 'watch' | 'skip';

interface AgentVerdictSummary {
  verdict: Verdict;
  overview: string;
  score?: number;
  light?: ScoreLight;
  confidence?: 'high' | 'medium' | 'low';
}

interface RunListItem {
  symbol: string;
  name: string | null;
  status: 'pending' | 'completed';
  phaseStatus: {
    phase1Done: boolean;
    phase2Done: boolean;
    phase3Done: boolean;
    phase4Done: boolean;
  };
  verdicts: {
    technical:   AgentVerdictSummary | null;
    news:        AgentVerdictSummary | null;
    chip:        AgentVerdictSummary | null;
    fundamental: AgentVerdictSummary | null;
  };
  risk: { verdict: 'green' | 'yellow' | 'red'; overview: string } | null;
  decision: {
    action: FinalAction;
    overview: string;
    bullScore: number;
    bearScore: number;
    sizeHint: number;
    totalScore?: number;
    grade?: StockGrade;
    suitableFor?: SuitableFor;
    gradeReason?: string;
  } | null;
}

interface DecisionsResponse {
  ok: boolean;
  date: string;
  runs: RunListItem[];
  count: number;
}

interface Props {
  onSelectStock?: (symbol: string) => void;
  defaultDate?: string;
  /** 目前選中股票（match run.symbol）— 用於 row highlight */
  selectedSymbol?: string | null;
  /** 日期變動時通知 parent（用於 3 tab date sync）*/
  onDateChange?: (date: string) => void;
}

const ACTION_STYLE: Record<FinalAction, { bg: string; text: string; label: string }> = {
  buy:   { bg: 'bg-green-700/60 border-green-500', text: 'text-green-200', label: '進場' },
  watch: { bg: 'bg-yellow-700/40 border-yellow-500/60', text: 'text-yellow-200', label: '觀察' },
  skip:  { bg: 'bg-slate-700/40 border-slate-500/40', text: 'text-slate-400', label: '跳過' },
};

const VERDICT_DOT: Record<Verdict, string> = {
  pass:  'bg-green-500',
  watch: 'bg-yellow-500',
  fail:  'bg-red-500',
};

/** 燈號 → 顯示色塊(用在 4 面 mini 分數)*/
const LIGHT_DOT: Record<ScoreLight, string> = {
  green:        'bg-green-500',
  yellow_green: 'bg-lime-500',
  yellow:       'bg-yellow-500',
  orange_red:   'bg-orange-500',
  red:          'bg-red-500',
};

export function MultiAgentTopPanel({ onSelectStock, defaultDate, selectedSymbol, onDateChange }: Props) {
  const [date, setDateLocal] = useState(defaultDate ?? lastBusinessDayYmd());
  const setDate = useCallback((d: string) => {
    setDateLocal(d);
    onDateChange?.(d);
  }, [onDateChange]);
  const [filter, setFilter] = useState<'all' | 'buy' | 'completed'>('all');
  const [data, setData] = useState<DecisionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [emptyDates, setEmptyDates] = useState<Set<string>>(() => new Set());
  const [populatedDates, setPopulatedDates] = useState<Set<string>>(() => new Set());

  // AbortController + 15s timeout 防卡載入中（user 快速切日期或 server hang）
  const abortRef = useRef<AbortController | null>(null);
  const fetchData = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const timeoutId = setTimeout(() => ac.abort(), 15_000);

    setLoading(true);
    setError(null);
    try {
      // 2026-05-26 加 transient retry:429 / 503 / 504 在 dev server cron 重壓時偶發,
      // 等 1.5s 再試 1 次,避免 user 看到 raw "HTTP 429"。
      let res = await fetch(`/api/agents/decisions?date=${date}`, { signal: ac.signal });
      if ((res.status === 429 || res.status === 503 || res.status === 504) && !ac.signal.aborted) {
        await new Promise(r => setTimeout(r, 1500));
        if (ac.signal.aborted) return;
        res = await fetch(`/api/agents/decisions?date=${date}`, { signal: ac.signal });
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as DecisionsResponse;
      if (ac.signal.aborted) return;
      setData(json);
      // 漸進式記錄 — DatePicker dim 沒分析過的日期
      if ((json.runs?.length ?? 0) > 0) {
        setPopulatedDates(prev => prev.has(date) ? prev : new Set(prev).add(date));
        setEmptyDates(prev => { if (!prev.has(date)) return prev; const n = new Set(prev); n.delete(date); return n; });
      } else {
        setEmptyDates(prev => prev.has(date) ? prev : new Set(prev).add(date));
      }
    } catch (err) {
      if (ac.signal.aborted) return;
      setData(null);
      setError(err instanceof Error ? err.message : 'fetch failed');
    } finally {
      clearTimeout(timeoutId);
      if (!ac.signal.aborted) setLoading(false);
    }
  }, [date]);

  const datePickerMeta = useMemo<Record<string, DateMeta>>(() => {
    const m: Record<string, DateMeta> = {};
    emptyDates.forEach(d => { m[d] = { dim: true }; });
    populatedDates.forEach(d => { m[d] = { note: '有多代理分析' }; });
    return m;
  }, [emptyDates, populatedDates]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // 過濾邏輯（API 已預排）
  const runs = (data?.runs ?? []).filter(r => {
    if (filter === 'buy') return r.decision?.action === 'buy';
    if (filter === 'completed') return r.status === 'completed';
    return true;
  });

  const stats = (data?.runs ?? []).reduce(
    (acc, r) => {
      acc.total += 1;
      if (r.status === 'completed') acc.completed += 1;
      if (r.decision?.action === 'buy') acc.buy += 1;
      if (r.decision?.action === 'watch') acc.watch += 1;
      if (r.decision?.action === 'skip') acc.skip += 1;
      return acc;
    },
    { total: 0, completed: 0, buy: 0, watch: 0, skip: 0 },
  );

  return (
    <div className="flex flex-col h-full">
      {/* Date pill grid（仿策略掃描）*/}
      <div className="shrink-0 px-2 py-1.5 border-b border-border bg-card/40">
        <DatePicker value={date} onChange={setDate} size="sm" meta={datePickerMeta} />
      </div>
      {/* Filter bar */}
      <div className="shrink-0 flex items-center gap-2 px-2 py-1.5 border-b border-border bg-secondary/20 text-xs">
        <div className="flex gap-0.5">
          {(['all', 'buy', 'completed'] as const).map(f => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`px-2 py-0.5 rounded border text-[10px] transition-colors ${
                filter === f
                  ? 'bg-sky-500/30 border-sky-500 text-sky-200'
                  : 'border-border text-muted-foreground hover:bg-muted/30'
              }`}
            >
              {f === 'all' ? `全部 ${stats.total}` : f === 'buy' ? `進場 ${stats.buy}` : `完成 ${stats.completed}`}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <Link
          href={`/agents?date=${date}`}
          className="text-sky-400 hover:underline text-[11px]"
          title="開啟完整多代理分析"
        >
          完整頁 →
        </Link>
      </div>
      {/* 一行小說明 — 讓使用者快速理解這 tab 的功能與欄位 */}
      <div className="shrink-0 px-2 py-1 text-[10px] text-muted-foreground border-b border-border/40 bg-card/20 leading-relaxed space-y-0.5">
        <div>
          對候選池跑 4 階段獨立分析後的結果。<span className="text-sky-400">等級</span>=綜合 A-E、<span className="text-sky-400">總分</span>=0-100、<span className="text-sky-400">面向</span>=4 大面分數燈號。
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sky-400">等級</span>
          <span className="px-1 py-0.5 rounded bg-emerald-700/40 text-emerald-200 border border-emerald-500/50 text-[9px]">A</span>
          <span className="px-1 py-0.5 rounded bg-sky-700/40 text-sky-200 border border-sky-500/50 text-[9px]">B</span>
          <span className="px-1 py-0.5 rounded bg-yellow-700/40 text-yellow-200 border border-yellow-500/50 text-[9px]">C</span>
          <span className="px-1 py-0.5 rounded bg-orange-700/40 text-orange-200 border border-orange-500/50 text-[9px]">D</span>
          <span className="px-1 py-0.5 rounded bg-red-700/40 text-red-200 border border-red-500/50 text-[9px]">E</span>
          <span>·</span>
          <span className="text-foreground/80">面向(左→右):技/籌/基/消</span>
          <span>·</span>
          <span className="text-foreground/80">舊資料無評分顯示</span>
          <span className="px-1 py-0.5 rounded bg-amber-700/30 text-amber-200 border border-amber-500/40 text-[9px]">⟳ 需重跑</span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && !data && !error && (
          <div className="text-center py-12 text-muted-foreground text-xs">載入中…</div>
        )}

        {error && (
          <div className="px-3 py-6 text-center text-xs text-rose-300 space-y-2">
            <div>載入多代理分析失敗：{error}</div>
            <button
              type="button"
              onClick={fetchData}
              className="text-sky-400 hover:underline"
            >
              重試 ↻
            </button>
          </div>
        )}

        {data && stats.total === 0 && !error && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground space-y-2">
            <div>此日尚未跑多代理分析</div>
            <Link
              href={`/agents?date=${date}`}
              className="text-sky-400 hover:underline"
            >
              到多代理頁批次準備 →
            </Link>
          </div>
        )}

        {data && stats.total > 0 && runs.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            篩選後無結果（試試「全部」）
          </div>
        )}

        {runs.length > 0 && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card z-10 text-muted-foreground border-b border-border">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium">股票</th>
                <th className="px-1 py-1.5 text-center font-medium" title="A-E 綜合等級(規則 + 分數,LLM 不能改)">等級</th>
                <th className="px-1 py-1.5 text-center font-medium" title="最終建議:進場 / 觀察 / 跳過(decisionPath 規則式)">建議</th>
                <th className="px-1 py-1.5 text-center font-medium" title="多方分數 / 空方分數">多/空</th>
                <th className="px-1 py-1.5 text-center font-medium" title="建議部位大小(占資金 %)">部位</th>
                <th className="px-1 py-1.5 text-left font-medium" title="4 大面向 0-100 分(技術 / 籌碼 / 基本 / 消息)">面向</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <AgentRow
                  key={r.symbol}
                  run={r}
                  onSelect={onSelectStock}
                  selected={selectedSymbol === r.symbol}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function AgentRow({ run, onSelect, selected }: { run: RunListItem; onSelect?: (symbol: string) => void; selected?: boolean }) {
  const pureSymbol = run.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  const action = run.decision?.action;
  const cfg = action ? ACTION_STYLE[action] : null;
  const phaseProgress = [
    run.phaseStatus.phase1Done,
    run.phaseStatus.phase2Done,
    run.phaseStatus.phase3Done,
    run.phaseStatus.phase4Done,
  ].filter(Boolean).length;
  const hasGrade = run.decision?.grade != null && run.decision?.totalScore != null;
  const isOldData = !!run.decision && !hasGrade;

  return (
    <tr
      className={`border-b border-border/40 hover:bg-muted/40 cursor-pointer transition-colors ${
        selected ? 'bg-sky-500/15 ring-1 ring-inset ring-sky-500/40' : ''
      }`}
      onClick={() => onSelect?.(run.symbol)}
      title={run.decision?.gradeReason ?? run.decision?.overview ?? `Phase ${phaseProgress}/4 — 尚未完成決策`}
    >
      <td className="px-2 py-1.5">
        <div className="text-foreground font-medium truncate max-w-[110px]">{run.name ?? '—'}</div>
        <div className="font-mono tabular-nums text-[10px] text-muted-foreground">{pureSymbol}</div>
      </td>
      <td className="px-1 py-1.5 text-center">
        {hasGrade ? (
          <GradeBadge grade={run.decision!.grade!} totalScore={run.decision!.totalScore!} size="sm" />
        ) : isOldData ? (
          <span
            className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded border text-[9px] bg-amber-700/30 text-amber-200 border-amber-500/40"
            title="此 decision 為舊版,需重跑 /multi-agent-decide 才有評分"
          >
            ⟳
          </span>
        ) : (
          <UnscoredBadge size="sm" />
        )}
      </td>
      <td className="px-1 py-1.5 text-center">
        {cfg ? (
          <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] ${cfg.bg} ${cfg.text}`}>
            {cfg.label}
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground">P{phaseProgress}/4</span>
        )}
      </td>
      <td className="px-1 py-1.5 text-center text-[10px]">
        {run.decision ? (
          <span className="font-mono tabular-nums">
            <span className="text-green-400">{run.decision.bullScore}</span>
            <span className="text-muted-foreground">/</span>
            <span className="text-red-400">{run.decision.bearScore}</span>
          </span>
        ) : '—'}
      </td>
      <td className="px-1 py-1.5 text-center text-[10px] font-mono tabular-nums">
        {run.decision ? `${Math.round(run.decision.sizeHint * 100)}%` : '—'}
      </td>
      <td className="px-1 py-1.5">
        <div className="flex gap-0.5" title="技 / 籌 / 基 / 消(分數顏色;舊資料用 verdict 色)">
          {(['technical', 'chip', 'fundamental', 'news'] as const).map(k => {
            const a = run.verdicts[k];
            // 優先用 score light(新評分);沒有 fallback verdict 三色
            const cls = a?.light
              ? LIGHT_DOT[a.light]
              : a?.verdict ? VERDICT_DOT[a.verdict] : 'bg-muted';
            const tip = a?.score != null
              ? `${k}: ${a.score} 分 (${a.confidence ?? '—'})`
              : a?.verdict ? `${k}: ${a.verdict}` : `${k}: 未完成`;
            return (
              <span key={k} className={`w-2 h-2 rounded-full ${cls}`} title={tip} />
            );
          })}
        </div>
      </td>
    </tr>
  );
}
