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

type BrokerPt = { date: string; netDifference: number };
type InstPt = { date: string } & InstDay;
type TdccPt = { date: string } & TdccDay;
type CandlePt = { date: string; close: number; volume: number };
/** 跟看盤 app 對齊的「正式公式」集中度（HiStock 分點區間彙總算，見 /api/stock/concentration）。
 *  只覆蓋最近數日的 5日(c5)/20日(c20)；其餘日期/週期 fallback 本檔自算近似值。 */
type ConcPt = { date: string; c5: number | null; c20: number | null };

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

const selCls = 'bg-card border border-border/60 rounded text-[10px] text-foreground/90 px-1 py-0.5 outline-none focus:border-primary/60';

function PeriodSelect({ value, onChange, options }: { value: number; onChange: (v: number) => void; options: readonly number[] }) {
  return (
    <select className={selCls} value={value} onChange={e => onChange(Number(e.target.value))}>
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
function BrokerConcTable({ broker, candles, cursorDate, concExact }: { broker: BrokerPt[]; candles: CandlePt[]; cursorDate: string | null; concExact?: ConcPt[] }) {
  const [periodA, setPeriodA] = useState(5);
  const [periodB, setPeriodB] = useState(20);
  const rows = useMemo(() => {
    if (!broker.length || candles.length < 2) return [];
    const byDate = new Map(broker.map(d => [d.date, d.netDifference]));
    // 跟看盤 app 對齊的正式集中度（5日/20日）；其餘日期/週期 fallback 本檔自算
    const exByDate = new Map((concExact ?? []).map(p => [p.date, p]));
    const pick = (i: number, period: number): number | null => {
      // HiStock 有抓到的日期(在 exByDate)＋週期是 5/20 → 用正式公式值（含 null=當天分點未出「結算中」，
      // 不退回舊式近似，免得跟看盤 app 對不上）。更早日期/其他週期 → 本檔自算。
      const ex = exByDate.get(candles[i].date);
      if (ex && period === 5) return ex.c5;
      if (ex && period === 20) return ex.c20;
      return conc(candles, byDate, i, period);
    };
    const start = Math.max(0, candles.length - 120);
    const out: { date: string; brokerNet: number | null; cA: number | null; cB: number | null; price: number }[] = [];
    for (let i = start; i < candles.length; i++) {
      const d = candles[i].date;
      out.push({
        date: d,
        brokerNet: byDate.has(d) ? byDate.get(d)! : null,
        cA: pick(i, periodA),
        cB: pick(i, periodB),
        price: candles[i].close,
      });
    }
    return out.reverse();
  }, [broker, candles, periodA, periodB, concExact]);
  const hiRef = useScrollToHighlight(cursorDate);
  if (!rows.length) return null;
  return (
    <div className="px-2 pt-1 pb-2">
      <div className="px-1 text-[11px] font-semibold text-foreground/80 mb-0.5">主力分點集中度</div>
      <div className="flex items-center justify-center gap-3 mb-1 text-[9px] text-muted-foreground/70">
        <span className="flex items-center gap-1">集中度一 <PeriodSelect value={periodA} onChange={setPeriodA} options={CONC_PERIODS} /></span>
        <span className="flex items-center gap-1">集中度二 <PeriodSelect value={periodB} onChange={setPeriodB} options={CONC_PERIODS} /></span>
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
                  <PeriodSelect value={sumPeriod} onChange={setSumPeriod} options={INST_SUM_PERIODS} />
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
  // 可選週次（升冪，≤ 游標日 — 不偷看未來）
  const weeks = useMemo(() => {
    const sorted = tdcc.slice().sort((a, b) => a.date.localeCompare(b.date));
    return cursorDate ? sorted.filter(r => r.date <= cursorDate) : sorted;
  }, [tdcc, cursorDate]);
  const [picked, setPicked] = useState<string | null>(null);
  if (!weeks.length) return null;
  // 預設選最新一週；picked 若不在可選範圍（游標退到更早）→ 退回最新
  const selIdx = (() => { const i = picked ? weeks.findIndex(w => w.date === picked) : -1; return i >= 0 ? i : weeks.length - 1; })();
  const data = buildDist(weeks[selIdx], weeks[selIdx - 1] ?? null);
  const tabWeeks = weeks.slice(-8); // 最近 8 週可一鍵切換；更早用走圖游標退

  return (
    <div className="px-2 pt-1 pb-2">
      <div className="mb-1 px-1">
        <span className="text-[11px] font-semibold text-foreground/80">集保持股分布</span>
      </div>
      <div className="flex flex-wrap justify-start gap-1 mb-1 px-1">
        {tabWeeks.map(w => {
          const on = w.date === data.date;
          return (
            <button key={w.date} onClick={() => setPicked(w.date)}
              className={`px-1.5 py-0.5 rounded text-[9px] font-mono border transition-colors ${on ? 'bg-primary/20 border-primary/60 text-foreground' : 'bg-card border-border/50 text-muted-foreground/70 hover:border-border'}`}>
              {w.date.slice(5)}
            </button>
          );
        })}
      </div>
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
  /** 跟看盤 app 對齊的正式集中度（HiStock 分點區間彙總，最近數日 5日/20日） */
  concExact?: ConcPt[];
}

export default function ChipRawTables({ broker, inst, tdcc, candles, cursorDate, concExact }: ChipRawTablesProps) {
  return (
    <div>
      <BrokerConcTable broker={broker ?? []} candles={candles} cursorDate={cursorDate} concExact={concExact} />
      <InstTable inst={inst ?? []} cursorDate={cursorDate} />
      <HolderDistTable tdcc={tdcc ?? []} cursorDate={cursorDate} />
    </div>
  );
}
