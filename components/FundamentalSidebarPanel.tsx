'use client';

/**
 * 基本面側邊面板 — 主頁分析 tab 用
 * 抓 /api/agents/decisions/{symbol}?date={date} 取 fundamental answer
 * 緊湊版（不含估值情境/scenarios — 那留給 /agents/{symbol} 完整頁）
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { FundamentalAnswer } from '@/lib/agents/types';

// 估值情境（悲觀/中性/樂觀）— Tier 1 才有，來自 FundamentalAnswer.valuation
//
// ⚠️ 距現價 / Forward PE / TTM PE 都是「價格衍生」欄位：估值產生當下（valuationDate）用當時
// 股價算好、寫死進 JSON。股價一旦移動，這些就過期（曾發生：2408 估值日 312 元、現價 401.5，
// 卻仍顯示 +38.7% 距現價，實際只剩 +7.8%）。→ 一律用即時價 currentPrice 重算。
// 合理價 / EPS / 合理 PE 是分析師輸出，不隨股價變，照舊顯示。
function ValuationScenarios({
  valuation,
  currentPrice,
  valuationDate,
}: {
  valuation: NonNullable<FundamentalAnswer['valuation']>;
  currentPrice?: number;
  valuationDate?: string;
}) {
  const { ttmPe, monthlyEpsEstimate, scenarios } = valuation;
  const tiers: Array<{ key: 'pessimistic' | 'base' | 'optimistic'; label: string; cls: string }> = [
    { key: 'pessimistic', label: '悲觀', cls: 'text-rose-300 border-rose-700/40 bg-rose-900/20' },
    { key: 'base',        label: '中性', cls: 'text-amber-300 border-amber-700/40 bg-amber-900/20' },
    { key: 'optimistic',  label: '樂觀', cls: 'text-emerald-300 border-emerald-700/40 bg-emerald-900/20' },
  ];

  const live = currentPrice && currentPrice > 0 ? currentPrice : null;
  // 反推估值基準價：upside ≡ (fairPrice − basePrice)/basePrice → basePrice = fairPrice/(1+upside)
  const basePriceAtVal = scenarios.base && scenarios.base.upside > -1
    ? scenarios.base.fairPrice / (1 + scenarios.base.upside)
    : null;
  // 反推 TTM EPS（舊檔沒存）：ttmPe = basePrice / ttmEps → 再用即時價重算 TTM PE
  const ttmEps = basePriceAtVal && ttmPe > 0 ? basePriceAtVal / ttmPe : null;
  const liveTtmPe = live && ttmEps ? live / ttmEps : ttmPe;

  return (
    <details className="border border-border/60 rounded bg-card/40 overflow-hidden" open>
      <summary className="px-2.5 py-1.5 bg-secondary/40 text-[11px] font-semibold text-cyan-300 cursor-pointer hover:text-cyan-200 select-none border-b border-border/40">
        估值情境（預估 EPS / 預估 PE / 合理股價）
      </summary>
      <div className="px-2.5 py-2 space-y-2">
        {/* 月化 EPS 推算（如果有）*/}
        {monthlyEpsEstimate && (
          <div className="rounded border border-border/50 bg-card/60 p-2">
            <div className="text-[10px] text-muted-foreground mb-1">
              {monthlyEpsEstimate.month} 月化 EPS 推算
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] text-foreground/80">月化 EPS</span>
              <span className="font-mono text-sm font-bold text-foreground">
                {monthlyEpsEstimate.estimatedEps.toFixed(2)} 元
              </span>
            </div>
            {monthlyEpsEstimate.note && (
              <div className="text-[10px] text-muted-foreground/70 mt-1 leading-snug">{monthlyEpsEstimate.note}</div>
            )}
          </div>
        )}

        {/* TTM PE 基準（依即時價重算）*/}
        <div className="flex items-baseline justify-between px-1">
          <span className="text-[11px] text-muted-foreground">TTM 本益比（過去 4 季）</span>
          <span className="font-mono text-xs font-semibold text-foreground/90">{liveTtmPe.toFixed(2)} 倍</span>
        </div>

        {/* 估值基準揭露：合理價/EPS 為基準日分析；距現價・Forward PE・TTM PE 已用即時價重算 */}
        {live && basePriceAtVal && (
          <div className="text-[10px] text-muted-foreground/70 px-1 leading-snug">
            合理價/EPS 為{valuationDate ? ` ${valuationDate} ` : ''}估值（基準價 {Math.round(basePriceAtVal)}）；
            距現價・Forward PE・TTM PE 依即時價 {live.toFixed(live > 100 ? 0 : 2)} 重算
          </div>
        )}

        {/* 三情境表 */}
        <div className="space-y-1.5">
          {tiers.map(t => {
            const s = scenarios[t.key];
            // 距現價・Forward PE 一律用即時價重算（無即時價才退回 JSON 寫死值）
            const upPct = live ? ((s.fairPrice - live) / live) * 100 : s.upside * 100;
            const fwdPe = live && s.fullYearEps > 0 ? live / s.fullYearEps : s.forwardPe;
            return (
              <div key={t.key} className={`rounded border px-2 py-1.5 ${t.cls}`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] font-bold">{t.label}</span>
                  {s.confidenceLevel && (
                    <span className="text-[9px] opacity-70 uppercase">{s.confidenceLevel}</span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px]">
                  <div className="flex justify-between">
                    <span className="opacity-70">全年 EPS</span>
                    <span className="font-mono font-semibold">{s.fullYearEps.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="opacity-70">Forward PE</span>
                    <span className="font-mono font-semibold">{fwdPe.toFixed(1)}×</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="opacity-70">合理 PE</span>
                    <span className="font-mono font-semibold">{s.fairPe.toFixed(0)}×</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="opacity-70">合理價</span>
                    <span className="font-mono font-bold">{Math.round(s.fairPrice)}</span>
                  </div>
                </div>
                <div className="flex justify-between items-baseline mt-1 pt-1 border-t border-current/20">
                  <span className="text-[10px] opacity-80">距現價</span>
                  <span className={`font-mono text-xs font-bold ${upPct >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                    {upPct >= 0 ? '+' : ''}{upPct.toFixed(1)}%
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </details>
  );
}

// Tier 2 — 原始財務數字（無 AI 分析時 fallback）
function RawFundamentalsView({ raw, symbol, standaloneValuation, currentPrice }: { raw: RawFundamentals; symbol: string; standaloneValuation: ValuationOnly | null; currentPrice?: number }) {
  const fmt = (v: number | undefined, suffix = '', digits = 2) =>
    v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}${suffix}`;
  const fmtRevenue = (v: number | undefined) => {
    if (v == null) return '—';
    return v >= 1e8 ? `${(v / 1e8).toFixed(2)} 億` : `${(v / 1e4).toFixed(0)} 萬`;
  };
  const yoyColor = (v?: number) =>
    v == null ? 'text-foreground/80' : v >= 0 ? 'text-emerald-400' : 'text-rose-400';

  const quarter = formatQuarter(raw.periods?.financialReportDate);
  const month = formatMonth(raw.periods?.revenueMonth);
  const valuationDate = raw.periods?.valuationDate ?? null;

  // 注意：FinMind getFundamentals 內 epsYoY 實際是「本季 vs 上一季」(QoQ)，不是真正 YoY
  // (FinancialStatements 是季資料、source code 用 prevDate = finDates[1] 上一筆)
  const sections = [
    {
      title: `獲利能力${quarter ? `（${quarter} 財報）` : '（最新季財報）'}`,
      rows: [
        { label: '每股盈餘 EPS', hint: '該季淨利 ÷ 流通股數', value: fmt(raw.eps, ' 元') },
        { label: 'EPS 季增率', hint: '本季 EPS vs 上一季', value: fmt(raw.epsYoY, '%'), cls: yoyColor(raw.epsYoY) },
        { label: '毛利率', hint: '(營收−成本) ÷ 營收', value: fmt(raw.grossMargin, '%') },
        { label: '淨利率', hint: '稅後淨利 ÷ 營收', value: fmt(raw.netMargin, '%') },
      ],
    },
    {
      title: `月營收${month ? `（${month}）` : '（最新公布月）'}`,
      rows: [
        { label: '月營收', hint: '該月度合併營收', value: fmtRevenue(raw.revenueLatest) },
        { label: '月增率 MoM', hint: 'vs 上個月', value: fmt(raw.revenueMoM, '%'), cls: yoyColor(raw.revenueMoM) },
        { label: '年增率 YoY', hint: 'vs 去年同月', value: fmt(raw.revenueYoY, '%'), cls: yoyColor(raw.revenueYoY) },
      ],
    },
    {
      title: `估值${valuationDate ? `（${valuationDate}）` : '（即時市價）'}`,
      rows: [
        { label: '本益比 PER', hint: '股價 ÷ 近 4 季 EPS 加總（TWSE 公告值）', value: fmt(raw.per, ' 倍') },
        { label: '股價淨值比 PBR', hint: '股價 ÷ 每股淨值（總資產−總負債 ÷ 股數）', value: fmt(raw.pbr, ' 倍') },
        { label: '現金殖利率', hint: '近一年現金股利 ÷ 股價', value: fmt(raw.dividendYield, '%') },
      ],
    },
  ];

  return (
    <div className="space-y-2 text-xs">
      {sections.map(sec => (
        <div key={sec.title} className="border border-border/60 rounded bg-card/40 overflow-hidden">
          <div className="px-2.5 py-1.5 bg-secondary/40 text-[11px] font-semibold text-cyan-300 border-b border-border/40">
            {sec.title}
          </div>
          <div className="divide-y divide-border/40">
            {sec.rows.map(r => (
              <div key={r.label} className="px-2.5 py-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[11px] text-foreground/90 font-medium">{r.label}</span>
                  <span className={`font-mono text-xs font-semibold shrink-0 ${r.cls ?? 'text-foreground/90'}`}>{r.value}</span>
                </div>
                <div className="text-[10px] text-muted-foreground/70 mt-0.5 leading-snug">{r.hint}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
      {/* 已有 standalone 估值（valuation skill 寫的）→ 顯示三情境 */}
      {standaloneValuation?.scenarios && standaloneValuation.ttmPe != null && (
        <ValuationScenarios
          valuation={{
            ttmPe: standaloneValuation.ttmPe,
            monthlyEpsEstimate: standaloneValuation.monthlyEpsEstimate,
            scenarios: standaloneValuation.scenarios,
            dilution: null,
            riskFlags: [],
            conclusion: 'fair',
            reasoning: '',
          }}
          currentPrice={currentPrice}
          valuationDate={standaloneValuation.date}
        />
      )}

      {/* 預估股價按鈕 — 觸發 valuation skill */}
      <ValuationButton symbol={symbol} hasResult={!!standaloneValuation?.scenarios} />
    </div>
  );
}

function ValuationButton({ symbol, hasResult }: { symbol: string; hasResult: boolean }) {
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'waiting' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const onClick = async () => {
    if (phase === 'preparing' || phase === 'waiting') return;
    setPhase('preparing');
    setMessage(null);
    try {
      const res = await fetch(`/api/valuation/prepare/${encodeURIComponent(symbol)}`, { method: 'POST' });
      const j = await res.json();
      if (!j.ok) {
        setPhase('error');
        setMessage(j.error ?? '準備失敗');
        return;
      }
      if (j.data.autoTrigger?.ok) {
        setPhase('waiting');
        setMessage('已切到 Claude session 觸發 /valuation。skill 分析中…（通常需 1-2 分鐘）');
        // 開始 poll read endpoint
        startPolling();
      } else {
        setPhase('error');
        setMessage(`自動觸發失敗：${j.data.autoTrigger?.detail ?? '?'}\n請手動在 Claude 對話輸入 ${j.data.skillInvocation}`);
      }
    } catch (e) {
      setPhase('error');
      setMessage((e as Error).message);
    }
  };

  const startPolling = () => {
    const start = Date.now();
    const MAX_MS = 5 * 60 * 1000;  // 5 分鐘 timeout
    const interval = setInterval(async () => {
      if (Date.now() - start > MAX_MS) {
        clearInterval(interval);
        setPhase('error');
        setMessage('等待超時（5 分鐘）。請手動 reload 頁面看是否已有結果。');
        return;
      }
      try {
        const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
        const res = await fetch(`/api/valuation/${encodeURIComponent(symbol)}?date=${today}`);
        const j = await res.json();
        if (j.ok && j.valuation) {
          clearInterval(interval);
          setPhase('idle');
          setMessage('✓ 估值結果已寫入，重新整理頁面查看');
          // 簡單 reload 讓 FundamentalSidebarPanel 重抓 standaloneValuation
          setTimeout(() => window.location.reload(), 800);
        }
      } catch { /* 繼續 poll */ }
    }, 5000);  // 每 5 秒 check 一次
  };

  const busy = phase === 'preparing' || phase === 'waiting';
  const label = phase === 'preparing'
    ? '準備中…'
    : phase === 'waiting'
    ? '朱老師估算中…'
    : hasResult
    ? '重新估算股價'
    : '預估股價';

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-purple-500/40 bg-gradient-to-r from-purple-500/15 to-indigo-500/15 hover:from-purple-500/25 hover:to-indigo-500/25 text-[12px] font-semibold text-purple-100 disabled:opacity-60 transition-all"
      >
        <span>{busy ? '⏳' : '📊'}</span>
        <span>{label} {symbol}</span>
      </button>
      {message && (
        <div className={`text-[10px] leading-snug px-1 whitespace-pre-line ${
          phase === 'error' ? 'text-rose-400' : 'text-emerald-300/90'
        }`}>
          {message}
        </div>
      )}
    </div>
  );
}

const SECTION_LABEL: Record<string, string> = {
  revenue:   '月營收 / YoY',
  profit:    '獲利能力',
  valuation: '估值',
  industry:  '產業',
};

const VERDICT_STYLE: Record<'pass' | 'watch' | 'fail', { bg: string; label: string }> = {
  pass:  { bg: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50', label: '可進場' },
  watch: { bg: 'bg-amber-900/40 text-amber-300 border-amber-700/50',     label: '觀察' },
  fail:  { bg: 'bg-rose-900/40 text-rose-300 border-rose-700/50',         label: '不建議' },
};

interface DecisionPayload {
  ok?: boolean;
  error?: string;
  fundamental?: FundamentalAnswer | null;
}

interface RawFundamentals {
  eps?: number;
  epsYoY?: number;
  grossMargin?: number;
  netMargin?: number;
  per?: number;
  pbr?: number;
  dividendYield?: number;
  revenueLatest?: number;
  revenueMoM?: number;
  revenueYoY?: number;
  periods?: {
    financialReportDate?: string | null;
    revenueMonth?: string | null;
    valuationDate?: string | null;
  };
}

/** "2026-03-31" → "26Q1"；不是季底就回原 YYYY-MM */
function formatQuarter(date: string | null | undefined): string | null {
  if (!date) return null;
  const m = date.match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!m) return null;
  const yy = m[1].slice(-2);
  const month = parseInt(m[2], 10);
  if ([3, 6, 9, 12].includes(month)) {
    const q = Math.ceil(month / 3);
    return `${yy}Q${q}`;
  }
  return `${m[1]}-${m[2]}`;
}

/** "2026-04-01" → "26 年 4 月" */
function formatMonth(date: string | null | undefined): string | null {
  if (!date) return null;
  const m = date.match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  return `${m[1].slice(-2)} 年 ${parseInt(m[2], 10)} 月`;
}

interface Props {
  symbol: string;
  date?: string;
  /** 即時價（= 走圖 header 顯示價）。用來把估值卡的距現價/Forward PE/TTM PE 從估值基準價重算成即時。 */
  currentPrice?: number;
  /** DU2：走圖回放中（步退至歷史日）。true 時加警示，提醒基本面/估值為最新資料、非走圖日。 */
  isHistorical?: boolean;
}

interface ValuationOnly {
  ttmPe?: number;
  date?: string;
  monthlyEpsEstimate?: NonNullable<FundamentalAnswer['valuation']>['monthlyEpsEstimate'];
  scenarios?: NonNullable<FundamentalAnswer['valuation']>['scenarios'];
}

export function FundamentalSidebarPanel({ symbol, date, currentPrice, isHistorical }: Props) {
  const [data, setData] = useState<FundamentalAnswer | null>(null);
  const [rawData, setRawData] = useState<RawFundamentals | null>(null);
  const [standaloneValuation, setStandaloneValuation] = useState<ValuationOnly | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    setRawData(null);
    setStandaloneValuation(null);
    const bareSymbol = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');

    // Tier 1: Multi-Agent 完整分析（API 規定 date 必填，預設今天台北日）
    const effectiveDate = date ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const decisionUrl = `/api/agents/decisions/${encodeURIComponent(bareSymbol)}?date=${effectiveDate}`;
    fetch(decisionUrl)
      .then(r => r.json())
      .then(async (j: DecisionPayload) => {
        if (cancelled) return;
        if (j.error) {
          setError(j.error);
          return;
        }
        if (j.fundamental) {
          setData(j.fundamental);
          return;
        }
        // Tier 2: 標準 fallback — 抓原始財務數字 + standalone 估值（可能存在）
        const [rawRes, valRes] = await Promise.all([
          fetch(`/api/fundamentals/${encodeURIComponent(bareSymbol)}`).catch(() => null),
          fetch(`/api/valuation/${encodeURIComponent(bareSymbol)}?date=${effectiveDate}`).catch(() => null),
        ]);
        if (cancelled) return;
        try {
          const rawJson = rawRes ? await rawRes.json() : null;
          if (rawJson?.ok && rawJson.data) setRawData(rawJson.data as RawFundamentals);
        } catch { /* ignore */ }
        try {
          const valJson = valRes ? await valRes.json() : null;
          if (valJson?.ok && valJson.valuation) setStandaloneValuation(valJson.valuation as ValuationOnly);
        } catch { /* ignore */ }
      })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [symbol, date]);

  if (loading) return <div className="p-3 text-xs text-muted-foreground animate-pulse">載入基本面分析…</div>;
  if (error) return <div className="p-3 text-xs text-rose-400">載入失敗：{error}</div>;

  const cleanSymbolEarly = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');

  // DU2：走圖回放中提醒「基本面/估值為最新資料、不隨走圖回溯」（避免歷史價配當前 PER 被誤讀）。
  // 觸發涵蓋兩種歷史情境：(1) 手動步退回放（isHistorical=currentIndex<last）；
  // (2) asOf 載入舊掃描結果（走圖日 date 早於基本面資料日 → 資料比走圖新）。
  // 比「資料日」而非 today，避免週末/非交易日把最新日誤判成歷史。
  const dataFreshDate = data?.date ?? rawData?.periods?.valuationDate ?? null;
  const showWalkNote = isHistorical || (!!date && !!dataFreshDate && date < dataFreshDate);
  const historicalNote = showWalkNote ? (
    <div className="px-2.5 py-1.5 rounded border border-amber-500/40 bg-amber-500/10 text-[11px] text-amber-700 dark:text-amber-200/90 leading-snug">
      ⚠ 走圖回放中{date ? `（${date}）` : ''}：以下基本面 / 估值為<b>最新資料</b>，非走圖當日（財報與估值不隨走圖回溯）。
    </div>
  ) : null;

  // Tier 2 fallback: 只有原始財務數字，無 AI 深度分析
  if (!data && rawData) {
    return <div className="space-y-2">{historicalNote}<RawFundamentalsView raw={rawData} symbol={cleanSymbolEarly} standaloneValuation={standaloneValuation} currentPrice={currentPrice} /></div>;
  }

  if (!data) {
    return (
      <div className="p-3 text-xs text-muted-foreground space-y-2">
        <div>該檔尚無基本面資料。</div>
        <div className="text-[11px] text-muted-foreground/70">
          資料來源失敗（FinMind/EastMoney）。要看 AI 深度分析請到 <Link href={`/agents/${encodeURIComponent(cleanSymbolEarly)}`} className="text-sky-400 underline">/agents/{cleanSymbolEarly}</Link> 觸發 prepare。
        </div>
      </div>
    );
  }

  const style = VERDICT_STYLE[data.verdict];
  const cleanSymbol = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');

  return (
    <div className="space-y-2 text-xs">
      {historicalNote}
      {/* Verdict + overview */}
      <div className={`px-2.5 py-1.5 rounded border ${style.bg}`}>
        <div className="flex items-center justify-between mb-0.5">
          <span className="font-bold">{style.label}</span>
          <span className="text-[10px] opacity-70 font-mono">{data.date}</span>
        </div>
        <div className="text-[11px] opacity-90 leading-snug">{data.overview}</div>
      </div>

      {/* 估值情境（悲觀 / 中性 / 樂觀預估股價）*/}
      {data.valuation && <ValuationScenarios valuation={data.valuation} currentPrice={currentPrice} valuationDate={data.date} />}

      {/* 4 段論述 (collapsible) */}
      <div className="space-y-1">
        {data.reasoning.map((r, i) => (
          <details
            key={r.section}
            className="border border-border/60 rounded bg-card/40"
            {...(i === 0 ? { open: true } : {})}
          >
            <summary className="px-2 py-1.5 cursor-pointer text-[11px] font-semibold text-cyan-300 hover:text-cyan-200 select-none">
              {SECTION_LABEL[r.section] ?? r.section}
            </summary>
            <div className="px-2 pb-2 pt-1 text-[11px] text-foreground/80 leading-relaxed whitespace-pre-wrap">
              {r.text}
            </div>
          </details>
        ))}
      </div>

      {/* Caveat */}
      {data.caveat && (
        <div className="px-2 py-1.5 rounded border border-amber-700/40 bg-amber-900/15 text-[11px] text-amber-200/90 italic">
          ⚠ {data.caveat}
        </div>
      )}

      {/* dataPoints summary */}
      {data.dataPoints && data.dataPoints.length > 0 && (
        <details className="border border-border/60 rounded bg-card/40">
          <summary className="px-2 py-1.5 cursor-pointer text-[11px] font-semibold text-cyan-300 hover:text-cyan-200 select-none">
            數據點（{data.dataPoints.length} 筆）
          </summary>
          <div className="px-2 pb-2 pt-1 space-y-1">
            {data.dataPoints.slice(0, 15).map((p, i) => (
              <div key={i} className="flex items-baseline justify-between gap-2 text-[10px]">
                <span className="text-muted-foreground/80 shrink-0 truncate" title={p.label}>{p.label}</span>
                <span className="font-mono text-foreground/90 text-right">{p.value}</span>
              </div>
            ))}
            {data.dataPoints.length > 15 && (
              <div className="text-[10px] text-muted-foreground italic pt-0.5">…還有 {data.dataPoints.length - 15} 筆，至完整頁查看</div>
            )}
          </div>
        </details>
      )}

      {/* link to full agent page */}
      <Link
        href={`/agents/${encodeURIComponent(cleanSymbol)}${date ? `?date=${date}` : ''}`}
        className="block text-center text-[11px] text-sky-400 hover:text-sky-300 underline py-1"
      >
        查看完整 Multi-Agent 分析 →
      </Link>
    </div>
  );
}
