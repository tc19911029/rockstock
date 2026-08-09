'use client';

/**
 * 基本面側邊面板 — 主頁分析 tab 用
 * 抓 /api/agents/decisions/{symbol}?date={date} 取 fundamental answer
 * 緊湊版：整合原始財報、Multi-Agent 判讀與可重新產生的估值情境。
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Calculator, CheckCircle2, ExternalLink, RefreshCw, Zap } from 'lucide-react';
import type { FundamentalAnswer } from '@/lib/agents/types';
import { mapCnFinancialsToSidebar } from '@/lib/valuation/cnSidebarFallback';
import { detectValuationFreshness } from '@/lib/valuation/freshness';

// 估值情境（悲觀/中性/樂觀）— 可來自 Multi-Agent 或獨立 valuation skill。
//
// ⚠️ 距現價 / 本年度預估 PE / TTM PE 都是「價格衍生」欄位：估值產生當下（valuationDate）用當時
// 股價算好、寫死進 JSON。股價一旦移動，這些就過期（曾發生：2408 估值日 312 元、現價 401.5，
// 卻仍顯示 +38.7% 距現價，實際只剩 +7.8%）。→ 一律用即時價 currentPrice 重算。
// 合理價 / EPS / 合理 PE 是分析師輸出，不隨股價變，照舊顯示。
function ValuationScenarios({
  valuation,
  currentPrice,
  valuationDate,
  ageDays,
  caveat,
  latestFundamentals,
  quality,
}: {
  valuation: NonNullable<FundamentalAnswer['valuation']>;
  currentPrice?: number;
  valuationDate?: string;
  ageDays?: number;
  caveat?: string;
  latestFundamentals?: RawFundamentals | null;
  quality?: ValuationOnly['quality'];
}) {
  const { ttmPe, currentPriceContext, monthlyEpsEstimate: rawMonthlyEpsEstimate, monthlyEpsActuals, scenarios, ntmEstimate, peerComparison, actualEpsYtd, reportedThrough, dilution, riskFlags } = valuation;
  const monthlyEpsEstimate = rawMonthlyEpsEstimate && Number.isFinite(rawMonthlyEpsEstimate.estimatedEps)
    ? rawMonthlyEpsEstimate
    : null;
  const latestSelfReported = monthlyEpsActuals?.[0] ?? latestFundamentals?.selfReportedMonthlyActuals?.[0];
  const modelSuperseded = Boolean(
    monthlyEpsEstimate && latestSelfReported && monthlyEpsEstimate.month === latestSelfReported.period,
  );
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
  const ttmEps = currentPriceContext?.ttmEps
    ?? (basePriceAtVal && ttmPe > 0 ? basePriceAtVal / ttmPe : null);
  const liveTtmPe = live && ttmEps ? live / ttmEps : ttmPe;
  const liveNtmPe = ntmEstimate && ntmEstimate.eps > 0
    ? (live ?? basePriceAtVal ?? ntmEstimate.pe * ntmEstimate.eps) / ntmEstimate.eps
    : null;
  const position = live == null
    ? null
    : live <= scenarios.pessimistic.fairPrice
      ? { label: '低於悲觀合理價', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/25' }
      : live <= scenarios.base.fairPrice
        ? { label: '悲觀～中性區間', cls: 'text-cyan-200 bg-cyan-500/10 border-cyan-500/25' }
        : live <= scenarios.optimistic.fairPrice
          ? { label: '中性～樂觀區間', cls: 'text-amber-200 bg-amber-500/10 border-amber-500/25' }
          : { label: '高於樂觀合理價', cls: 'text-rose-300 bg-rose-500/10 border-rose-500/25' };
  const isStale = ageDays != null && ageDays > 30;
  const freshness = detectValuationFreshness(valuation, valuationDate, latestFundamentals);

  return (
    <details className="overflow-hidden rounded-lg border border-cyan-500/20 bg-gradient-to-b from-cyan-950/20 to-card/50" open>
      <summary className="min-h-11 cursor-pointer select-none border-b border-border/40 bg-secondary/35 px-2.5 py-2 text-[11px] font-semibold text-cyan-200 hover:text-cyan-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
        <span className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5"><Calculator aria-hidden="true" className="size-3.5" />深度估值</span>
          {valuationDate && (
            <span className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${isStale ? 'border-amber-500/35 bg-amber-500/10 text-amber-200' : 'border-foreground/10 bg-background/30 text-muted-foreground'}`}>
              {valuationDate}{ageDays ? ` · ${ageDays} 天前` : ''}
            </span>
          )}
        </span>
      </summary>
      <div className="px-2.5 py-2 space-y-2">
        {position && (
          <div className={`flex items-center justify-between rounded border px-2 py-1.5 ${position.cls}`}>
            <span className="text-[10px] opacity-80">現價位置</span>
            <span className="text-[11px] font-semibold">{position.label}</span>
          </div>
        )}

        {isStale && (
          <div className="flex gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] leading-snug text-amber-200">
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
            估值已超過 30 天，合理價仍可參考，但 EPS 與同業 PE 應重新估算。
          </div>
        )}
        {quality && !quality.valid && (
          <div className="flex gap-1.5 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 text-[10px] leading-snug text-rose-800 dark:text-rose-200">
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
            <span>估值快照未通過算術／來源驗證（{quality.errors.length} 項），合理價暫不應視為有效結論。請重新估算。</span>
          </div>
        )}
        {quality?.valid && quality.warnings.length > 0 && (
          <div className="flex gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] leading-snug text-amber-800 dark:text-amber-200">
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
            <span>估值已通過核心算術驗證，但仍有 {quality.warnings.length} 項資料限制：{quality.warnings.map(item => item.message).join('；')}</span>
          </div>
        )}
        {freshness.hasNewData && latestFundamentals && (
          <div className="rounded border border-rose-500/35 bg-rose-500/10 px-2 py-1.5 text-[10px] leading-snug text-rose-800 dark:text-rose-200">
            <div className="flex gap-1.5 font-semibold">
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
              下方估值尚未納入最新正式資料
            </div>
            <div className="mt-1 space-y-0.5 pl-4 text-foreground/75">
              {freshness.hasNewFinancialReport && (
                <div>
                  {formatQuarter(freshness.financialReportDate) ?? '最新季報'}：
                  單季 EPS {latestFundamentals.eps != null ? `${latestFundamentals.eps.toFixed(2)} 元` : '已公布'}
                  {latestFundamentals.epsYtd != null ? `，本年累計 EPS ${latestFundamentals.epsYtd.toFixed(2)} 元` : ''}
                </div>
              )}
              {freshness.hasNewMonthlyRevenue && (
                <div>
                  {formatMonth(latestFundamentals.periods?.revenueMonth) ?? '最新月'}營收：
                  {latestFundamentals.revenueLatest != null ? formatRevenue(latestFundamentals.revenueLatest) : '已公布'}
                </div>
              )}
              {freshness.hasNewSelfReportedEps && latestFundamentals.selfReportedMonthlyActuals?.[0] && (
                <div>
                  {latestFundamentals.selfReportedMonthlyActuals[0].period} 自結 EPS：
                  {latestFundamentals.selfReportedMonthlyActuals[0].eps.toFixed(2)} 元
                </div>
              )}
              {freshness.hasShareCountChange && (
                <div>流通股數已變更為 {freshness.sharesOutstanding?.toLocaleString()} 股，EPS／合理價需按新股數重算。</div>
              )}
              {freshness.hasNewDilutionEvent && (
                <div>新增或更新稀釋事件（增資／GDR／私募／可轉債），需重算完全稀釋 EPS。</div>
              )}
            </div>
            <div className="mt-1 pl-4">請重新估算；舊情境只保留作歷史快照，不能當作目前合理價。</div>
          </div>
        )}
        {latestSelfReported && (
          <div className="rounded border border-emerald-500/30 bg-emerald-500/10 p-2">
            <div className="mb-1 flex items-center justify-between gap-2 text-[10px] text-emerald-800 dark:text-emerald-200">
              <span>{latestSelfReported.period} 單月自結 EPS</span>
              <span className="rounded border border-emerald-500/25 px-1 py-0.5 text-[8px]">公司公告</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] text-foreground/80">每股盈餘</span>
              <span className="font-mono text-sm font-bold text-foreground">{latestSelfReported.eps.toFixed(2)} 元</span>
            </div>
            {'revenue' in latestSelfReported && latestSelfReported.revenue != null && (
              <div className="mt-1 text-[9px] text-foreground/65">單月營收 {formatRevenue(latestSelfReported.revenue)}</div>
            )}
            <div className="mt-1 flex items-center justify-between gap-2 text-[9px] text-muted-foreground">
              <span>注意股重大訊息之自結數，未經會計師核閱</span>
              {latestSelfReported.sourceUrl && (
                <a href={latestSelfReported.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-6 shrink-0 items-center gap-0.5 text-sky-700 underline-offset-2 hover:underline dark:text-sky-300">
                  公告<ExternalLink aria-hidden="true" className="size-2.5" />
                </a>
              )}
            </div>
          </div>
        )}

        {/* 月化 EPS 推算（同月份已有自結實績時隱藏，避免模型覆蓋真值）*/}
        {monthlyEpsEstimate && !modelSuperseded && (
          <div className="rounded ring-1 ring-foreground/10 bg-card/60 p-2">
            <div className="text-[10px] text-muted-foreground mb-1">
              {monthlyEpsEstimate.month} 月 EPS 模型估計
              {freshness.hasNewData && <span className="ml-1 text-rose-700 dark:text-rose-300">（舊快照）</span>}
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
            <div className="mt-1 text-[9px] leading-snug text-amber-200/75">模型推估，非公司公告的正式 EPS。</div>
          </div>
        )}

        {/* 歷史與前瞻 PE 分開，避免把本年度 EPS 冒充 NTM。 */}
        <div className="grid grid-cols-2 gap-1.5 rounded border border-foreground/10 bg-background/20 p-2">
          <div>
            <div className="text-[9px] text-muted-foreground">TTM PE · 過去四季</div>
            <div className="font-mono text-xs font-semibold text-foreground/90">
              {liveTtmPe > 0 ? `${liveTtmPe.toFixed(2)} 倍` : '不適用（TTM EPS≤0）'}
            </div>
          </div>
          <div>
            <div className="text-[9px] text-muted-foreground">NTM PE · 未來十二月</div>
            <div className="font-mono text-xs font-semibold text-foreground/90">{liveNtmPe != null ? `${liveNtmPe.toFixed(2)} 倍` : '資料不足'}</div>
          </div>
          {actualEpsYtd != null && (
            <div className="col-span-2 flex items-baseline justify-between border-t border-border/40 pt-1.5">
              <span className="text-[9px] text-muted-foreground">已公告累積 EPS{reportedThrough ? `（至 ${reportedThrough}）` : ''}</span>
              <span className="font-mono text-[11px] font-semibold">{actualEpsYtd.toFixed(2)}</span>
            </div>
          )}
        </div>

        <PeerComparisonBlock comparison={peerComparison} />

        {dilution && (
          <div className="rounded border border-amber-500/30 bg-amber-500/10 p-2 text-[10px]">
            <div className="flex items-center justify-between gap-2 font-semibold text-amber-800 dark:text-amber-200">
              <span>股本／稀釋已納入</span>
              <span className="font-mono">{dilution.ratio > 0 ? `${(dilution.ratio * 100).toFixed(1)}%` : '股數待定'}</span>
            </div>
            {dilution.originalShares > 0 && dilution.newShares > 0 && (
              <div className="mt-1 text-foreground/70">{dilution.originalShares.toLocaleString()} → {dilution.newShares.toLocaleString()} 股</div>
            )}
            {dilution.events?.map((event, index) => (
              <div key={`${event.type}-${index}`} className="mt-1 leading-snug text-foreground/70">
                {event.description ?? `${event.type} 新增 ${event.newShares.toLocaleString()} 股`}
              </div>
            ))}
          </div>
        )}

        {riskFlags?.length ? (
          <div className="flex flex-wrap gap-1">
            {riskFlags.map(flag => <span key={flag} className="rounded border border-rose-500/25 bg-rose-500/10 px-1.5 py-0.5 text-[9px] text-rose-700 dark:text-rose-200">{flag}</span>)}
          </div>
        ) : null}

        {/* 估值基準揭露：合理價/EPS 為基準日分析；價格衍生數字依即時價重算 */}
        {live && basePriceAtVal && (
          <div className="text-[10px] text-muted-foreground/70 px-1 leading-snug">
            合理價/EPS 為{valuationDate ? ` ${valuationDate} ` : ''}估值（基準價 {Math.round(basePriceAtVal)}）；
            距現價・本年預估 PE・TTM PE 依即時價 {live.toFixed(live > 100 ? 0 : 2)} 重算
          </div>
        )}

        {/* 三情境表 */}
        <div className="space-y-1.5">
          {tiers.map(t => {
            const s = scenarios[t.key];
            const valuationEps = s.valuationEps ?? s.fullYearEps;
            // 距現價・本年預估 PE 一律用即時價重算（無即時價才退回 JSON 寫死值）
            const upPct = live ? ((s.fairPrice - live) / live) * 100 : s.upside * 100;
            const fwdPe = live && valuationEps > 0 ? live / valuationEps : s.forwardPe;
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
                    <span className="opacity-70">{s.valuationEps != null && s.valuationEps !== s.fullYearEps ? '估值 EPS' : '全年 EPS'}</span>
                    <span className="font-mono font-semibold">{valuationEps.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="opacity-70">本年預估 PE</span>
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
        {caveat && (
          <details className="rounded border border-foreground/10 bg-background/20">
            <summary className="min-h-9 cursor-pointer px-2 py-2 text-[10px] font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
              估值依據與限制
            </summary>
            <div className="border-t border-border/40 px-2 py-1.5 text-[10px] leading-relaxed text-foreground/70">{caveat}</div>
          </details>
        )}
      </div>
    </details>
  );
}

type PeerComparison = NonNullable<NonNullable<FundamentalAnswer['valuation']>['peerComparison']>;

function PeerComparisonBlock({ comparison }: { comparison?: PeerComparison }) {
  if (!comparison) {
    return (
      <div className="flex gap-1.5 rounded border border-amber-500/25 bg-amber-500/10 px-2 py-1.5 text-[10px] leading-snug text-amber-700 dark:text-amber-200/80">
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
        此份估值未保存同業 PE 明細，合理倍數無法逐家核驗；重新估算後補齊。
      </div>
    );
  }

  const included = comparison.peers.filter(peer => !peer.excluded);
  const median = comparison.medianCurrentYearPe ?? comparison.medianTtmPe;

  return (
    <details className="rounded border border-foreground/10 bg-background/20">
      <summary className="min-h-10 cursor-pointer px-2 py-2 text-[10px] font-medium text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
        <span className="flex items-center justify-between gap-2">
          <span>同業 PE 校準 · {included.length} 家有效</span>
          <span className="font-mono text-cyan-700 dark:text-cyan-200">中位 {median != null ? `${median.toFixed(1)}×` : '—'}</span>
        </span>
      </summary>
      <div className="space-y-1.5 border-t border-border/40 px-2 py-2">
        <p className="text-[9px] leading-snug text-muted-foreground">{comparison.selectionBasis}</p>
        {comparison.peers.map(peer => (
          <div key={`${peer.market}-${peer.symbol}`} className={`rounded border px-1.5 py-1 ${peer.excluded ? 'border-foreground/5 opacity-55' : 'border-foreground/10'}`}>
            <div className="flex items-center justify-between gap-1 text-[9px]">
              <span className="min-w-0 truncate font-medium text-foreground/80">{peer.name} {peer.symbol}</span>
              <span className="shrink-0 font-mono text-foreground/70">
                FY {peer.currentYearPe != null ? `${peer.currentYearPe.toFixed(1)}×` : '—'} · TTM {peer.ttmPe != null ? `${peer.ttmPe.toFixed(1)}×` : '—'}
              </span>
            </div>
            <div className="mt-0.5 flex items-center justify-between gap-1 text-[8px] text-muted-foreground">
              <span>{peer.excluded ? `排除：${peer.exclusionReason ?? '不具可比性'}` : peer.asOf}</span>
              {peer.sourceUrl && (
                <a href={peer.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-6 items-center gap-0.5 text-sky-700 underline-offset-2 hover:underline dark:text-sky-300">
                  來源<ExternalLink aria-hidden="true" className="size-2.5" />
                </a>
              )}
            </div>
          </div>
        ))}
        <p className="text-[9px] leading-snug text-foreground/65">{comparison.appliedPeRationale}</p>
      </div>
    </details>
  );
}

// Tier 2 — 原始財務數字（無 AI 分析時 fallback）
function RawFundamentalsView({ raw, symbol, standaloneValuation, currentPrice, onValuationReady }: { raw: RawFundamentals; symbol: string; standaloneValuation: ValuationOnly | null; currentPrice?: number; onValuationReady: (valuation: ValuationOnly) => void }) {
  const fmt = (v: number | null | undefined, suffix = '', digits = 2) =>
    v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}${suffix}`;
  const fmtRevenue = (v: number | null | undefined) => {
    if (v == null) return '—';
    return v >= 1e8 ? `${(v / 1e8).toFixed(2)} 億` : `${(v / 1e4).toFixed(0)} 萬`;
  };
  const yoyColor = (v?: number) =>
    v == null ? 'text-foreground/80' : v >= 0 ? 'text-emerald-400' : 'text-rose-400';

  const quarter = formatQuarter(raw.periods?.financialReportDate);
  const month = formatMonth(raw.periods?.revenueMonth);
  const valuationDate = raw.periods?.valuationDate ?? null;
  const latestSelfReported = raw.selfReportedMonthlyActuals?.[0];

  // 注意：FinMind getFundamentals 內 epsYoY 實際是「本季 vs 上一季」(QoQ)，不是真正 YoY
  // (FinancialStatements 是季資料、source code 用 prevDate = finDates[1] 上一筆)
  const sections = [
    {
      title: `獲利能力${quarter ? `（${quarter} 財報）` : '（最新季財報）'}`,
      rows: [
        { label: '單季 EPS', hint: '該季淨利 ÷ 該季加權平均股數', value: fmt(raw.eps, ' 元') },
        ...(raw.epsYtd != null ? [{ label: '本年累計 EPS', hint: '交易所正式財報累計基本 EPS', value: fmt(raw.epsYtd, ' 元') }] : []),
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
      {latestSelfReported && (
        <div className="overflow-hidden rounded border border-emerald-500/30 bg-emerald-500/10">
          <div className="flex items-center justify-between border-b border-emerald-500/20 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-800 dark:text-emerald-200">
            <span>公司單月自結（{latestSelfReported.period}）</span>
            <a href={latestSelfReported.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-6 items-center gap-0.5 text-[9px] text-sky-700 underline-offset-2 hover:underline dark:text-sky-300">
              公告<ExternalLink aria-hidden="true" className="size-2.5" />
            </a>
          </div>
          <div className="grid grid-cols-2 gap-2 px-2.5 py-2">
            <div>
              <div className="text-[9px] text-muted-foreground">單月 EPS</div>
              <div className="font-mono text-sm font-bold">{latestSelfReported.eps.toFixed(2)} 元</div>
            </div>
            <div>
              <div className="text-[9px] text-muted-foreground">單月營收</div>
              <div className="font-mono text-sm font-bold">{latestSelfReported.revenue != null ? fmtRevenue(latestSelfReported.revenue) : '—'}</div>
            </div>
          </div>
          <div className="px-2.5 pb-1.5 text-[9px] leading-snug text-muted-foreground">自結實績優先於月營收模型；未經會計師查核或核閱。</div>
        </div>
      )}
      {sections.map(sec => (
        <div key={sec.title} className="ring-1 ring-foreground/10 rounded bg-card/40 overflow-hidden">
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
            currentPriceContext: standaloneValuation.currentPriceContext,
            fiscalYear: standaloneValuation.fiscalYear,
            reportedThrough: standaloneValuation.reportedThrough,
            actualEpsYtd: standaloneValuation.actualEpsYtd,
            dataAsOf: standaloneValuation.dataAsOf,
            ntmEstimate: standaloneValuation.ntmEstimate,
            peerComparison: standaloneValuation.peerComparison,
            monthlyEpsEstimate: standaloneValuation.monthlyEpsEstimate,
            monthlyEpsActuals: standaloneValuation.monthlyEpsActuals,
            scenarios: standaloneValuation.scenarios,
            dilution: standaloneValuation.dilution ?? null,
            riskFlags: standaloneValuation.riskFlags ?? [],
            conclusion: 'fair',
            reasoning: '',
          }}
          currentPrice={currentPrice}
          valuationDate={standaloneValuation.date}
          ageDays={standaloneValuation.ageDays}
          caveat={standaloneValuation.valuationCaveat ?? standaloneValuation.reasoning}
          latestFundamentals={raw}
          quality={standaloneValuation.quality}
        />
      )}

      {/* 預估股價按鈕 — 觸發 valuation skill */}
      <ValuationButton
        symbol={symbol}
        currentValuation={standaloneValuation}
        freshness={standaloneValuation ? detectValuationFreshness(standaloneValuation, standaloneValuation.date, raw) : null}
        onValuationReady={onValuationReady}
      />
    </div>
  );
}

function ValuationButton({ symbol, currentValuation, freshness, onValuationReady }: { symbol: string; currentValuation: ValuationOnly | null; freshness: ReturnType<typeof detectValuationFreshness> | null; onValuationReady: (valuation: ValuationOnly) => void }) {
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'waiting' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollTimer.current) clearInterval(pollTimer.current);
    pollTimer.current = null;
  };

  useEffect(() => stopPolling, [symbol]);

  const onClick = async (requestedMode: 'auto' | 'deep' = 'auto') => {
    if (phase === 'preparing' || phase === 'waiting') return;
    const valuationIsRecent = (currentValuation?.ageDays ?? Number.POSITIVE_INFINITY) <= 7;
    const valuationIsValid = currentValuation?.quality?.valid !== false;
    if (requestedMode === 'auto' && currentValuation?.scenarios && freshness && !freshness.hasNewData && valuationIsRecent && valuationIsValid) {
      setPhase('idle');
      setMessage('正式資料未變，已沿用驗證過的深度估值；PE、距合理價與現價位置會隨即時股價自動重算。');
      return;
    }
    setPhase('preparing');
    setMessage(null);
    try {
      const hasCriticalChange = Boolean(
        freshness?.hasNewFinancialReport || freshness?.hasShareCountChange || freshness?.hasNewDilutionEvent,
      );
      const mode = requestedMode === 'deep'
        ? 'deep'
        : currentValuation?.scenarios && freshness?.hasNewData && !hasCriticalChange && valuationIsRecent
          ? 'incremental'
          : 'auto';
      const res = await fetch(`/api/valuation/prepare/${encodeURIComponent(symbol)}?mode=${mode}`, { method: 'POST' });
      const j = await res.json();
      if (!j.ok) {
        setPhase('error');
        setMessage(j.error ?? '準備失敗');
        return;
      }
      const job = j.analysisJob ?? j.autoTrigger;
      if (job?.ok) {
        if (j.updateMode === 'reuse' || job.status === 'completed') {
          setPhase('idle');
          setMessage(j.message ?? job.detail ?? '估值已是最新。');
          return;
        }
        setPhase('waiting');
        setMessage(j.updateMode === 'incremental'
          ? '新資料已確認，正在增量更新情境與 EPS（通常約 1–4 分鐘）…'
          : '資料整理完成，正在執行完整深度估值（通常約 3–10 分鐘）…');
        startPolling(currentValuation?.updatedAt);
      } else {
        setPhase('error');
        setMessage(`估值資料已整理，但 Rockstar 內建分析未啟動：${job?.detail ?? '未知原因'}。請稍後重試。`);
      }
    } catch (e) {
      setPhase('error');
      setMessage((e as Error).message);
    }
  };

  const startPolling = (previousUpdatedAt?: string) => {
    stopPolling();
    const start = Date.now();
    const MAX_MS = 15 * 60 * 1000;  // 深度查核同業與公司行動時可能超過 5 分鐘
    const poll = async () => {
      if (Date.now() - start > MAX_MS) {
        stopPolling();
        setPhase('error');
        setMessage('等待超過 15 分鐘。背景工作可能仍在進行，可稍後按「檢查估值更新」確認。');
        return;
      }
      try {
        const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
        const [valuationRes, statusRes] = await Promise.all([
          fetch(`/api/valuation/${encodeURIComponent(symbol)}?date=${today}&_=${Date.now()}`, { cache: 'no-store' }),
          fetch(`/api/valuation/prepare/${encodeURIComponent(symbol)}?date=${today}&_=${Date.now()}`, { cache: 'no-store' }),
        ]);
        const [j, statusJson] = await Promise.all([valuationRes.json(), statusRes.json()]);
        const isNewResult = j.ok && j.valuation && j.date === today && (!previousUpdatedAt || j.updatedAt !== previousUpdatedAt);
        if (isNewResult) {
          stopPolling();
          setPhase('idle');
          setMessage('估值已更新，下方情境已套用最新結果。');
          onValuationReady({ ...j.valuation, date: j.date, ageDays: j.ageDays, updatedAt: j.updatedAt, quality: j.quality });
          return;
        }
        if (statusJson?.job?.status === 'failed') {
          stopPolling();
          setPhase('error');
          setMessage(`背景估值未通過：${statusJson.job.error ?? '分析程序已停止'}。請重新執行。`);
        } else if (statusJson?.job?.status === 'running') {
          const elapsedMs = Date.now() - Date.parse(statusJson.job.startedAt);
          const elapsedMinutes = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 60_000)) : 0;
          setMessage(statusJson.job.mode === 'incremental'
            ? `增量更新中：正在核對最新公告並重算情境 · 已執行 ${elapsedMinutes} 分鐘`
            : `完整深度分析中：正在查核同業、股數與估值模型 · 已執行 ${elapsedMinutes} 分鐘`);
        }
      } catch { /* 繼續 poll */ }
    };
    pollTimer.current = setInterval(() => { void poll(); }, 5000);  // 每 5 秒 check 一次
    void poll(); // 已完成或已有可用快照時立即套用，不必先空等 5 秒。
  };

  const busy = phase === 'preparing' || phase === 'waiting';
  const hasNewData = freshness?.hasNewData ?? false;
  const isRecent = (currentValuation?.ageDays ?? Number.POSITIVE_INFINITY) <= 7;
  const canReuseImmediately = Boolean(currentValuation?.scenarios && freshness && !hasNewData && isRecent);
  const label = phase === 'preparing'
    ? '準備中…'
    : phase === 'waiting'
    ? '朱老師估算中…'
    : currentValuation?.scenarios
      ? hasNewData
        ? '納入新資料更新估值'
        : canReuseImmediately
          ? '即時更新估值位置'
          : isRecent
            ? '檢查估值更新'
            : '更新同業與深度估值'
      : '建立深度估值';

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => { void onClick('auto'); }}
        disabled={busy}
        className="flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-cyan-500/35 bg-cyan-500/10 px-3 py-2 text-[12px] font-semibold text-cyan-100 transition-colors hover:bg-cyan-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-wait disabled:opacity-60"
      >
        {busy
          ? <RefreshCw aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
          : canReuseImmediately
            ? <Zap aria-hidden="true" className="size-4" />
            : <Calculator aria-hidden="true" className="size-4" />}
        <span>{label} {symbol}</span>
      </button>
      {currentValuation?.scenarios && !busy && (
        <button
          type="button"
          onClick={() => { void onClick('deep'); }}
          className="min-h-8 w-full cursor-pointer rounded px-2 text-[9px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        >
          強制完整深度重算（約 3–10 分鐘）
        </button>
      )}
      {message && (
        <div role={phase === 'error' ? 'alert' : 'status'} aria-live="polite" className={`text-[10px] leading-snug px-1 whitespace-pre-line ${
          phase === 'error' ? 'text-rose-400' : 'text-emerald-300/90'
        }`}>
          <span className="inline-flex gap-1.5">
            {phase === 'error' ? <AlertTriangle aria-hidden="true" className="mt-0.5 size-3 shrink-0" /> : <CheckCircle2 aria-hidden="true" className="mt-0.5 size-3 shrink-0" />}
            {message}
          </span>
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
  market?: 'TW' | 'CN';
  eps?: number;
  epsYtd?: number | null;
  epsYoY?: number;
  grossMargin?: number;
  netMargin?: number;
  per?: number;
  pbr?: number;
  dividendYield?: number;
  revenueLatest?: number;
  revenueMoM?: number;
  revenueYoY?: number;
  selfReportedMonthlyActuals?: Array<{
    period: string;
    revenue: number | null;
    netIncome: number | null;
    eps: number;
    announcedAt: string;
    sourceUrl: string;
    audited: false;
    note: string;
  }>;
  sharesOutstanding?: number | null;
  dilutionSignature?: string | null;
  periods?: {
    financialReportDate?: string | null;
    revenueMonth?: string | null;
    selfReportedPeriod?: string | null;
    valuationDate?: string | null;
  };
}

function formatRevenue(value: number): string {
  return value >= 1e8 ? `${(value / 1e8).toFixed(2)} 億` : `${(value / 1e4).toFixed(0)} 萬`;
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
  /** 即時價（= 走圖 header 顯示價）。用來把估值卡的距現價/本年度預估 PE/TTM PE 從估值基準價重算成即時。 */
  currentPrice?: number;
  /** DU2：走圖回放中（步退至歷史日）。true 時加警示，提醒基本面/估值為最新資料、非走圖日。 */
  isHistorical?: boolean;
}

interface ValuationOnly {
  ttmPe?: number;
  currentPriceContext?: NonNullable<FundamentalAnswer['valuation']>['currentPriceContext'];
  date?: string;
  ageDays?: number;
  updatedAt?: string;
  valuationCaveat?: string;
  reasoning?: string;
  fiscalYear?: number;
  reportedThrough?: string;
  actualEpsYtd?: number;
  dataAsOf?: NonNullable<FundamentalAnswer['valuation']>['dataAsOf'];
  ntmEstimate?: NonNullable<FundamentalAnswer['valuation']>['ntmEstimate'];
  peerComparison?: NonNullable<FundamentalAnswer['valuation']>['peerComparison'];
  monthlyEpsEstimate?: NonNullable<FundamentalAnswer['valuation']>['monthlyEpsEstimate'];
  monthlyEpsActuals?: NonNullable<FundamentalAnswer['valuation']>['monthlyEpsActuals'];
  scenarios?: NonNullable<FundamentalAnswer['valuation']>['scenarios'];
  dilution?: NonNullable<FundamentalAnswer['valuation']>['dilution'];
  riskFlags?: NonNullable<FundamentalAnswer['valuation']>['riskFlags'];
  conclusion?: NonNullable<FundamentalAnswer['valuation']>['conclusion'];
  quality?: {
    valid: boolean;
    errors: Array<{ code: string; message: string; path?: string }>;
    warnings: Array<{ code: string; message: string; path?: string }>;
  };
}

function toAgentValuation(valuation: ValuationOnly | null): NonNullable<FundamentalAnswer['valuation']> | null {
  if (valuation?.ttmPe == null || !valuation.scenarios) return null;
  return {
    ttmPe: valuation.ttmPe,
    currentPriceContext: valuation.currentPriceContext,
    fiscalYear: valuation.fiscalYear,
    reportedThrough: valuation.reportedThrough,
    actualEpsYtd: valuation.actualEpsYtd,
    dataAsOf: valuation.dataAsOf,
    ntmEstimate: valuation.ntmEstimate,
    peerComparison: valuation.peerComparison,
    monthlyEpsEstimate: valuation.monthlyEpsEstimate,
    monthlyEpsActuals: valuation.monthlyEpsActuals,
    scenarios: valuation.scenarios,
    dilution: valuation.dilution ?? null,
    riskFlags: valuation.riskFlags ?? [],
    conclusion: valuation.conclusion ?? 'fair',
    reasoning: valuation.reasoning ?? '',
  };
}

function ageInDays(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const start = Date.parse(`${date}T00:00:00Z`);
  const end = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return Math.max(0, Math.floor((end - start) / 86_400_000));
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
    const isCnSymbol = /\.(SS|SZ)$/i.test(symbol) || /^\d{6}$/.test(bareSymbol);
    if (symbol.startsWith('^')) { setLoading(false); return; }  // 指數無基本面/估值，短路不打 decisions API（否則回「symbol 格式不合法」）

    // 三種資料固定並行載入：完整分析不再阻擋原始財報或獨立估值。
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const effectiveDate = date ?? today;
    const decisionUrl = `/api/agents/decisions/${encodeURIComponent(bareSymbol)}?date=${effectiveDate}`;
    const load = async () => {
      const safeJson = async (request: Promise<Response>) => {
        try {
          const response = await request;
          return await response.json();
        } catch {
          return null;
        }
      };
      const decisionRequest = safeJson(fetch(decisionUrl, { signal: AbortSignal.timeout(8000) }))
        .then(json => {
          const decision = json as DecisionPayload | null;
          if (!cancelled && decision?.fundamental) {
            setData(decision.fundamental);
            setLoading(false);
          }
          return json;
        });
      // 市場別原始財報 fallback：即使尚未跑過 Agent／深度估值，也要先顯示正式財報。
      const rawUrl = isCnSymbol
        ? `/api/cn/financials/${encodeURIComponent(bareSymbol)}`
        : `/api/fundamentals/${encodeURIComponent(bareSymbol)}`;
      const rawRequest = safeJson(fetch(rawUrl, { signal: AbortSignal.timeout(8000), cache: 'no-store' }))
        .then(json => {
          const mapped = isCnSymbol
            ? mapCnFinancialsToSidebar(json)
            : json?.ok && json.data
              ? ({ ...json.data, market: 'TW' } as RawFundamentals)
              : null;
          if (!cancelled && mapped) {
            setRawData(mapped as RawFundamentals);
            setLoading(false);
          }
          return { json, data: mapped };
        });
      const valuationRequest = safeJson(fetch(`/api/valuation/${encodeURIComponent(bareSymbol)}?date=${today}`, { signal: AbortSignal.timeout(8000), cache: 'no-store' }))
        .then(json => {
          if (!cancelled && json?.ok && json.valuation) {
            setStandaloneValuation({
              ...(json.valuation as ValuationOnly),
              date: json.date,
              ageDays: json.ageDays,
              updatedAt: json.updatedAt,
              quality: json.quality,
            });
            setLoading(false);
          }
          return json;
        });
      const [decisionJson, rawResult, valuationJson] = await Promise.all([decisionRequest, rawRequest, valuationRequest]);
      if (cancelled) return;

      const decision = decisionJson as DecisionPayload | null;
      if (!decision?.fundamental && !rawResult?.data && !valuationJson?.valuation) {
        setError(decision?.error ?? rawResult?.json?.error ?? '目前找不到可用的基本面資料');
      }
      setLoading(false);
    };
    void load().catch(err => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : '載入失敗');
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [symbol, date]);

  if (symbol.startsWith('^')) return <div className="p-3 text-xs text-muted-foreground py-6 text-center">指數無基本面 / 估值資料</div>;
  if (loading) return <div className="p-3 text-xs text-muted-foreground animate-pulse">載入基本面分析…</div>;

  const cleanSymbolEarly = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  const standaloneAsAgent = toAgentValuation(standaloneValuation);

  if (error && !data && !rawData && !standaloneValuation) {
    return (
      <div className="space-y-2 p-3 text-xs">
        <div className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-rose-300">資料載入不完整：{error}</div>
        <ValuationButton symbol={cleanSymbolEarly} currentValuation={null} freshness={null} onValuationReady={setStandaloneValuation} />
      </div>
    );
  }

  // 陸股正式財報已由外層 CnFundamentalPanel 顯示；這裡只補深度估值狀態，避免重複整份財報。
  if (!data && rawData?.market === 'CN') {
    return (
      <div className="space-y-2 p-1 text-xs">
        {!standaloneValuation && (
          <div className="rounded border border-cyan-500/25 bg-cyan-500/10 px-2 py-1.5 text-cyan-800 dark:text-cyan-200">
            正式財報已載入；深度估值尚未生成，可直接在 Rockstar 背景執行。
          </div>
        )}
        {standaloneValuation && standaloneAsAgent && (
          <ValuationScenarios
            valuation={standaloneAsAgent}
            currentPrice={currentPrice}
            valuationDate={standaloneValuation.date}
            ageDays={standaloneValuation.ageDays}
            caveat={standaloneValuation.valuationCaveat ?? standaloneValuation.reasoning}
            quality={standaloneValuation.quality}
          />
        )}
        <ValuationButton
          symbol={cleanSymbolEarly}
          currentValuation={standaloneValuation}
          freshness={standaloneValuation ? detectValuationFreshness(standaloneValuation, standaloneValuation.date, rawData) : null}
          onValuationReady={setStandaloneValuation}
        />
      </div>
    );
  }

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
    return <div className="space-y-2">{historicalNote}<RawFundamentalsView raw={rawData} symbol={cleanSymbolEarly} standaloneValuation={standaloneValuation} currentPrice={currentPrice} onValuationReady={setStandaloneValuation} /></div>;
  }

  if (!data) {
    return (
      <div className="p-3 text-xs text-muted-foreground space-y-2">
        <div>該檔尚無完整財報資料，仍可查看或建立估值。</div>
        {standaloneAsAgent && (
          <ValuationScenarios
            valuation={standaloneAsAgent}
            currentPrice={currentPrice}
            valuationDate={standaloneValuation?.date}
            ageDays={standaloneValuation?.ageDays}
            caveat={standaloneValuation?.valuationCaveat ?? standaloneValuation?.reasoning}
            quality={standaloneValuation?.quality}
          />
        )}
        <ValuationButton symbol={cleanSymbolEarly} currentValuation={standaloneValuation} freshness={null} onValuationReady={setStandaloneValuation} />
        <div className="text-[11px] text-muted-foreground/70">
          資料來源失敗（FinMind/EastMoney）。要看 AI 深度分析請到 <Link href={`/agents/${encodeURIComponent(cleanSymbolEarly)}`} className="text-sky-400 underline">/agents/{cleanSymbolEarly}</Link> 觸發 prepare。
        </div>
      </div>
    );
  }

  const style = VERDICT_STYLE[data.verdict];
  const cleanSymbol = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  const useStandaloneValuation = !!standaloneAsAgent && (!data.valuation || (standaloneValuation?.date ?? '') >= data.date);
  const displayedValuation = useStandaloneValuation ? standaloneAsAgent : data.valuation ?? null;
  const displayedValuationDate = useStandaloneValuation ? standaloneValuation?.date : data.date;
  const displayedAgeDays = useStandaloneValuation ? standaloneValuation?.ageDays : ageInDays(data.date);
  const displayedCaveat = useStandaloneValuation
    ? standaloneValuation?.valuationCaveat ?? standaloneValuation?.reasoning
    : data.valuation?.reasoning;
  const displayedFreshness = displayedValuation
    ? detectValuationFreshness(displayedValuation, displayedValuationDate, rawData)
    : null;

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
      {displayedValuation && (
        <ValuationScenarios
          valuation={displayedValuation}
          currentPrice={currentPrice}
          valuationDate={displayedValuationDate}
          ageDays={displayedAgeDays}
          caveat={displayedCaveat}
          latestFundamentals={rawData}
          quality={useStandaloneValuation ? standaloneValuation?.quality : undefined}
        />
      )}
      <ValuationButton
        symbol={cleanSymbol}
        currentValuation={standaloneValuation}
        freshness={displayedFreshness}
        onValuationReady={setStandaloneValuation}
      />

      {/* 4 段論述 (collapsible) */}
      <div className="space-y-1">
        {data.reasoning.map((r, i) => (
          <details
            key={r.section}
            className="ring-1 ring-foreground/10 rounded bg-card/40"
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
        <details className="ring-1 ring-foreground/10 rounded bg-card/40">
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
