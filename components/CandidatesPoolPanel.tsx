'use client';

/**
 * CandidatesPoolPanel — 首頁右側「候選池」tab 內容
 *
 * 簡化版（vs /agents/pool 整頁）：
 *   - 日期切換
 *   - minSourceCount 篩選（≥1/2/3/4 源）
 *   - 候選列表（symbol/name/sources chip + ★ 高共識 + 簡短 reasons）
 *   - 點任一檔 → onSelectStock(symbol) 觸發左側 K 線跳轉
 *
 * 不做的事：
 *   - 不顯示 Source 狀態大卡（首頁右側空間有限）
 *   - 不顯示多源分布長條（/agents/pool 才需要）
 *   - 不提供「建立 Pool」按鈕（首頁是看結果，要建請去 /agents/pool）
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { Candidate, SourceName } from '@/lib/agents/candidates/types';
import { lastBusinessDayYmd, fmtDateLabelTw } from '@/lib/dateDefaults';
import { DatePicker, type DateMeta } from '@/components/ui/DatePicker';
import { formatLetters } from '@/lib/scanner/buyMethodTracks';
import { signalOf } from '@/lib/i18n/fundamentalLabels';

interface PoolResponse {
  ok: boolean;
  date: string;
  market: string;
  exists: boolean;
  generatedAt?: string;
  total?: number;
  returned?: number;
  candidates?: Candidate[];
  error?: string;
}

interface Props {
  /** 點任一檔股 → 觸發左側 K 線跳轉 */
  onSelectStock?: (symbol: string) => void;
  /** 預設 date（首頁 today；可由 URL 控制）*/
  defaultDate?: string;
  /** 目前選中股票（match candidate.symbol）— 用於 row highlight */
  selectedSymbol?: string | null;
  /** 日期變動時通知 parent（用於 3 tab date sync）*/
  onDateChange?: (date: string) => void;
}

const SOURCE_LABEL: Record<SourceName, string> = {
  technical: '技',
  youtube: '消',
  chip: '籌',
  fundamental: '基',
};

const SOURCE_COLOR: Record<SourceName, string> = {
  technical:   'bg-blue-700/40 text-blue-300 border-blue-500/50',
  youtube:     'bg-purple-700/40 text-purple-300 border-purple-500/50',
  chip:        'bg-orange-700/40 text-orange-300 border-orange-500/50',
  fundamental: 'bg-teal-700/40 text-teal-300 border-teal-500/50',
};

export function CandidatesPoolPanel({ onSelectStock, defaultDate, selectedSymbol, onDateChange }: Props) {
  const [date, setDateLocal] = useState(defaultDate ?? lastBusinessDayYmd());
  const setDate = useCallback((d: string) => {
    setDateLocal(d);
    onDateChange?.(d);
  }, [onDateChange]);
  const [minSourceCount, setMinSourceCount] = useState(1);
  const [data, setData] = useState<PoolResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  // 已知無資料的日期 — 漸進式 dim DatePicker pill
  const [emptyDates, setEmptyDates] = useState<Set<string>>(() => new Set());
  const [populatedDates, setPopulatedDates] = useState<Set<string>>(() => new Set());

  const fetchPool = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/pool?date=${date}&minSourceCount=${minSourceCount}&limit=100`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as PoolResponse;
      setData(json);
      // 漸進式記錄該日是否有資料 — DatePicker 用來 dim 空日 pill
      if (json.exists) {
        setPopulatedDates(prev => prev.has(date) ? prev : new Set(prev).add(date));
        setEmptyDates(prev => { if (!prev.has(date)) return prev; const n = new Set(prev); n.delete(date); return n; });
      } else {
        setEmptyDates(prev => prev.has(date) ? prev : new Set(prev).add(date));
      }
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : 'fetch failed');
    } finally {
      setLoading(false);
    }
  }, [date, minSourceCount]);

  const datePickerMeta = useMemo<Record<string, DateMeta>>(() => {
    const m: Record<string, DateMeta> = {};
    emptyDates.forEach(d => { m[d] = { dim: true }; });
    populatedDates.forEach(d => { m[d] = { note: '有候選池' }; });
    return m;
  }, [emptyDates, populatedDates]);

  useEffect(() => { fetchPool(); }, [fetchPool]);

  const buildPool = useCallback(async () => {
    setBusy(true);
    setBanner(null);
    setError(null);
    try {
      const res = await fetch(`/api/agents/pool/build?date=${date}`, { method: 'POST' });
      const json = await res.json() as { ok?: boolean; error?: string; total?: number; elapsedMs?: number };
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
      } else {
        setBanner(`✅ 已建立 ${json.total} 檔候選 (${json.elapsedMs}ms)`);
        await fetchPool();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'build failed');
    } finally {
      setBusy(false);
    }
  }, [date, fetchPool]);

  return (
    <div className="flex flex-col h-full">
      {/* Date pill grid（仿策略掃描）*/}
      <div className="shrink-0 px-2 py-1.5 border-b border-border bg-card/40">
        <DatePicker value={date} onChange={setDate} size="sm" meta={datePickerMeta} />
      </div>
      {/* Filter bar */}
      <div className="shrink-0 flex items-center gap-2 px-2 py-1.5 border-b border-border bg-secondary/20 text-xs">
        <label className="text-muted-foreground flex items-center gap-1">
          ≥
          <select
            value={minSourceCount}
            onChange={(e) => setMinSourceCount(Number(e.target.value))}
            className="bg-card border border-border rounded px-1.5 py-0.5 text-[11px]"
            title="只看至少這幾個面向同時看好的股票"
          >
            <option value={1}>1 個面向</option>
            <option value={2}>2 個面向</option>
            <option value={3}>3 個面向</option>
            <option value={4}>4 個面向</option>
          </select>
        </label>
        <div className="flex-1" />
        <span
          className="text-muted-foreground tabular-nums"
          title={data?.exists ? `顯示 ${data.returned} 檔／全部 ${data.total} 檔（受「≥ N 個面向」與每頁上限影響）` : '此日尚未建立候選池'}
        >
          {data?.exists ? `顯示 ${data.returned}／全部 ${data.total}` : '—'}
        </span>
        <Link
          href={`/agents/pool?date=${date}`}
          className="text-sky-400 hover:underline text-[11px]"
          title="開啟完整候選池頁"
        >
          完整頁 →
        </Link>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && !data && !error && (
          <div className="text-center py-12 text-muted-foreground text-xs">載入中…</div>
        )}

        {error && (
          <div className="px-3 py-6 text-center text-xs text-rose-300 space-y-2">
            <div>載入候選池失敗：{error}</div>
            <button
              type="button"
              onClick={fetchPool}
              className="text-sky-400 hover:underline"
            >
              重試 ↻
            </button>
          </div>
        )}

        {banner && (
          <div className="mx-2 mt-2 border border-sky-500/40 bg-sky-500/10 text-sky-300 rounded p-2 text-[10px] leading-relaxed">
            {banner}
          </div>
        )}

        {data && !data.exists && !error && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground space-y-3">
            <div>此日尚未建立候選池</div>
            <div className="flex flex-col items-center gap-2">
              <button
                type="button"
                onClick={buildPool}
                disabled={busy}
                className="bg-sky-500 hover:bg-sky-400 text-white px-3 py-1.5 rounded text-xs font-medium transition disabled:opacity-50"
              >
                {busy ? '建立中…' : '⚡ 建立候選池'}
              </button>
              <Link
                href={`/agents/pool?date=${date}`}
                className="text-sky-400 hover:underline text-[10px]"
              >
                或開啟完整候選池頁 →
              </Link>
            </div>
          </div>
        )}

        {data?.exists && (data.candidates?.length ?? 0) === 0 && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            ≥{minSourceCount} 個面向無候選。試試 ≥1 個面向。
          </div>
        )}

        {data?.exists && data.candidates && data.candidates.length > 0 && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card z-10 text-muted-foreground border-b border-border">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium">股票</th>
                <th className="px-1 py-1.5 text-center font-medium" title="幾個面向同時看好">面向</th>
                <th className="px-1 py-1.5 text-left font-medium">命中</th>
                <th className="px-2 py-1.5 text-left font-medium">理由</th>
              </tr>
            </thead>
            <tbody>
              {data.candidates.map((c) => (
                <PoolRow
                  key={c.symbol}
                  candidate={c}
                  onSelect={onSelectStock}
                  selected={selectedSymbol === c.symbol}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function PoolRow({ candidate, onSelect, selected }: { candidate: Candidate; onSelect?: (symbol: string) => void; selected?: boolean }) {
  const pureSymbol = candidate.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  const reasons: string[] = [];
  const t = candidate.sources.technical;
  if (t) reasons.push(`技 ${t.tracks.length > 0 ? formatLetters(t.tracks) + '｜' : ''}六條件 ${t.sixConditionsScore}/6`);
  const y = candidate.sources.youtube;
  if (y) reasons.push(`消 ${y.mentionCount} 節目${y.inHighConsensus ? '｜★高共識' : ''}`);
  const ch = candidate.sources.chip;
  if (ch && ch.signals.length > 0) reasons.push(`籌 ${signalOf(ch.signals[0])}`);
  const f = candidate.sources.fundamental;
  if (f && f.signals.length > 0) reasons.push(`基 ${signalOf(f.signals[0])}`);

  return (
    <tr
      className={`border-b border-border/40 hover:bg-muted/40 cursor-pointer transition-colors ${
        selected ? 'bg-sky-500/15 ring-1 ring-inset ring-sky-500/40' : ''
      }`}
      onClick={() => onSelect?.(candidate.symbol)}
      title={reasons.length > 0 ? reasons.join('\n') : `${candidate.name}（${candidate.industry ?? '—'}）`}
    >
      <td className="px-2 py-1.5">
        <div className="text-foreground font-medium truncate max-w-[110px]">{candidate.name}</div>
        <div className="font-mono tabular-nums text-[10px] text-muted-foreground">{pureSymbol}</div>
      </td>
      <td className="px-1 py-1.5 text-center font-mono font-semibold text-foreground">
        {candidate.sourceCount}
      </td>
      <td className="px-1 py-1.5">
        <div className="flex gap-0.5 flex-wrap">
          {(Object.keys(candidate.sources) as SourceName[]).map((s) => {
            const youtubeHighConsensus = s === 'youtube' && candidate.sources.youtube?.inHighConsensus === true;
            return (
              <span
                key={s}
                title={youtubeHighConsensus
                  ? `高共識：${candidate.sources.youtube?.mentionCount} 節目同向`
                  : undefined}
                className={`inline-flex items-center px-1 py-0.5 rounded border text-[10px] ${
                  youtubeHighConsensus
                    ? 'bg-purple-500/50 text-purple-100 border-purple-300 font-semibold'
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
      <td className="px-2 py-1.5 text-[10px] text-muted-foreground">
        <div className="space-y-0.5">
          {reasons.map((r, i) => <div key={i}>{r}</div>)}
        </div>
      </td>
    </tr>
  );
}
