'use client';

/**
 * /today — 今日決策中心
 *
 * 一頁回答交易者每天打開 app 的 3 個問題：
 *   1. 今天大盤能不能做？（marketTrend + 13:20 倒數 + NT$ 進度）
 *   2. 今天要進場什麼？（multi-agent decision.action='buy'）
 *   3. 今天要動的持倉？（server holdings × 最新收盤 → 觸發停損/停利）
 *   4. 今天要觀察什麼？（pool sourceCount ≥ 2 但還沒 enter）
 *
 * 所有資料來自既有 API，不引入新 source。
 * 限 TW（per project_cn_excluded_from_path：業務邏輯 TW-only；陸股 UI 仍在其他頁）
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PageShell, PageHeader } from '@/components/shared';
import { lastBusinessDayYmd } from '@/lib/dateDefaults';
import { useTotalCapital, formatNT } from '@/lib/portfolio/useTotalCapital';

type Trend = '多頭' | '空頭' | '盤整';

interface Decision { action: 'buy' | 'watch' | 'skip'; sizeHint: number; overview: string; bullScore: number; bearScore: number }
interface Run { symbol: string; name: string | null; decision: Decision | null }

interface PoolCandidate {
  symbol: string; name: string; industry?: string;
  sourceCount: number;
  sources: { technical?: { prohibitionHit: boolean; eliminationHit: boolean; reasons: string[] }; youtube?: { mentionCount: number; sentiment: string; inHighConsensus: boolean } };
}

interface Holding {
  symbol: string; name: string; market: 'TW' | 'CN';
  entryDate: string; entryPrice: number; shares: number;
  stopLoss?: number; status: string;
}

interface GrowthDisplay { currentCapital: number; targetCapital: number; startCapital: number; gapPct: number; currentMonthTarget: number; status: string }

interface YoutubeStockMini { code: string; name: string; rating?: string; mention_count: number; sentiment: string }
interface YoutubeSummary {
  market_view: string;
  bullish_consensus: string[];
  bearish_consensus: string[];
  high_consensus_stocks: number;
  top_stocks: YoutubeStockMini[];
}

export default function TodayPage() {
  const today = useMemo(() => lastBusinessDayYmd(), []);

  const [trend, setTrend] = useState<Trend | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [holdingPrices, setHoldingPrices] = useState<Record<string, number>>({});
  const [pool, setPool] = useState<PoolCandidate[]>([]);
  const [growth, setGrowth] = useState<GrowthDisplay | null>(null);
  const [youtube, setYoutube] = useState<YoutubeSummary | null>(null);
  const [loading, setLoading] = useState(true);
  // 資料新鮮度（4 source 是否有 today 資料）
  const [freshness, setFreshness] = useState<{ trend: boolean; pool: boolean; agents: boolean; youtube: boolean }>({
    trend: false, pool: false, agents: false, youtube: false,
  });

  const totalCapital = useTotalCapital();

  // 13:20 CST 倒數（朱書交易時間）
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    (async () => {
      const [trendRes, decisionsRes, holdingsRes, poolRes, growthRes, youtubeRes] = await Promise.all([
        fetch(`/api/scanner/market-trend?market=TW&date=${today}`).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`/api/agents/decisions?date=${today}`).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`/api/agents/portfolio?status=open`).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`/api/agents/pool?market=TW&date=${today}&minSourceCount=2&limit=20`).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`/api/portfolio/growth-status`).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`/api/youtube/analysis/${today}`).then(r => r.ok ? r.json() : null).catch(() => null),
      ]);
      if (canceled) return;
      setTrend((trendRes?.trend as Trend) ?? null);
      setRuns((decisionsRes?.runs as Run[]) ?? []);
      const hold = (holdingsRes?.holdings as Holding[] | undefined) ?? [];
      setHoldings(hold.filter(h => h.market === 'TW' && h.status === 'open'));
      setPool((poolRes?.candidates as PoolCandidate[]) ?? []);
      const gp = growthRes?.progress;
      const gpath = growthRes?.path;
      setGrowth(gp && gpath ? {
        currentCapital: gp.currentCapital,
        startCapital: gpath.startCapital,
        targetCapital: gpath.targetCapital,
        gapPct: gp.gapPct,
        currentMonthTarget: gp.currentMonthTarget,
        status: gp.status,
      } : null);

      // YouTube 摘要：market_view 1 句 + consensus chip + top 5 mention 股
      // API 回 { ok, analysis: { ... } }，分析資料在 .analysis 下
      const ana = youtubeRes?.analysis;
      if (ana) {
        const high = (ana.high_consensus_stocks ?? []) as Array<{ matched?: { code: string; name: string }; sentiment: string; combined_confidence: number }>;
        const scoring = (ana.stock_scoring ?? []) as Array<{ stock_code: string; rating: string; composite_score: number }>;
        const ratingByCode = new Map(scoring.map(s => [s.stock_code, s.rating]));
        const byCode = new Map<string, YoutubeStockMini>();
        for (const m of high) {
          if (!m.matched || m.combined_confidence < 0.6) continue;
          const code = m.matched.code;
          const existing = byCode.get(code);
          if (existing) existing.mention_count += 1;
          else byCode.set(code, {
            code, name: m.matched.name,
            rating: ratingByCode.get(code),
            mention_count: 1,
            sentiment: m.sentiment,
          });
        }
        const top = Array.from(byCode.values()).sort((a, b) => b.mention_count - a.mention_count).slice(0, 6);
        setYoutube({
          market_view: (ana.market_view ?? '').slice(0, 200),
          bullish_consensus: (ana.bullish_consensus ?? []).slice(0, 3),
          bearish_consensus: (ana.bearish_consensus ?? []).slice(0, 2),
          high_consensus_stocks: high.length,
          top_stocks: top,
        });
      }

      // 資料新鮮度：每個 source 是不是有 today 的資料
      setFreshness({
        trend: !!(trendRes?.trend),
        pool: !!(poolRes?.exists ?? (poolRes?.candidates?.length ?? 0) > 0),
        agents: !!(decisionsRes?.runs?.length),
        youtube: !!(youtubeRes?.analysis ?? youtubeRes?.market_view ?? youtubeRes?.date),
      });

      // 每檔持倉撈最新收盤
      if (hold.length > 0) {
        const prices = await Promise.all(
          hold.map(async h => {
            const r = await fetch(`/api/stock?symbol=${encodeURIComponent(h.symbol)}&period=1mo`)
              .then(r => r.ok ? r.json() : null).catch(() => null);
            const candles = r?.candles as Array<{ close: number }> | undefined;
            return [h.symbol, candles?.length ? candles[candles.length - 1].close : 0] as const;
          }),
        );
        if (!canceled) setHoldingPrices(Object.fromEntries(prices.filter(([, p]) => p > 0)));
      }

      if (!canceled) setLoading(false);
    })();
    return () => { canceled = true; };
  }, [today]);

  const buyRuns = runs.filter(r => r.decision?.action === 'buy');
  const watchRuns = runs.filter(r => r.decision?.action === 'watch').slice(0, 8);

  // 持倉動作分類
  const holdingActions = holdings.map(h => {
    const close = holdingPrices[h.symbol];
    if (!close) return { ...h, close: null, pnl: null, pnlPct: null, action: 'no_data' as const, hint: '無最新報價' };
    const pnl = (close - h.entryPrice) * h.shares;
    const pnlPct = ((close - h.entryPrice) / h.entryPrice) * 100;
    const distToStop = h.stopLoss ? ((close - h.stopLoss) / close) * 100 : null;
    let action: 'stop_loss' | 'take_profit' | 'hold' = 'hold';
    let hint = '正常持有';
    if (h.stopLoss && close <= h.stopLoss) { action = 'stop_loss'; hint = `已跌破停損 ${h.stopLoss}`; }
    else if (distToStop != null && distToStop < 3) { action = 'stop_loss'; hint = `距停損僅 ${distToStop.toFixed(1)}%`; }
    else if (pnlPct >= 10) { action = 'take_profit'; hint = `已漲 ${pnlPct.toFixed(1)}%，留意短線 MA5 跌破`; }
    return { ...h, close, pnl, pnlPct, action, hint };
  });

  // 進場時點倒數（朱書 13:20 看、13:25 掛市價）
  const tradeWindow = computeTradeWindow(now);

  const header = <PageHeader title="🌅 今日決策中心" subtitle={`${today} · 一頁回答今天該動什麼`} />;

  const freshAll = freshness.trend && freshness.pool && freshness.agents && freshness.youtube;
  const freshCount = [freshness.trend, freshness.pool, freshness.agents, freshness.youtube].filter(Boolean).length;

  return (
    <PageShell headerSlot={header}>
      <div className="max-w-6xl mx-auto px-4 py-4 space-y-4">
        {/* ─── 資料新鮮度 chip 列 ─── */}
        <section className={`rounded-md border px-3 py-2 text-xs flex items-center gap-2 flex-wrap ${
          freshAll
            ? 'border-emerald-700/40 bg-emerald-900/15 text-emerald-300'
            : freshCount >= 2
              ? 'border-amber-700/40 bg-amber-900/15 text-amber-300'
              : 'border-red-700/40 bg-red-900/15 text-red-300'
        }`}>
          <span className="font-semibold">📡 {today} 資料新鮮度</span>
          <FreshDot label="行情" ok={freshness.trend} hint="data/cache/market-trend；scanner cron 寫" />
          <FreshDot label="Pool" ok={freshness.pool} hint="data/agents/pool/TW/{date}.json；agents-daily-decide cron 19:30 寫" />
          <FreshDot label="多代理" ok={freshness.agents} hint="data/agents/runs/{date}/；user 在 Claude Code 跑 /multi-agent-decide 後填入" />
          <FreshDot label="YouTube" ok={freshness.youtube} hint="data/youtube/analysis/{date}.json；user 跑 /youtube-analysis skill 後寫" />
          {!freshAll && (
            <Link href="/health" className="ml-auto text-sky-400 hover:underline">查 /health →</Link>
          )}
        </section>

        {/* ─── Hero: 大盤 + 倒數 + NT$ 進度 ─── */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Card title="今日大盤" tone={trendTone(trend)}>
            {trend ? (
              <>
                <div className="text-2xl font-bold mb-1">{trendEmoji(trend)} {trend}</div>
                <p className="text-xs text-muted-foreground">{trendHint(trend)}</p>
              </>
            ) : <p className="text-sm text-muted-foreground">無 {today} 大盤資料</p>}
          </Card>

          <Card title="進場時點（朱書 13:20-13:25）" tone={tradeWindow.tone}>
            <div className="text-2xl font-bold mb-1 font-mono">{tradeWindow.label}</div>
            <p className="text-xs text-muted-foreground">{tradeWindow.hint}</p>
          </Card>

          <Card title="7000萬 → 3億 進度" tone={growth ? 'info' : 'muted'}>
            {growth ? (
              <>
                <div className="text-2xl font-bold font-mono mb-1">
                  {formatNT(growth.currentCapital)}
                </div>
                <ProgressBar
                  start={growth.startCapital}
                  current={growth.currentCapital}
                  target={growth.targetCapital}
                />
                <p className="text-[10px] text-muted-foreground mt-1">
                  起 {formatNT(growth.startCapital)} · 目標 {formatNT(growth.targetCapital)}
                </p>
              </>
            ) : <p className="text-sm text-muted-foreground">growth-path 未設定</p>}
          </Card>
        </section>

        {loading && <p className="text-sm text-muted-foreground text-center py-4">載入中…</p>}

        {/* ─── 進場 ─── */}
        <Section title="① 今日要進場" emoji="✅" tone={buyRuns.length > 0 ? 'success' : 'muted'} count={buyRuns.length}>
          {buyRuns.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              今日多代理判定 0 檔進場。系統檢視 {runs.length} 檔候選後沒挑出可進場標的（常見：大盤盤整 / 戒律觸發 / 高位置）。
              <br />
              <span className="text-xs">建議今日不動作或減倉觀望，或到 <Link href={`/agents?date=${today}`} className="underline text-sky-400">/agents</Link> 看「觀察」第一名再決定。</span>
            </p>
          ) : (
            <div className="space-y-2">
              {buyRuns.map(r => (
                <Link key={r.symbol} href={`/agents/${encodeURIComponent(r.symbol)}?date=${today}`}
                  className="block rounded-lg border border-emerald-700/50 bg-emerald-900/20 hover:bg-emerald-900/30 p-3 transition-colors">
                  <div className="flex items-baseline justify-between gap-2 flex-wrap">
                    <div>
                      <span className="font-bold text-emerald-300 text-lg">{r.name ?? r.symbol}</span>
                      <span className="font-mono text-xs text-emerald-500/70 ml-2">{r.symbol}</span>
                    </div>
                    <div className="text-xs font-mono">
                      部位 <span className="text-emerald-300 font-bold">{r.decision?.sizeHint}%</span>
                      {totalCapital && r.decision && r.decision.sizeHint > 0 && (
                        <span className="text-cyan-300 ml-1">（≈ {formatNT(totalCapital * r.decision.sizeHint / 100)}）</span>
                      )}
                      <span className="text-muted-foreground mx-1">·</span>
                      多 {r.decision?.bullScore} / 空 {r.decision?.bearScore}
                    </div>
                  </div>
                  <p className="text-xs text-slate-300 mt-1">{r.decision?.overview}</p>
                </Link>
              ))}
            </div>
          )}
        </Section>

        {/* ─── 持倉動作 ─── */}
        <Section title="② 今日持倉動作" emoji="💼" tone={holdingActions.some(a => a.action === 'stop_loss') ? 'danger' : 'info'} count={holdings.length}>
          {holdings.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              server 持倉為空（讀 <code className="text-xs bg-secondary px-1 rounded">data/agents/portfolio/holdings.json</code>）。
              到 <Link href="/portfolio" className="underline text-sky-400">/portfolio</Link> 新增、或 <Link href="/agents/portfolio" className="underline text-sky-400">/agents/portfolio</Link> 寫到 server。
            </p>
          ) : (
            <div className="space-y-2">
              {holdingActions.map(h => (
                <HoldingRow key={h.symbol} h={h} totalCapital={totalCapital} />
              ))}
            </div>
          )}
        </Section>

        {/* ─── 觀察名單 ─── */}
        <Section title="③ 今日觀察名單" emoji="👀" tone="info" count={pool.length}>
          {pool.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              候選池無 ≥ 2 面向命中。檢查 <Link href={`/agents/pool?date=${today}`} className="underline text-sky-400">/agents/pool</Link>。
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {pool.slice(0, 10).map(c => (
                <Link key={c.symbol} href={`/agents/${encodeURIComponent(c.symbol)}?date=${today}`}
                  className="block rounded border border-amber-700/40 bg-amber-900/10 hover:bg-amber-900/20 p-2.5 transition-colors">
                  <div className="flex items-center justify-between gap-1.5 flex-wrap">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-medium text-amber-200">{c.name}</span>
                      <span className="font-mono text-[10px] text-amber-500/70">{c.symbol}</span>
                      {c.sources.technical?.prohibitionHit && <span title="戒律觸發" className="text-[10px] px-1 py-0.5 rounded bg-red-900/50 text-red-300">🚫戒律</span>}
                      {!c.sources.technical && <span title="技術面未檢核" className="text-[10px] px-1 py-0.5 rounded bg-slate-800 text-slate-400">⚠技術未檢</span>}
                    </div>
                    <span className="text-xs font-mono text-amber-300">{c.sourceCount} 面向</span>
                  </div>
                  {c.industry && <p className="text-[10px] text-amber-500/60 mt-0.5">{c.industry}</p>}
                </Link>
              ))}
              {pool.length > 10 && (
                <Link href={`/agents/pool?date=${today}`} className="md:col-span-2 text-center text-xs text-sky-400 hover:underline">
                  看完整 {pool.length} 檔 →
                </Link>
              )}
            </div>
          )}
        </Section>

        {/* ─── YouTube 共識 inline ─── */}
        {youtube && (
          <Section title="④ YouTube 跨節目共識" emoji="📺" tone="info" count={youtube.high_consensus_stocks}>
            <p className="text-xs text-foreground/80 leading-relaxed mb-2">{youtube.market_view}</p>
            {youtube.bullish_consensus.length > 0 && (
              <div className="text-xs space-y-0.5 mb-1">
                <span className="text-emerald-400">看多：</span>
                {youtube.bullish_consensus.map((b, i) => (
                  <div key={i} className="ml-3 text-foreground/70">· {b}</div>
                ))}
              </div>
            )}
            {youtube.bearish_consensus.length > 0 && (
              <div className="text-xs space-y-0.5 mb-2">
                <span className="text-red-400">看空 / 風險：</span>
                {youtube.bearish_consensus.map((b, i) => (
                  <div key={i} className="ml-3 text-foreground/70">· {b}</div>
                ))}
              </div>
            )}
            {youtube.top_stocks.length > 0 && (
              <div className="flex gap-1.5 flex-wrap pt-1 border-t border-border/40">
                <span className="text-[10px] text-muted-foreground self-center">高共識股：</span>
                {youtube.top_stocks.map(s => (
                  <Link key={s.code} href={`/agents/${s.code}.TW?date=${today}`}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-purple-900/30 border border-purple-700/40 text-purple-200 hover:bg-purple-900/50">
                    {s.rating && <span className="font-bold">{s.rating}</span>}
                    <span>{s.name}</span>
                    <span className="text-purple-400/70">×{s.mention_count}</span>
                  </Link>
                ))}
                <Link href={`/youtube?date=${today}`} className="text-[10px] text-sky-400 hover:underline self-center ml-1">完整 →</Link>
              </div>
            )}
          </Section>
        )}

        {/* ─── 本週 growth gap ─── */}
        {growth && (
          <Section title="⑤ 本月 growth gap" emoji="📈" tone={growth.status === 'red' ? 'danger' : growth.status === 'yellow' ? 'warn' : 'success'}>
            <div className="text-xs grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <div className="text-muted-foreground text-[10px]">本月應到</div>
                <div className="font-mono font-bold">{formatNT(growth.currentMonthTarget)}</div>
              </div>
              <div>
                <div className="text-muted-foreground text-[10px]">當前</div>
                <div className="font-mono font-bold">{formatNT(growth.currentCapital)}</div>
              </div>
              <div>
                <div className="text-muted-foreground text-[10px]">差距</div>
                <div className={`font-mono font-bold ${growth.gapPct >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                  {growth.gapPct >= 0 ? '+' : ''}{(growth.gapPct * 100).toFixed(1)}%
                </div>
              </div>
              <div>
                <Link href="/growth" className="text-sky-400 hover:underline">看完整軌跡 →</Link>
              </div>
            </div>
          </Section>
        )}

        {/* ─── Export ─── */}
        <section className="pt-2 border-t border-border">
          <button
            type="button"
            onClick={() => exportTodayMd({ today, trend, buyRuns, watchRuns, holdingActions, growth, totalCapital })}
            className="text-xs px-3 py-1.5 bg-sky-900/30 hover:bg-sky-900/50 border border-sky-700/40 text-sky-300 rounded transition-colors"
          >
            📋 Export 明日觀察名單（markdown）
          </button>
          <span className="text-[10px] text-muted-foreground/60 ml-2">下載 .md 檔，含大盤狀態 + 進場 + 持倉動作 + 觀察名單</span>
        </section>

        {/* ─── 深度連結 ─── */}
        <nav className="flex gap-2 flex-wrap text-xs pt-2 border-t border-border">
          <Link href={`/agents?date=${today}`} className="text-sky-400 hover:underline">🤖 4 階段詳情</Link>
          <Link href={`/agents/pool?date=${today}`} className="text-sky-400 hover:underline">🗂 完整候選池</Link>
          <Link href="/portfolio" className="text-sky-400 hover:underline">💼 持倉細節</Link>
          <Link href="/growth" className="text-sky-400 hover:underline">📈 進度</Link>
          <Link href="/sizer" className="text-sky-400 hover:underline">📐 部位試算</Link>
          <Link href="/risk" className="text-sky-400 hover:underline">🛡 風險面板</Link>
          <Link href="/journal" className="text-sky-400 hover:underline">📓 交易日誌</Link>
          <Link href={`/youtube?date=${today}`} className="text-sky-400 hover:underline">📺 YouTube 共識</Link>
          <Link href="/health" className="text-sky-400 hover:underline">📊 資料健康</Link>
        </nav>
      </div>
    </PageShell>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────────────

function trendEmoji(t: Trend | null): string {
  return t === '多頭' ? '▲' : t === '空頭' ? '▼' : '↔';
}
function trendTone(t: Trend | null): CardTone {
  return t === '多頭' ? 'success' : t === '空頭' ? 'danger' : 'warn';
}
function trendHint(t: Trend): string {
  if (t === '多頭') return '可選股做多（六條件 + 戒律未觸發即可進場）';
  if (t === '空頭') return '禁止做多（戒律 8：空頭趨勢下的紅K反彈勿進場）';
  return '可選擇性做多 — 盤整不是多頭，謹慎進場（戒律 7 提醒）';
}

type CardTone = 'success' | 'danger' | 'warn' | 'info' | 'muted';

function FreshDot({ label, ok, hint }: { label: string; ok: boolean; hint: string }) {
  return (
    <span
      title={hint}
      className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] cursor-help ${
        ok ? 'bg-emerald-900/40 text-emerald-300' : 'bg-red-900/40 text-red-300'
      }`}
    >
      {ok ? '✓' : '✗'} {label}
    </span>
  );
}

function Card({ title, tone, children }: { title: string; tone: CardTone; children: React.ReactNode }) {
  const cls = {
    success: 'border-emerald-700/50 bg-emerald-900/20',
    danger:  'border-red-700/50 bg-red-900/20',
    warn:    'border-amber-700/50 bg-amber-900/20',
    info:    'border-sky-700/40 bg-sky-900/15',
    muted:   'border-border bg-card',
  }[tone];
  return (
    <div className={`rounded-lg border p-3 ${cls}`}>
      <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{title}</div>
      {children}
    </div>
  );
}

function Section({ title, emoji, tone, count, children }: { title: string; emoji: string; tone: CardTone; count?: number; children: React.ReactNode }) {
  const headCls = {
    success: 'text-emerald-300',
    danger:  'text-red-300',
    warn:    'text-amber-300',
    info:    'text-sky-300',
    muted:   'text-muted-foreground',
  }[tone];
  return (
    <section className="space-y-2">
      <h2 className={`text-sm font-semibold ${headCls} flex items-center gap-1.5`}>
        <span>{emoji}</span>
        <span>{title}</span>
        {count !== undefined && <span className="text-xs font-mono text-muted-foreground">({count})</span>}
      </h2>
      {children}
    </section>
  );
}

function HoldingRow({ h, totalCapital }: {
  h: { symbol: string; name: string; entryPrice: number; shares: number; stopLoss?: number; close: number | null; pnl: number | null; pnlPct: number | null; action: 'stop_loss' | 'take_profit' | 'hold' | 'no_data'; hint: string };
  totalCapital: number | null;
}) {
  const cls = {
    stop_loss:   'border-red-700/50 bg-red-900/20',
    take_profit: 'border-amber-700/50 bg-amber-900/20',
    hold:        'border-slate-700/40 bg-slate-900/30',
    no_data:     'border-border bg-card',
  }[h.action];
  const actionLabel = {
    stop_loss:   '🛑 注意停損',
    take_profit: '💰 留意停利',
    hold:        '✓ 正常持有',
    no_data:     '— 無報價',
  }[h.action];
  const costShare = totalCapital ? (h.entryPrice * h.shares / totalCapital * 100) : null;
  return (
    <Link href={`/agents/${encodeURIComponent(h.symbol)}`} className={`block rounded border p-3 hover:opacity-80 transition-opacity ${cls}`}>
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <div>
          <span className="font-bold text-slate-100">{h.name}</span>
          <span className="font-mono text-xs text-slate-500 ml-2">{h.symbol}</span>
          <span className="ml-2 text-xs">{actionLabel}</span>
        </div>
        <div className="text-xs font-mono text-right">
          {h.pnl != null && (
            <span className={h.pnl >= 0 ? 'text-bull' : 'text-bear'}>
              {h.pnl >= 0 ? '+' : ''}{formatNT(h.pnl)} ({h.pnlPct?.toFixed(2)}%)
            </span>
          )}
        </div>
      </div>
      <div className="text-[10px] text-muted-foreground mt-0.5 font-mono">
        {h.shares.toLocaleString()} 股 · 進場 {h.entryPrice.toFixed(2)}
        {h.close && <> · 現價 <span className="text-slate-300">{h.close.toFixed(2)}</span></>}
        {h.stopLoss && <> · 停損 {h.stopLoss.toFixed(2)}</>}
        {costShare != null && <> · 資金佔比 {costShare.toFixed(1)}%</>}
      </div>
      <p className="text-xs text-slate-300 mt-1">{h.hint}</p>
    </Link>
  );
}

function ProgressBar({ start, current, target }: { start: number; current: number; target: number }) {
  const pct = Math.max(0, Math.min(100, ((current - start) / (target - start)) * 100));
  return (
    <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
      <div className="h-full bg-gradient-to-r from-sky-500 to-emerald-500" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** 把 /today 整理出 markdown 檔丟下載；明日盤前可印出來看 */
function exportTodayMd(args: {
  today: string;
  trend: Trend | null;
  buyRuns: Run[];
  watchRuns: Run[];
  holdingActions: Array<{ symbol: string; name: string; close: number | null; pnl: number | null; pnlPct: number | null; action: string; hint: string; entryPrice: number; shares: number; stopLoss?: number }>;
  growth: GrowthDisplay | null;
  totalCapital: number | null;
}) {
  const { today, trend, buyRuns, watchRuns, holdingActions, growth, totalCapital } = args;
  const lines: string[] = [];
  lines.push(`# 明日觀察名單 — ${today}`);
  lines.push('');
  lines.push(`> 產出時間：${new Date().toISOString()}`);
  lines.push('');

  // 大盤 + 進度
  lines.push('## 📊 大盤 + 進度');
  if (trend) lines.push(`- **大盤趨勢**：${trend}（${trend === '多頭' ? '可選股做多' : trend === '空頭' ? '禁止做多（戒律 8）' : '可選擇性做多 — 戒律 7 提醒謹慎'}）`);
  if (growth) lines.push(`- **資產進度**：${formatNT(growth.currentCapital)} / 目標 ${formatNT(growth.targetCapital)}`);
  lines.push('');

  // 進場
  lines.push(`## ✅ 今日要進場 (${buyRuns.length})`);
  if (buyRuns.length === 0) {
    lines.push('系統判定 0 檔進場。建議今日不動作或減倉觀望。');
  } else {
    for (const r of buyRuns) {
      const amt = totalCapital && r.decision && r.decision.sizeHint > 0
        ? `（≈ ${formatNT(totalCapital * r.decision.sizeHint / 100)}）`
        : '';
      lines.push(`### ${r.name ?? r.symbol} (${r.symbol})`);
      lines.push(`- **部位**：${r.decision?.sizeHint}% ${amt}`);
      lines.push(`- **多/空**：${r.decision?.bullScore} / ${r.decision?.bearScore}`);
      lines.push(`- **理由**：${r.decision?.overview ?? '—'}`);
      lines.push('');
    }
  }
  lines.push('');

  // 持倉動作
  lines.push(`## 💼 今日持倉動作 (${holdingActions.length})`);
  if (holdingActions.length === 0) {
    lines.push('無 server 持倉（讀 data/agents/portfolio/holdings.json）。');
  } else {
    lines.push('| 名稱 | 代號 | 動作 | 現價 | 損益 | 提示 |');
    lines.push('|---|---|---|---|---|---|');
    for (const h of holdingActions) {
      const actionLabel = h.action === 'stop_loss' ? '🛑 注意停損'
        : h.action === 'take_profit' ? '💰 留意停利'
        : h.action === 'hold' ? '✓ 正常持有'
        : '— 無報價';
      const pnlStr = h.pnl != null ? `${h.pnl >= 0 ? '+' : ''}${formatNT(h.pnl)} (${h.pnlPct?.toFixed(2)}%)` : '—';
      lines.push(`| ${h.name} | ${h.symbol} | ${actionLabel} | ${h.close?.toFixed(2) ?? '—'} | ${pnlStr} | ${h.hint} |`);
    }
  }
  lines.push('');

  // 觀察
  lines.push(`## 👀 觀察名單 (${watchRuns.length})`);
  if (watchRuns.length > 0) {
    lines.push('| 名稱 | 代號 | 部位建議 | 多/空 | 理由摘要 |');
    lines.push('|---|---|---|---|---|');
    for (const r of watchRuns) {
      const sz = r.decision ? `${r.decision.sizeHint}%` : '—';
      const bs = r.decision ? `${r.decision.bullScore}/${r.decision.bearScore}` : '—';
      lines.push(`| ${r.name ?? r.symbol} | ${r.symbol} | ${sz} | ${bs} | ${(r.decision?.overview ?? '—').replace(/\|/g, '/')} |`);
    }
  } else {
    lines.push('無觀察名單。');
  }
  lines.push('');

  lines.push('---');
  lines.push('產出自 [rockstock](http://localhost:3000) `/today` · 不是投資建議');

  const md = lines.join('\n');
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `today-${today}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 朱書交易時點：13:20 看、13:25 掛市價。CST 時間。 */
function computeTradeWindow(now: Date): { label: string; hint: string; tone: CardTone } {
  // 轉 CST
  const cst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const dow = cst.getDay();
  if (dow === 0 || dow === 6) return { label: '週末', hint: '非交易日；可週末複盤', tone: 'muted' };
  const h = cst.getHours(), m = cst.getMinutes();
  const mins = h * 60 + m;
  const watchStart = 13 * 60 + 20;  // 13:20
  const orderTime  = 13 * 60 + 25;  // 13:25
  const close      = 13 * 60 + 30;  // 13:30 收盤
  if (mins < 9 * 60) {
    const d = 9 * 60 - mins;
    return { label: `距開盤 ${Math.floor(d / 60)}h${d % 60}m`, hint: '開盤前；先看大盤 + pool 候選', tone: 'muted' };
  }
  if (mins < watchStart) {
    const d = watchStart - mins;
    return { label: `距 13:20 ${Math.floor(d / 60)}h${d % 60}m`, hint: '盤中觀察期；朱書建議 13:20 才看突破/跌破', tone: 'info' };
  }
  if (mins < orderTime) {
    const d = orderTime - mins;
    return { label: `🔥 13:20 觀察中（${d} 分到 13:25）`, hint: '進場觀察期。看是否真突破/真跌破前日 K 線', tone: 'warn' };
  }
  if (mins < close) {
    return { label: `🚨 13:25 掛單時點！`, hint: '朱書交易時間：掛市價、不要等', tone: 'danger' };
  }
  return { label: '已收盤', hint: '盤後；可看 multi-agent 跑明日候選', tone: 'muted' };
}
