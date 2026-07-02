'use client';

/**
 * 老師準度面板（2026-06-14）— 把「誰講的準」接到 YouTube 提及面板。
 *
 * 資料：/api/youtube/teacher-leaderboard?days=30|60|90（TeacherRow[]，已含勝率/贏大盤/樣本）。
 * 排序：按 d5「贏大盤(excessAvgPct)」降序（準度），樣本太少(<5)不列、<正式門檻淡化標示。
 * 誠實框：這幾週沒人穩定贏大盤、高勝率多是 1-2 筆運氣 → 看樣本數，別當明牌。
 * 設計系統：主題變數 + bullBearClass（紅=贏大盤/漲），不寫死顏色。
 */

import { useEffect, useState } from 'react';
import { bullBearClass } from '@/lib/format';
import { cn } from '@/lib/utils';

interface HorizonStats { n: number; avgPct: number; winRatePct: number; excessAvgPct: number | null }
interface TeacherRow {
  teacher: string;
  programs: Array<{ source_id: string; display_name: string }>;
  scored_events: number;
  byHorizon: Record<string, HorizonStats>;
}
interface LbResponse {
  ok: boolean;
  teachers?: TeacherRow[];
  meta?: { minScored: number };
  window?: { start: string; end: string; days: number };
}

const DAYS_OPTIONS = [30, 60, 90] as const;
// 樣本 <50 不列：事件常擠在 1-2 天（如被動元件那波），n=31 也可能是「俊敏 94%」這種假象。
// 使用者明示「樣本夠多才可信」、約需 ~100 筆 → 50 起列、<100 仍淡化⚠️。
const MIN_CREDIBLE = 50;
const NOISY_BELOW = 100;

export function TeacherAccuracyPanel({ horizon = 'd5' }: { horizon?: 'd5' | 'd20' }) {
  const [days, setDays] = useState<number>(30);
  const [resp, setResp] = useState<LbResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let aborted = false;
    setLoading(true);
    fetch(`/api/youtube/teacher-leaderboard?days=${days}`)
      .then(r => r.json())
      .then(j => { if (!aborted) setResp(j as LbResponse); })
      .catch(() => { if (!aborted) setResp(null); })
      .finally(() => { if (!aborted) setLoading(false); });
    return () => { aborted = true; };
  }, [days]);

  const rows = (resp?.teachers ?? [])
    .map(t => ({ t, h: t.byHorizon?.[horizon] }))
    // 只列樣本夠多的（≥MIN_CREDIBLE）— 擋掉「勝率88%但只8-16筆」的曇花一現
    .filter(x => x.h && x.t.scored_events >= MIN_CREDIBLE)
    // 準度排序：先贏大盤(excess) 高，再勝率高，再樣本多
    .sort((a, b) =>
      (b.h!.excessAvgPct ?? -99) - (a.h!.excessAvgPct ?? -99) ||
      b.h!.winRatePct - a.h!.winRatePct ||
      b.t.scored_events - a.t.scored_events,
    )
    .slice(0, 8);

  return (
    <div className="rounded-xl ring-1 ring-foreground/10 bg-card p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          🎓 老師準度
          <span className="text-[11px] font-normal text-muted-foreground">按「贏大盤」排（{horizon}）</span>
        </h2>
        <div className="flex items-center gap-1">
          {DAYS_OPTIONS.map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={cn('text-[11px] px-2 py-0.5 rounded border transition-colors',
                days === d ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : 'border-border text-muted-foreground hover:text-foreground')}
            >
              {d}天
            </button>
          ))}
        </div>
      </div>

      {/* 誠實框：別給假希望 */}
      <p className="text-[11px] text-amber-300/90 bg-amber-500/10 border border-amber-500/30 rounded px-2.5 py-1.5 leading-relaxed">
        ⚠️ 這幾週<b>沒有任何老師穩定贏大盤</b>，「贏大盤」幾乎都是 0 到負的；高勝率多是 1-2 筆運氣 → <b>看樣本數</b>，別當明牌。樣本短，是初步參考不是定論。
      </p>

      {loading && !resp ? (
        <div className="text-xs text-muted-foreground py-4 text-center animate-pulse">載入中…</div>
      ) : rows.length === 0 ? (
        <div className="text-xs text-muted-foreground py-4 text-center">樣本不足（需 ≥{MIN_CREDIBLE} 筆才夠可信）</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground border-b border-border">
              <tr className="text-left">
                <th className="py-1.5 pr-2 font-medium">#</th>
                <th className="py-1.5 pr-2 font-medium">老師</th>
                <th className="py-1.5 px-2 text-right font-medium">贏大盤</th>
                <th className="py-1.5 px-2 text-right font-medium">勝率</th>
                <th className="py-1.5 px-2 text-right font-medium">樣本</th>
                <th className="py-1.5 pl-2 font-medium">節目</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ t, h }, i) => {
                const lowSample = t.scored_events < NOISY_BELOW;
                return (
                  <tr key={t.teacher} className="border-b border-border/40 hover:bg-muted/30 transition-colors">
                    <td className="py-1.5 pr-2 text-muted-foreground/60">{i + 1}</td>
                    <td className="py-1.5 pr-2 font-medium">{t.teacher}</td>
                    <td className={`py-1.5 px-2 text-right font-mono tabular-nums ${bullBearClass(h!.excessAvgPct ?? 0)}`}>
                      {h!.excessAvgPct == null ? '—' : `${h!.excessAvgPct >= 0 ? '+' : ''}${h!.excessAvgPct.toFixed(1)}%`}
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono tabular-nums text-foreground/80">
                      {h!.winRatePct.toFixed(0)}%
                    </td>
                    <td className={cn('py-1.5 px-2 text-right font-mono tabular-nums',
                      lowSample ? 'text-amber-400/80' : 'text-muted-foreground')}
                      title={lowSample ? `樣本 <${NOISY_BELOW}，仍可能是運氣` : undefined}>
                      {t.scored_events}{lowSample && ' ⚠️'}
                    </td>
                    <td className="py-1.5 pl-2 text-muted-foreground truncate max-w-[8rem]">
                      {t.programs[0]?.display_name ?? '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex justify-end">
        <a href="/youtube/teachers" className="text-[11px] text-sky-400 hover:underline">
          完整排行 + 逐筆事件 + 時光機驗證 →
        </a>
      </div>
    </div>
  );
}
