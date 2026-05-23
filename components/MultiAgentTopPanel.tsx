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

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

type Verdict = 'pass' | 'watch' | 'fail';
type FinalAction = 'buy' | 'watch' | 'skip';

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
    technical:   { verdict: Verdict; overview: string } | null;
    news:        { verdict: Verdict; overview: string } | null;
    chip:        { verdict: Verdict; overview: string } | null;
    fundamental: { verdict: Verdict; overview: string } | null;
  };
  risk: { verdict: 'green' | 'yellow' | 'red'; overview: string } | null;
  decision: {
    action: FinalAction;
    overview: string;
    bullScore: number;
    bearScore: number;
    sizeHint: number;
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
}

function todayYmd(): string {
  const tpe = new Date(Date.now() + 8 * 3600_000);
  return tpe.toISOString().slice(0, 10);
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

export function MultiAgentTopPanel({ onSelectStock, defaultDate }: Props) {
  const [date, setDate] = useState(defaultDate ?? todayYmd());
  const [filter, setFilter] = useState<'all' | 'buy' | 'completed'>('all');
  const [data, setData] = useState<DecisionsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/agents/decisions?date=${date}`);
      const json = await res.json() as DecisionsResponse;
      setData(json);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [date]);

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
      {/* Filter bar */}
      <div className="shrink-0 flex items-center gap-2 px-2 py-1.5 border-b border-border bg-secondary/20 text-xs">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="bg-card border border-border rounded px-1.5 py-0.5 text-foreground font-mono text-[11px]"
        />
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
          title="開啟完整 Multi-Agent 視窗"
        >
          完整 →
        </Link>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && !data && (
          <div className="text-center py-12 text-muted-foreground text-xs">載入中…</div>
        )}

        {data && stats.total === 0 && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground space-y-2">
            <div>此日尚未跑 Multi-Agent 分析</div>
            <Link
              href={`/agents?date=${date}`}
              className="text-sky-400 hover:underline"
            >
              到 /agents 觸發 prepare-batch →
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
                <th className="px-1 py-1.5 text-center font-medium" title="最終 action">建議</th>
                <th className="px-1 py-1.5 text-center font-medium" title="多空比">多/空</th>
                <th className="px-1 py-1.5 text-center font-medium" title="部位建議 %">部位</th>
                <th className="px-1 py-1.5 text-left font-medium" title="4 面向 verdict">面向</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <AgentRow key={r.symbol} run={r} onSelect={onSelectStock} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function AgentRow({ run, onSelect }: { run: RunListItem; onSelect?: (symbol: string) => void }) {
  const pureSymbol = run.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  const action = run.decision?.action;
  const cfg = action ? ACTION_STYLE[action] : null;
  const phaseProgress = [
    run.phaseStatus.phase1Done,
    run.phaseStatus.phase2Done,
    run.phaseStatus.phase3Done,
    run.phaseStatus.phase4Done,
  ].filter(Boolean).length;

  return (
    <tr
      className="border-b border-border/40 hover:bg-muted/40 cursor-pointer transition-colors"
      onClick={() => onSelect?.(run.symbol)}
    >
      <td className="px-2 py-1.5">
        <div className="font-mono tabular-nums text-foreground">{pureSymbol}</div>
        <div className="text-[10px] text-muted-foreground truncate max-w-[100px]">{run.name ?? '—'}</div>
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
        <div className="flex gap-0.5" title="技術 / 消息 / 籌碼 / 基本">
          {(['technical', 'news', 'chip', 'fundamental'] as const).map(k => {
            const v = run.verdicts[k]?.verdict;
            return (
              <span
                key={k}
                className={`w-2 h-2 rounded-full ${v ? VERDICT_DOT[v] : 'bg-muted'}`}
                title={v ? `${k}: ${v}` : `${k}: 未完成`}
              />
            );
          })}
        </div>
      </td>
    </tr>
  );
}
