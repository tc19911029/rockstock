'use client';

/**
 * /growth — 7000萬 → 3億 進度頁
 *
 * 讀 /api/portfolio/growth-status：
 *   - path（milestones、startCapital、targetCapital、monthlyRate）
 *   - progress（currentCapital、status：green/yellow/red、gapPct）
 *   - capital（cash + stockValue + 持倉數）
 *
 * 提供 3 個視角：
 *   1. Hero 大數字：當前資產 / 進度 % / 燈號 + message
 *   2. 月份里程碑表：應到 vs 實到（當前資金跟所有 milestone 對比）
 *   3. 軌跡折線：milestone 軌道 vs 當前位置（SVG 自畫，無 chart lib）
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { PageShell, PageHeader } from '@/components/shared';
import { formatNT } from '@/lib/portfolio/useTotalCapital';

interface Milestone { yearMonth: string; targetEnd: number }
interface Path {
  startDate: string; startCapital: number;
  targetDate: string; targetCapital: number;
  monthlyRate: number;
  milestones: Milestone[];
  notes?: string;
  warningBands: { yellowPct: number; redPct: number };
}
interface Progress {
  asOfDate: string;
  currentCapital: number;
  currentMonth: string;
  currentMonthTarget: number;
  gapPct: number;
  monthsRemaining: number;
  requiredMonthlyRate: number;
  status: 'green' | 'yellow' | 'red';
  message: string;
}
interface GrowthStatus {
  path: Path;
  progress: Progress;
  capital: { cash: number; stockValue: number; total: number; holdingsCount: number };
}

export default function GrowthPage() {
  const [data, setData] = useState<GrowthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    fetch('/api/portfolio/growth-status')
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (canceled) return;
        if (!j || !j.path || !j.progress) {
          setError('無 growth-path 資料；先設定起點/目標');
          return;
        }
        setData(j as GrowthStatus);
      })
      .catch(e => !canceled && setError(e instanceof Error ? e.message : 'fetch failed'));
    return () => { canceled = true; };
  }, []);

  const header = <PageHeader title="📈 7000萬 → 3億 進度" backButton subtitle="應到 vs 實到 + 月化需求 + 軌跡" />;

  if (error) {
    return (
      <PageShell headerSlot={header}>
        <div className="max-w-3xl mx-auto px-4 py-6 text-sm text-red-300">❌ {error}</div>
      </PageShell>
    );
  }
  if (!data) {
    return (
      <PageShell headerSlot={header}>
        <div className="max-w-3xl mx-auto px-4 py-6 text-sm text-muted-foreground">載入中…</div>
      </PageShell>
    );
  }

  const { path, progress, capital } = data;
  const totalPct = Math.max(0, Math.min(100,
    ((progress.currentCapital - path.startCapital) / (path.targetCapital - path.startCapital)) * 100
  ));
  const statusCls = {
    green:  'border-emerald-700/50 bg-emerald-900/20',
    yellow: 'border-amber-700/50 bg-amber-900/20',
    red:    'border-red-700/50 bg-red-900/20',
  }[progress.status];
  const statusEmoji = { green: '🟢', yellow: '🟡', red: '🔴' }[progress.status];

  return (
    <PageShell headerSlot={header}>
      <div className="max-w-5xl mx-auto px-4 py-4 space-y-4">

        {/* Hero */}
        <section className={`rounded-lg border-2 p-5 ${statusCls}`}>
          <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
            <div>
              <div className="text-xs text-muted-foreground mb-1">當前總資產 · {progress.asOfDate}</div>
              <div className="text-4xl font-bold font-mono text-foreground">
                {formatNT(progress.currentCapital)}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                現金 {formatNT(capital.cash)} · 持股 {formatNT(capital.stockValue)} ({capital.holdingsCount} 檔)
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs text-muted-foreground mb-1">目標 {path.targetDate}</div>
              <div className="text-2xl font-bold font-mono text-foreground/70">{formatNT(path.targetCapital)}</div>
              <div className="text-xs text-muted-foreground mt-1">剩 {progress.monthsRemaining} 個月</div>
            </div>
          </div>

          {/* 總進度條 */}
          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
              <span>起 {formatNT(path.startCapital)}</span>
              <span>{totalPct.toFixed(1)}%</span>
              <span>目標 {formatNT(path.targetCapital)}</span>
            </div>
            <div className="w-full h-3 bg-slate-800 rounded-full overflow-hidden">
              <div className="h-full bg-gradient-to-r from-sky-500 to-emerald-500 transition-all"
                style={{ width: `${totalPct}%` }} />
            </div>
          </div>

          {/* Status message */}
          <div className="mt-3 text-sm font-medium">
            <span className="mr-1">{statusEmoji}</span>
            {progress.message}
          </div>
        </section>

        {/* 月化需求 + risk band */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Card title="本月應到">
            <div className="text-xl font-bold font-mono">{formatNT(progress.currentMonthTarget)}</div>
            <div className="text-[10px] text-muted-foreground mt-1">{progress.currentMonth}</div>
          </Card>
          <Card title="剩餘月化需求">
            <div className="text-xl font-bold font-mono text-amber-300">
              {(progress.requiredMonthlyRate * 100).toFixed(2)}%
            </div>
            <div className="text-[10px] text-muted-foreground mt-1">
              要從現在到 {path.targetDate} 達標的每月複利率
            </div>
          </Card>
          <Card title="距本月目標">
            <div className={`text-xl font-bold font-mono ${progress.gapPct >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
              {progress.gapPct >= 0 ? '+' : ''}{(progress.gapPct * 100).toFixed(1)}%
            </div>
            <div className="text-[10px] text-muted-foreground mt-1">
              黃燈閾值 {(path.warningBands.yellowPct * 100).toFixed(0)}% · 紅燈 {(path.warningBands.redPct * 100).toFixed(0)}%
            </div>
          </Card>
        </section>

        {/* 軌跡 SVG */}
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-semibold text-foreground mb-3">📊 月份軌跡</h2>
          <MilestoneChart milestones={path.milestones} currentCapital={progress.currentCapital} currentMonth={progress.currentMonth} />
        </section>

        {/* 里程碑表 */}
        <section className="rounded-lg border border-border bg-card p-4 overflow-x-auto">
          <h2 className="text-sm font-semibold text-foreground mb-3">📋 月份里程碑</h2>
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="px-2 py-1 text-left">月份</th>
                <th className="px-2 py-1 text-right">應到</th>
                <th className="px-2 py-1 text-right">vs 現在</th>
                <th className="px-2 py-1 text-right">月增</th>
                <th className="px-2 py-1">狀態</th>
              </tr>
            </thead>
            <tbody>
              {path.milestones.map((m, i) => {
                const prev = i > 0 ? path.milestones[i - 1].targetEnd : path.startCapital;
                const monthGrowth = (m.targetEnd / prev - 1) * 100;
                const vsNow = m.targetEnd - progress.currentCapital;
                const isCurrent = m.yearMonth === progress.currentMonth;
                const isPast = m.yearMonth < progress.currentMonth;
                return (
                  <tr key={m.yearMonth} className={`border-b border-border ${
                    isCurrent ? 'bg-sky-900/20' : isPast ? 'opacity-50' : ''
                  }`}>
                    <td className="px-2 py-1.5 font-mono">{m.yearMonth}{isCurrent && ' ← 本月'}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{formatNT(m.targetEnd)}</td>
                    <td className={`px-2 py-1.5 text-right font-mono ${
                      vsNow > 0 ? 'text-red-300' : 'text-emerald-300'
                    }`}>
                      {vsNow > 0 ? `+${formatNT(vsNow)}` : vsNow === 0 ? '達標' : formatNT(vsNow)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">
                      +{monthGrowth.toFixed(1)}%
                    </td>
                    <td className="px-2 py-1.5 text-xs">
                      {isPast ? '已過' : isCurrent ? '🔥 本月' : '— 未到'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        {/* notes */}
        {path.notes && (
          <p className="text-xs text-muted-foreground italic">
            📝 {path.notes}
          </p>
        )}

        {/* 連結 */}
        <nav className="flex gap-2 flex-wrap text-xs pt-2 border-t border-border">
          <Link href="/today" className="text-sky-400 hover:underline">🌅 今日決策</Link>
          <Link href="/portfolio" className="text-sky-400 hover:underline">💼 持倉</Link>
          <Link href="/sizer" className="text-sky-400 hover:underline">📐 部位試算</Link>
          <Link href="/agents/portfolio" className="text-sky-400 hover:underline">🤖 持倉 review</Link>
        </nav>

        <p className="text-[9px] text-muted-foreground/60 italic">
          資料來源：data/portfolio/growth-path.json + holdings.json × 最新 K 線。
          要改起點/目標：POST /api/portfolio/growth-status with {`{ regen: true, startCapital, targetCapital, targetDate }`}
        </p>
      </div>
    </PageShell>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{title}</div>
      {children}
    </div>
  );
}

function MilestoneChart({ milestones, currentCapital, currentMonth }: {
  milestones: Milestone[]; currentCapital: number; currentMonth: string;
}) {
  if (milestones.length === 0) return <p className="text-xs text-muted-foreground">無里程碑</p>;
  const min = Math.min(...milestones.map(m => m.targetEnd), currentCapital);
  const max = Math.max(...milestones.map(m => m.targetEnd));
  const range = max - min || 1;
  const w = 800;
  const h = 200;
  const padX = 40;
  const padY = 25;
  const innerW = w - padX * 2;
  const innerH = h - padY * 2;
  const xOf = (i: number) => padX + (i / Math.max(1, milestones.length - 1)) * innerW;
  const yOf = (v: number) => padY + (1 - (v - min) / range) * innerH;

  const pathData = milestones.map((m, i) => `${i === 0 ? 'M' : 'L'}${xOf(i)},${yOf(m.targetEnd)}`).join(' ');
  const currentIdx = milestones.findIndex(m => m.yearMonth === currentMonth);
  const currentX = currentIdx >= 0 ? xOf(currentIdx) : padX;
  const currentY = yOf(currentCapital);

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full max-w-3xl mx-auto" preserveAspectRatio="xMidYMid meet">
        {/* milestone line */}
        <path d={pathData} fill="none" stroke="rgb(251 191 36)" strokeWidth="2" strokeDasharray="4,3" opacity="0.7" />
        {/* milestone dots */}
        {milestones.map((m, i) => (
          <g key={m.yearMonth}>
            <circle cx={xOf(i)} cy={yOf(m.targetEnd)} r="4" fill="rgb(251 191 36)" opacity="0.8" />
            <text x={xOf(i)} y={h - 6} textAnchor="middle" fontSize="10" fill="rgb(148 163 184)" fontFamily="monospace">
              {m.yearMonth.slice(5)}
            </text>
          </g>
        ))}
        {/* current position */}
        <line x1={currentX} y1={padY} x2={currentX} y2={h - padY} stroke="rgb(56 189 248)" strokeWidth="1" strokeDasharray="2,2" opacity="0.4" />
        <circle cx={currentX} cy={currentY} r="6" fill="rgb(56 189 248)" />
        <text x={currentX + 8} y={currentY + 4} fontSize="11" fill="rgb(56 189 248)" fontFamily="monospace" fontWeight="bold">
          現在
        </text>
        {/* Y axis labels (start + target) */}
        <text x="4" y={yOf(max) + 4} fontSize="9" fill="rgb(148 163 184)" fontFamily="monospace">
          {(max / 1_000_000).toFixed(0)}M
        </text>
        <text x="4" y={yOf(min) + 4} fontSize="9" fill="rgb(148 163 184)" fontFamily="monospace">
          {(min / 1_000_000).toFixed(0)}M
        </text>
      </svg>
      <div className="flex items-center justify-center gap-4 text-[10px] text-muted-foreground mt-1">
        <span><span className="inline-block w-3 h-0.5 bg-amber-400 mr-1 align-middle" />應到軌跡（黃線）</span>
        <span><span className="inline-block w-2.5 h-2.5 rounded-full bg-sky-400 mr-1 align-middle" />當前位置</span>
      </div>
    </div>
  );
}
