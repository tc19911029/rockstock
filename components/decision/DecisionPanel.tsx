'use client';

/**
 * DecisionPanel — 首頁走圖區下方深度決策摘要
 *
 * 顯示 4 面向 verdict + 進出場 + 投信動向 + 連結到完整決策視圖。
 * 5 分 K / 1 分 K 直接用主走圖 toolbar 切換 timeframe（同一張圖）。
 * 資料來源：/api/agents/decisions/{symbol}?date=
 *
 * §0 隔離：4 verdict 並列展示（不混合加權），由 FinalDecision.verdictsByAgent 直接拿
 */

import { useEffect, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { decisionPathZh } from '@/lib/i18n/decisionPathLabel';
import { replaceAgentTerms } from '@/lib/i18n/agentTermsLabel';
import { computeFacetVerdicts, type FacetVerdictsResult } from '@/lib/decision/computeFacetVerdicts';
import { summarizeFacetVerdicts, type FacetSummary } from '@/lib/decision/summarizeFacetVerdicts';
import { dedupedFetch } from '@/lib/utils/dedupedFetch';
import type {
  AgentRunMeta,
  AgentPhaseState,
  FinalDecision,
  TechnicalAnswer,
  NewsAnswer,
  ChipAnswer,
  FundamentalAnswer,
} from '@/lib/agents/types';

const TrustMomentumPanel = dynamic(
  () => import('@/app/agents/[symbol]/_components/TrustMomentumPanel').then(m => m.TrustMomentumPanel),
  { ssr: false },
);

type Verdict = 'pass' | 'watch' | 'fail';

interface DecisionPayload {
  ok: boolean;
  date: string;
  symbol: string;
  meta: AgentRunMeta | null;
  phase: AgentPhaseState | null;
  technical: TechnicalAnswer | null;
  news: NewsAnswer | null;
  chip: ChipAnswer | null;
  fundamental: FundamentalAnswer | null;
  decision: FinalDecision | null;
  error?: string;
}

const VERDICT_CFG: Record<Verdict, { label: string; cls: string }> = {
  pass:  { label: '通過', cls: 'border-emerald-700/60 bg-emerald-950/40 text-emerald-300' },
  watch: { label: '觀察', cls: 'border-amber-700/60  bg-amber-950/40  text-amber-300' },
  fail:  { label: '不過', cls: 'border-rose-700/60   bg-rose-950/40   text-rose-300' },
};

const ACTION_CFG: Record<FinalDecision['action'], { label: string; cls: string; emoji: string }> = {
  buy:   { label: '進場',  cls: 'border-emerald-500/60 bg-emerald-900/30 text-emerald-100', emoji: '✅' },
  watch: { label: '觀望',  cls: 'border-amber-500/60  bg-amber-900/30  text-amber-100',  emoji: '👀' },
  skip:  { label: '不進場', cls: 'border-rose-500/60   bg-rose-900/30   text-rose-100',   emoji: '⛔' },
};

interface Props {
  symbol: string;          // 帶 suffix：2330.TW
  date?: string;            // YYYY-MM-DD，可選
}

export function DecisionPanel({ symbol, date }: Props) {
  const [data, setData] = useState<DecisionPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(true);
  const [chipExpanded, setChipExpanded] = useState(false);
  const toggleChip = () => setChipExpanded(o => !o);

  useEffect(() => {
    if (!symbol) return;
    // DEMO / 大盤指數不打 API：DEMO 是 store 預設 placeholder（用戶還沒載股）；
    // 大盤指數本來就不會跑多代理。避免每次首頁載入就送一堆 404/400。
    if (symbol === 'DEMO' || /^\^|^000001\.SS$/.test(symbol)) return;
    // /api/agents/decisions/[symbol] 要求 date param（zod 不接受 undefined）
    // 沒帶 date 時用台北今日，避免每次載入跳 400 + console 噪音
    const effectiveDate = date
      ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
    const url = `/api/agents/decisions/${encodeURIComponent(symbol)}?date=${encodeURIComponent(effectiveDate)}`;
    setLoading(true);
    fetch(url)
      .then(r => r.json())
      .then((j: DecisionPayload) => setData(j))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [symbol, date]);

  if (!symbol) return null;

  // 大盤指數不顯示
  if (/^\^|^000001\.SS$/.test(symbol)) return null;

  // 折疊狀態
  const header = (
    <div className="flex items-center justify-between gap-2 px-3 py-2 bg-slate-900/60 border-b border-slate-700/50">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-bold text-cyan-300">🎯 深度決策面板</span>
        <span className="text-slate-400 font-mono text-xs">{symbol}{date ? ` · ${date}` : ''}</span>
        {loading && <span className="text-xs text-slate-500 animate-pulse">載入中…</span>}
      </div>
      <div className="flex items-center gap-2">
        <Link
          href={`/agents/${encodeURIComponent(symbol)}${date ? `?date=${encodeURIComponent(date)}` : ''}`}
          className="text-xs text-cyan-400 hover:text-cyan-300 hover:underline"
        >
          展開完整視圖 →
        </Link>
        <button
          onClick={() => setOpen(o => !o)}
          aria-label={open ? '收起決策面板' : '展開決策面板'}
          className="text-slate-400 hover:text-slate-200 text-xs px-2"
        >
          {open ? '▾' : '▸'}
        </button>
      </div>
    </div>
  );

  if (!open) return <section className="border border-slate-700/50 rounded-lg overflow-hidden">{header}</section>;

  // API 回 ok=false 或無 multi-agent 結果 — 改顯示「📊 規則式推估」4 verdict + 投信動向
  // API 行為：即使 multi-agent 沒跑、API 也回 ok=true 但所有欄位 null。
  //   - data.ok=false → 真的失敗
  //   - data.ok=true 且 4 個 verdict + decision 全 null → multi-agent 未跑（要 fallback）
  // 兩者都走 FallbackFacetVerdicts 顯示規則推估，避免顯示 4 個「⏳ 未跑」空白卡。
  const allVerdictsNull = data && data.ok
    && !data.technical && !data.news && !data.chip && !data.fundamental && !data.decision;
  if ((data && !data.ok) || allVerdictsNull) {
    return (
      <section className="border border-slate-700/50 rounded-lg overflow-hidden">
        {header}
        <div className="p-3 space-y-3 bg-slate-900/40">
          <HoldingBadge symbol={symbol} />
          <FallbackFacetVerdicts
            symbol={symbol}
            date={date}
            chipExpanded={chipExpanded}
            onToggleChip={toggleChip}
          />
          {chipExpanded && <TrustMomentumPanel symbol={symbol} date={date} />}
          <div className="text-[11px] text-slate-500 border border-slate-700/30 rounded p-2 bg-slate-900/30 leading-relaxed">
            💡 以上 4 面向是<strong className="text-amber-300/90"> 規則推估</strong>（六條件 / YouTube 共識 / 籌碼分數 / EPS+營收 YoY）。
            想看完整多空辯論 + 進出場參數，執行 <code className="mx-1 px-1.5 py-0.5 bg-slate-800 rounded text-cyan-300">/multi-agent-decide {symbol}</code>。
          </div>
        </div>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="border border-slate-700/50 rounded-lg overflow-hidden">
        {header}
        <div className="p-3 text-xs text-slate-500">…</div>
      </section>
    );
  }

  return (
    <section className="border border-slate-700/50 rounded-lg overflow-hidden">
      {header}

      <div className="p-3 space-y-3 bg-slate-900/40">

        {/* 持有狀態 badge（若在 portfolio open holdings 內）*/}
        <HoldingBadge symbol={symbol} />

        {/* 4 面向 verdict 卡 — 籌碼可展開看投信動向細項 */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <VerdictMini title="技術" answer={data.technical} />
          <VerdictMini title="消息" answer={data.news} />
          <VerdictMini
            title="籌碼"
            answer={data.chip}
            expandable
            expanded={chipExpanded}
            onToggle={toggleChip}
          />
          <VerdictMini title="基本" answer={data.fundamental} />
        </div>
        {chipExpanded && <TrustMomentumPanel symbol={symbol} date={date} />}

        {/* 最終決策 + 進出場 */}
        {data.decision && (() => {
          const cfg = ACTION_CFG[data.decision.action];
          return (
            <div className={`border rounded p-3 space-y-2 ${cfg.cls}`}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xl">{cfg.emoji}</span>
                <span className="font-bold text-base">最終決策：{cfg.label}</span>
                <span className="text-xs opacity-80" title={`規則代碼：${data.decision.decisionPath}`}>（{decisionPathZh(data.decision.decisionPath)}）</span>
              </div>
              <p className="text-xs opacity-90">{data.decision.overview}</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs border-t border-current/20 pt-2">
                <KV k="多空" v={`多 ${data.decision.bullScore} vs 空 ${data.decision.bearScore}`} />
                {data.decision.entryPrice != null && <KV k="進場" v={String(data.decision.entryPrice)} />}
                {data.decision.stopLoss != null && <KV k="停損" v={String(data.decision.stopLoss)} cls="text-rose-200" />}
                {data.decision.target1 != null && (
                  <KV k="目標" v={`${data.decision.target1}${data.decision.target2 != null ? ` / ${data.decision.target2}` : ''}`} cls="text-emerald-200" />
                )}
              </div>
              {data.decision.conflicts.length > 0 && (
                <div className="border-t border-current/20 pt-2">
                  <div className="text-xs font-semibold mb-1 text-amber-300">⚠️ 4 代理意見衝突</div>
                  <ul className="text-xs list-disc ml-5 space-y-0.5 opacity-90">
                    {data.decision.conflicts.map((c, i) => <li key={i}>{replaceAgentTerms(c)}</li>)}
                  </ul>
                </div>
              )}
            </div>
          );
        })()}

        {/* 提示：未跑完整 4 phase 時 */}
        {!data.decision && (
          <div className="text-xs text-slate-400 border border-slate-700/40 rounded p-2 bg-slate-900/40">
            🔄 多代理流程未跑完。已載入 {[data.technical, data.news, data.chip, data.fundamental].filter(Boolean).length}/4 個 analyst。
            執行 <code className="mx-1 px-1 bg-slate-800 rounded text-cyan-300">/multi-agent-decide {symbol}</code> 完成 phase 2-4。
          </div>
        )}
      </div>
    </section>
  );
}

// ── inline 子元件 ────────────────────────────────────────────────────────────

function VerdictMini({
  title,
  answer,
  expandable,
  expanded,
  onToggle,
}: {
  title: string;
  answer: { verdict: Verdict; overview: string } | null;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const interactiveProps = expandable
    ? {
        role: 'button' as const,
        tabIndex: 0,
        'aria-expanded': !!expanded,
        onClick: onToggle,
        onKeyDown: (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle?.();
          }
        },
      }
    : {};
  const interactiveCls = expandable ? 'cursor-pointer hover:brightness-110 transition' : '';
  const caret = expandable ? (
    <span className="text-[10px] opacity-70" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
  ) : null;

  if (!answer) {
    return (
      <div className={`border border-slate-700/50 rounded p-2 bg-slate-900/30 ${interactiveCls}`} {...interactiveProps}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-slate-500">{title}</span>
          {caret}
        </div>
        <div className="text-xs text-slate-500">⏳ 未跑</div>
      </div>
    );
  }
  const cfg = VERDICT_CFG[answer.verdict];
  return (
    <div className={`border rounded p-2 ${cfg.cls} ${interactiveCls}`} {...interactiveProps}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs opacity-80">{title}</span>
        <span className="flex items-center gap-1">
          <span className="text-xs font-bold">{cfg.label}</span>
          {caret}
        </span>
      </div>
      <div className="text-xs opacity-90 line-clamp-2">{answer.overview}</div>
    </div>
  );
}

// 持有狀態 badge — 查 /api/agents/portfolio?status=open + /api/stock/quote 算 pnl
interface MinimalHolding {
  symbol: string;
  entryDate: string;
  entryPrice: number;
  shares: number;
  stopLoss?: number;
}
type AlertRule = 'blowoff-bearish' | 'blowoff-bullish' | 'terminal-rally' | 'ma5-breakdown'
  | 'stop-loss-breach' | 'pump-reversal' | 'rapid-drop';
const RULE_LABEL: Record<AlertRule, string> = {
  'blowoff-bearish': '爆量長黑',
  'blowoff-bullish': '爆量長紅',
  'terminal-rally':  '末升段',
  'ma5-breakdown':   'MA5 跌破',
  'stop-loss-breach': '跌破停損',
  'pump-reversal':   '拉高回落',
  'rapid-drop':      '急殺',
};
interface MinimalAlert {
  rule: AlertRule;
  firedAt: number;
  tfMin: 1 | 5;
}

function HoldingBadge({ symbol }: { symbol: string }) {
  const [nowMs] = useState(() => Date.now());
  const [holding, setHolding] = useState<MinimalHolding | null>(null);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [latestAlert, setLatestAlert] = useState<MinimalAlert | null>(null);

  useEffect(() => {
    if (!symbol) return;
    // DEMO 不打 chip/quote API（store 預設 placeholder，避免 404 spam）
    if (symbol === 'DEMO' || /^\^|^000001\.SS$/.test(symbol)) return;
    let cancelled = false;
    const raw = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    Promise.all([
      dedupedFetch('/api/agents/portfolio?status=open').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`/api/stock/quote?symbol=${encodeURIComponent(raw)}`).then(r => r.ok ? r.json() : null).catch(() => null),
      // 多 fetch 一次 today alerts、取本檔的最近一條
      dedupedFetch('/api/realtime/alerts/today').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([p, q, a]) => {
      if (cancelled) return;
      const list: MinimalHolding[] = p?.holdings ?? [];
      const h = list.find(it => it.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '') === raw);
      setHolding(h ?? null);
      setCurrentPrice(typeof q?.close === 'number' && q.close > 0 ? q.close : null);
      const bySymbol: Record<string, MinimalAlert> = a?.bySymbol ?? {};
      // a.bySymbol 帶 suffix key（'3661.TW'），直接 lookup
      setLatestAlert(bySymbol[symbol] ?? null);
    });
    return () => { cancelled = true; };
  }, [symbol]);

  if (!holding) return null;

  const pnlPct = currentPrice && holding.entryPrice > 0
    ? ((currentPrice - holding.entryPrice) / holding.entryPrice) * 100
    : null;
  const daysHeld = Math.max(0, Math.floor(
    (nowMs - new Date(holding.entryDate + 'T00:00:00').getTime()) / 86400000,
  ));
  const stopLossDistPct = currentPrice && holding.stopLoss
    ? ((currentPrice - holding.stopLoss) / currentPrice) * 100
    : null;
  const stopLossBreached = stopLossDistPct !== null && stopLossDistPct < 0;

  const pnlCls = pnlPct === null ? 'text-slate-400'
    : pnlPct >= 0 ? 'text-emerald-300' : 'text-rose-300';

  return (
    <div className="border border-emerald-700/50 bg-emerald-950/30 rounded p-2 text-xs">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-emerald-300 font-bold">✅ 已持有</span>
        <span className="text-slate-200 font-mono">
          {holding.shares.toLocaleString()} 股
        </span>
        <span className="text-slate-400">·</span>
        <span className="text-slate-300">
          進場 <span className="font-mono">{holding.entryPrice.toFixed(2)}</span> @ {holding.entryDate}
          <span className="text-slate-500 ml-1">({daysHeld} 天)</span>
        </span>
        <span className="text-slate-400">·</span>
        <span className={`font-bold font-mono ${pnlCls}`}>
          未實現 {pnlPct === null ? '—' : `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`}
        </span>
        {currentPrice !== null && (
          <span className="text-slate-500 text-[10px] font-mono">
            (現價 {currentPrice.toFixed(2)})
          </span>
        )}
      </div>
      {holding.stopLoss !== undefined && (
        <div className="mt-1 flex items-center gap-2 text-[10px]">
          <span className="text-rose-300/80">
            停損 <span className="font-mono">{holding.stopLoss.toFixed(2)}</span>
          </span>
          {stopLossDistPct !== null && (
            <span className={stopLossBreached ? 'text-rose-300 font-bold' : 'text-slate-400'}>
              {stopLossBreached
                ? `⚠ 已跌破停損 ${Math.abs(stopLossDistPct).toFixed(2)}%`
                : `距停損 -${stopLossDistPct.toFixed(2)}%`}
            </span>
          )}
        </div>
      )}
      {latestAlert && (
        <div className="mt-1 flex items-center gap-2 text-[10px]">
          <span
            className="px-1.5 py-0.5 rounded bg-rose-900/40 text-rose-200 font-mono border border-rose-700/50"
            title={`${RULE_LABEL[latestAlert.rule]}（${latestAlert.tfMin} 分K 偵測）— 點主走圖切 5m 看 marker 詳情。\n警示是分時類推、非書本日 K 規則，盤中假突破不算。`}
          >
            ⚠ {formatHhmm(latestAlert.firedAt)} {RULE_LABEL[latestAlert.rule]}
          </span>
          <span className="text-slate-500">本檔最近 5 分K 警示</span>
        </div>
      )}
    </div>
  );
}

function formatHhmm(epochMs: number): string {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return fmt.format(new Date(epochMs));
}

function KV({ k, v, cls }: { k: string; v: string; cls?: string }) {
  return (
    <div>
      <div className="opacity-70 text-[10px]">{k}</div>
      <div className={`font-mono ${cls ?? ''}`}>{v}</div>
    </div>
  );
}

// 規則式 4 verdict fallback — multi-agent 未跑時、從 pool/chip/fund API 推算
function FallbackFacetVerdicts({
  symbol,
  date,
  chipExpanded,
  onToggleChip,
}: {
  symbol: string;
  date?: string;
  chipExpanded: boolean;
  onToggleChip: () => void;
}) {
  const [verdicts, setVerdicts] = useState<FacetVerdictsResult | null>(null);
  const [summary, setSummary] = useState<FacetSummary | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!symbol) return;
    if (symbol === 'DEMO' || /^\^|^000001\.SS$/.test(symbol)) return;
    const raw = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    const market = /\.(SS|SZ)$/i.test(symbol) ? 'CN' : 'TW';
    const isCN = market === 'CN';
    const useDate = date ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
    setLoading(true);
    let cancelled = false;
    // 陸股走 CN 專屬端點（股东户数/龙虎榜、逐季财报），台股走原 TW 端點（避免對陸股打 /api/chip 回 404）
    const chipUrl = isCN ? `/api/cn/chips/${encodeURIComponent(raw)}` : `/api/chip?symbol=${encodeURIComponent(symbol)}`;
    const fundUrl = isCN ? `/api/cn/financials/${encodeURIComponent(raw)}` : `/api/fundamentals/${encodeURIComponent(raw)}`;
    Promise.allSettled([
      dedupedFetch(`/api/agents/pool?market=${market}&date=${useDate}&minSourceCount=1&limit=500`).then(r => r.ok ? r.json() : null).catch(() => null),
      dedupedFetch(chipUrl).then(r => r.ok ? r.json() : null).catch(() => null),
      dedupedFetch(fundUrl).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([poolR, chipR, fundR]) => {
      if (cancelled) return;
      const pool = poolR.status === 'fulfilled' ? poolR.value : null;
      const chip = chipR.status === 'fulfilled' ? chipR.value : null;
      const fund = fundR.status === 'fulfilled' ? fundR.value : null;
      const candidate = pool?.candidates?.find((c: { symbol: string }) =>
        c.symbol === symbol || c.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '') === raw,
      );
      const prohibitionHit = candidate?.sources?.technical?.prohibitionHit;
      // chip / 基本面 依市場解析不同 shape
      let chipScoreFromApi: number | null;
      let epsYoY: number | null | undefined;
      let revenueYoY: number | null | undefined;
      if (isCN) {
        // 陸股籌碼：股东户数集中度（户数减少 ratio<0 = 籌碼集中 = 偏多）+ 龙虎榜净额微调
        const sh = chip?.shareholders?.[0];
        if (sh && typeof sh.holderNumRatio === 'number') {
          let sc = 50 - sh.holderNumRatio * 3;
          const lhb = chip?.dragontiger?.[0];
          if (lhb && typeof lhb.netAmt === 'number') sc += lhb.netAmt > 0 ? 5 : -5;
          chipScoreFromApi = Math.round(Math.max(0, Math.min(100, sc)));
        } else chipScoreFromApi = null;
        // 陸股基本面：最新一季逐季财报 YoY（净利同比≈EPS YoY、营收同比）
        const f0 = fund?.financials?.[0];
        epsYoY = f0?.netProfitYoY ?? null;
        revenueYoY = f0?.revenueYoY ?? null;
      } else {
        // 台股：fundamentals API 回 { ok, data:{...} }；chip API 回 top-level chipScore（0 也算有資料）
        const fundData = fund?.data ?? null;
        chipScoreFromApi = chip?.ok && typeof chip?.chipScore === 'number' ? chip.chipScore : null;
        epsYoY = fundData?.epsYoY ?? candidate?.sources?.fundamental?.epsYoY;
        revenueYoY = fundData?.revenueYoY ?? candidate?.sources?.fundamental?.revenueYoY;
      }
      const input = {
        sixConditionsScore: candidate?.sources?.technical?.sixConditionsScore,
        prohibitionHit,
        youtubeMentionCount: candidate?.strengthSignals?.youtubeMentionCount,
        youtubeInHighConsensus: candidate?.sources?.youtube?.inHighConsensus,
        chipScore: chipScoreFromApi ?? candidate?.strengthSignals?.chipScore ?? null,
        epsYoY,
        revenueYoY,
      };
      const result = computeFacetVerdicts(input);
      setVerdicts(result);
      setSummary(summarizeFacetVerdicts({ ...result, prohibitionHit }));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [symbol, date]);

  if (loading && !verdicts) {
    return (
      <div className="text-xs text-slate-500 animate-pulse text-center py-3">
        📊 規則推估 4 面向 verdict 載入中…
      </div>
    );
  }
  if (!verdicts) return null;

  // 規則推估卡用「半透明 + 虛線」風格、跟 multi-agent 跑過的鮮明卡視覺區隔
  // 籌碼/基本面 副標依市場切換（陸股用股东户数/龙虎榜、营收/净利）
  const isCNStock = /\.(SS|SZ)$/i.test(symbol);
  const cards: Array<{ title: string; subtitle: string; v: keyof Omit<FacetVerdictsResult, 'hints'>; hint: string }> = [
    { title: '技術', subtitle: '含朱書 6 條件', v: 'technical', hint: verdicts.hints.technical },
    { title: '消息', subtitle: '含 YouTube 共識', v: 'news', hint: verdicts.hints.news },
    { title: '籌碼', subtitle: isCNStock ? '股东户数/龙虎榜' : '外資/投信/大戶', v: 'chip', hint: verdicts.hints.chip },
    { title: '基本', subtitle: isCNStock ? '营收/净利/ROE' : 'EPS/營收/PE', v: 'fundamental', hint: verdicts.hints.fundamental },
  ];

  // 整體一句話結論的顏色
  const summaryCls = summary?.level === 'green'
    ? 'border-emerald-700/60 bg-emerald-950/30 text-emerald-200'
    : summary?.level === 'yellow'
    ? 'border-amber-700/60 bg-amber-950/30 text-amber-200'
    : 'border-rose-700/60 bg-rose-950/30 text-rose-200';

  return (
    <div className="space-y-2">
      <div className="text-[11px] text-amber-300/90 font-semibold">
        📊 規則推估 4 面向（多代理未跑、以下用既有資料推算）
      </div>
      {/* 一句話人話結論 */}
      {summary && (
        <div className={`border rounded p-2.5 ${summaryCls}`}>
          <div className="text-xs font-bold leading-relaxed">{summary.conclusion}</div>
          <div className="text-[10px] opacity-70 mt-0.5 font-mono">
            通過 {summary.counts.pass} / 觀察 {summary.counts.watch} / 不過 {summary.counts.fail}
          </div>
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {cards.map(c => {
          const cfg = VERDICT_CFG[verdicts[c.v]];
          const isChip = c.v === 'chip';
          const interactiveProps = isChip
            ? {
                role: 'button' as const,
                tabIndex: 0,
                'aria-expanded': chipExpanded,
                onClick: onToggleChip,
                onKeyDown: (e: KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onToggleChip();
                  }
                },
              }
            : {};
          const interactiveCls = isChip ? 'cursor-pointer hover:brightness-110 transition' : '';
          return (
            <div
              key={c.v}
              className={`border border-dashed rounded p-2 ${cfg.cls} opacity-90 ${interactiveCls}`}
              {...interactiveProps}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs opacity-80">
                  {c.title}
                  <span className="text-[9px] opacity-60 ml-1">{c.subtitle}</span>
                </span>
                <span className="flex items-center gap-1">
                  <span className="text-xs font-bold">{cfg.label}</span>
                  {isChip && (
                    <span className="text-[10px] opacity-70" aria-hidden="true">
                      {chipExpanded ? '▾' : '▸'}
                    </span>
                  )}
                </span>
              </div>
              <div className="text-[11px] opacity-90 leading-snug">{c.hint}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
