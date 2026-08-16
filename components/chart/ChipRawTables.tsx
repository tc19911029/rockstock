'use client';

/**
 * 走圖籌碼三表（CMoney 風格，純顯示，三軌 W/X/Y 共用）：
 *   1. 主力分點集中度（逐日）— 兩個可選週期下拉（集中度一/集中度二）
 *   2. 三大法人（逐日）— 外資/投信/自營商/合計 + 頂部 N日合計列
 *   3. 集保持股分布（≤ 游標當週）— 全 15 級距 人數+比例+週增減（缺 brackets 退大戶聚合）
 *
 * 台股紅漲綠跌：買超(正)紅、賣超(負)綠。不加 `+` 前綴（靠顏色+負號，照 CMoney）。
 * 不動選股邏輯，資料全部 client-side 從既有 chips 時序算。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { InstDay, TdccDay } from '@/lib/chips/types';
import { DatePicker } from '@/components/ui/DatePicker';

type BrokerPt = { date: string; netDifference: number };
type InstPt = { date: string } & InstDay;
type TdccPt = { date: string } & TdccDay;
type CandlePt = { date: string; close: number; volume: number };
/** 跟看盤 app 對齊的「正式公式」集中度（FinMind 全分點區間彙總算，見 /api/stock/concentration）。
 *  只覆蓋最近數日的 5日(c5)/20日(c20)；其餘日期/週期 fallback 本檔自算近似值。 */
type ConcPt = { date: string; c5: number | null; c20: number | null; net?: number | null };

const CONC_PERIODS = [1, 5, 10, 20, 60] as const;
const INST_SUM_PERIODS = [5, 10, 20, 60] as const;

/** TDCC 持股分級 1-15 → 張數標籤（1 張 = 1000 股，固定級距定義） */
const TDCC_LABELS: Record<number, string> = {
  1: '1張以下', 2: '1~5張', 3: '5~10張', 4: '10~15張', 5: '15~20張',
  6: '20~30張', 7: '30~40張', 8: '40~50張', 9: '50~100張', 10: '100~200張',
  11: '200~400張', 12: '400~600張', 13: '600~800張', 14: '800~1000張', 15: '1000張以上',
};

const upDownCls = (v: number | null | undefined) =>
  v == null ? 'text-muted-foreground/40' : v > 0 ? 'text-red-400' : v < 0 ? 'text-green-400' : 'text-muted-foreground';
/** 不加 + 前綴，僅千分位 + 負號（CMoney 風格） */
const intStr = (v: number | null | undefined) =>
  v == null ? '—' : Math.round(v).toLocaleString();
const pct2 = (v: number | null | undefined) =>
  v == null ? '—' : `${v.toFixed(2)}%`;

/** 區間集中度 = Σ主力分點淨買賣超 ÷ Σ成交量(官方一般交易量) × 100%（視窗結束於 candles[endIdx]） */
function conc(candles: CandlePt[], brokerByDate: Map<string, number>, endIdx: number, w: number): number | null {
  let net = 0, vol = 0;
  for (let k = endIdx - w + 1; k <= endIdx; k++) {
    if (k < 0) return null;
    const d = candles[k].date;
    if (!brokerByDate.has(d)) return null;
    net += brokerByDate.get(d)!;
    vol += candles[k].volume || 0;
  }
  return vol > 0 ? (net / vol) * 100 : null;
}

const selCls = 'min-h-8 bg-card border border-border/60 rounded text-[10px] text-foreground/90 px-1.5 py-1 outline-none focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/50';

function PeriodSelect({ value, onChange, options, ariaLabel }: { value: number; onChange: (v: number) => void; options: readonly number[]; ariaLabel: string }) {
  return (
    <select aria-label={ariaLabel} className={selCls} value={value} onChange={e => onChange(Number(e.target.value))}>
      {options.map(o => <option key={o} value={o}>{o}日</option>)}
    </select>
  );
}

/** 游標當天那列捲到可視範圍 */
function useScrollToHighlight(highlightDate: string | null | undefined) {
  const ref = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => { ref.current?.scrollIntoView({ block: 'nearest' }); }, [highlightDate]);
  return ref;
}

// table-fixed = 欄寬平均、不撐破面板（免左右滑動）；全部置中對齊（欄頭與數值同線）。
const wrapCls = 'max-h-60 overflow-y-auto rounded-md border border-border/40';
const tblCls = 'w-full text-[10px] font-mono border-collapse table-fixed';
const theadCls = 'sticky top-0 z-10 bg-card/95 backdrop-blur text-muted-foreground/70';
const thCls = () => 'px-0.5 py-1 font-medium whitespace-nowrap text-center overflow-hidden text-ellipsis';
const tdCls = (cls?: string) => `px-0.5 py-1 whitespace-nowrap text-center overflow-hidden text-ellipsis ${cls ?? 'text-foreground/85'}`;

// ── 1. 主力分點集中度（逐日）──────────────────────────────────────────────
function BrokerConcTable({ broker, candles, cursorDate, concExact, concentrationStatus = 'idle', concentrationError, onRetryConcentration }: {
  broker: BrokerPt[];
  candles: CandlePt[];
  cursorDate: string | null;
  concExact?: ConcPt[];
  concentrationStatus?: 'idle' | 'loading' | 'ready' | 'partial' | 'unavailable' | 'error';
  concentrationError?: string;
  onRetryConcentration?: () => void;
}) {
  const [periodA, setPeriodA] = useState(5);
  const [periodB, setPeriodB] = useState(20);
  const rows = useMemo(() => {
    // 買賣超可來自 FinMind 集中度同源（concExact.net），所以 broker 檔空也能渲染
    if (candles.length < 2 || (!broker.length && !(concExact?.length))) return [];
    const byDate = new Map(broker.map(d => [d.date, d.netDifference]));
    // 跟看盤 app 對齊的正式集中度（5日/20日）；其餘日期/週期 fallback 本檔自算
    const exByDate = new Map((concExact ?? []).map(p => [p.date, p]));
    const pick = (i: number, period: number): number | null => {
      // 正式值非空才採用；正式來源當天缺值時退回已儲存的近似值，
      // 並由上方狀態列明確揭露 partial/unavailable，避免空值被誤標成「正式完成」。
      const ex = exByDate.get(candles[i].date);
      if (ex && period === 5 && ex.c5 != null) return ex.c5;
      if (ex && period === 20 && ex.c20 != null) return ex.c20;
      return conc(candles, byDate, i, period);
    };
    const start = Math.max(0, candles.length - 120);
    const out: { date: string; brokerNet: number | null; cA: number | null; cB: number | null; price: number }[] = [];
    for (let i = start; i < candles.length; i++) {
      const d = candles[i].date;
      // 買賣超：優先用 FinMind 分點同源值（含當天、補回 Yahoo cron 漏掉的近日）；缺才退回 broker 檔
      const exNet = exByDate.get(d)?.net;
      out.push({
        date: d,
        brokerNet: exNet != null ? exNet : (byDate.has(d) ? byDate.get(d)! : null),
        cA: pick(i, periodA),
        cB: pick(i, periodB),
        price: candles[i].close,
      });
    }
    return out.reverse();
  }, [broker, candles, periodA, periodB, concExact]);
  const hiRef = useScrollToHighlight(cursorDate);
  if (!rows.length) {
    return concentrationStatus === 'loading'
      ? <div role="status" className="mx-2 my-2 rounded border border-border/50 bg-secondary/30 px-3 py-2 text-[10px] text-muted-foreground">正式集中度計算中，完成後會自動顯示。</div>
      : null;
  }
  return (
    <div className="px-2 pt-1 pb-2">
      <div className="px-1 text-[11px] font-semibold text-foreground/80 mb-0.5">主力分點集中度</div>
      {concentrationStatus === 'loading' && (
        <div role="status" className="mb-1 rounded border border-sky-500/20 bg-sky-500/10 px-2 py-1.5 text-[9px] leading-snug text-sky-200">
          正式 5／20 日分點集中度計算中；完成前先顯示可用的近似值。
        </div>
      )}
      {concentrationStatus === 'ready' && (
        <div className="mb-1 px-1 text-[9px] text-emerald-300/80">最近日期的 5／20 日欄位已採正式分點公式。</div>
      )}
      {concentrationStatus === 'partial' && (
        <div role="status" className="mb-1 rounded border border-amber-500/25 bg-amber-500/10 px-2 py-1.5 text-[9px] leading-snug text-amber-200">
          {concentrationError ?? '正式集中度僅部分日期可用；缺少的日期先顯示已儲存近似值。'}
        </div>
      )}
      {(concentrationStatus === 'unavailable' || concentrationStatus === 'error') && (
        <div role="alert" className="mb-1 flex items-center justify-between gap-2 rounded border border-amber-500/25 bg-amber-500/10 px-2 py-1.5 text-[9px] leading-snug text-amber-200">
          <span>{concentrationError ?? '正式集中度暫時無法載入，表格先用近似值。'}</span>
          {onRetryConcentration && <button type="button" onClick={onRetryConcentration} className="min-h-8 shrink-0 cursor-pointer rounded border border-amber-400/40 px-2 font-medium transition-colors hover:bg-amber-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/70">重試</button>}
        </div>
      )}
      <div className="flex items-center justify-center gap-3 mb-1 text-[9px] text-muted-foreground/70">
        <span className="flex items-center gap-1">集中度一 <PeriodSelect ariaLabel="集中度一計算週期" value={periodA} onChange={setPeriodA} options={CONC_PERIODS} /></span>
        <span className="flex items-center gap-1">集中度二 <PeriodSelect ariaLabel="集中度二計算週期" value={periodB} onChange={setPeriodB} options={CONC_PERIODS} /></span>
      </div>
      <div className={wrapCls}>
        <table className={tblCls}>
          <colgroup>
            <col style={{ width: '16%' }} /><col style={{ width: '19%' }} /><col style={{ width: '22%' }} /><col style={{ width: '21%' }} /><col style={{ width: '22%' }} />
          </colgroup>
          <thead className={theadCls}>
            <tr>
              <th className={thCls()}>日期</th>
              <th className={thCls()}>買賣超</th>
              <th className={thCls()}>集中度一</th>
              <th className={thCls()}>集中度二</th>
              <th className={thCls()}>股價</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const hi = cursorDate != null && r.date === cursorDate;
              return (
                <tr key={r.date} ref={hi ? hiRef : undefined} className={`border-t border-border/20 ${hi ? 'bg-primary/15' : ''}`}>
                  <td className={tdCls('text-muted-foreground/80')}>{r.date.slice(5)}</td>
                  <td className={tdCls(upDownCls(r.brokerNet))}>{intStr(r.brokerNet)}</td>
                  <td className={tdCls(upDownCls(r.cA))}>{pct2(r.cA)}</td>
                  <td className={tdCls(upDownCls(r.cB))}>{pct2(r.cB)}</td>
                  <td className={tdCls()}>{r.price.toFixed(2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── 2. 三大法人（逐日）+ 頂部 N日合計 ────────────────────────────────────
function InstTable({ inst, cursorDate }: { inst: InstPt[]; cursorDate: string | null }) {
  const [sumPeriod, setSumPeriod] = useState(5);
  const { rows, sum } = useMemo(() => {
    if (!inst.length) return { rows: [] as InstPt[], sum: null as null | { foreign: number; trust: number; dealer: number; total: number } };
    const sorted = inst.slice().sort((a, b) => a.date.localeCompare(b.date));
    const rows = sorted.slice(-120).reverse();
    const last = sorted.slice(-sumPeriod);
    const sum = last.length
      ? last.reduce((a, d) => ({ foreign: a.foreign + d.foreign, trust: a.trust + d.trust, dealer: a.dealer + d.dealer, total: a.total + d.total }),
        { foreign: 0, trust: 0, dealer: 0, total: 0 })
      : null;
    return { rows, sum };
  }, [inst, sumPeriod]);
  const hiRef = useScrollToHighlight(cursorDate);
  if (!rows.length) return null;
  return (
    <div className="px-2 pt-1 pb-2">
      <div className="mb-1 px-1">
        <span className="text-[11px] font-semibold text-foreground/80">三大法人</span>
      </div>
      <div className={wrapCls}>
        <table className={tblCls}>
          <colgroup>
            <col style={{ width: '20%' }} /><col style={{ width: '20%' }} /><col style={{ width: '20%' }} /><col style={{ width: '20%' }} /><col style={{ width: '20%' }} />
          </colgroup>
          <thead className={theadCls}>
            <tr>
              <th className={thCls()}>日期</th>
              <th className={thCls()}><span className="text-sky-400">●</span> 外資</th>
              <th className={thCls()}><span className="text-rose-400">●</span> 投信</th>
              <th className={thCls()}><span className="text-purple-400">●</span> 自營商</th>
              <th className={thCls()}>合計</th>
            </tr>
          </thead>
          <tbody>
            {sum && (
              <tr className="border-t border-border/20 bg-secondary/40 font-semibold">
                <td className={tdCls('text-foreground/70')}>
                  <PeriodSelect ariaLabel="三大法人合計週期" value={sumPeriod} onChange={setSumPeriod} options={INST_SUM_PERIODS} />
                </td>
                <td className={tdCls(upDownCls(sum.foreign))}>{intStr(sum.foreign)}</td>
                <td className={tdCls(upDownCls(sum.trust))}>{intStr(sum.trust)}</td>
                <td className={tdCls(upDownCls(sum.dealer))}>{intStr(sum.dealer)}</td>
                <td className={tdCls(upDownCls(sum.total))}>{intStr(sum.total)}</td>
              </tr>
            )}
            {rows.map(r => {
              const hi = cursorDate != null && r.date === cursorDate;
              return (
                <tr key={r.date} ref={hi ? hiRef : undefined} className={`border-t border-border/20 ${hi ? 'bg-primary/15' : ''}`}>
                  <td className={tdCls('text-muted-foreground/80')}>{r.date.slice(5)}</td>
                  <td className={tdCls(upDownCls(r.foreign))}>{intStr(r.foreign)}</td>
                  <td className={tdCls(upDownCls(r.trust))}>{intStr(r.trust)}</td>
                  <td className={tdCls(upDownCls(r.dealer))}>{intStr(r.dealer)}</td>
                  <td className={tdCls(upDownCls(r.total))}>{intStr(r.total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── 3. 集保持股分布（可切換週次）────────────────────────────────────────
type DistRow = { label: string; holders: number | null; pct: number | null; pctChg: number | null; holdersChg: number | null };

/** 把「某週 vs 前一週」組成分布表資料（全級距，缺 brackets 退大戶聚合） */
function buildDist(last: TdccPt, prev: TdccPt | null) {
  if (last.brackets?.length) {
    const prevByLevel = new Map((prev?.brackets ?? []).map(b => [b.level, b]));
    const rows: DistRow[] = last.brackets.slice().sort((a, b) => b.level - a.level).map(b => {
      const pv = prevByLevel.get(b.level);
      return {
        label: TDCC_LABELS[b.level] ?? `級${b.level}`,
        holders: b.holders, pct: b.pct,
        pctChg: pv ? +(b.pct - pv.pct).toFixed(2) : null,
        holdersChg: pv ? b.holders - pv.holders : null,
      };
    });
    return {
      date: last.date, rows, full: true,
      totalHolders: last.holderCount ?? null,
      totalHoldersChg: last.holderCount != null && prev?.holderCount != null ? last.holderCount - prev.holderCount : null,
    };
  }
  // fallback：只有大戶聚合比例（歷史尚未回補 brackets）
  const aggDef: { label: string; key: keyof TdccDay; derive?: (d: TdccDay) => number | null }[] = [
    { label: '1000張以上', key: 'holder1000Pct' },
    { label: '800~1000張', key: 'holder800To1000Pct' },
    { label: '600~800張', key: 'holder600To800Pct' },
    { label: '400~600張', key: 'holder400To600Pct' },
    { label: '200~400張', key: 'holder200Pct', derive: d => d.holder200Pct != null && d.holder400Pct != null ? +(d.holder200Pct - d.holder400Pct).toFixed(2) : null },
    { label: '100~200張', key: 'holder100Pct', derive: d => d.holder100Pct != null && d.holder200Pct != null ? +(d.holder100Pct - d.holder200Pct).toFixed(2) : null },
  ];
  const val = (d: TdccDay, def: typeof aggDef[number]): number | null =>
    def.derive ? def.derive(d) : (typeof d[def.key] === 'number' ? d[def.key] as number : null);
  const rows: DistRow[] = aggDef.map(def => {
    const cur = val(last, def);
    const pv = prev ? val(prev, def) : null;
    return { label: def.label, holders: null, pct: cur, pctChg: cur != null && pv != null ? +(cur - pv).toFixed(2) : null, holdersChg: null };
  });
  return {
    date: last.date, rows, full: false,
    totalHolders: last.holderCount ?? null,
    totalHoldersChg: last.holderCount != null && prev?.holderCount != null ? last.holderCount - prev.holderCount : null,
  };
}

function HolderDistTable({ tdcc, cursorDate }: { tdcc: TdccPt[]; cursorDate: string | null }) {
  // 計算仍維持升冪，方便取得前一週；日期導覽交給 DatePicker 統一顯示為最新在前。
  // ≤ 游標日，避免走圖回看時偷看未來資料。
  const weeks = useMemo(() => {
    const sorted = tdcc.slice().sort((a, b) => a.date.localeCompare(b.date));
    return cursorDate ? sorted.filter(r => r.date <= cursorDate) : sorted;
  }, [tdcc, cursorDate]);
  // 選取週次綁定目前 tdcc 資料陣列；切換股票後自動回到該股最新一週，
  // 不把上一檔股票手動選過的舊週次帶過來。
  const [selection, setSelection] = useState<{ source: TdccPt[]; date: string } | null>(null);
  const picked = selection?.source === tdcc ? selection.date : null;
  if (!weeks.length) return null;
  // 預設選最新一週；picked 若不在可選範圍（游標退到更早）→ 退回最新
  const selIdx = (() => { const i = picked ? weeks.findIndex(w => w.date === picked) : -1; return i >= 0 ? i : weeks.length - 1; })();
  const data = buildDist(weeks[selIdx], weeks[selIdx - 1] ?? null);
  const tabWeekDates = weeks.slice(-8).map(w => w.date); // DatePicker 會統一排成新 → 舊

  return (
    <div className="px-2 pt-1 pb-2">
      <div className="mb-1 flex items-center justify-between gap-2 px-1">
        <span className="text-[11px] font-semibold text-foreground/80">集保持股分布</span>
        <span className="shrink-0 font-mono text-[9px] text-muted-foreground/60">目前 {data.date} · 日期新→舊</span>
      </div>
      <DatePicker
        value={data.date}
        onChange={(date) => setSelection({ source: tdcc, date })}
        dates={tabWeekDates}
        size="sm"
        limit={8}
        ariaLabel="集保持股分布週次"
        className="mb-1 px-1"
      />
      <div className={wrapCls}>
        <table className={tblCls}>
          <colgroup>
            <col style={{ width: '28%' }} /><col style={{ width: '28%' }} /><col style={{ width: '20%' }} /><col style={{ width: '24%' }} />
          </colgroup>
          <thead className={theadCls}>
            <tr>
              <th className={thCls()}>持股分級</th>
              <th className={thCls()}>持股人數</th>
              <th className={thCls()}>持股比例</th>
              <th className={thCls()}>週增減</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map(r => (
              <tr key={r.label} className="border-t border-border/20">
                <td className={tdCls('text-muted-foreground/80')}>{r.label}</td>
                <td className={tdCls()}>{r.holders == null ? '—' : r.holders.toLocaleString()}</td>
                <td className={tdCls('text-foreground/85')}>{pct2(r.pct)}</td>
                <td className={tdCls(upDownCls(r.pctChg))}>{r.pctChg == null ? '—' : `${r.pctChg > 0 ? '+' : ''}${r.pctChg.toFixed(2)}%`}</td>
              </tr>
            ))}
          </tbody>
          {data.totalHolders != null && (
            <tfoot className="sticky bottom-0 bg-card/95 backdrop-blur">
              <tr className="border-t border-border/40 font-semibold">
                <td className={tdCls('text-foreground/70')}>總人數</td>
                <td className={tdCls('text-foreground/85')}>{data.totalHolders.toLocaleString()}</td>
                <td className={tdCls()}>—</td>
                <td className={tdCls(upDownCls(data.totalHoldersChg))}>
                  {data.totalHoldersChg == null ? '—' : `${data.totalHoldersChg > 0 ? '+' : ''}${data.totalHoldersChg.toLocaleString()}`}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

// ── 三表合一 ─────────────────────────────────────────────────────────────
export interface ChipRawTablesProps {
  broker?: BrokerPt[];
  inst?: InstPt[];
  tdcc?: TdccPt[];
  candles: CandlePt[];
  cursorDate: string | null;
  /** 跟看盤 app 對齊的正式集中度（FinMind 全分點區間彙總，最近數日 5日/20日） */
  concExact?: ConcPt[];
  concentrationStatus?: 'idle' | 'loading' | 'ready' | 'partial' | 'unavailable' | 'error';
  concentrationError?: string;
  onRetryConcentration?: () => void;
}

export default function ChipRawTables({ broker, inst, tdcc, candles, cursorDate, concExact, concentrationStatus, concentrationError, onRetryConcentration }: ChipRawTablesProps) {
  return (
    <div>
      <BrokerConcTable
        broker={broker ?? []}
        candles={candles}
        cursorDate={cursorDate}
        concExact={concExact}
        concentrationStatus={concentrationStatus}
        concentrationError={concentrationError}
        onRetryConcentration={onRetryConcentration}
      />
      <InstTable inst={inst ?? []} cursorDate={cursorDate} />
      <HolderDistTable tdcc={tdcc ?? []} cursorDate={cursorDate} />
    </div>
  );
}
