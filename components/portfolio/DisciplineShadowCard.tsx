'use client';

/**
 * 紀律影子帳本卡（2026-06-12，A2）。
 *
 * 顯示「書本規則嚴格執行版」vs 實際抱單的損益差額（紀律差額）。
 * 正值紅字 = 不照規則正在花掉的錢；讓停損不執行的成本天天可見。
 * 資料：GET /api/portfolio/shadow（server 重放，與今日操作建議同一套規則常數）。
 */
import { useCallback, useEffect, useState } from 'react';
import { usePortfolioProfileStore } from '@/store/portfolioProfileStore';
import type { ShadowResponse } from '@/app/api/portfolio/shadow/route';

function fmtNT(n: number): string {
  const sign = n < 0 ? '−' : '';
  const v = Math.abs(n);
  if (v >= 10_000) return `${sign}NT$${(v / 10_000).toFixed(1)}萬`;
  return `${sign}NT$${Math.round(v).toLocaleString()}`;
}

export function DisciplineShadowCard() {
  const activeProfileId = usePortfolioProfileStore(s => s.activeProfileId);
  const [data, setData] = useState<ShadowResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch(`/api/portfolio/shadow?profile=${encodeURIComponent(activeProfileId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      setData((j.data ?? j) as ShadowResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'fetch failed');
    }
  }, [activeProfileId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (error) return null; // 影子帳本是輔助資訊，失敗不佔版面
  if (!data || data.items.length === 0) return null;

  const gap = data.totalDisciplineGap;
  const gapColor = gap > 1000 ? 'text-red-400' : gap < -1000 ? 'text-emerald-400' : 'text-zinc-400';

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-200">📐 紀律影子帳本</h3>
        <div className="text-right">
          <div className="text-[11px] text-zinc-500">紀律差額（照書本規則 − 實際抱單）</div>
          <div className={`text-lg font-bold ${gapColor}`}>{gap > 0 ? '+' : ''}{fmtNT(gap)}</div>
        </div>
      </div>
      <div className="space-y-1.5">
        {data.items.map(it => (
          <div key={it.symbol} className="text-xs text-zinc-400 border-t border-zinc-800/60 pt-1.5">
            <div className="flex items-center justify-between">
              <span className="text-zinc-300 font-medium">{it.name} <span className="text-zinc-500">{it.symbol}</span></span>
              <span className={it.disciplineGap > 0 ? 'text-red-400' : 'text-zinc-400'}>
                差額 {it.disciplineGap > 0 ? '+' : ''}{fmtNT(it.disciplineGap)}
              </span>
            </div>
            {it.events.length === 0 ? (
              <div className="text-zinc-600">影子帳本未觸發任何出場規則（與實際相同）</div>
            ) : (
              it.events.map((ev, i) => (
                <div key={i} className="text-zinc-500">
                  {ev.date} {ev.label} @ {ev.price.toFixed(2)}（{ev.sharesSold.toLocaleString()} 股）
                </div>
              ))
            )}
          </div>
        ))}
      </div>
      <p className="text-[10px] text-zinc-600">
        影子帳本 = 停損守 stopLoss、漲≥10% 破 MA5 減半 / 破 MA10 全出、漲≥20% 破 MA20 全出，當日收盤價成交。
        僅供紀律對照，非投資建議。
      </p>
    </div>
  );
}
