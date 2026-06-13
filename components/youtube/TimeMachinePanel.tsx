'use client';

/**
 * TimeMachinePanel — 時光機跟單回測結果卡（walk-forward，防前視偏誤）
 *
 * 「假裝回到 asOf 當天 → 跟當時排行榜最準的 top-K 老師買 → 到今天賺不賺」
 * 對照組：全部老師推薦都買 + 大盤同期。資料來自 /api/youtube/teacher-walkforward。
 */

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { bullBearClass } from '@/lib/format';

interface SelStatsLite { n: number; avgPct: number; medianPct: number; winRatePct: number }
interface StatBlock {
  events: number; uniqueStocks: number;
  hold: SelStatsLite; holdExcessAvg: number | null;
  d1: SelStatsLite; d5: SelStatsLite;
}
interface FollowEvent {
  date: string; teacher: string; stock_code: string; stock_name: string;
  recommendation_type: string; entry_open: number | null;
  hold: number | null; holdExcess: number | null; d1: number | null; d5: number | null; isOpen: boolean;
}
interface WalkforwardResponse {
  asOf: string; today: string;
  config: { topK: number; selectBy: string; minSample: number };
  train: { eventsUsed: number; teachersEligible: number; note: string | null };
  selectedTeachers: Array<{ teacher: string; programs: string[]; trainScored: number; trainAvg: number; trainWin: number }>;
  follow: StatBlock; benchmarkAll: StatBlock;
  marketReturn: number | null;
  followEvents: FollowEvent[];
  note: string;
  error?: string;
}

const fmtPct = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
const HORIZON_LABEL: Record<string, string> = { d1: '隔日', d5: '一週(D5)', d20: '一個月(D20)' };

interface Props { asOf: string; topK: number; selectBy: 'd1' | 'd5' | 'd20' }

export function TimeMachinePanel({ asOf, topK, selectBy }: Props) {
  const [data, setData] = useState<WalkforwardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showEvents, setShowEvents] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/youtube/teacher-walkforward?asOf=${asOf}&topK=${topK}&selectBy=${selectBy}`)
      .then(r => r.json())
      .then((j: WalkforwardResponse) => {
        if (cancelled) return;
        if (j.error) { setError(j.error); setData(null); } else setData(j);
      })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [asOf, topK, selectBy]);

  if (loading && !data) return <div className="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground">回到 {asOf} 模擬跟單中…</div>;
  if (error) return <div className="rounded-lg border border-red-700/40 bg-card p-4 text-sm text-red-400">無法回測：{error}</div>;
  if (!data) return null;

  const f = data.follow, b = data.benchmarkAll;
  const mkt = data.marketReturn;
  const vsAll = f.hold.avgPct != null && b.hold.avgPct != null ? f.hold.avgPct - b.hold.avgPct : null;
  const vsMkt = f.hold.avgPct != null && mkt != null ? f.hold.avgPct - mkt : null;

  return (
    <div className="rounded-lg border border-amber-700/40 bg-amber-950/10 p-4 space-y-3">
      <div>
        <h2 className="text-base font-semibold">
          🕰 假裝回到 <span className="text-amber-300">{asOf}</span>，跟「當時最準的 {topK} 位老師」買 → 到今天 {data.today} 的結果
        </h2>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          選老師只看 {asOf} 以前、且已走完{HORIZON_LABEL[selectBy]}的推薦（沒偷看未來）；之後他們每喊一檔就隔日開盤模擬買進，抱到現在。
        </p>
      </div>

      {/* 選出的老師 */}
      {data.selectedTeachers.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          <span className="text-muted-foreground">當時選出：</span>
          {data.selectedTeachers.map(t => (
            <span key={t.teacher} className="px-1.5 py-0.5 rounded bg-secondary/40 border border-border/50">
              {t.teacher} <span className="text-green-400">{HORIZON_LABEL[selectBy]}均{fmtPct(t.trainAvg)}</span>
              <span className="text-muted-foreground"> · 勝{t.trainWin.toFixed(0)}% · {t.trainScored}筆</span>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-yellow-400">{data.train.note ?? '截至此日沒有老師有足夠樣本可選，請把 as-of 日期往後挪。'}</p>
      )}

      {/* 三欄對照 */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground border-b border-border">
            <tr className="[&>th]:px-2 [&>th]:py-1.5 [&>th]:text-right [&>th:first-child]:text-left">
              <th></th>
              <th className="text-amber-300">跟最準 {topK} 位</th>
              <th>全部都買</th>
              <th>大盤</th>
            </tr>
          </thead>
          <tbody className="[&>tr>td]:px-2 [&>tr>td]:py-1.5 [&>tr>td]:text-right [&>tr>td:first-child]:text-left">
            <tr className="border-b border-border/30">
              <td className="text-muted-foreground">推薦數 / 檔數</td>
              <td>{f.events} / {f.uniqueStocks}</td>
              <td>{b.events} / {b.uniqueStocks}</td>
              <td>—</td>
            </tr>
            <tr className="border-b border-border/30 font-semibold">
              <td className="text-muted-foreground font-normal">持有至今 平均報酬</td>
              <td className={bullBearClass(f.hold.avgPct)}>{fmtPct(f.hold.avgPct)}</td>
              <td className={bullBearClass(b.hold.avgPct)}>{fmtPct(b.hold.avgPct)}</td>
              <td className={bullBearClass(mkt)}>{fmtPct(mkt)}</td>
            </tr>
            <tr className="border-b border-border/30">
              <td className="text-muted-foreground">持有至今 勝率</td>
              <td>{f.hold.n ? `${f.hold.winRatePct.toFixed(0)}%` : '—'}</td>
              <td>{b.hold.n ? `${b.hold.winRatePct.toFixed(0)}%` : '—'}</td>
              <td>—</td>
            </tr>
            <tr className="border-b border-border/30">
              <td className="text-muted-foreground">贏過大盤（超額）</td>
              <td className={bullBearClass(f.holdExcessAvg)}>{fmtPct(f.holdExcessAvg)}</td>
              <td className={bullBearClass(b.holdExcessAvg)}>{fmtPct(b.holdExcessAvg)}</td>
              <td>—</td>
            </tr>
            <tr>
              <td className="text-muted-foreground">一週(D5) 平均（已走完）</td>
              <td className={bullBearClass(f.d5.avgPct)}>{f.d5.n ? fmtPct(f.d5.avgPct) : '—'} <span className="text-muted-foreground">({f.d5.n})</span></td>
              <td className={bullBearClass(b.d5.avgPct)}>{b.d5.n ? fmtPct(b.d5.avgPct) : '—'} <span className="text-muted-foreground">({b.d5.n})</span></td>
              <td>—</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* 自動結論（樣本太少時只警告，不給誤導結論） */}
      <div className="rounded bg-secondary/20 border border-border/40 p-2.5 text-xs leading-relaxed">
        {f.events < 5 ? (
          <p className="text-yellow-400">
            ⚠ <b>樣本太少，先別下結論</b>：選出的這 {topK} 位老師在 {asOf} 之後只新喊了 <b>{f.events}</b> 筆
            （他們不是天天上節目的常客）。建議：把上方 as-of 日期<b>往前拉</b>（給更長測試窗）、或把「選幾位老師」<b>加大到 5 位</b>，
            讓跟單筆數夠多才有參考價值。下面「全部都買」的 {b.events} 筆才是這段期間的大樣本基準。
          </p>
        ) : (
          <>
            {vsAll != null && (
              <p>
                {vsAll > 0
                  ? <>✅ <b className="text-green-400">篩選有效</b>：跟「最準 {topK} 位老師」比「全部都買」多賺 <b>{fmtPct(vsAll)}</b>。</>
                  : <>⚠️ <b className="text-yellow-400">篩選沒幫助</b>：跟「最準 {topK} 位老師」反而比「全部都買」差 {fmtPct(Math.abs(vsAll))} — 短線「最準」不代表之後也準。</>}
              </p>
            )}
            {vsMkt != null && (
              <p className="mt-0.5">
                {vsMkt > 0
                  ? <>🎯 而且 <b className="text-green-400">跑贏大盤 {fmtPct(vsMkt)}</b> — 這段期間照名單跟單是賺的。</>
                  : <>📉 但 <b className="text-red-400">輸給大盤</b>（大盤 {fmtPct(mkt)}）— 這段是弱勢/回檔盤，節目愛推的強勢股回檔時跌更兇。</>}
              </p>
            )}
          </>
        )}
        <p className="mt-1 text-[11px] text-muted-foreground">
          ⚠ 測試窗 {asOf} → {data.today}（約 {Math.max(1, Math.round((new Date(data.today).getTime() - new Date(asOf).getTime()) / 86400000 * 5 / 7))} 個交易日）。
          樣本越短、剛好遇到單邊行情，結論越不穩；把 as-of 往前拉、或多試幾個時點再下定論。
          目前資料從 2026-05-18 起累積，未來越久樣本越厚。
        </p>
      </div>

      {/* 跟單明細 */}
      {data.followEvents.length > 0 && (
        <div>
          <button onClick={() => setShowEvents(v => !v)} className="text-[11px] text-sky-400 hover:underline">
            {showEvents ? '收合' : '展開'}跟單明細（{data.followEvents.length} 筆，按報酬排序）
          </button>
          {showEvents && (
            <div className="mt-2 overflow-x-auto max-h-80 overflow-y-auto">
              <table className="w-full text-[11px]">
                <thead className="text-muted-foreground sticky top-0 bg-card">
                  <tr className="[&>th]:px-1.5 [&>th]:py-1 [&>th]:text-right [&>th:nth-child(-n+3)]:text-left">
                    <th>日期</th><th>股票</th><th>老師</th><th>型態</th><th>進場</th><th>持有至今</th><th>超額</th><th>D5</th>
                  </tr>
                </thead>
                <tbody>
                  {data.followEvents.map((e, i) => (
                    <tr key={`${e.date}-${e.stock_code}-${e.teacher}-${i}`} className="border-t border-border/30 [&>td]:px-1.5 [&>td]:py-1 [&>td]:text-right [&>td:nth-child(-n+3)]:text-left">
                      <td className="whitespace-nowrap">{e.date}</td>
                      <td className="whitespace-nowrap">
                        <a href={`/?load=${e.stock_code}`} className="text-sky-300 hover:underline font-mono">{e.stock_code}</a> {e.stock_name}
                      </td>
                      <td className="text-amber-300/80 whitespace-nowrap">{e.teacher}</td>
                      <td className="text-muted-foreground">{e.recommendation_type}</td>
                      <td>{e.entry_open ?? '—'}</td>
                      <td className={bullBearClass(e.hold)}>{fmtPct(e.hold)}</td>
                      <td className={bullBearClass(e.holdExcess)}>{fmtPct(e.holdExcess)}</td>
                      <td className={bullBearClass(e.d5)}>{e.isOpen ? '追蹤中' : fmtPct(e.d5)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
