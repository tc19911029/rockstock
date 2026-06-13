'use client';

/**
 * 今日最優先卡（2026-06-12，C1+C2）。
 *
 * 目的：降低決策摩擦 — 把「回測驗證最強的策略×排序」的今日 top 1-3 直接放在
 * scan tab 最上面，一眼一個動作。資料全部讀現成結果：
 *   - 哪個策略最強：/api/backtest/leaderboard（鐵則 #10 單一事實 — 重跑排行榜本卡自動跟上，
 *     不寫死「台股=三色高共振」這類結論）
 *   - 今日命中誰：三色 /api/{tw,cn}-sanse/scan（具名策略從 records 衍生）、
 *     買法 /api/scanner/results（L4 現成紀錄）— 本卡不發起任何掃描。
 * 每檔附「試算」→ /sizer 預填（C2）與走圖連結；底部固定朱書執行時點提醒。
 * 純顯示層，不進選股 gate。
 */
import { useEffect, useMemo, useState } from 'react';
import { matchedStrategies } from '@/lib/cn-sanse/namedStrategies';
import { buyScore } from '@/lib/cn-sanse/buyScore';
import type { ConditionReport } from '@/lib/cn-sanse/conditions';
import type { LeaderboardRow } from '@/lib/backtest/leaderboardTypes';

interface Props { market: 'TW' | 'CN' }

interface PickView { symbol: string; name: string; price: number | null; note: string }

interface SanseRecordRow {
  symbol: string; name?: string; price?: number; report: ConditionReport;
}
interface SanseResp {
  ok: boolean; lastDate?: string;
  results?: Record<string, Array<{ symbol: string; name: string; price: number }>>;
  records?: SanseRecordRow[];
}

const MIN_N = 100;

export function TodayTopPriorityCard({ market }: Props) {
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [picks, setPicks] = useState<PickView[] | null>(null);
  const [usedRow, setUsedRow] = useState<LeaderboardRow | null>(null);
  const [bestRow, setBestRow] = useState<LeaderboardRow | null>(null);
  const [scanDate, setScanDate] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const r = await fetch(`/api/backtest/leaderboard?market=${market}`);
        const j = await r.json();
        const all: LeaderboardRow[] = (j.rows ?? j.data?.rows ?? []).filter((x: LeaderboardRow) => x.market === market);
        if (!dead) setRows(all);
      } catch { if (!dead) setHidden(true); }
    })();
    return () => { dead = true; };
  }, [market]);

  // 排行榜 top（n≥100，依 d5 top1 平均報酬）→ 依序找「今日有命中」的那一列
  const ranked = useMemo(() => {
    if (!rows) return [];
    return rows
      .filter(r => (r.byHorizon?.d5?.top1?.n ?? 0) >= MIN_N)
      .sort((a, b) => (b.byHorizon.d5.top1.avgPct ?? -99) - (a.byHorizon.d5.top1.avgPct ?? -99))
      .slice(0, 5);
  }, [rows]);

  useEffect(() => {
    if (ranked.length === 0) return;
    setBestRow(ranked[0]);
    let dead = false;
    (async () => {
      // 三色 scan 抓一次共用
      let sanse: SanseResp | null = null;
      try {
        const r = await fetch(`/api/${market === 'TW' ? 'tw-sanse' : 'cn-sanse'}/scan`);
        sanse = await r.json();
      } catch { /* sanse 不可用就只剩買法路徑 */ }
      if (sanse?.lastDate && !dead) setScanDate(sanse.lastDate);

      for (const row of ranked) {
        const resolved = await resolvePicks(row, market, sanse);
        if (dead) return;
        if (resolved.length > 0) {
          setUsedRow(row);
          setPicks(resolved.slice(0, 3));
          return;
        }
      }
      setUsedRow(null);
      setPicks([]); // 全部沒命中 → 顯示「今日無命中」
    })();
    return () => { dead = true; };
  }, [ranked, market]);

  if (hidden || !rows || rows.length === 0 || ranked.length === 0) return null;

  const row = usedRow ?? bestRow;
  if (!row) return null;
  const d5 = row.byHorizon.d5.top1;

  return (
    <div className="rounded-md border border-amber-700/40 bg-amber-950/20 p-2.5 mb-2 text-xs space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-amber-300">🎯 今日最優先</span>
        <span className="text-[10px] text-zinc-500">
          回測最強：{row.strategyLabel} × {row.sortLabel}（d5 top1 均 {d5.avgPct > 0 ? '+' : ''}{d5.avgPct}%・n={d5.n}）
        </span>
      </div>
      {picks === null ? (
        <div className="text-zinc-500">載入今日命中…</div>
      ) : picks.length === 0 ? (
        <div className="text-zinc-500">
          前 5 強策略今日皆無命中 — 沒訊號就是沒訊號，別硬做。
        </div>
      ) : (
        <div className="space-y-1">
          {usedRow && bestRow && usedRow.id !== bestRow.id && (
            <div className="text-[10px] text-zinc-500">最強「{bestRow.strategyLabel}」今日無命中 → 顯示次強有命中者</div>
          )}
          {picks.map((p, i) => (
            <div key={p.symbol} className="flex items-center justify-between gap-2">
              <a href={`/?load=${encodeURIComponent(p.symbol)}`} className="text-zinc-200 hover:text-amber-300 truncate">
                <span className="text-zinc-500 mr-1">{i + 1}.</span>{p.name} <span className="text-zinc-500">{p.symbol.replace(/\.(TW|TWO|SS|SZ)$/, '')}</span>
                {p.price != null && <span className="ml-1 text-zinc-400">{p.price}</span>}
                <span className="ml-1 text-[10px] text-zinc-500">{p.note}</span>
              </a>
              {market === 'TW' && (
                <a
                  href={`/sizer?symbol=${encodeURIComponent(p.symbol)}&name=${encodeURIComponent(p.name)}${p.price != null ? `&entry=${p.price}` : ''}`}
                  className="shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:text-amber-300 hover:border-amber-700"
                  title="帶入 /sizer 部位試算（entry 預填收盤價，停損自填）"
                >📐 試算</a>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="text-[10px] text-zinc-600 border-t border-zinc-800/60 pt-1">
        執行時點（朱書）：明日 13:20 確認、13:25 掛市價；09:00 開盤不動作。掃描日 {scanDate ?? '—'}
      </div>
    </div>
  );
}

/** 把排行榜列解析成今日 picks（三色：results level 或具名策略衍生；買法：L4 records） */
async function resolvePicks(row: LeaderboardRow, market: 'TW' | 'CN', sanse: SanseResp | null): Promise<PickView[]> {
  if (row.engine === 'sanse') {
    if (!sanse?.ok) return [];
    const direct = sanse.results?.[row.strategyId];
    if (direct && direct.length > 0) {
      return sortByBuyScore(direct.map(h => ({ symbol: h.symbol, name: h.name, price: h.price ?? null })), sanse);
    }
    // 具名策略 / 組合桶 → 從 records 衍生
    const recs = (sanse.records ?? []).filter(r => {
      try { return matchedStrategies(r.report).some(s => s.id === row.strategyId); } catch { return false; }
    });
    return sortByBuyScore(recs.map(r => ({ symbol: r.symbol, name: r.name ?? r.symbol, price: r.price ?? null })), sanse);
  }
  // 買法字母：L4 現成紀錄（latest 有結果的 session）
  try {
    const r = await fetch(`/api/scanner/results?market=${market}&direction=long&mtf=${encodeURIComponent(row.strategyId)}`);
    const j = await r.json();
    const sessions: Array<{ date: string; resultCount: number; results?: Array<{ symbol: string; name: string; price: number; changePercent: number }> }> = j.sessions ?? [];
    const latest = sessions.find(s => (s.resultCount ?? 0) > 0 && (s.results?.length ?? 0) > 0);
    if (!latest) return [];
    const sorted = [...latest.results!].sort((a, b) => (b.changePercent ?? 0) - (a.changePercent ?? 0));
    return sorted.map(s => ({ symbol: s.symbol, name: s.name, price: s.price ?? null, note: `${latest.date}` }));
  } catch { return []; }
}

function sortByBuyScore(items: Array<{ symbol: string; name: string; price: number | null }>, sanse: SanseResp): PickView[] {
  const reportMap = new Map((sanse.records ?? []).map(r => [r.symbol, r.report]));
  return items
    .sort((a, b) => buyScore(reportMap.get(b.symbol)) - buyScore(reportMap.get(a.symbol)))
    .map(x => ({ ...x, note: '應買排序' }));
}
