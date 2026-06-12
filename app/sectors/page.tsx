'use client';

/**
 * /sectors — 板塊（題材）強弱排名頁（2026-06-12 A2）
 *
 * 顯示層參考：25 題材的今日/5/20/60 日聚合報酬、廣度、法人 5 日合計、6 階段分類。
 * 不參與選股（鐵則 #5）— 用途是回答「今天資金流向哪些題材」「哪個板塊是主流」。
 * 資料：/api/themes/ranking（盤後 17:10 cron 產出，data/sectors/TW/{date}.json）。
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface ThemeStockPerf {
  code: string; name: string;
  d1: number | null; d5: number | null; d20: number | null; d60: number | null;
  volRatio: number | null; instNet5: number | null;
}
interface ThemeRank {
  theme: string; stockCount: number;
  avgD1: number | null; avgD5: number | null; avgD20: number | null; avgD60: number | null;
  avgVolRatio: number | null; breadth: number | null; instNet5: number | null;
  stage: string;
  topStock: { code: string; name: string; d1: number } | null;
  members: ThemeStockPerf[];
}
interface RankingFile { date: string; generatedAt: string; themes: ThemeRank[] }

const STAGE_STYLE: Record<string, string> = {
  '剛啟動': 'bg-emerald-900/60 text-emerald-300',
  '主升段': 'bg-red-900/60 text-red-300',
  '高潮噴出': 'bg-orange-900/60 text-orange-300',
  '震盪換手': 'bg-yellow-900/60 text-yellow-300',
  '退潮': 'bg-slate-700/60 text-slate-300',
  '補跌': 'bg-green-900/60 text-green-300',
  '盤整': 'bg-slate-800/60 text-slate-400',
};

function Pct({ v }: { v: number | null }) {
  if (v == null) return <span className="text-slate-600">—</span>;
  const cls = v > 0 ? 'text-red-400' : v < 0 ? 'text-green-400' : 'text-slate-400';
  return <span className={cls}>{v > 0 ? '+' : ''}{v.toFixed(1)}%</span>;
}

function Lots({ v }: { v: number | null }) {
  if (v == null) return <span className="text-slate-600">—</span>;
  const cls = v > 0 ? 'text-red-400' : v < 0 ? 'text-green-400' : 'text-slate-400';
  const abs = Math.abs(v);
  const text = abs >= 10000 ? `${(v / 10000).toFixed(1)}萬` : `${v}`;
  return <span className={cls}>{v > 0 ? '+' : ''}{text}</span>;
}

export default function SectorsPage() {
  const [data, setData] = useState<RankingFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/themes/ranking')
      .then(r => r.json())
      .then(j => {
        if (j.ok === false) throw new Error(j.error ?? '載入失敗');
        setData((j.data ?? j) as RankingFile);
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-4 md:p-6">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-baseline justify-between mb-1">
          <h1 className="text-xl font-bold">板塊強弱排名</h1>
          <Link href="/" className="text-sm text-sky-400 hover:underline">← 回看盤台</Link>
        </div>
        <p className="text-xs text-slate-500 mb-4">
          25 題材聚合報酬（成分股單純平均）· 預設按 5 日排序 · 階段為顯示用分類，不參與選股
          {data && <span className="ml-2 text-slate-600">資料日 {data.date}</span>}
        </p>

        {error && <div className="text-amber-400 text-sm py-8">⚠ {error}（盤後 17:10 cron 產出，可先手動跑 compute-sector-strength）</div>}
        {!data && !error && <div className="text-slate-500 text-sm py-8">載入中…</div>}

        {data && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-slate-500 text-xs border-b border-slate-800">
                  <th className="text-left py-2 pr-2">#</th>
                  <th className="text-left py-2 pr-3">題材</th>
                  <th className="text-right py-2 px-2">今日</th>
                  <th className="text-right py-2 px-2">5日</th>
                  <th className="text-right py-2 px-2">20日</th>
                  <th className="text-right py-2 px-2">60日</th>
                  <th className="text-right py-2 px-2">廣度</th>
                  <th className="text-right py-2 px-2">法人5日(張)</th>
                  <th className="text-center py-2 px-2">階段</th>
                  <th className="text-left py-2 pl-2">當日最強</th>
                </tr>
              </thead>
              <tbody>
                {data.themes.map((t, i) => (
                  <SectorRow key={t.theme} t={t} rank={i + 1}
                    expanded={expanded === t.theme}
                    onToggle={() => setExpanded(expanded === t.theme ? null : t.theme)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function SectorRow({ t, rank, expanded, onToggle }: {
  t: ThemeRank; rank: number; expanded: boolean; onToggle: () => void;
}) {
  return (
    <>
      <tr onClick={onToggle}
        className="border-b border-slate-800/60 hover:bg-slate-900/60 cursor-pointer">
        <td className="py-2 pr-2 text-slate-500">{rank}</td>
        <td className="py-2 pr-3 font-medium">
          {t.theme}
          <span className="ml-1 text-xs text-slate-600">({t.stockCount})</span>
        </td>
        <td className="text-right px-2"><Pct v={t.avgD1} /></td>
        <td className="text-right px-2"><Pct v={t.avgD5} /></td>
        <td className="text-right px-2"><Pct v={t.avgD20} /></td>
        <td className="text-right px-2"><Pct v={t.avgD60} /></td>
        <td className="text-right px-2 text-slate-400">
          {t.breadth != null ? `${Math.round(t.breadth * 100)}%` : '—'}
        </td>
        <td className="text-right px-2"><Lots v={t.instNet5} /></td>
        <td className="text-center px-2">
          <span className={`text-xs px-1.5 py-0.5 rounded ${STAGE_STYLE[t.stage] ?? STAGE_STYLE['盤整']}`}>
            {t.stage}
          </span>
        </td>
        <td className="py-2 pl-2 text-slate-300">
          {t.topStock ? (
            <Link href={`/?load=${t.topStock.code}`} className="hover:text-sky-400"
              onClick={e => e.stopPropagation()}>
              {t.topStock.name} <Pct v={t.topStock.d1} />
            </Link>
          ) : '—'}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-slate-900/40">
          <td colSpan={10} className="px-4 py-2">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-1 text-xs">
              {t.members.map(m => (
                <div key={m.code} className="flex justify-between gap-2">
                  <Link href={`/?load=${m.code}`} className="text-slate-300 hover:text-sky-400">
                    {m.name} <span className="text-slate-600">{m.code}</span>
                  </Link>
                  <span>
                    <Pct v={m.d1} /> <span className="text-slate-600">/5日</span> <Pct v={m.d5} />
                  </span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
