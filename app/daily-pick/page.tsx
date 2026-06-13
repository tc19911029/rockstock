'use client';

/**
 * /daily-pick — 每日選股漏斗頁面（2026-06-13 改版：統一對齊表格）
 *
 * 最上面「今日 top3 可執行清單」（依漲幅、帶進場/停損/持有/事後結果），
 * 下面分三層候選（低乖離/時機中性/末升段）。全部共用同一套欄位、同一條對齊線，
 * 每區只印一次前瞻報酬欄頭（隔日開/1~10日/20日/最高/最低），不再每檔重複標籤。
 * 資料 = /api/daily-pick（lib/dailyPick/buildDailyPick 單一事實）。
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Fwd {
  openReturn?: number | null; d1Return?: number | null; d2Return?: number | null;
  d3Return?: number | null; d4Return?: number | null; d5Return?: number | null;
  d6Return?: number | null; d7Return?: number | null; d8Return?: number | null;
  d9Return?: number | null; d10Return?: number | null; d20Return?: number | null;
  maxGain?: number | null; maxLoss?: number | null;
}
interface Row {
  code: string; name: string; industry: string; changePct: number;
  level: string | null; comboLabel: string; comboRank: number;
  sixCore: boolean; sixTotal: number; theme: string | null;
  entryState: 'can_enter' | 'watch' | 'no_chase'; entryReason: string;
  deviationMa20: number | null; price: number; fwd: Fwd | null;
}
interface Outcome {
  entryOpen: number; exitClose: number; ret: number; holdDays: number;
  exitReason: 'stop' | 'time' | 'holding'; maxGain: number; maxLoss: number;
}
interface Focus extends Row { stop: number; stopPct: number; outcome: Outcome | null }
interface Result {
  date: string; exists: boolean;
  scan: { evaluated: number; strong: number; strict: number } | null;
  disposalCount: number;
  hotThemes: Array<{ theme: string; stage: string; avgD5: number | null }>;
  focus: Focus[]; canEnter: Row[]; watch: Row[]; noChase: Row[]; vetoedStrong: Row[];
}

const STAGE_CLS: Record<string, string> = {
  剛啟動: 'text-emerald-400', 主升段: 'text-red-400', 高潮噴出: 'text-orange-400',
  震盪換手: 'text-yellow-400', 退潮: 'text-slate-400', 補跌: 'text-green-400', 盤整: 'text-slate-500',
};

const FWD_COLS: Array<{ k: keyof Fwd; label: string }> = [
  { k: 'openReturn', label: '隔開' }, { k: 'd1Return', label: '1' }, { k: 'd2Return', label: '2' },
  { k: 'd3Return', label: '3' }, { k: 'd4Return', label: '4' }, { k: 'd5Return', label: '5' },
  { k: 'd6Return', label: '6' }, { k: 'd7Return', label: '7' }, { k: 'd8Return', label: '8' },
  { k: 'd9Return', label: '9' }, { k: 'd10Return', label: '10' }, { k: 'd20Return', label: '20' },
  { k: 'maxGain', label: '最高' }, { k: 'maxLoss', label: '最低' },
];
// 身份欄(代號名稱+訊號) + 14 個前瞻報酬欄，所有列共用 → 數字永遠對齊在同一條線
const GRID: React.CSSProperties = { gridTemplateColumns: 'minmax(150px, 1.6fr) repeat(14, minmax(0, 1fr))' };

function Chg({ v }: { v: number }) {
  const cls = v > 0 ? 'text-red-400' : v < 0 ? 'text-green-400' : 'text-slate-400';
  return <span className={`tabular-nums ${cls}`}>{v > 0 ? '+' : ''}{v.toFixed(1)}%</span>;
}

function retCls(v: number | null | undefined): string {
  return v == null ? 'text-slate-700' : v > 0 ? 'text-red-400' : v < 0 ? 'text-green-400' : 'text-slate-500';
}

/** 欄頭：每區印一次 */
function FwdHead() {
  return (
    <div className="grid items-end gap-x-0.5 px-2 pb-1 border-b border-slate-700/70 text-[9px] text-slate-500" style={GRID}>
      <div>股票 · 訊號</div>
      {FWD_COLS.map(c => <div key={c.k} className="text-right tabular-nums">{c.label}</div>)}
    </div>
  );
}

/** 一檔：身份 + 14 個對齊數字；focus 多一條進場/停損/事後 */
function StockRow({ x, date, rank, focus }: { x: Row | Focus; date: string; rank?: number; focus?: boolean }) {
  const f = x as Focus;
  return (
    <div className="px-2 py-1 hover:bg-slate-900/40">
      <div className="grid items-center gap-x-0.5" style={GRID}>
        <div className="min-w-0 pr-2">
          <div className="flex items-baseline gap-1.5 leading-tight">
            {rank != null && <span className="text-slate-600 text-[10px]">#{rank}</span>}
            <Link href={`/?load=${x.code}&date=${date}`} className="text-[13px] font-medium truncate hover:text-sky-400">
              {x.code} {x.name}
            </Link>
            <Chg v={x.changePct} />
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-slate-500 leading-tight">
            <span className="truncate">{x.comboLabel}</span>
            <span className="text-slate-600 shrink-0">六{x.sixCore ? '✓' : ''}{x.sixTotal}</span>
            {x.theme && <span className="text-sky-300/50 truncate">{x.theme}</span>}
          </div>
        </div>
        {FWD_COLS.map(c => {
          const v = x.fwd?.[c.k];
          return (
            <div key={c.k} className={`text-right text-[10px] font-mono tabular-nums ${retCls(v)}`}>
              {v == null ? '·' : `${v > 0 ? '+' : ''}${v.toFixed(1)}`}
            </div>
          );
        })}
      </div>
      {focus && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 pl-1 text-[10px] text-slate-500 leading-tight">
          <span>進場 <span className="text-slate-300">明日13:25市價</span></span>
          <span>停損 <span className="text-rose-300">{f.stop}（{f.stopPct}%）</span></span>
          <span>持有 ~20日</span>
          {f.outcome && (
            <span className="text-slate-600">
              · 事後（{f.outcome.entryOpen} 進）{' '}
              <span className={retCls(f.outcome.ret)}>實現 {f.outcome.ret > 0 ? '+' : ''}{f.outcome.ret}%</span>{' '}
              {f.outcome.exitReason === 'stop' ? '🛑停損' : f.outcome.exitReason === 'time' ? '⏱滿20日' : '持有中'}
              （持{f.outcome.holdDays}日）
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function Section(
  { dot, title, sub, rows, date, max = 999, focus }:
  { dot: string; title: string; sub?: string; rows: Row[] | Focus[]; date: string; max?: number; focus?: boolean },
) {
  if (!rows?.length) return null;
  return (
    <div className="mb-5">
      <h3 className="text-sm font-semibold text-slate-200">
        {dot} {title} <span className="text-slate-600 font-normal">（{rows.length}）</span>
      </h3>
      {sub && <p className="text-[11px] text-slate-500 mt-0.5 mb-1.5">{sub}</p>}
      <div className="rounded-lg border border-slate-800 bg-slate-900/40 overflow-hidden">
        <FwdHead />
        <div className="divide-y divide-slate-800/50">
          {rows.slice(0, max).map((x, i) => (
            <StockRow key={x.code} x={x} date={date} rank={focus ? i + 1 : undefined} focus={focus} />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function DailyPickPage() {
  const [data, setData] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dates, setDates] = useState<string[]>([]);
  const [sel, setSel] = useState<string | null>(null);  // null = 最新

  useEffect(() => {
    fetch('/api/daily-pick/dates').then(r => r.json())
      .then(j => setDates((j.data ?? j).dates ?? [])).catch(() => {});
  }, []);

  useEffect(() => {
    setData(null); setErr(null);
    fetch(`/api/daily-pick${sel ? `?date=${sel}` : ''}`)
      .then(r => r.json())
      .then(j => { if (j.ok === false) throw new Error(j.error ?? '載入失敗'); setData((j.data ?? j) as Result); })
      .catch(e => setErr(e instanceof Error ? e.message : String(e)));
  }, [sel]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-4 md:p-6">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-baseline justify-between mb-1">
          <h1 className="text-xl font-bold">每日選股漏斗</h1>
          <Link href="/" className="text-sm text-sky-400 hover:underline">← 回看盤台</Link>
        </div>
        <p className="text-xs text-slate-500 mb-2">
          三色強訊號 → 過處置veto → 依當日漲幅排序取 top3 · 帶進場/停損/持有
          {data?.date && <span className="ml-2 text-slate-600">資料日 {data.date}</span>}
        </p>

        {/* 日期選擇器 */}
        {dates.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-3">
            <button onClick={() => setSel(null)}
              className={`text-[11px] px-2 py-0.5 rounded border ${sel === null ? 'bg-sky-900/60 border-sky-600 text-sky-200' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}>
              最新
            </button>
            {dates.map(d => (
              <button key={d} onClick={() => setSel(d)}
                className={`text-[11px] px-2 py-0.5 rounded border ${sel === d ? 'bg-sky-900/60 border-sky-600 text-sky-200' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}>
                {d.slice(5)}
              </button>
            ))}
          </div>
        )}

        {/* 回測誠實警語 */}
        <div className="text-[11px] text-amber-300/80 bg-amber-950/30 border border-amber-900/40 rounded px-3 py-2 mb-4">
          ⚠️ 回測(2年無未來偏誤)：依漲幅取 top1 排序alpha +0.8% d5 / +2.4% d20，但 <b>edge 集中 top1</b>、
          取超過 3 檔等於沒排序；<b>勝率約 4 成</b>靠大贏家右尾，扣交易成本後淨 edge 薄。
          能不能賺 90% 看「砍輸家·抱贏家」的紀律，不看選股。末升段(動能股)回測報酬反而最高但波動最大，非「不可買」。
        </div>

        {err && <div className="text-rose-400 text-sm py-8">⚠ {err}</div>}
        {!data && !err && <div className="text-slate-500 text-sm py-8">載入中…</div>}
        {data && !data.exists && (
          <div className="text-amber-400 text-sm py-8">該日無三色掃描檔（盤後 tw-sanse cron 未跑？）</div>
        )}

        {data?.exists && (
          <>
            <div className="text-xs text-slate-500 mb-1">
              三色掃描 {data.scan?.evaluated} 檔 → 強共振 {data.scan?.strong} / 嚴格級 {data.scan?.strict}
              · 處置中 {data.disposalCount} 檔已剔除
            </div>
            <p className="text-[10px] text-slate-600 mb-4">
              數字＝相對掃描日收盤的前瞻報酬(%)，<span className="text-red-400">紅漲</span>／<span className="text-green-400">綠跌</span>／· 尚無資料。
            </p>

            {/* top3 可執行 */}
            <Section dot="🎯" title="今日 top3（依漲幅）" rows={data.focus} date={data.date} focus
              sub={data.focus.length === 0 ? '今日無三色強候選（過 veto 後）。' : undefined} />

            {/* 板塊熱度 */}
            {data.hotThemes.length > 0 && (
              <div className="mb-5">
                <h3 className="text-sm font-semibold mb-1.5 text-slate-300">資金最強板塊（5日）</h3>
                <div className="flex flex-wrap gap-2 text-xs">
                  {data.hotThemes.map(t => (
                    <span key={t.theme} className="bg-slate-900/60 border border-slate-800 rounded px-2 py-1">
                      {t.theme} <span className={STAGE_CLS[t.stage] ?? 'text-slate-400'}>[{t.stage}]</span>{' '}
                      {t.avgD5 != null && <Chg v={t.avgD5} />}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* 三層候選 */}
            <Section dot="🟢" title="低乖離·時機乾淨" rows={data.canEnter} date={data.date}
              sub="貼著均線、乖離小，進場最穩 — 但回測報酬偏弱。" />
            <Section dot="🟡" title="時機中性" rows={data.watch} date={data.date} max={12}
              sub="乖離中等，可等回檔或突破再進。" />
            <Section dot="🔴" title="末升段·高動能" rows={data.noChase} date={data.date} max={10}
              sub="離月線>15%、或剛連3長紅暴量（衝太高），追高風險大 — 但回測報酬其實最高、波動也最大，非「不可買」。" />

            {data.vetoedStrong.length > 0 && (
              <div className="mt-6">
                <h3 className="text-sm font-semibold mb-1 text-slate-500">⛔ 被處置 veto 刷掉（{data.vetoedStrong.length}）</h3>
                <div className="text-xs text-slate-600">
                  {data.vetoedStrong.map(x => `${x.code} ${x.name}`).join('、')} — 分盤交易不可追
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
