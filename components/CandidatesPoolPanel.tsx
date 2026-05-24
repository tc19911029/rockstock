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

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { Candidate, SourceName } from '@/lib/agents/candidates/types';
import { lastBusinessDayYmd } from '@/lib/dateDefaults';

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

  const fetchPool = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/agents/pool?date=${date}&minSourceCount=${minSourceCount}&limit=100`);
      const json = await res.json() as PoolResponse;
      setData(json);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [date, minSourceCount]);

  useEffect(() => { fetchPool(); }, [fetchPool]);

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
        <label className="text-muted-foreground flex items-center gap-1">
          ≥
          <select
            value={minSourceCount}
            onChange={(e) => setMinSourceCount(Number(e.target.value))}
            className="bg-card border border-border rounded px-1.5 py-0.5 text-[11px]"
          >
            <option value={1}>1 源</option>
            <option value={2}>2 源</option>
            <option value={3}>3 源</option>
            <option value={4}>4 源</option>
          </select>
        </label>
        <div className="flex-1" />
        <span className="text-muted-foreground tabular-nums">
          {data?.exists ? `${data.returned}/${data.total}` : '—'}
        </span>
        <Link
          href={`/agents/pool?date=${date}`}
          className="text-sky-400 hover:underline text-[11px]"
          title="開啟完整 Pool 頁"
        >
          完整 →
        </Link>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && !data && (
          <div className="text-center py-12 text-muted-foreground text-xs">載入中…</div>
        )}

        {data && !data.exists && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground space-y-2">
            <div>此日尚無 Candidates Pool</div>
            <Link
              href={`/agents/pool?date=${date}`}
              className="text-sky-400 hover:underline"
            >
              到 /agents/pool 建立 →
            </Link>
          </div>
        )}

        {data?.exists && (data.candidates?.length ?? 0) === 0 && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            ≥{minSourceCount} 源無候選。試試 ≥1 源。
          </div>
        )}

        {data?.exists && data.candidates && data.candidates.length > 0 && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card z-10 text-muted-foreground border-b border-border">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium">股票</th>
                <th className="px-1 py-1.5 text-center font-medium" title="多源命中數">源</th>
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
  if (t) reasons.push(`技${t.tracks.length > 0 ? ' ' + t.tracks.join('/') : ''} ${t.sixConditionsScore}/6`);
  const y = candidate.sources.youtube;
  if (y) reasons.push(`消 ${y.mentionCount}節${y.inHighConsensus ? '★高共識' : ''}`);
  const ch = candidate.sources.chip;
  if (ch && ch.signals.length > 0) reasons.push(`籌 ${ch.signals[0]}`);
  const f = candidate.sources.fundamental;
  if (f && f.signals.length > 0) reasons.push(`基 ${f.signals[0]}`);

  return (
    <tr
      className={`border-b border-border/40 hover:bg-muted/40 cursor-pointer transition-colors ${
        selected ? 'bg-sky-500/15 ring-1 ring-inset ring-sky-500/40' : ''
      }`}
      onClick={() => onSelect?.(candidate.symbol)}
      title={reasons.length > 0 ? reasons.join('\n') : `${candidate.name}（${candidate.industry ?? '—'}）`}
    >
      <td className="px-2 py-1.5">
        <div className="font-mono tabular-nums text-foreground">{pureSymbol}</div>
        <div className="text-[10px] text-muted-foreground truncate max-w-[100px]">{candidate.name}</div>
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
