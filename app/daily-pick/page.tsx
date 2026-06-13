'use client';

/**
 * /daily-pick — 每日選股漏斗頁面（2026-06-13）
 *
 * 把 daily-pick 終端腳本搬上瀏覽器：最上面是「今日 top3 可執行清單」（依漲幅排序、
 * 帶進場/停損/持有），下面是板塊熱度 + 分層候選 + 被 veto 清單。
 * 資料 = /api/daily-pick（lib/dailyPick/buildDailyPick 單一事實）。
 *
 * 全頁帶回測誠實警語：edge 集中 top1、勝率~4成靠大贏家、紀律>選股（backtest-rank-edge）。
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Row {
  code: string; name: string; industry: string; changePct: number;
  level: string | null; comboLabel: string; comboRank: number;
  sixCore: boolean; sixTotal: number; theme: string | null;
  entryState: 'can_enter' | 'watch' | 'no_chase'; entryReason: string;
  deviationMa20: number | null; price: number;
}
interface Outcome {
  entryOpen: number; exitClose: number; ret: number; holdDays: number;
  exitReason: 'stop' | 'time' | 'holding'; maxGain: number; maxLoss: number;
}
interface Fwd {
  openReturn?: number | null; d1Return?: number | null; d2Return?: number | null;
  d3Return?: number | null; d4Return?: number | null; d5Return?: number | null;
  d6Return?: number | null; d7Return?: number | null; d8Return?: number | null;
  d9Return?: number | null; d10Return?: number | null; d20Return?: number | null;
  maxGain?: number | null; maxLoss?: number | null;
}
interface Focus extends Row { stop: number; stopPct: number; outcome: Outcome | null; fwd: Fwd | null }
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
const ENTRY_TAG: Record<string, { label: string; cls: string }> = {
  can_enter: { label: '低乖離·穩', cls: 'bg-emerald-900/50 text-emerald-300' },
  watch: { label: '時機中性', cls: 'bg-slate-700/50 text-slate-300' },
  no_chase: { label: '末升段·高動能高波動', cls: 'bg-orange-900/50 text-orange-300' },
};

function Chg({ v }: { v: number }) {
  const cls = v > 0 ? 'text-red-400' : v < 0 ? 'text-green-400' : 'text-slate-400';
  return <span className={cls}>{v > 0 ? '+' : ''}{v.toFixed(1)}%</span>;
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
      <div className="max-w-4xl mx-auto">
        <div className="flex items-baseline justify-between mb-1">
          <h1 className="text-xl font-bold">每日選股漏斗</h1>
          <Link href="/" className="text-sm text-sky-400 hover:underline">← 回看盤台</Link>
        </div>
        <p className="text-xs text-slate-500 mb-1">
          三色強訊號 → 過處置veto → 依當日漲幅排序取 top3 · 帶進場/停損/持有
          {data?.date && <span className="ml-2 text-slate-600">資料日 {data.date}</span>}
        </p>

        {/* 日期選擇器（回看過去 ~30 天當時選了哪 3 檔 + 後來漲跌） */}
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
            {/* 掃描摘要 */}
            <div className="text-xs text-slate-500 mb-4">
              三色掃描 {data.scan?.evaluated} 檔 → 強共振 {data.scan?.strong} / 嚴格級 {data.scan?.strict}
              · 處置中 {data.disposalCount} 檔已剔除
            </div>

            {/* ★ Focus top3 — 可執行清單 */}
            <h2 className="text-base font-semibold mb-2">🎯 今日 top3（依漲幅）</h2>
            {data.focus.length === 0 && <div className="text-slate-500 text-sm mb-6">今日無三色強候選（過 veto 後）。</div>}
            <div className="space-y-3 mb-8">
              {data.focus.map((x, i) => (
                <div key={x.code} className="bg-slate-900/60 border border-slate-800 rounded-lg p-3">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-slate-500 text-sm">#{i + 1}</span>
                    <Link href={`/?load=${x.code}&date=${data.date}`} className="font-semibold hover:text-sky-400">
                      {x.code} {x.name}
                    </Link>
                    <span className="text-xs text-slate-500">{x.industry}</span>
                    <Chg v={x.changePct} />
                    <span className="text-xs text-slate-400">{x.comboLabel}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${ENTRY_TAG[x.entryState].cls}`}>
                      {ENTRY_TAG[x.entryState].label}
                    </span>
                    {x.theme && <span className="text-[10px] text-sky-300/80">{x.theme}</span>}
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 mt-2 text-xs">
                    <div><span className="text-slate-500">收盤</span> {x.price}</div>
                    <div><span className="text-slate-500">進場</span> 明日13:25市價</div>
                    <div>
                      <span className="text-slate-500">停損</span>{' '}
                      <span className="text-rose-300">{x.stop}（{x.stopPct}%）</span>
                    </div>
                    <div><span className="text-slate-500">持有</span> ~20日</div>
                  </div>
                  <div className="text-[10px] text-slate-600 mt-1">
                    六條件 {x.sixCore ? '核心✓' : ''}{x.sixTotal}/6 · 跌破停損收盤就砍、大量長黑先出
                  </div>
                  {x.fwd && <FwdRow f={x.fwd} />}
                  {x.outcome && <Outcome o={x.outcome} />}
                </div>
              ))}
            </div>

            {/* 板塊熱度 */}
            {data.hotThemes.length > 0 && (
              <div className="mb-6">
                <h3 className="text-sm font-semibold mb-1 text-slate-400">資金最強板塊（5日）</h3>
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

            {/* 分層候選 */}
            <Tier title="🟢 低乖離·時機乾淨（穩但回測報酬偏弱）" rows={data.canEnter} date={data.date} />
            <Tier title="🟡 時機中性" rows={data.watch} max={12} date={data.date} />
            <Tier title="🔴 末升段·高動能（回測報酬最高但波動最大，非不可買）" rows={data.noChase} max={10} date={data.date} />

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

const FWD_COLS: Array<{ k: keyof Fwd; label: string }> = [
  { k: 'openReturn', label: '隔日開' }, { k: 'd1Return', label: '1日' }, { k: 'd2Return', label: '2日' },
  { k: 'd3Return', label: '3日' }, { k: 'd4Return', label: '4日' }, { k: 'd5Return', label: '5日' },
  { k: 'd6Return', label: '6日' }, { k: 'd7Return', label: '7日' }, { k: 'd8Return', label: '8日' },
  { k: 'd9Return', label: '9日' }, { k: 'd10Return', label: '10日' }, { k: 'd20Return', label: '20日' },
  { k: 'maxGain', label: '最高' }, { k: 'maxLoss', label: '最低' },
];
function FwdRow({ f }: { f: Fwd }) {
  return (
    <div className="mt-2 pt-2 border-t border-slate-800 flex gap-0.5">
      {FWD_COLS.map(({ k, label }) => {
        const v = f[k];
        const cls = v == null ? 'text-slate-600' : v > 0 ? 'text-red-400' : v < 0 ? 'text-green-400' : 'text-slate-400';
        return (
          <div key={k} className="flex-1 text-center">
            <div className="text-[9px] text-slate-600">{label}</div>
            <div className={`text-[10px] font-mono ${cls}`}>{v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`}</div>
          </div>
        );
      })}
    </div>
  );
}

function Outcome({ o }: { o: Outcome }) {
  const cls = o.ret > 0 ? 'text-red-400' : o.ret < 0 ? 'text-green-400' : 'text-slate-400';
  const reason = o.exitReason === 'stop' ? '🛑停損出' : o.exitReason === 'time' ? '⏱滿20日' : '持有中';
  return (
    <div className="mt-2 pt-2 border-t border-slate-800 text-[11px] flex flex-wrap gap-x-3 gap-y-0.5">
      <span className="text-slate-500">事後結果（隔日開盤 {o.entryOpen} 進）：</span>
      <span className={cls}>實現 {o.ret > 0 ? '+' : ''}{o.ret}%</span>
      <span className="text-slate-400">{reason}（持 {o.holdDays} 日）</span>
      <span className="text-slate-500">途中最高 +{o.maxGain}% / 最低 {o.maxLoss}%</span>
    </div>
  );
}

function Tier({ title, rows, max = 999, date }: { title: string; rows: Row[]; max?: number; date: string }) {
  if (!rows?.length) return null;
  return (
    <div className="mb-5">
      <h3 className="text-sm font-semibold mb-1 text-slate-400">{title}（{rows.length}）</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <tbody>
            {rows.slice(0, max).map(x => (
              <tr key={x.code} className="border-b border-slate-800/50">
                <td className="py-1 pr-2">
                  <Link href={`/?load=${x.code}&date=${date}`} className="hover:text-sky-400">{x.code} {x.name}</Link>
                </td>
                <td className="py-1 px-2 text-slate-500">{x.industry.slice(0, 6)}</td>
                <td className="py-1 px-2 text-right"><Chg v={x.changePct} /></td>
                <td className="py-1 px-2 text-slate-400">{x.comboLabel}</td>
                <td className="py-1 px-2 text-slate-500">六{x.sixCore ? '✓' : ''}{x.sixTotal}/6</td>
                <td className="py-1 pl-2 text-sky-300/70">{x.theme ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
