'use client';

/**
 * FundamentalRevaluationPanel — 右側面板：基本面補漲 Top 20
 *
 * 加在首頁右側 tabs（YouTube 提及 ↔ 候選池）之間。
 * 比 /strategies/fundamental-revaluation 全頁更精簡：去掉 6 個 view tab，只保留主榜 Top 20。
 * 點任一檔 → onSelectStock(symbol) 載入左側 K 線。
 * 「查看完整 →」連到全頁。
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { gradeLabel, flagLabel } from '@/lib/strategy/fundamentalRevaluation/recommendationGrade';
import type {
  FundamentalRevaluationSession,
  FundamentalRevaluationResult,
} from '@/lib/strategy/fundamentalRevaluation/types';

interface Props {
  date: string;
  onDateChange?: (date: string) => void;
  onSelectStock?: (code: string) => void;
  selectedCode?: string | null;
}

type Market = 'TW' | 'CN';

export function FundamentalRevaluationPanel({ date, onDateChange: _onDateChange, onSelectStock, selectedCode }: Props) {
  const [market, setMarket] = useState<Market>('TW');
  const [session, setSession] = useState<FundamentalRevaluationSession | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let aborted = false;
    setLoading(true);
    fetch(`/api/strategies/fundamental-revaluation?market=${market}&date=${date}`)
      .then((r) => r.json())
      .then((json) => {
        if (aborted) return;
        setSession(json.session ?? null);
      })
      .catch(() => {
        if (!aborted) setSession(null);
      })
      .finally(() => {
        if (!aborted) setLoading(false);
      });
    return () => {
      aborted = true;
    };
  }, [market, date]);

  const top20: FundamentalRevaluationResult[] = session?.top100.slice(0, 20) ?? [];

  return (
    <div className="flex flex-col h-full">
      {/* 控制列 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <div className="inline-flex rounded-md border border-border overflow-hidden text-xs">
          {(['TW', 'CN'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMarket(m)}
              className={
                'px-2 py-1 font-medium transition-colors ' +
                (market === m ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-secondary')
              }
            >
              {m === 'TW' ? '台股' : '陸股'}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">{date}</span>
        {loading && <span className="text-xs text-muted-foreground">載入中…</span>}
        <div className="flex-1" />
        <Link
          href={`/strategies/fundamental-revaluation?market=${market}&date=${date}`}
          className="inline-flex items-center gap-0.5 text-xs text-sky-500 hover:underline"
          title="完整頁含排除名單與評分明細"
        >
          完整 <ExternalLink className="w-3 h-3" />
        </Link>
      </div>

      {/* Stats */}
      {session && (
        <div className="px-3 py-1.5 text-xs text-muted-foreground border-b border-border/50 flex items-center gap-3 flex-wrap">
          <span>Top {Math.min(20, session.top100.length)} / 候選 {session.totalCandidates}</span>
          {session.exclusionLists.oneTimeGainExcluded.length > 0 && (
            <span className="text-amber-500">
              排除一次性 {session.exclusionLists.oneTimeGainExcluded.length}
            </span>
          )}
          {session.exclusionLists.deductedNetProfitPoor.length > 0 && (
            <span className="text-amber-500">
              扣非品質差 {session.exclusionLists.deductedNetProfitPoor.length}
            </span>
          )}
          {session.exclusionLists.valuationStretched.length > 0 && (
            <span className="text-rose-500">
              估值偏滿 {session.exclusionLists.valuationStretched.length}
            </span>
          )}
        </div>
      )}

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto">
        {!session && !loading && (
          <div className="text-xs text-muted-foreground p-4 text-center">
            該日無 session — 跑{' '}
            <code className="px-1 bg-secondary rounded">
              ?market={market}&force=1
            </code>{' '}
            cron 後再看
          </div>
        )}
        {session && top20.length === 0 && (
          <div className="text-xs text-muted-foreground p-4 text-center">無候選股</div>
        )}
        {top20.length > 0 && (
          <table className="w-full text-xs">
            <thead className="text-muted-foreground border-b border-border sticky top-0 bg-background">
              <tr>
                <th className="text-left py-1.5 px-2">#</th>
                <th className="text-left py-1.5 px-2">代號</th>
                <th className="text-left py-1.5 px-2">名稱</th>
                <th className="text-right py-1.5 px-2">分</th>
                <th className="text-left py-1.5 px-2">等級</th>
                <th className="text-right py-1.5 px-2">空間</th>
                <th className="text-left py-1.5 px-2">旗</th>
              </tr>
            </thead>
            <tbody>
              {top20.map((r) => {
                const isSelected = selectedCode === r.symbol;
                return (
                  <tr
                    key={r.symbol}
                    onClick={() => onSelectStock?.(r.symbol)}
                    className={
                      'cursor-pointer border-b border-border/50 hover:bg-secondary/40 ' +
                      (isSelected ? 'bg-secondary/60' : '')
                    }
                  >
                    <td className="py-1 px-2 font-mono tabular-nums text-muted-foreground">{r.rank}</td>
                    <td className="py-1 px-2 font-mono text-primary">{r.symbol}</td>
                    <td className="py-1 px-2 truncate max-w-[90px]" title={r.name}>{r.name}</td>
                    <td className="py-1 px-2 text-right font-mono tabular-nums font-medium">
                      {r.breakdown.total}
                    </td>
                    <td className="py-1 px-2 whitespace-nowrap">{gradeLabel(r.breakdown.grade)}</td>
                    <td
                      className={
                        r.baseUpside == null
                          ? 'py-1 px-2 text-right font-mono tabular-nums text-muted-foreground'
                          : r.baseUpside > 0
                          ? 'py-1 px-2 text-right font-mono tabular-nums text-emerald-500'
                          : 'py-1 px-2 text-right font-mono tabular-nums text-rose-500'
                      }
                    >
                      {r.baseUpside != null ? `${(r.baseUpside * 100).toFixed(0)}%` : '—'}
                    </td>
                    <td className="py-1 px-2">
                      <div className="flex flex-wrap gap-0.5">
                        {r.breakdown.flags.slice(0, 2).map((f) => (
                          <span
                            key={f}
                            className={
                              'inline-block px-1 rounded text-[10px] ' +
                              (f === 'one_time_gain' || f === 'valuation_stretched' || f === 'cyclical_peak'
                                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                                : f === 'undervalued'
                                ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                                : 'bg-secondary text-muted-foreground')
                            }
                          >
                            {flagLabel(f)}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
