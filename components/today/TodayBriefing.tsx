'use client';

/**
 * TodayBriefing — 首頁走圖下方的「每日決策工作台」
 *
 * 一段 sentence 操作建議 + 3 hero metric + 4 sub-card + 盤中警示。
 * 完整版（含資料新鮮度 chip / NT$ 進度條 / 詳細持倉動作）仍在 /today，
 * 此元件聚焦「今天該動什麼」的精簡 surface。
 *
 * 資料源（7 個 parallel fetch）：reuse 既有 API、不引入新 source
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { lastBusinessDayYmd } from '@/lib/dateDefaults';
import { useTotalCapital, formatNT } from '@/lib/portfolio/useTotalCapital';
import {
  composeOperationSuggestion,
  type DecisionRunForSuggestion,
  type PortfolioReviewForSuggestion,
  type AlertForSuggestion,
  type ReviewAction,
} from '@/lib/today/composeOperationSuggestion';
import { computeHoldingAction, type HoldingActionRule } from '@/lib/today/computeHoldingAction';

type Trend = '多頭' | '空頭' | '盤整';

interface DecisionItem {
  symbol: string;
  name: string | null;
  decision: {
    action: 'buy' | 'watch' | 'skip';
    decisionPath: string;
    sizeHint: number;
    overview: string;
    bullScore: number;
    bearScore: number;
  } | null;
}

interface PoolCandidate {
  symbol: string;
  name: string;
  industry?: string;
  sourceCount: number;
}

interface PortfolioReviewItem {
  symbol: string;
  name: string;
  action: ReviewAction;
  returnPct?: number;
  currentPrice?: number;
  reasoning?: string;
  keyPriceLevels?: { stopLossPrice?: number };
}

interface YoutubeTopStock { code: string; name: string; rating?: string; mention_count: number }

interface AlertItem {
  symbol: string;
  rule: 'blowoff-bearish' | 'blowoff-bullish' | 'terminal-rally' | 'ma5-breakdown';
  firedAt: number;
  tfMin: 1 | 5;
  isHolding: boolean;
}

interface GrowthState {
  gapPct: number;
  status: 'green' | 'yellow' | 'red';
  currentCapital: number;
  currentMonthTarget?: number;
}

const RULE_LABEL: Record<AlertItem['rule'], string> = {
  'blowoff-bearish': '爆量長黑',
  'blowoff-bullish': '爆量長紅',
  'terminal-rally':  '末升段',
  'ma5-breakdown':   'MA5 跌破',
};

const REVIEW_LABEL: Record<ReviewAction, { zh: string; cls: string }> = {
  stop_loss:    { zh: '建議停損', cls: 'text-rose-300 border-rose-700/50 bg-rose-950/30' },
  reduce:       { zh: '建議減碼', cls: 'text-amber-300 border-amber-700/50 bg-amber-950/30' },
  take_profit:  { zh: '建議停利', cls: 'text-emerald-300 border-emerald-700/50 bg-emerald-950/30' },
  add:          { zh: '可加碼', cls: 'text-cyan-300 border-cyan-700/50 bg-cyan-950/30' },
  hold_strong:  { zh: '續抱', cls: 'text-slate-300 border-slate-700/50 bg-slate-900/50' },
  hold_observe: { zh: '觀察', cls: 'text-slate-400 border-slate-700/50 bg-slate-900/50' },
  no_add:       { zh: '不加碼', cls: 'text-slate-400 border-slate-700/50 bg-slate-900/50' },
};

// 規則式 fallback action (computeHoldingAction 回的) → label
const RULE_ACTION_LABEL: Record<HoldingActionRule, { zh: string; cls: string }> = {
  stop_loss:    { zh: '⚠ 停損', cls: 'text-rose-300 border-rose-700/50 bg-rose-950/30' },
  take_profit:  { zh: '🎯 停利', cls: 'text-emerald-300 border-emerald-700/50 bg-emerald-950/30' },
  hold_observe: { zh: '續抱', cls: 'text-slate-300 border-slate-700/50 bg-slate-900/50' },
  no_data:      { zh: '—', cls: 'text-slate-500 border-slate-800 bg-slate-900/30' },
};

interface Props {
  market?: 'TW' | 'CN';
}

export function TodayBriefing({ market = 'TW' }: Props) {
  const today = useMemo(() => lastBusinessDayYmd(), []);
  const totalCapital = useTotalCapital();

  const [loading, setLoading] = useState(true);
  const [trend, setTrend] = useState<Trend | null>(null);
  const [decisions, setDecisions] = useState<DecisionItem[]>([]);
  const [holdings, setHoldings] = useState<{ symbol: string; name: string; entryPrice: number; shares: number; stopLoss?: number }[]>([]);
  const [holdingPrices, setHoldingPrices] = useState<Record<string, number>>({});
  const [reviews, setReviews] = useState<PortfolioReviewItem[]>([]);
  const [pool, setPool] = useState<PoolCandidate[]>([]);
  const [growth, setGrowth] = useState<GrowthState | null>(null);
  const [youtube, setYoutube] = useState<YoutubeTopStock[]>([]);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    (async () => {
      const [trendRes, decisionsRes, holdingsRes, reviewRes, poolRes, growthRes, ytRes, alertsRes] = await Promise.allSettled([
        fetch(`/api/scanner/market-trend?market=${market}&date=${today}`).then(r => r.ok ? r.json() : null),
        fetch(`/api/agents/decisions?date=${today}`).then(r => r.ok ? r.json() : null),
        fetch(`/api/agents/portfolio?status=open`).then(r => r.ok ? r.json() : null),
        fetch(`/api/agents/portfolio/review?date=${today}`).then(r => r.ok ? r.json() : null),
        fetch(`/api/agents/pool?market=${market}&date=${today}&minSourceCount=3&limit=10&sort=weighted`).then(r => r.ok ? r.json() : null),
        fetch(`/api/portfolio/growth-status`).then(r => r.ok ? r.json() : null),
        fetch(`/api/youtube/analysis/${today}`).then(r => r.ok ? r.json() : null),
        fetch(`/api/realtime/alerts/today`).then(r => r.ok ? r.json() : null),
      ]);
      if (canceled) return;

      const pick = <T,>(r: PromiseSettledResult<T | null>): T | null =>
        r.status === 'fulfilled' ? r.value : null;

      const trendData = pick<{ trend?: Trend }>(trendRes);
      setTrend(trendData?.trend ?? null);

      const dec = pick<{ runs?: DecisionItem[] }>(decisionsRes);
      setDecisions(dec?.runs ?? []);

      const hold = pick<{ holdings?: { symbol: string; name: string; market: string; status: string; entryPrice: number; shares: number; stopLoss?: number }[] }>(holdingsRes);
      const myHoldings = (hold?.holdings ?? [])
        .filter(h => h.market === market && h.status === 'open')
        .map(h => ({ symbol: h.symbol, name: h.name, entryPrice: h.entryPrice, shares: h.shares, stopLoss: h.stopLoss }));
      setHoldings(myHoldings);
      // 持股最新報價 — review 沒當天時用 currentPrice 規則式判斷 action
      if (myHoldings.length > 0) {
        const prices = await Promise.all(myHoldings.map(async (h) => {
          const raw = h.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
          const r = await fetch(`/api/stock/quote?symbol=${encodeURIComponent(raw)}`)
            .then(rr => rr.ok ? rr.json() : null).catch(() => null);
          return [h.symbol, typeof r?.close === 'number' ? r.close : 0] as const;
        }));
        if (!canceled) setHoldingPrices(Object.fromEntries(prices.filter(([, p]) => p > 0)));
      }

      const rev = pick<{ ok?: boolean; review?: { reviews: PortfolioReviewItem[] } }>(reviewRes);
      setReviews(rev?.review?.reviews ?? []);

      const p = pick<{ candidates?: PoolCandidate[] }>(poolRes);
      setPool(p?.candidates ?? []);

      const g = pick<{ progress?: { gapPct: number; status: 'green' | 'yellow' | 'red'; currentCapital: number; currentMonthTarget?: number } }>(growthRes);
      setGrowth(g?.progress ? {
        gapPct: g.progress.gapPct,
        status: g.progress.status,
        currentCapital: g.progress.currentCapital,
        currentMonthTarget: g.progress.currentMonthTarget,
      } : null);

      const yt = pick<{ analysis?: { high_consensus_stocks?: Array<{ matched?: { code: string; name: string }; combined_confidence: number }>; stock_scoring?: Array<{ stock_code: string; rating: string }> } }>(ytRes);
      const ana = yt?.analysis;
      if (ana) {
        const high = ana.high_consensus_stocks ?? [];
        const ratingByCode = new Map((ana.stock_scoring ?? []).map(s => [s.stock_code, s.rating]));
        const byCode = new Map<string, YoutubeTopStock>();
        for (const m of high) {
          if (!m.matched || m.combined_confidence < 0.6) continue;
          const code = m.matched.code;
          const existing = byCode.get(code);
          if (existing) existing.mention_count += 1;
          else byCode.set(code, { code, name: m.matched.name, rating: ratingByCode.get(code), mention_count: 1 });
        }
        setYoutube(Array.from(byCode.values()).sort((a, b) => b.mention_count - a.mention_count).slice(0, 6));
      }

      const a = pick<{ alerts?: AlertItem[] }>(alertsRes);
      setAlerts((a?.alerts ?? []).slice(0, 5));

      setLoading(false);
    })();
    return () => { canceled = true; };
  }, [today, market]);

  // 組「今日操作建議」一句話
  const operationSuggestion = useMemo(() => {
    const dec: DecisionRunForSuggestion[] = decisions.map(d => ({
      symbol: d.symbol,
      name: d.name ?? undefined,
      decision: d.decision ? {
        action: d.decision.action,
        decisionPath: d.decision.decisionPath,
        sizeHint: d.decision.sizeHint,
        overview: d.decision.overview,
      } : null,
    }));
    const rev: PortfolioReviewForSuggestion[] = reviews.map(r => ({
      symbol: r.symbol,
      name: r.name,
      action: r.action,
      returnPct: r.returnPct,
      currentPrice: r.currentPrice,
      keyPriceLevels: r.keyPriceLevels,
    }));
    const al: AlertForSuggestion[] = alerts.map(a => ({
      symbol: a.symbol,
      rule: a.rule,
      firedAt: a.firedAt,
      isHolding: a.isHolding,
    }));
    return composeOperationSuggestion({
      decisions: dec,
      portfolioReview: rev,
      alertsToday: al,
      growthGap: growth ? { gapPct: growth.gapPct, status: growth.status } : null,
    });
  }, [decisions, reviews, alerts, growth]);

  const buyRuns = decisions.filter(d => d.decision?.action === 'buy');
  const watchRuns = decisions.filter(d => d.decision?.action === 'watch').slice(0, 5);

  // 規則式 holding action（review 沒當天時 fallback）
  const holdingActions = useMemo(() => holdings.map(h => {
    const reviewMatch = reviews.find(r => r.symbol === h.symbol);
    if (reviewMatch?.action) {
      return { symbol: h.symbol, name: h.name, action: reviewMatch.action as HoldingActionRule | ReviewAction, source: 'review' as const, hint: reviewMatch.reasoning?.slice(0, 30) ?? '' };
    }
    const close = holdingPrices[h.symbol] ?? null;
    const result = computeHoldingAction({ entryPrice: h.entryPrice, currentPrice: close, stopLoss: h.stopLoss });
    return { symbol: h.symbol, name: h.name, action: result.action, source: 'rule' as const, hint: result.hint, returnPct: result.returnPct };
  }), [holdings, reviews, holdingPrices]);

  const holdingAlertsCount = holdingActions.filter(a => a.action === 'stop_loss' || a.action === 'reduce' || a.action === 'take_profit').length;
  const reviewAlertsCount = reviews.filter(r => r.action === 'stop_loss' || r.action === 'reduce' || r.action === 'take_profit').length;

  return (
    <section id="today-briefing" className="border border-slate-700/50 rounded-lg bg-slate-900/40 overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-slate-900/60 border-b border-slate-700/50">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-bold text-amber-300">🌅 今日簡報</span>
          <span className="text-slate-400 font-mono text-xs">{today}</span>
          {loading && <span className="text-xs text-slate-500 animate-pulse">載入中…</span>}
        </div>
        <Link href={`/today`} className="text-xs text-cyan-400 hover:text-cyan-300 hover:underline">
          完整版 /today →
        </Link>
      </div>

      <div className="p-3 space-y-3">
        {/* Hero row：3 個 metric */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <HeroCard label="今日大盤">
            {trend ? (
              <div className={`text-xl font-bold ${
                trend === '多頭' ? 'text-emerald-300' :
                trend === '空頭' ? 'text-rose-300' :
                'text-amber-300'
              }`}>{trendEmoji(trend)} {trend}</div>
            ) : <span className="text-slate-500 text-sm">無資料</span>}
          </HeroCard>

          <HeroCard label="進場時點">
            <TradeWindowDisplay />
          </HeroCard>

          <HeroCard label="月底目標進度">
            {growth ? <GrowthGapDetail growth={growth} /> : <span className="text-slate-500 text-sm">未設定</span>}
          </HeroCard>
        </div>

        {/* 操作建議一句話 */}
        <div className="border border-amber-700/40 bg-amber-950/20 rounded p-3">
          <div className="text-xs font-bold text-amber-300 mb-1">💡 今日操作建議</div>
          <p className="text-sm text-slate-200 leading-relaxed">{operationSuggestion}</p>
        </div>

        {/* 4 sub-cards：候選/持股/觀察/YouTube */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2">
          <SubCard
            title={buyRuns.length > 0 ? '① 多代理進場' : '① 今日觀察（候選池高分）'}
            count={buyRuns.length > 0 ? buyRuns.length : pool.length}
            tone={buyRuns.length > 0 ? 'success' : pool.length > 0 ? 'info' : 'muted'}
            href={buyRuns.length > 0 ? `/?tab=agent` : `/?tab=pool&date=${today}`}
            hint={buyRuns.length === 0 ? '多代理未跑、用候選池替代' : undefined}
          >
            {buyRuns.length === 0 && pool.length === 0 ? (
              <Empty>多代理 0 檔、候選池無 ≥3 共識股</Empty>
            ) : buyRuns.length > 0 ? (
              <div className="space-y-1.5">
                {buyRuns.slice(0, 4).map(r => (
                  <Link key={r.symbol} href={`/?load=${encodeURIComponent(r.symbol)}&date=${today}&tab=decision`}
                    className="block text-xs hover:bg-emerald-900/30 rounded px-1.5 py-1 transition">
                    <span className="font-medium text-emerald-300">{r.name ?? r.symbol}</span>
                    <span className="text-slate-400 ml-1.5">{r.decision?.sizeHint}%</span>
                    {totalCapital && r.decision && r.decision.sizeHint > 0 && (
                      <span className="text-cyan-400 text-[10px] ml-1">
                        ≈ {formatNT(totalCapital * r.decision.sizeHint / 100)}
                      </span>
                    )}
                  </Link>
                ))}
              </div>
            ) : (
              // fallback：candidates pool 高分股
              <div className="space-y-1.5">
                {pool.slice(0, 4).map(c => (
                  <Link key={c.symbol} href={`/?load=${encodeURIComponent(c.symbol)}&date=${today}&tab=decision`}
                    className="flex items-center justify-between gap-1.5 hover:bg-slate-800 rounded px-1.5 py-1 transition text-xs">
                    <span className="text-amber-200 truncate">{c.name}</span>
                    <span className="text-amber-400 font-mono text-[10px]">{c.sourceCount} 面</span>
                  </Link>
                ))}
              </div>
            )}
          </SubCard>

          <SubCard
            title="② 持股動作"
            count={holdings.length}
            tone={holdingAlertsCount > 0 ? 'danger' : 'info'}
            href={`/portfolio`}
            hint={reviews.length === 0 ? '規則式（review 未跑）' : undefined}
          >
            {holdings.length === 0 ? (
              <Empty>無持股</Empty>
            ) : (
              <div className="space-y-1.5">
                {holdingActions.slice(0, 4).map(a => {
                  // review 來源用 REVIEW_LABEL（含 reduce/take_profit/stop_loss/add/hold_strong/hold_observe/no_add）
                  // rule 來源用 RULE_ACTION_LABEL（stop_loss/take_profit/hold_observe/no_data）
                  const cfg = a.source === 'review'
                    ? REVIEW_LABEL[a.action as ReviewAction] ?? RULE_ACTION_LABEL.hold_observe
                    : RULE_ACTION_LABEL[a.action as HoldingActionRule] ?? RULE_ACTION_LABEL.no_data;
                  return (
                    <Link key={a.symbol} href={`/?load=${encodeURIComponent(a.symbol)}&tab=decision`}
                      className="flex items-center justify-between gap-1.5 hover:bg-slate-800 rounded px-1.5 py-1 transition text-xs"
                      title={a.hint}>
                      <span className="text-slate-200 truncate flex items-center gap-1">
                        {a.name}
                        {a.source === 'rule' && <span className="text-[9px] text-slate-500" title="無 review 資料、用 stopLoss 距離規則式判斷">⚙</span>}
                      </span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] border ${cfg.cls}`}>{cfg.zh}</span>
                    </Link>
                  );
                })}
              </div>
            )}
          </SubCard>

          <SubCard
            title="③ 觀察池"
            count={pool.length}
            tone="info"
            href={`/?tab=pool&date=${today}`}
            hint="≥3 面向共識"
          >
            {pool.length === 0 ? (
              <Empty>無 ≥3 共識候選</Empty>
            ) : (
              <div className="space-y-1.5">
                {pool.slice(0, 4).map(c => (
                  <Link key={c.symbol} href={`/?load=${encodeURIComponent(c.symbol)}&tab=decision`}
                    className="flex items-center justify-between gap-1.5 hover:bg-slate-800 rounded px-1.5 py-1 transition text-xs">
                    <span className="text-amber-200 truncate">{c.name}</span>
                    <span className="text-amber-400 font-mono text-[10px]">{c.sourceCount} 面</span>
                  </Link>
                ))}
              </div>
            )}
          </SubCard>

          <SubCard
            title="④ YouTube 共識"
            count={youtube.length}
            tone="info"
            href={`/?tab=youtube&date=${today}`}
            hint="≥2 節目同向"
          >
            {youtube.length === 0 ? (
              <Empty>無共識股</Empty>
            ) : (
              <div className="space-y-1.5">
                {youtube.slice(0, 4).map(y => (
                  <Link key={y.code} href={`/?load=${encodeURIComponent(y.code)}.TW&tab=decision`}
                    className="flex items-center justify-between gap-1.5 hover:bg-slate-800 rounded px-1.5 py-1 transition text-xs">
                    <span className="text-purple-200 truncate">{y.name}</span>
                    <div className="flex items-center gap-1 text-[10px]">
                      {y.rating && <span className="font-mono text-purple-300">{y.rating}</span>}
                      <span className="text-purple-400 font-mono">{y.mention_count}節</span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </SubCard>
        </div>

        {/* 盤中警示時間軸 */}
        {alerts.length > 0 && (
          <div className="border border-rose-700/40 bg-rose-950/15 rounded p-2">
            <div className="text-xs font-bold text-rose-300 mb-1.5">⚠ 今日盤中警示（{alerts.length} 條）</div>
            <ul className="space-y-1">
              {alerts.slice(0, watchRuns.length > 0 ? 3 : 5).map((a, i) => (
                <li key={`${a.symbol}-${a.firedAt}-${i}`} className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-rose-400 text-[10px]">{hhmm(a.firedAt)}</span>
                  <Link href={`/?load=${encodeURIComponent(a.symbol)}&tf=5m`}
                    className="text-slate-300 hover:text-rose-300 hover:underline font-mono">{a.symbol}</Link>
                  <span className="text-rose-300">{RULE_LABEL[a.rule]}</span>
                  <span className="text-slate-500 text-[10px]">tf={a.tfMin}m</span>
                  {a.isHolding && <span className="text-amber-400 text-[10px]">持股中</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

// ── inline 子元件 ────────────────────────────────────────────────────────────

function HeroCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border border-slate-700/40 rounded p-2 bg-slate-900/40">
      <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-1">{label}</div>
      {children}
    </div>
  );
}

function SubCard({
  title, count, tone, href, hint, children,
}: {
  title: string; count: number;
  tone: 'success' | 'danger' | 'info' | 'muted';
  href: string; hint?: string; children: React.ReactNode;
}) {
  const toneCls = {
    success: 'border-emerald-700/40 bg-emerald-950/15',
    danger:  'border-rose-700/40 bg-rose-950/15',
    info:    'border-slate-700/40 bg-slate-900/30',
    muted:   'border-slate-800 bg-slate-900/20',
  }[tone];
  return (
    <div className={`rounded p-2 border ${toneCls} flex flex-col`}>
      <div className="flex items-center justify-between mb-1.5">
        <Link href={href} className="text-xs font-bold text-slate-200 hover:underline">
          {title} <span className="text-slate-400 font-mono">({count})</span>
        </Link>
        {hint && <span className="text-[10px] text-slate-500">{hint}</span>}
      </div>
      <div className="flex-1 max-h-[160px] overflow-y-auto">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] text-slate-500 italic">{children}</p>;
}

function GrowthGapDetail({ growth }: { growth: GrowthState }) {
  const toneCls = growth.status === 'green' ? 'text-emerald-300'
    : growth.status === 'yellow' ? 'text-amber-300'
    : 'text-rose-300';
  // 月底還剩幾天 + 還差多少
  const now = new Date();
  const tpe = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const lastDay = new Date(tpe.getFullYear(), tpe.getMonth() + 1, 0).getDate();
  const daysLeft = lastDay - tpe.getDate();
  const gap = growth.currentMonthTarget != null
    ? growth.currentMonthTarget - growth.currentCapital
    : null;
  const requiredDailyPct = gap != null && gap > 0 && daysLeft > 0 && growth.currentCapital > 0
    ? ((Math.pow((growth.currentCapital + gap) / growth.currentCapital, 1 / daysLeft) - 1) * 100)
    : null;
  return (
    <>
      <div className={`text-xl font-bold ${toneCls}`}>
        {growth.gapPct >= 0 ? '+' : ''}{(growth.gapPct * 100).toFixed(1)}%
      </div>
      <div className="text-[10px] text-slate-400 font-mono leading-tight">
        現 {formatNT(growth.currentCapital)}
        {growth.currentMonthTarget && (
          <span className="text-slate-500"> / 目標 {formatNT(growth.currentMonthTarget)}</span>
        )}
      </div>
      {gap != null && gap > 0 && (
        <div className="text-[10px] text-rose-400/80 leading-tight mt-0.5">
          還差 {formatNT(gap)}
          {daysLeft > 0 && ` · 剩 ${daysLeft} 天`}
          {requiredDailyPct != null && ` · 需日均 +${requiredDailyPct.toFixed(2)}%`}
        </div>
      )}
      {gap != null && gap <= 0 && (
        <div className="text-[10px] text-emerald-400/80 leading-tight mt-0.5">
          ✓ 已達標、超前 {formatNT(Math.abs(gap))}
        </div>
      )}
    </>
  );
}

function TradeWindowDisplay() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  // 台北時間 HH:MM + 星期
  const tpe = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  });
  const parts = tpe.formatToParts(now);
  const h = Number(parts.find(p => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find(p => p.type === 'minute')?.value ?? '0');
  const weekday = parts.find(p => p.type === 'weekday')?.value ?? '';
  const mins = h * 60 + m;
  const tradeStart = 13 * 60 + 20;
  const tradeEnd = 13 * 60 + 25;
  const marketClose = 13 * 60 + 30;

  // 9:00 之前 / 13:20 之前 / 13:20-13:25 / 13:30 後 / 假日
  const isWeekend = weekday === 'Sat' || weekday === 'Sun';
  if (isWeekend) {
    return (
      <>
        <div className="text-xl font-bold text-slate-500 font-mono">週末休市</div>
        <div className="text-[10px] text-slate-500">下個交易日 09:00 開盤</div>
      </>
    );
  }
  if (mins < tradeStart) {
    const diff = tradeStart - mins;
    const hh = Math.floor(diff / 60);
    const mm = diff % 60;
    const today_or_tomorrow = mins < 9 * 60 ? '今日' : (mins > marketClose ? '明日' : '今日');
    return (
      <>
        <div className="text-xl font-bold text-slate-300 font-mono">
          {hh > 0 ? `${hh}h ` : ''}{mm}m
        </div>
        <div className="text-[10px] text-slate-500">距 {today_or_tomorrow} 13:20</div>
      </>
    );
  }
  if (mins <= tradeEnd) {
    return (
      <>
        <div className="text-xl font-bold text-emerald-300 font-mono">⏰ 進場時段</div>
        <div className="text-[10px] text-emerald-400">13:20-13:25 掛市價</div>
      </>
    );
  }
  if (mins <= marketClose) {
    return (
      <>
        <div className="text-xl font-bold text-amber-300 font-mono">收盤前 {marketClose - mins}m</div>
        <div className="text-[10px] text-amber-400">13:30 收盤</div>
      </>
    );
  }
  // 已收盤 — 距明日 13:20
  const tomorrowMins = (24 * 60 - mins) + tradeStart;
  const hh = Math.floor(tomorrowMins / 60);
  const mm = tomorrowMins % 60;
  return (
    <>
      <div className="text-xl font-bold text-slate-300 font-mono">{hh}h {mm}m</div>
      <div className="text-[10px] text-slate-500">距明日 13:20</div>
    </>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function trendEmoji(t: Trend | null): string {
  if (t === '多頭') return '▲';
  if (t === '空頭') return '▼';
  if (t === '盤整') return '↔';
  return '—';
}

function hhmm(epochMs: number): string {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return fmt.format(new Date(epochMs));
}
