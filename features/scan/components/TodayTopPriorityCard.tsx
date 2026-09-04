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
import { bucketsForRecord } from '@/lib/cn-sanse/rankingScore';
import type { ConditionReport } from '@/lib/cn-sanse/conditions';
import type { ResonanceRecord } from '@/lib/cn-sanse/scan';
import type { LeaderboardRow } from '@/lib/backtest/leaderboardTypes';
import type { StockScanResult } from '@/lib/scanner/types';
import { stockDisplayName } from '@/lib/stocks/stockIdentity';

interface Props { market: 'TW' | 'CN' }

interface PickView { symbol: string; name: string; price: number | null; note: string }

interface SanseHitRow { symbol: string; name: string; price: number; changePct?: number; shortAttack?: number; turnoverRank?: number }
interface SanseResp {
  ok: boolean; lastDate?: string;
  results?: Record<string, SanseHitRow[]>;
  records?: ResonanceRecord[];
}

const MIN_N = 100;
const BUY_SORTS_AVAILABLE_FROM_SESSION = new Set(['漲幅', '六條件總分', '成交額', '乖離率低']);

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
      // 目前封存 session 沒存量比／動能／換手率等回測 feature；不能假裝能重建那些排序。
      .filter(r => r.engine === 'sanse' || BUY_SORTS_AVAILABLE_FROM_SESSION.has(r.sortKey))
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
                <span className="text-zinc-500 mr-1">{i + 1}.</span>{stockDisplayName(p.name, p.symbol)} <span className="text-zinc-500">{p.symbol.replace(/\.(TW|TWO|SS|SZ)$/, '')}</span>
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
    const tier = row.strategyId.startsWith('tier_') ? row.strategyId.slice(5) : null;
    const direct = tier ? sanse.results?.[tier] : sanse.results?.[row.strategyId];
    if (direct && direct.length > 0) {
      return sortSansePicks(direct.map(h => ({
        symbol: h.symbol, name: h.name, price: h.price ?? null,
        changePct: h.changePct, shortAttack: h.shortAttack, turnoverRank: h.turnoverRank,
      })), row);
    }
    const bucket = row.strategyId.startsWith('bucket_') ? row.strategyId.slice(7) : null;
    // 具名策略 / 組合桶 → 從 records 衍生；不能把 leaderboard 的 bucket id 拿去比具名策略 id。
    const recs = (sanse.records ?? []).filter(r => {
      try {
        if (bucket) return bucketsForRecord(r).includes(bucket);
        return matchedStrategies(r.report).some(s => s.id === row.strategyId);
      } catch { return false; }
    });
    return sortSansePicks(recs.map(r => ({
      symbol: r.symbol, name: stockDisplayName(r.name, r.symbol), price: r.price ?? null,
      changePct: r.changePct, shortAttack: r.report.scores.shortAttack,
      turnoverRank: r.turnoverRank, report: r.report,
    })), row);
  }
  // 買法字母：先取日期索引，再明確帶 date 載完整 session；無 date 的 API 只回 metadata。
  try {
    const r = await fetch(`/api/scanner/results?market=${market}&direction=long&mtf=${encodeURIComponent(row.strategyId)}`);
    const j = await r.json();
    const sessions: Array<{ date: string; resultCount: number }> = j.sessions ?? [];
    for (const meta of sessions.filter(s => s.resultCount > 0).slice(0, 10)) {
      const detailRes = await fetch(`/api/scanner/results?market=${market}&direction=long&mtf=${encodeURIComponent(row.strategyId)}&date=${meta.date}`);
      const detail = await detailRes.json();
      const latest = detail.sessions?.[0] as { date: string; results?: StockScanResult[] } | undefined;
      if (!latest?.results?.length) continue;
      const sorted = sortBuyMethodResults(latest.results, row.sortKey);
      return sorted.map(s => ({ symbol: s.symbol, name: s.name, price: s.price ?? null, note: `${latest.date}・${row.sortLabel}` }));
    }
    return [];
  } catch { return []; }
}

function sortBuyMethodResults(items: StockScanResult[], sortKey: string): StockScanResult[] {
  const score = (r: StockScanResult): number => {
    if (sortKey === '六條件總分') return (r.sixConditionsScore ?? 0) * 10 + (r.changePercent ?? 0);
    if (sortKey === '成交額') return (r.volume ?? 0) * (r.price ?? 0);
    if (sortKey === '乖離率低') return -(r.ma20Deviation ?? Infinity);
    return r.changePercent ?? 0;
  };
  return [...items].sort((a, b) => score(b) - score(a));
}

function sortSansePicks(
  items: Array<Omit<PickView, 'note'> & { changePct?: number; shortAttack?: number; turnoverRank?: number; report?: ConditionReport }>,
  row: LeaderboardRow,
): PickView[] {
  const score = (x: (typeof items)[number]): number => {
    if (row.sortKey === '短攻') return x.shortAttack ?? x.report?.scores.shortAttack ?? -Infinity;
    if (row.sortKey === '成交額名次') return -(x.turnoverRank ?? Infinity);
    if (row.sortKey === '共振強度') return (x.report?.groupBuyCount ?? 0) * 100 + (x.report?.scores.shortAttack ?? 0);
    return x.changePct ?? -Infinity;
  };
  return items
    .sort((a, b) => score(b) - score(a))
    .map(x => ({ symbol: x.symbol, name: x.name, price: x.price, note: row.sortLabel }));
}
