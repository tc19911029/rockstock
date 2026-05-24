'use client';

/**
 * DecisionPanel — 首頁走圖區下方深度決策摘要
 *
 * 顯示 4 面向 verdict + 進出場 + 5分K mini + 投信動向 + 連結到完整決策視圖。
 * 資料來源：/api/agents/decisions/{symbol}?date=
 *
 * §0 隔離：4 verdict 並列展示（不混合加權），由 FinalDecision.verdictsByAgent 直接拿
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import type {
  AgentRunMeta,
  AgentPhaseState,
  FinalDecision,
  TechnicalAnswer,
  NewsAnswer,
  ChipAnswer,
  FundamentalAnswer,
} from '@/lib/agents/types';
import type { CandleWithIndicators } from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { useBlowoffMarkers } from '@/lib/hooks/useBlowoffMarkers';

const CandleChart = dynamic(() => import('@/components/CandleChart'), { ssr: false });

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

  useEffect(() => {
    if (!symbol) return;
    const url = `/api/agents/decisions/${encodeURIComponent(symbol)}${date ? `?date=${encodeURIComponent(date)}` : ''}`;
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

  // API 回 ok=false 或無 multi-agent 結果 — 5 分K + 投信動向仍顯示（不依賴 multi-agent）
  if (data && !data.ok) {
    return (
      <section className="border border-slate-700/50 rounded-lg overflow-hidden">
        {header}
        <div className="p-3 space-y-3 bg-slate-900/40">
          <HoldingBadge symbol={symbol} />
          <div className="text-xs text-slate-400 border border-slate-700/40 rounded p-2 bg-slate-900/40">
            ⏳ 尚未跑 multi-agent 4 phase 決策（缺 verdict / 進出場 / 多空辯論）。
            執行 <code className="mx-1 px-1.5 py-0.5 bg-slate-800 rounded text-cyan-300">/multi-agent-decide {symbol}</code> 取得完整建議。
          </div>
          <MiniFiveMinChart symbol={symbol} />
          <TrustMomentumPanel symbol={symbol} date={date} />
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

        {/* 4 面向 verdict 卡 */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <VerdictMini title="技術" answer={data.technical} />
          <VerdictMini title="消息" answer={data.news} />
          <VerdictMini title="籌碼" answer={data.chip} />
          <VerdictMini title="基本" answer={data.fundamental} />
        </div>

        {/* 最終決策 + 進出場 */}
        {data.decision && (() => {
          const cfg = ACTION_CFG[data.decision.action];
          return (
            <div className={`border rounded p-3 space-y-2 ${cfg.cls}`}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xl">{cfg.emoji}</span>
                <span className="font-bold text-base">最終決策：{cfg.label}</span>
                <span className="text-xs opacity-80">（{data.decision.decisionPath}）</span>
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
                    {data.decision.conflicts.map((c, i) => <li key={i}>{c}</li>)}
                  </ul>
                </div>
              )}
            </div>
          );
        })()}

        {/* 5 分 K mini chart — 看主力動向 + 爆量警示，獨立於主走圖 timeframe */}
        <MiniFiveMinChart symbol={symbol} />

        {/* 投信動向（reuse 已存在元件） */}
        <TrustMomentumPanel symbol={symbol} date={date} />

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

function VerdictMini({ title, answer }: { title: string; answer: { verdict: Verdict; overview: string } | null }) {
  if (!answer) {
    return (
      <div className="border border-slate-700/50 rounded p-2 bg-slate-900/30">
        <div className="text-xs text-slate-500 mb-1">{title}</div>
        <div className="text-xs text-slate-500">⏳ 未跑</div>
      </div>
    );
  }
  const cfg = VERDICT_CFG[answer.verdict];
  return (
    <div className={`border rounded p-2 ${cfg.cls}`}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs opacity-80">{title}</span>
        <span className="text-xs font-bold">{cfg.label}</span>
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
function HoldingBadge({ symbol }: { symbol: string }) {
  const [holding, setHolding] = useState<MinimalHolding | null>(null);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);

  useEffect(() => {
    if (!symbol) return;
    let cancelled = false;
    const raw = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    Promise.all([
      fetch('/api/agents/portfolio?status=open').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`/api/stock/quote?symbol=${encodeURIComponent(raw)}`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([p, q]) => {
      if (cancelled) return;
      const list: MinimalHolding[] = p?.holdings ?? [];
      // symbol 比對：portfolio 帶 .TW，比對時兩邊都 strip suffix 才不漏
      const h = list.find(it => it.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '') === raw);
      setHolding(h ?? null);
      setCurrentPrice(typeof q?.close === 'number' && q.close > 0 ? q.close : null);
    });
    return () => { cancelled = true; };
  }, [symbol]);

  if (!holding) return null;

  const pnlPct = currentPrice && holding.entryPrice > 0
    ? ((currentPrice - holding.entryPrice) / holding.entryPrice) * 100
    : null;
  const daysHeld = Math.max(0, Math.floor(
    (Date.now() - new Date(holding.entryDate + 'T00:00:00').getTime()) / 86400000,
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
    </div>
  );
}

function KV({ k, v, cls }: { k: string; v: string; cls?: string }) {
  return (
    <div>
      <div className="opacity-70 text-[10px]">{k}</div>
      <div className={`font-mono ${cls ?? ''}`}>{v}</div>
    </div>
  );
}

// 5 分 K mini chart — 獨立 fetch、獨立 timeframe、永遠顯示最近 60 根 + blowoff markers
function MiniFiveMinChart({ symbol }: { symbol: string }) {
  const [bars, setBars] = useState<CandleWithIndicators[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!symbol) return;
    const raw = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    setLoading(true);
    setError(null);
    fetch(`/api/stock?symbol=${encodeURIComponent(raw)}&interval=5m&period=60d`)
      .then(r => r.json())
      .then(j => {
        if (!j.candles?.length) {
          setError('無 5 分K 資料（指數或新上市）');
          setBars([]);
          return;
        }
        const enriched = computeIndicators(j.candles);
        // 只取最後 60 根（4-5 小時範圍，盤中即時最有意義）
        setBars(enriched.slice(-60));
      })
      .catch(() => setError('5 分K 載入失敗'))
      .finally(() => setLoading(false));
  }, [symbol]);

  // 用既有 hook 算 blowoff markers（不需 mock holding，盤中看出貨警示）
  const markers = useBlowoffMarkers(bars, symbol, '5m', false);

  if (error) {
    return (
      <div className="border border-slate-700/40 rounded p-2 bg-slate-900/30 text-xs text-slate-500">
        5 分 K：{error}
      </div>
    );
  }
  if (loading && bars.length === 0) {
    return (
      <div className="border border-slate-700/40 rounded p-2 bg-slate-900/30 text-xs text-slate-500 animate-pulse">
        5 分 K 載入中…
      </div>
    );
  }
  if (bars.length === 0) return null;

  const last = bars[bars.length - 1];
  const blowoffCount = markers.length;

  return (
    <div className="border border-slate-700/40 rounded bg-slate-900/30 overflow-hidden">
      <div className="flex items-center justify-between px-2 py-1 bg-slate-900/60 border-b border-slate-700/50">
        <div className="text-xs font-bold text-cyan-300">
          📊 5 分 K（最近 60 根）
        </div>
        <div className="text-xs text-slate-400 font-mono">
          {last.date} · {last.close.toFixed(2)}
          {blowoffCount > 0 && (
            <span className="ml-2 text-rose-300" title="hover K 棒上的標記看詳情">
              ⚠ {blowoffCount} 個爆量警示
            </span>
          )}
        </div>
      </div>
      <CandleChart
        candles={bars}
        signals={[]}
        chartMarkers={markers}
        height={140}
        maToggles={{ ma5: true, ma10: true, ma20: false, ma60: false, ma240: false }}
        showBollinger={false}
        showTrendlines={false}
        showPivots={false}
        showSupportResistance={false}
      />
      {/* caveat — blowoffDetector signals 帶 caveat:'minute-inference' */}
      <div className="px-2 py-1 text-[10px] italic text-amber-400/80 bg-amber-950/20 border-t border-slate-700/40">
        ⚠ 分鐘 K 爆量警示是「日 K 規則的分時類推」、未經回測，
        書本原文（爆量長黑/末升段）皆為日 K。盤中假突破不算，
        要看收盤前 5-10 分鐘確認。
      </div>
    </div>
  );
}
