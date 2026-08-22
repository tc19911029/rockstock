'use client';

import { useEffect, useState, useMemo, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { PageShell, PageHeader } from '@/components/shared';
import { TopList } from './_components/TopList';
import { ScoreBreakdownPanel } from './_components/ScoreBreakdownPanel';
import { lastBusinessDayYmd } from '@/lib/dateDefaults';
import type {
  FundamentalRevaluationSession,
  FundamentalRevaluationDeepSession,
  FundamentalRevaluationResult,
} from '@/lib/strategy/fundamentalRevaluation/types';
import { stockDisplayName } from '@/lib/stocks/stockIdentity';

type Market = 'TW' | 'CN';
type ViewKey = 'top20' | 'top100' | 'one_time_gain' | 'stretched' | 'cyclical_peak' | 'insufficient';

interface ApiResponse {
  ok: boolean;
  market: Market;
  date: string;
  session: FundamentalRevaluationSession | null;
  deep: FundamentalRevaluationDeepSession | null;
}

export default function FundamentalRevaluationPage() {
  // useSearchParams 需包在 Suspense boundary 內，否則 Next.js production build 在此頁 prerender 失敗
  return (
    <Suspense fallback={null}>
      <FundamentalRevaluationInner />
    </Suspense>
  );
}

function FundamentalRevaluationInner() {
  const params = useSearchParams();
  const [market, setMarket] = useState<Market>('TW');
  const [date, setDate] = useState<string>(lastBusinessDayYmd());

  // 從 URL 同步初始值（hydration 後）
  useEffect(() => {
    const qsMarket = params.get('market')?.toUpperCase();
    if (qsMarket === 'TW' || qsMarket === 'CN') setMarket(qsMarket);
    const qsDate = params.get('date');
    if (qsDate && /^\d{4}-\d{2}-\d{2}$/.test(qsDate)) setDate(qsDate);
  }, [params]);
  const [session, setSession] = useState<FundamentalRevaluationSession | null>(null);
  const [deep, setDeep] = useState<FundamentalRevaluationDeepSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<ViewKey>('top20');
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    setLoading(true);
    fetch(`/api/strategies/fundamental-revaluation?market=${market}&date=${date}`)
      .then((r) => r.json() as Promise<ApiResponse>)
      .then((json) => {
        if (aborted) return;
        setSession(json.session ?? null);
        setDeep(json.deep ?? null);
        setSelectedSymbol(null);
      })
      .catch(() => {
        if (!aborted) {
          setSession(null);
          setDeep(null);
        }
      })
      .finally(() => {
        if (!aborted) setLoading(false);
      });
    return () => {
      aborted = true;
    };
  }, [market, date]);

  const rows: FundamentalRevaluationResult[] = useMemo(() => {
    if (!session) return [];
    if (view === 'top20') return session.top100.slice(0, 20);
    if (view === 'top100') return session.top100;
    return [];
  }, [session, view]);

  const exclusionRows = useMemo(() => {
    if (!session) return [];
    switch (view) {
      case 'one_time_gain':
        return market === 'TW'
          ? session.exclusionLists.oneTimeGainExcluded
          : session.exclusionLists.deductedNetProfitPoor;
      case 'stretched':
        return session.exclusionLists.valuationStretched;
      case 'cyclical_peak':
        return session.exclusionLists.cyclicalPeak;
      case 'insufficient':
        return session.exclusionLists.insufficientData;
      default:
        return [];
    }
  }, [session, view, market]);

  const isMainList = view === 'top20' || view === 'top100';

  const selected = useMemo(() => {
    if (!selectedSymbol || !session) return null;
    return session.top100.find((r) => r.symbol === selectedSymbol) ?? null;
  }, [selectedSymbol, session]);

  return (
    <PageShell
      headerSlot={
        <PageHeader
          title="📊 基本面補漲策略"
          subtitle={
            session ? (
              <span>
                {market} · {session.date} · {session.totalCandidates} 候選 · 寫於{' '}
                {new Date(session.computedAt).toLocaleString('zh-TW', { hour12: false })}
              </span>
            ) : (
              <span>{market} · {date}</span>
            )
          }
          backButton
        />
      }
    >
      <div className="space-y-4 p-4">
        {/* 控制列 */}
        <div className="flex flex-wrap gap-2 items-center">
          <div className="inline-flex rounded-md border border-border overflow-hidden">
            {(['TW', 'CN'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMarket(m)}
                className={
                  'px-3 py-1.5 text-sm font-medium transition-colors ' +
                  (market === m ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-secondary')
                }
              >
                {m === 'TW' ? '台股' : '陸股'}
              </button>
            ))}
          </div>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="bg-card ring-1 ring-foreground/10 rounded-md px-2 py-1 text-sm"
          />
          {deep && (
            <span className="text-xs px-2 py-1 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              已有深度分析（{deep.analyzedSymbols.length} 檔）
            </span>
          )}
          {loading && <span className="text-xs text-muted-foreground">載入中…</span>}
        </div>

        {/* View tabs */}
        <div className="flex flex-wrap gap-1.5 border-b border-border pb-2">
          {([
            { key: 'top20', label: 'Top 20', count: Math.min(20, session?.top100.length ?? 0) },
            { key: 'top100', label: 'Top 100', count: session?.top100.length ?? 0 },
            {
              key: 'one_time_gain',
              label: market === 'TW' ? '一次性收益排除' : '扣非品質不佳',
              count:
                market === 'TW'
                  ? session?.exclusionLists.oneTimeGainExcluded.length ?? 0
                  : session?.exclusionLists.deductedNetProfitPoor.length ?? 0,
            },
            {
              key: 'stretched',
              label: '估值偏滿',
              count: session?.exclusionLists.valuationStretched.length ?? 0,
            },
            {
              key: 'cyclical_peak',
              label: '景氣高峰',
              count: session?.exclusionLists.cyclicalPeak.length ?? 0,
            },
            {
              key: 'insufficient',
              label: '資料不足',
              count: session?.exclusionLists.insufficientData.length ?? 0,
            },
          ] as Array<{ key: ViewKey; label: string; count: number }>).map((tab) => (
            <button
              key={tab.key}
              onClick={() => setView(tab.key)}
              className={
                'px-2.5 py-1 text-xs rounded transition-colors ' +
                (view === tab.key
                  ? 'bg-primary/15 text-primary font-medium'
                  : 'hover:bg-secondary text-muted-foreground')
              }
            >
              {tab.label}{' '}
              <span className="text-muted-foreground font-mono">({tab.count})</span>
            </button>
          ))}
        </div>

        {/* 主視圖 */}
        {isMainList ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="ring-1 ring-foreground/10 rounded-xl bg-card/30 p-3">
              <TopList
                rows={rows}
                selectedSymbol={selectedSymbol}
                onSelect={setSelectedSymbol}
                market={market}
              />
            </div>
            <div className="ring-1 ring-foreground/10 rounded-xl bg-card/30 p-3">
              {selected ? (
                <ScoreBreakdownPanel result={selected} />
              ) : (
                <div className="text-sm text-muted-foreground p-4 text-center">
                  從左側點選一檔以查看評分明細
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="ring-1 ring-foreground/10 rounded-xl bg-card/30 p-3">
            {exclusionRows.length === 0 ? (
              <div className="text-sm text-muted-foreground p-4 text-center">無此類別</div>
            ) : (
              <ul className="space-y-1 text-xs">
                {exclusionRows.map((r, i) => (
                  <li key={i} className="flex items-baseline gap-2 border-b border-border/50 py-1.5">
                    <span className="font-mono text-primary">{r.symbol}</span>
                    <span>{stockDisplayName(r.name, r.symbol)}</span>
                    <span className="text-muted-foreground ml-auto">{r.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* 策略說明 */}
        {session && (
          <div className="ring-1 ring-foreground/10 rounded-xl bg-card/30 p-3 text-xs text-muted-foreground space-y-1">
            <div className="font-medium text-foreground">策略：{session.strategyVersion}</div>
            <div>
              台股版用「月營收 YoY/MoM」提前推估 Forward EPS；陸股版用「季報 + 扣非淨利」確認本業轉強。
            </div>
            <div>
              4 維 25 分制：成長 / 獲利 / 估值吸引力 / 風險控制；
              ≥85 A 級補漲核心、≥75 B 級候選、≥65 C 級觀察、≥55 D 級弱、否則排除。
            </div>
            <div>
              Phase 2 深度分析請開 Claude Code 跑 <code>/fundamental-revaluation</code> skill；
              Top 20 已自動排隊到 <code>/tmp/rockstock-agents/queue/{session.date}/</code>，可用{' '}
              <code>/multi-agent-decide --batch</code> 對全 20 檔跑多空辯論。
            </div>
          </div>
        )}
      </div>
    </PageShell>
  );
}
