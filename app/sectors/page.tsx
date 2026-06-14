'use client';

/**
 * /sectors — 板塊（題材）強弱排名頁（2026-06-12 A2；2026-06-14 套用統一版面）
 *
 * 顯示層參考：25 題材的今日/5/20/60 日聚合報酬、廣度、法人 5 日合計、6 階段分類。
 * 不參與選股（鐵則 #5）— 用途是回答「今天資金流向哪些題材」「哪個板塊是主流」。
 * 資料：/api/themes/ranking（盤後 17:10 cron 產出，data/sectors/TW/{date}.json）。
 *
 * 版面：統一走 PageShell + PageHeader + 主題 CSS 變數（不再寫死深灰固定底色，主題切換不會壞）。
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { PageShell, PageHeader, EmptyState } from '@/components/shared';
import { bullBearClass } from '@/lib/format';

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

// 階段 badge — 用主題友善的色階（半透明底 + 邊框，深淺主題皆可讀）
const STAGE_STYLE: Record<string, string> = {
  '剛啟動': 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  '主升段': 'bg-red-500/15 text-red-400 border-red-500/30',
  '高潮噴出': 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  '震盪換手': 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  '退潮': 'bg-muted text-muted-foreground border-border',
  '補跌': 'bg-green-500/15 text-green-400 border-green-500/30',
  '盤整': 'bg-secondary text-muted-foreground border-border',
};

function Pct({ v }: { v: number | null }) {
  if (v == null) return <span className="text-muted-foreground/50">—</span>;
  return <span className={bullBearClass(v)}>{v > 0 ? '+' : ''}{v.toFixed(1)}%</span>;
}

function Lots({ v }: { v: number | null }) {
  if (v == null) return <span className="text-muted-foreground/50">—</span>;
  const abs = Math.abs(v);
  const text = abs >= 10000 ? `${(v / 10000).toFixed(1)}萬` : `${v}`;
  return <span className={bullBearClass(v)}>{v > 0 ? '+' : ''}{text}</span>;
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
    <PageShell
      headerSlot={
        <PageHeader
          title="📊 板塊強弱排名"
          subtitle={data ? `資料日 ${data.date} · 25 題材 · 預設按 5 日` : '25 題材聚合報酬'}
          backButton
        />
      }
    >
      <div className="p-4 space-y-3">
        <p className="text-xs text-muted-foreground">
          25 題材聚合報酬（成分股單純平均）· 階段為顯示用分類，<b>不參與選股</b>。
          <span className="text-bull">紅</span>=漲、<span className="text-bear">綠</span>=跌。點一列看成分股。
        </p>

        {error && (
          <EmptyState icon="⚠️" title="尚未產生資料" description={`${error}（盤後 17:10 cron 產出，可先手動跑 compute-sector-strength）`} />
        )}
        {!data && !error && (
          <div className="text-muted-foreground text-sm py-12 text-center animate-pulse">載入中…</div>
        )}

        {data && (
          <div className="rounded-xl ring-1 ring-foreground/10 bg-card/60 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground text-xs border-b border-border bg-secondary/30">
                    <th className="text-left py-2.5 pl-3 pr-2 font-medium">#</th>
                    <th className="text-left py-2.5 pr-3 font-medium">題材</th>
                    <th className="text-right py-2.5 px-2 font-medium">今日</th>
                    <th className="text-right py-2.5 px-2 font-medium">5日</th>
                    <th className="text-right py-2.5 px-2 font-medium">20日</th>
                    <th className="text-right py-2.5 px-2 font-medium">60日</th>
                    <th className="text-right py-2.5 px-2 font-medium">廣度</th>
                    <th className="text-right py-2.5 px-2 font-medium">法人5日(張)</th>
                    <th className="text-center py-2.5 px-2 font-medium">階段</th>
                    <th className="text-left py-2.5 pl-2 pr-3 font-medium">當日最強</th>
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
          </div>
        )}
      </div>
    </PageShell>
  );
}

function SectorRow({ t, rank, expanded, onToggle }: {
  t: ThemeRank; rank: number; expanded: boolean; onToggle: () => void;
}) {
  return (
    <>
      <tr onClick={onToggle}
        className="border-b border-border last:border-0 hover:bg-muted/40 cursor-pointer transition-colors">
        <td className="py-2.5 pl-3 pr-2 text-muted-foreground">{rank}</td>
        <td className="py-2.5 pr-3 font-medium">
          {t.theme}
          <span className="ml-1 text-xs text-muted-foreground/60">({t.stockCount})</span>
        </td>
        <td className="text-right px-2 font-mono tabular-nums"><Pct v={t.avgD1} /></td>
        <td className="text-right px-2 font-mono tabular-nums"><Pct v={t.avgD5} /></td>
        <td className="text-right px-2 font-mono tabular-nums"><Pct v={t.avgD20} /></td>
        <td className="text-right px-2 font-mono tabular-nums"><Pct v={t.avgD60} /></td>
        <td className="text-right px-2 text-muted-foreground font-mono tabular-nums">
          {t.breadth != null ? `${Math.round(t.breadth * 100)}%` : '—'}
        </td>
        <td className="text-right px-2 font-mono tabular-nums"><Lots v={t.instNet5} /></td>
        <td className="text-center px-2">
          <span className={`text-xs px-1.5 py-0.5 rounded border ${STAGE_STYLE[t.stage] ?? STAGE_STYLE['盤整']}`}>
            {t.stage}
          </span>
        </td>
        <td className="py-2.5 pl-2 pr-3 text-foreground/80">
          {t.topStock ? (
            <Link href={`/?load=${t.topStock.code}`} className="hover:text-sky-400"
              onClick={e => e.stopPropagation()}>
              {t.topStock.name} <Pct v={t.topStock.d1} />
            </Link>
          ) : '—'}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-muted/20">
          <td colSpan={10} className="px-4 py-3">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-1.5 text-xs">
              {t.members.map(m => (
                <div key={m.code} className="flex justify-between gap-2">
                  <Link href={`/?load=${m.code}`} className="text-foreground/80 hover:text-sky-400">
                    {m.name} <span className="text-muted-foreground/60">{m.code}</span>
                  </Link>
                  <span className="font-mono tabular-nums">
                    <Pct v={m.d1} /> <span className="text-muted-foreground/60">/5日</span> <Pct v={m.d5} />
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
