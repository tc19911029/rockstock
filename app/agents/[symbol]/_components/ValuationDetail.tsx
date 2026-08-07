'use client';

/**
 * 估值分析詳細（/agents/[symbol] 專用）
 *
 * 6 個區塊：
 *   1. 基本資料卡（股價/TTM EPS/TTM PE/最新季 EPS/月營收/股數/PB/產業模板）
 *   2. TTM PE vs 本年度預估 PE / NTM PE 對比
 *   3. 月營收推估 EPS
 *   4. 三情境季度推估（Q2/Q3/Q4 EPS + 全年 + 合理 PE + 合理股價 + 現價差距）
 *   5. GDR/增資稀釋
 *   6. 風險提示 chip list
 *
 * 資料來源：FundamentalAnswer.valuation（skill 寫）+ FundamentalGroundTruth.valuationInputs（程式預抓）
 */

import type { FundamentalAnswer, FundamentalQuestion, ScenarioOutput } from '@/lib/agents/types';
import { SellHeavinessReference } from '@/components/shared/SellHeavinessReference';
import { classifyMarket } from '@/lib/market/classify';

interface Props {
  answer: FundamentalAnswer | null;
  question?: FundamentalQuestion | null;
}

export function ValuationDetail({ answer, question }: Props) {
  const v = answer?.valuation ?? null;
  const inputs = question?.groundTruth?.valuationInputs ?? null;
  const symbol = answer?.symbol ?? question?.symbol ?? '';
  const latestMonthlyActual = v?.monthlyEpsActuals?.[0] ?? inputs?.selfReportedMonthlyActuals?.[0];

  if (!v && !inputs) return null;

  return (
    <section className="rounded-lg border border-amber-500/30 bg-amber-950/10 p-4 space-y-5">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <h3 className="text-sm font-semibold text-amber-200">估值分析 · TTM / 本年度預估 / NTM PE</h3>
        {v?.conclusion && (
          <span className={
            'px-2 py-0.5 rounded text-xs font-semibold ' +
            (v.conclusion === 'undervalued' ? 'bg-emerald-900/40 text-emerald-300' :
             v.conclusion === 'overvalued' ? 'bg-rose-900/40 text-rose-300' :
             'bg-slate-800 text-slate-300')
          }>
            {v.conclusion === 'undervalued' ? '可能低估' : v.conclusion === 'overvalued' ? '可能高估' : '大致合理'}
          </span>
        )}
      </div>

      {inputs && <BasicInfoCard inputs={inputs} />}
      {v && inputs && <PeComparison v={v} inputs={inputs} />}
      {v?.peerComparison && <PeerComparisonDetail comparison={v.peerComparison} />}
      {latestMonthlyActual && <MonthlyEpsActualBlock actual={latestMonthlyActual} />}
      {/* 月營收推估 EPS 區塊只對台股顯示（陸股無月營收） */}
      {inputs?.market !== 'CN' && v?.monthlyEpsEstimate && v.monthlyEpsEstimate.month !== latestMonthlyActual?.period && <MonthlyEpsBlock m={v.monthlyEpsEstimate} />}
      {v && <ScenarioTable v={v} />}
      {v?.dilution && <DilutionBlock d={v.dilution} />}
      {v?.riskFlags && v.riskFlags.length > 0 && <RiskFlagChips flags={v.riskFlags} />}
      {v?.reasoning && (
        <details open className="border border-amber-700/30 bg-amber-950/20 rounded p-3">
          <summary className="text-xs font-medium text-amber-300 cursor-pointer select-none">分析結論</summary>
          <p className="mt-2 text-sm text-slate-200 whitespace-pre-wrap leading-relaxed">{v.reasoning}</p>
        </details>
      )}
      {!v && inputs && (
        <p className="text-xs text-amber-300/70 italic">
          ※ 估值分析資料已備齊，但尚未跑 multi-agent-decide。對話內輸入 /multi-agent-decide {symbol} 即可生成三情境分析。
        </p>
      )}
      {/* 賣訊輕重速查（出場訊號該不該立刻動作；2 年回測，與首頁三色面板同源）— 元件自帶、隨引用自動出現 */}
      <SellHeavinessReference market={classifyMarket(symbol)} />
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 區塊 1：基本資料卡
// ────────────────────────────────────────────────────────────────────────────

function BasicInfoCard({
  inputs,
}: {
  inputs: NonNullable<FundamentalQuestion['groundTruth']['valuationInputs']>;
}) {
  const q1 = inputs.quarterlyHistory[0];
  const m1 = inputs.monthlyRevenueHistory[0];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
      <Stat label="股價" value={fmtPrice(inputs.currentPrice)} />
      <Stat label="TTM EPS" value={fmt(inputs.ttmEps, 2)} />
      {inputs.proFormaTtmEps != null && inputs.ttmEps != null && Math.abs(inputs.proFormaTtmEps - inputs.ttmEps) >= 0.01 && (
        <Stat
          label="備考 TTM EPS"
          value={fmt(inputs.proFormaTtmEps, 2)}
          sub="TTM 淨利 ÷ 最新股數（非報表 EPS）"
        />
      )}
      <Stat label="TTM PE"
            value={inputs.ttmPe != null ? fmt(inputs.ttmPe, 1) + ' 倍' : 'N/A'}
            hint={inputs.ttmPe && inputs.ttmPe > 50 ? 'high' : undefined} />
      {inputs.proFormaTtmPe != null && inputs.proFormaTtmEps != null && (
        <Stat label="備考 TTM PE" value={fmt(inputs.proFormaTtmPe, 1) + ' 倍'} sub="按最新股數重算" />
      )}
      <Stat label="動態 PE"
            value={inputs.dynamicPe != null ? fmt(inputs.dynamicPe, 1) + ' 倍' : 'N/A'}
            sub="股價/(最新季 EPS×4)" />
      <Stat label="靜態 PE"
            value={inputs.staticPe != null ? fmt(inputs.staticPe, 1) + ' 倍' : 'N/A'}
            sub={inputs.lastYearTotalEps ? `去年 EPS ${fmt(inputs.lastYearTotalEps, 2)}` : undefined} />
      <Stat label="最新季 EPS" value={q1?.eps != null ? fmt(q1.eps, 2) : 'N/A'}
            sub={q1?.quarter} />
      <Stat label="當月營收"
            value={m1 ? fmtBillion(m1.revenue) : 'N/A'}
            sub={m1?.month} />
      <Stat label="月營收 YoY"
            value={m1?.yoy != null ? (m1.yoy * 100).toFixed(1) + '%' : 'N/A'} />
      <Stat label="流通股數"
            value={inputs.sharesOutstanding ? fmtShareCount(inputs.sharesOutstanding) : 'N/A'} />
      <Stat label="每股淨值"
            value={inputs.bookValuePerShare ? fmt(inputs.bookValuePerShare, 2) : 'N/A'} />
      <Stat label="產業模板"
            value={inputs.industryTemplateLabel}
            sub={`合理 PE ${inputs.reasonablePeRange.pessimistic}-${inputs.reasonablePeRange.optimistic} 倍`} />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 區塊 2：TTM PE vs 本年度預估 PE / NTM PE
// ────────────────────────────────────────────────────────────────────────────

function PeComparison({
  v, inputs,
}: {
  v: NonNullable<FundamentalAnswer['valuation']>;
  inputs: NonNullable<FundamentalQuestion['groundTruth']['valuationInputs']>;
}) {
  return (
    <div className="border border-amber-700/30 rounded p-3 bg-amber-950/20">
      <div className="text-xs font-semibold text-amber-300 mb-2">PE 對比</div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead>
            <tr className="text-slate-400 text-[10px] uppercase">
              <th className="px-2 py-1 text-left">指標</th>
              <th className="px-2 py-1 text-right">數值</th>
              <th className="px-2 py-1 text-right">EPS 來源</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            <tr className="border-t border-slate-800">
              <td className="px-2 py-1">TTM PE</td>
              <td className="px-2 py-1 text-right">{fmt(v.ttmPe, 1)} 倍</td>
              <td className="px-2 py-1 text-right text-slate-400">近 4 季 EPS = {fmt(inputs.ttmEps, 2)}</td>
            </tr>
            {inputs.dynamicPe != null && (
              <tr className="border-t border-slate-800">
                <td className="px-2 py-1 text-slate-300">動態 PE</td>
                <td className="px-2 py-1 text-right">{fmt(inputs.dynamicPe, 1)} 倍</td>
                <td className="px-2 py-1 text-right text-slate-400">
                  最新季 EPS × 4 = {fmt((inputs.quarterlyHistory[0]?.eps ?? 0) * 4, 2)}
                </td>
              </tr>
            )}
            {inputs.staticPe != null && (
              <tr className="border-t border-slate-800">
                <td className="px-2 py-1 text-slate-300">靜態 PE</td>
                <td className="px-2 py-1 text-right">{fmt(inputs.staticPe, 1)} 倍</td>
                <td className="px-2 py-1 text-right text-slate-400">去年全年 EPS = {fmt(inputs.lastYearTotalEps, 2)}</td>
              </tr>
            )}
            {v.ntmEstimate && (
              <tr className="border-t border-slate-800">
                <td className="px-2 py-1 text-sky-300">NTM PE</td>
                <td className="px-2 py-1 text-right">{fmt(v.ntmEstimate.pe, 1)} 倍</td>
                <td className="px-2 py-1 text-right text-slate-400">{v.ntmEstimate.period} EPS {fmt(v.ntmEstimate.eps, 2)}</td>
              </tr>
            )}
            <tr className="border-t border-slate-800">
              <td className="px-2 py-1 text-rose-300">悲觀本年度預估 PE</td>
              <td className="px-2 py-1 text-right">{fmt(v.scenarios.pessimistic.forwardPe, 1)} 倍</td>
              <td className="px-2 py-1 text-right text-slate-400">EPS {fmt(v.scenarios.pessimistic.fullYearEps, 2)}</td>
            </tr>
            <tr className="border-t border-slate-800">
              <td className="px-2 py-1 text-amber-300">中性本年度預估 PE</td>
              <td className="px-2 py-1 text-right">{fmt(v.scenarios.base.forwardPe, 1)} 倍</td>
              <td className="px-2 py-1 text-right text-slate-400">EPS {fmt(v.scenarios.base.fullYearEps, 2)}</td>
            </tr>
            <tr className="border-t border-slate-800">
              <td className="px-2 py-1 text-emerald-300">樂觀本年度預估 PE</td>
              <td className="px-2 py-1 text-right">{fmt(v.scenarios.optimistic.forwardPe, 1)} 倍</td>
              <td className="px-2 py-1 text-right text-slate-400">EPS {fmt(v.scenarios.optimistic.fullYearEps, 2)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PeerComparisonDetail({
  comparison,
}: {
  comparison: NonNullable<NonNullable<FundamentalAnswer['valuation']>['peerComparison']>;
}) {
  return (
    <details className="rounded border border-amber-700/30 bg-amber-950/20 p-3">
      <summary className="cursor-pointer select-none text-xs font-semibold text-amber-300">
        同業 PE 校準 · 有效 {comparison.peers.filter(peer => !peer.excluded).length} 家
      </summary>
      <p className="mt-2 text-xs leading-relaxed text-slate-300">{comparison.selectionBasis}</p>
      <div className="mt-2 overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead className="text-[10px] uppercase text-slate-400">
            <tr>
              <th className="px-2 py-1 text-left">同業</th>
              <th className="px-2 py-1 text-right">TTM PE</th>
              <th className="px-2 py-1 text-right">本年度預估 PE</th>
              <th className="px-2 py-1 text-left">狀態／來源日</th>
            </tr>
          </thead>
          <tbody>
            {comparison.peers.map(peer => (
              <tr key={`${peer.market}-${peer.symbol}`} className={`border-t border-slate-800 ${peer.excluded ? 'opacity-50' : ''}`}>
                <td className="px-2 py-1">
                  <a href={peer.sourceUrl} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">
                    {peer.name} {peer.symbol}
                  </a>
                </td>
                <td className="px-2 py-1 text-right font-mono">{fmt(peer.ttmPe, 1)}</td>
                <td className="px-2 py-1 text-right font-mono">{fmt(peer.currentYearPe, 1)}</td>
                <td className="px-2 py-1 text-slate-400">{peer.excluded ? `排除：${peer.exclusionReason ?? '不具可比性'}` : peer.asOf}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-slate-300">{comparison.appliedPeRationale}</p>
    </details>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 區塊 3：月營收推估 EPS
// ────────────────────────────────────────────────────────────────────────────

function MonthlyEpsBlock({ m }: { m: NonNullable<FundamentalAnswer['valuation']>['monthlyEpsEstimate'] }) {
  if (!m) return null;
  return (
    <div className="border border-amber-700/30 rounded p-3 bg-amber-950/20">
      <div className="text-xs font-semibold text-amber-300 mb-2">月營收推估 EPS · {m.month}</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono">
        <Stat label="月營收" value={fmtBillion(m.monthlyRevenue)} />
        <Stat label="採用淨利率" value={(m.netMarginUsed * 100).toFixed(1) + '%'} />
        <Stat label="預估稅後淨利" value={fmtBillion(m.estimatedNetIncome)} />
        <Stat label="預估月 EPS" value={fmt(m.estimatedEps, 2)} />
      </div>
      <p className="mt-2 text-[10px] text-amber-300/70 italic">※ {m.note || '此為用月營收 × 上一季淨利率 / 股數的推估，非公司正式 EPS'}</p>
    </div>
  );
}

function MonthlyEpsActualBlock({
  actual,
}: {
  actual: NonNullable<NonNullable<FundamentalQuestion['groundTruth']['valuationInputs']>['selfReportedMonthlyActuals']>[number]
    | NonNullable<NonNullable<FundamentalAnswer['valuation']>['monthlyEpsActuals']>[number];
}) {
  return (
    <div className="rounded border border-emerald-600/35 bg-emerald-950/20 p-3">
      <div className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold text-emerald-300">
        <span>公司單月自結實績 · {actual.period}</span>
        <a href={actual.sourceUrl} target="_blank" rel="noreferrer" className="text-[10px] text-sky-300 hover:underline">公告來源</a>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs font-mono sm:grid-cols-3">
        <Stat label="單月 EPS" value={`${fmt(actual.eps, 2)} 元`} />
        <Stat label="單月營收" value={actual.revenue != null ? fmtBillion(actual.revenue) : 'N/A'} />
        <Stat label="公告日" value={actual.announcedAt} />
      </div>
      <p className="mt-2 text-[10px] italic text-emerald-300/70">注意股重大訊息之自結數，優先於月營收模型；未經會計師查核或核閱。</p>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 區塊 4：三情境季度推估表
// ────────────────────────────────────────────────────────────────────────────

function ScenarioTable({ v }: { v: NonNullable<FundamentalAnswer['valuation']> }) {
  return (
    <div className="border border-amber-700/30 rounded p-3 bg-amber-950/20 space-y-3">
      <div className="text-xs font-semibold text-amber-300">三情境推估</div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs font-mono">
          <thead>
            <tr className="text-slate-400 text-[10px] uppercase">
              <th className="px-2 py-1 text-left">情境</th>
              <th className="px-2 py-1 text-right">Q2 EPS</th>
              <th className="px-2 py-1 text-right">Q3 EPS</th>
              <th className="px-2 py-1 text-right">Q4 EPS</th>
              <th className="px-2 py-1 text-right">全年 EPS</th>
              <th className="px-2 py-1 text-right">合理 PE</th>
              <th className="px-2 py-1 text-right">合理價</th>
              <th className="px-2 py-1 text-right">現價差距</th>
            </tr>
          </thead>
          <tbody>
            <ScenarioRow label="悲觀" color="text-rose-300" s={v.scenarios.pessimistic} />
            <ScenarioRow label="中性" color="text-amber-300" s={v.scenarios.base} />
            <ScenarioRow label="樂觀" color="text-emerald-300" s={v.scenarios.optimistic} />
          </tbody>
        </table>
      </div>
      {/* 推估依據 expandable — 三情境分別顯示 */}
      <div className="space-y-1.5">
        <ScenarioBasisBlock s={v.scenarios.pessimistic} label="悲觀" />
        <ScenarioBasisBlock s={v.scenarios.base} label="中性" />
        <ScenarioBasisBlock s={v.scenarios.optimistic} label="樂觀" />
      </div>
    </div>
  );
}

function ScenarioRow({ label, color, s }: { label: string; color: string; s: ScenarioOutput }) {
  return (
    <tr className="border-t border-slate-800">
      <td className={`px-2 py-1 font-semibold ${color}`}>
        {label}
        {s.confidenceLevel && <ConfidenceChip level={s.confidenceLevel} />}
      </td>
      <td className="px-2 py-1 text-right">{fmt(s.q2Eps, 1)}</td>
      <td className="px-2 py-1 text-right">{fmt(s.q3Eps, 1)}</td>
      <td className="px-2 py-1 text-right">{fmt(s.q4Eps, 1)}</td>
      <td className="px-2 py-1 text-right font-semibold">{fmt(s.fullYearEps, 1)}</td>
      <td className="px-2 py-1 text-right">{fmt(s.fairPe, 0)}</td>
      <td className="px-2 py-1 text-right">{fmtPrice(s.fairPrice)}</td>
      <td className={`px-2 py-1 text-right font-semibold ${s.upside > 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
        {s.upside > 0 ? '+' : ''}{(s.upside * 100).toFixed(1)}%
      </td>
    </tr>
  );
}

function ConfidenceChip({ level }: { level: 'low' | 'medium' | 'high' }) {
  const styles = {
    low:    'bg-rose-900/40 text-rose-300 border-rose-700/40',
    medium: 'bg-amber-900/40 text-amber-300 border-amber-700/40',
    high:   'bg-emerald-900/40 text-emerald-300 border-emerald-700/40',
  };
  const label = level === 'low' ? '低' : level === 'medium' ? '中' : '高';
  return (
    <span className={`ml-1.5 px-1 py-0 rounded text-[9px] border ${styles[level]}`}>
      信心{label}
    </span>
  );
}

const OPTIMISTIC_FLAG_LABEL: Record<string, string> = {
  q3_revenue_jump_over_50pct_vs_q2: 'Q3 營收 > Q2 × 150%',
  q4_revenue_jump_over_20pct_vs_q3: 'Q4 > Q3 × 120%',
  q2_margin_above_q1_by_3pp: 'Q2 淨利率 > Q1 + 3pp',
  q3_margin_above_q1_by_3pp: 'Q3 淨利率 > Q1 + 3pp',
  q4_margin_above_q1_by_3pp: 'Q4 淨利率 > Q1 + 3pp',
  fullyear_eps_above_consensus_upper_by_15pct: '全年 EPS 超共識上緣 15%',
};

function ScenarioBasisBlock({ s, label }: { s: ScenarioOutput; label: string }) {
  if (!s.revenueBasis && !s.netMarginBasis && !s.validationTriggers && !s.reverseEngineeredFrom) {
    return null;
  }
  return (
    <details className="border border-amber-700/20 rounded p-2 bg-slate-900/30 text-xs">
      <summary className="cursor-pointer text-amber-300/80 hover:text-amber-200 select-none">
        {label}情境推估依據 {s.confidenceLevel && <ConfidenceChip level={s.confidenceLevel} />}
      </summary>
      <div className="mt-2 space-y-2 text-slate-300">
        {s.revenueBasis && (
          <div>
            <div className="text-[10px] text-amber-300/70 uppercase mb-0.5">營收假設依據</div>
            <p className="whitespace-pre-wrap leading-relaxed">{s.revenueBasis}</p>
          </div>
        )}
        {s.netMarginBasis && (
          <div>
            <div className="text-[10px] text-amber-300/70 uppercase mb-0.5">淨利率假設依據</div>
            <p className="whitespace-pre-wrap leading-relaxed">{s.netMarginBasis}</p>
          </div>
        )}
        {s.reverseEngineeredFrom && (
          <div className="border-l-2 border-cyan-700/40 pl-2">
            <div className="text-[10px] text-cyan-300/70 uppercase mb-0.5">反推模式</div>
            <p className="leading-relaxed">
              目標全年 EPS {s.reverseEngineeredFrom.targetFullYearEps} 元 → H2 淨利率 {(s.reverseEngineeredFrom.h2NetMarginUsed * 100).toFixed(0)}% → H2 所需營收 {s.reverseEngineeredFrom.h2RequiredRevenue} 億
            </p>
            {s.reverseEngineeredFrom.note && (
              <p className="text-slate-400 text-[10px] mt-0.5">{s.reverseEngineeredFrom.note}</p>
            )}
          </div>
        )}
        {s.validationTriggers && (
          <div className="border-l-2 border-emerald-700/40 pl-2">
            <div className="text-[10px] text-emerald-300/70 uppercase mb-0.5">後續驗證條件</div>
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-1 font-mono text-[11px] mb-1">
              {s.validationTriggers.may != null && <span>5 月: {s.validationTriggers.may}</span>}
              {s.validationTriggers.june != null && <span>6 月: {s.validationTriggers.june}</span>}
              {s.validationTriggers.july != null && <span>7 月: {s.validationTriggers.july}</span>}
              {s.validationTriggers.aug != null && <span>8 月: {s.validationTriggers.aug}</span>}
              {s.validationTriggers.sept != null && <span>9 月: {s.validationTriggers.sept}</span>}
              {s.validationTriggers.q3MonthlyAvg != null && (
                <span className="col-span-2">Q3 月均: {s.validationTriggers.q3MonthlyAvg}</span>
              )}
              {s.validationTriggers.q4MonthlyAvg != null && (
                <span className="col-span-2">Q4 月均: {s.validationTriggers.q4MonthlyAvg}</span>
              )}
            </div>
            {s.validationTriggers.description && (
              <p className="text-slate-400 text-[10px] leading-relaxed">{s.validationTriggers.description}</p>
            )}
          </div>
        )}
        {s.overlyOptimisticFlags && s.overlyOptimisticFlags.length > 0 && (
          <div className="border-l-2 border-rose-700/40 pl-2">
            <div className="text-[10px] text-rose-300/70 uppercase mb-0.5">過度樂觀偵測</div>
            <div className="flex flex-wrap gap-1">
              {s.overlyOptimisticFlags.map((f) => (
                <span key={f} className="px-1.5 py-0 rounded bg-rose-900/30 text-rose-200 text-[10px] border border-rose-700/40">
                  {OPTIMISTIC_FLAG_LABEL[f] ?? f}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 區塊 5：GDR / 增資稀釋
// ────────────────────────────────────────────────────────────────────────────

function DilutionBlock({ d }: { d: NonNullable<NonNullable<FundamentalAnswer['valuation']>['dilution']> }) {
  return (
    <div className="border border-rose-700/40 rounded p-3 bg-rose-950/15">
      <div className="text-xs font-semibold text-rose-300 mb-2">GDR / 增資稀釋</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono mb-3">
        <Stat label="原股數" value={fmtShareCount(d.originalShares)} />
        <Stat label="新增股數" value={fmtShareCount(d.newShares - d.originalShares)} />
        <Stat label="新股數" value={fmtShareCount(d.newShares)} />
        <Stat label="稀釋比例" value={(d.ratio * 100).toFixed(2) + '%'} hint="high" />
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs font-mono">
          <thead>
            <tr className="text-slate-400 text-[10px] uppercase">
              <th className="px-2 py-1 text-left">情境</th>
              <th className="px-2 py-1 text-right">稀釋後 EPS</th>
              <th className="px-2 py-1 text-right">稀釋後合理價</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-slate-800">
              <td className="px-2 py-1 text-rose-300">悲觀</td>
              <td className="px-2 py-1 text-right">{fmt(d.pessimisticDilutedEps, 1)}</td>
              <td className="px-2 py-1 text-right">{fmtPrice(d.pessimisticDilutedPrice)}</td>
            </tr>
            <tr className="border-t border-slate-800">
              <td className="px-2 py-1 text-amber-300">中性</td>
              <td className="px-2 py-1 text-right">{fmt(d.baseDilutedEps, 1)}</td>
              <td className="px-2 py-1 text-right">{fmtPrice(d.baseDilutedPrice)}</td>
            </tr>
            <tr className="border-t border-slate-800">
              <td className="px-2 py-1 text-emerald-300">樂觀</td>
              <td className="px-2 py-1 text-right">{fmt(d.optimisticDilutedEps, 1)}</td>
              <td className="px-2 py-1 text-right">{fmtPrice(d.optimisticDilutedPrice)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {d.events.length > 0 && (
        <ul className="mt-3 space-y-1 text-[11px] text-slate-300">
          {d.events.map((e, i) => (
            <li key={i} className="border-l-2 border-rose-700 pl-2">
              <span className="text-rose-300 font-semibold">{labelDilutionType(e.type)}</span>
              {' · '}
              <span>{fmtShareCount(e.newShares)} 股</span>
              {e.sourceUrl && (
                <a href={e.sourceUrl} target="_blank" rel="noreferrer" className="ml-2 underline text-amber-300/80">來源</a>
              )}
              {e.description && <div className="text-slate-400 mt-0.5">{e.description}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 區塊 6：風險提示
// ────────────────────────────────────────────────────────────────────────────

const RISK_LABEL: Record<string, string> = {
  one_time_gain: '一次性收益（EPS 失真）',
  pb_overheated: 'PB 過高',
  cyclical_peak: '景氣循環高峰',
  forward_pe_misleading: 'Forward PE 誤導',
  dilution_pending: 'GDR/增資稀釋待定',
  margin_declining_while_revenue_growing: '營收成長但毛利下降',
  monthly_revenue_pending: '月營收尚未公布',
  aggressive_scenario_assumption: '樂觀情境假設激進',
  foreign_currency_sensitive: '匯率敏感',
  customer_concentration: '客戶集中度高',
};

function RiskFlagChips({ flags }: { flags: string[] }) {
  return (
    <div className="border border-amber-700/30 rounded p-3 bg-amber-950/20">
      <div className="text-xs font-semibold text-amber-300 mb-2">風險提示</div>
      <div className="flex flex-wrap gap-1.5">
        {flags.map((f) => (
          <span key={f} className="px-2 py-0.5 rounded bg-amber-900/40 text-amber-200 text-[11px] border border-amber-700/40">
            {RISK_LABEL[f] ?? f}
          </span>
        ))}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────────────

function Stat({ label, value, sub, hint }: { label: string; value: string; sub?: string; hint?: 'high' | 'low' }) {
  return (
    <div className="border border-slate-800 rounded p-2 bg-slate-900/40">
      <div className="text-[10px] text-slate-500 uppercase tracking-wider">{label}</div>
      <div className={
        'text-sm font-mono font-semibold mt-0.5 ' +
        (hint === 'high' ? 'text-rose-300' : hint === 'low' ? 'text-emerald-300' : 'text-slate-100')
      }>
        {value}
      </div>
      {sub && <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function fmt(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return 'N/A';
  return n.toFixed(digits);
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'N/A';
  return n.toFixed(n > 100 ? 0 : 2) + ' 元';
}

function fmtBillion(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'N/A';
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 億';
  if (n >= 1e4) return (n / 1e4).toFixed(2) + ' 萬';
  return n.toString();
}

function fmtShareCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'N/A';
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 億股';
  if (n >= 1e4) return (n / 1e4).toFixed(0) + ' 萬股';
  return n.toString() + ' 股';
}

function labelDilutionType(t: string): string {
  switch (t) {
    case 'gdr': return 'GDR / 海外存託憑證';
    case 'rights_issue': return '現金增資';
    case 'convertible_bond': return '可轉換公司債';
    case 'employee_option': return '員工認股權';
    case 'private_placement': return '私募';
    default: return t;
  }
}
