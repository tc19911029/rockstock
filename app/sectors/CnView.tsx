'use client';

/**
 * /sectors 陸股視圖（?market=CN）— 2026-06-19
 *
 * 東方財富現成的行業/概念板塊（盤後 cn-agents-eod 已存）+ 人氣榜 + 漲停池，做成跟台股
 * /sectors 一樣的「熱門板塊（可排序/看輪動/點開逐檔績效）+ 今日熱點」。純顯示層，不參與選股（鐵則 #5）。
 *
 * 自帶小 primitive（Pct/Amt/RankBadge/RotationCell/SortTh/CnPerfGrid），刻意不耦合台股
 * page.tsx 的元件（那邊有法人金額視角等 WIP，分開避免互相牽動）。
 *
 *   熱門板塊（mode=fixed）：概念/行業切換 → 板塊表（輪動/今日/5日/主力淨流入/漲停/領漲股/階段），
 *     點欄位標題排序，點一列 lazy 抓成分股 1~10/20 日績效（/api/cn-sectors/board-members）。
 *   今日熱點（mode=hot）：人氣榜（東財關注度 top100）+ 漲停/炸板池。
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { EmptyState } from '@/components/shared';
import { applySort } from '@/lib/sorting/sortEngine';
import type { SortDir } from '@/lib/sorting/registry';
import { bullBearClass } from '@/lib/format';
import { PERF_PERIODS } from '@/lib/themes/perfPeriods';
import { FlowRotationBoards, type RankItem } from './RankBoards';

// ── 型別（對齊 /api/cn-sectors/* 回傳）─────────────────────────────────────────

interface CnRotation { rankNow?: number; rankPrev?: number | null; rankDelta: number | null; bucket: 'in' | 'mid' | 'out' }
interface CnBoard {
  code: string; name: string; kind: 'industry' | 'concept';
  pct: number; turnoverCny: number | null; mainNetCny: number | null;
  upCount: number | null; downCount: number | null;
  leaderSymbol: string | null; leaderName: string | null; leaderPct: number | null;
  limitUpCount: number | null; rank: number; pct5d: number | null;
  rotation: CnRotation | null; stage: string;
}
interface CnRankingFile { date: string; priorDate: string | null; concepts: CnBoard[]; industries: CnBoard[] }

interface CnMemberPerf { code: string; name: string; symbol: string; changePercent: number; turnoverCny: number | null; rets: (number | null)[] }
interface CnMembersFile { boardCode: string; date: string; totalMembers: number; shown: number; members: CnMemberPerf[] }

interface HotRankEntry { symbol: string; name: string | null; rank: number; rankChange: number | null; daysInTop100: number }
interface LimitUpEntry { symbol: string; name: string; board: string; pct: number; close: number; consecBoards: number; boardsPattern: string | null; industry: string | null; firstSealTime: string | null; isOneWord: boolean; isST: boolean }
interface BrokenEntry { symbol: string; name: string; board: string; pct: number; brokenTimes: number | null; industry: string | null; isST: boolean }
interface CnHotFile { date: string; hotRank: HotRankEntry[]; limitUp: LimitUpEntry[]; broken: BrokenEntry[] }

type Mode = 'fixed' | 'hot';

const STAGE_STYLE: Record<string, string> = {
  '剛啟動': 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  '主升段': 'bg-red-500/15 text-red-400 border-red-500/30',
  '高潮噴出': 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  '退潮': 'bg-muted text-muted-foreground border-border',
  '盤整': 'bg-secondary text-muted-foreground border-border',
};

/** 6 位裸碼 → 帶後綴 symbol（走圖 ?load 用）。6/9→.SS、0/2/3→.SZ、4/8→.BJ */
function toFullSymbol(code: string, board?: string): string {
  if (board) {
    if (board === 'SH-main' || board === 'STAR') return `${code}.SS`;
    if (board === 'BJ') return `${code}.BJ`;
    if (board === 'SZ-main' || board === 'ChiNext') return `${code}.SZ`;
  }
  const c = code[0];
  if (c === '6' || c === '9') return `${code}.SS`;
  if (c === '0' || c === '2' || c === '3') return `${code}.SZ`;
  return `${code}.BJ`;
}

// ── 小 primitive ─────────────────────────────────────────────────────────────

function Pct({ v }: { v: number | null }) {
  if (v == null) return <span className="text-muted-foreground/40">—</span>;
  const a = Math.abs(v);
  if (a < 1) return <span className="text-muted-foreground/55 tabular-nums">{v > 0 ? '+' : ''}{v.toFixed(1)}%</span>;
  const tone = a >= 12 ? 'font-semibold' : a >= 5 ? 'opacity-90' : 'opacity-55';
  return <span className={`${bullBearClass(v)} ${tone} tabular-nums`}>{v > 0 ? '+' : ''}{v.toFixed(1)}%</span>;
}

// 主力淨流入（元 → 億/萬）。流入(+)=紅、流出=綠；接近 0 灰。
function Amt({ v }: { v: number | null }) {
  if (v == null) return <span className="text-muted-foreground/40">—</span>;
  const a = Math.abs(v);
  const text = a >= 1e8 ? `${(v / 1e8).toFixed(1)}億` : a >= 1e4 ? `${Math.round(v / 1e4)}萬` : `${Math.round(v)}`;
  if (a < 1e7) return <span className="text-muted-foreground/55 tabular-nums">{v > 0 ? '+' : ''}{text}</span>;
  return <span className={`${bullBearClass(v)} tabular-nums`}>{v > 0 ? '+' : ''}{text}</span>;
}

function RankBadge({ rank }: { rank: number }) {
  if (rank <= 3) {
    const tone = ['bg-orange-500/20 text-orange-400 ring-orange-500/30',
      'bg-amber-500/15 text-amber-400 ring-amber-500/25',
      'bg-yellow-500/15 text-yellow-500 ring-yellow-500/25'][rank - 1];
    return <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-semibold ring-1 ${tone} tabular-nums`}>{rank}</span>;
  }
  return <span className="inline-flex items-center justify-center w-6 text-sm text-muted-foreground/50 tabular-nums">{rank}</span>;
}

function RotationCell({ r }: { r?: CnRotation | null }) {
  const move = r?.rankPrev != null && r?.rankNow != null ? `${r.rankPrev}→${r.rankNow}名` : '';
  if (r?.bucket === 'in') return <span className="text-xs whitespace-nowrap" title="5日強弱名次往上爬＝資金流進（描述用，非買賣訊號）">🟢 資金流進 <span className="text-muted-foreground/70">{move}</span></span>;
  if (r?.bucket === 'out') return <span className="text-xs whitespace-nowrap" title="5日強弱名次往下掉＝資金流出（描述用，非買賣訊號）">🔴 資金流出 <span className="text-muted-foreground/70">{move}</span></span>;
  if (r?.rankNow != null) return <span className="text-xs whitespace-nowrap text-muted-foreground/65" title="名次沒大變動，資金沒明顯進出">{r.rankNow <= 3 ? '🔥 ' : ''}第{r.rankNow}名</span>;
  return <span className="text-xs text-muted-foreground/45 whitespace-nowrap">—</span>;
}

function SortTh({ id, label, sortId, dir, onSort, align = 'right' }: {
  id: string; label: string; sortId: string; dir: SortDir; onSort: (id: string) => void; align?: 'left' | 'right' | 'center';
}) {
  const active = sortId === id;
  const a = align === 'left' ? 'text-left' : align === 'center' ? 'text-center' : 'text-right';
  return (
    <th onClick={() => onSort(id)}
      className={`py-2.5 px-2 font-medium cursor-pointer select-none hover:text-foreground whitespace-nowrap ${a} ${active ? 'text-sky-400' : ''}`}>
      {label}{active ? (dir === 'desc' ? ' ▼' : ' ▲') : ''}
    </th>
  );
}

// ── 成分股績效格（1~10,20 日滾動報酬；標發動最猛那段）────────────────────────

function CnPerfGrid({ file }: { file: CnMembersFile | 'loading' | 'error' | undefined }) {
  const [sortId, setSortId] = useState('r5');
  const [dir, setDir] = useState<SortDir>('desc');
  const idxOf = (p: number) => (PERF_PERIODS as readonly number[]).indexOf(p);
  const periodIndex = (id: string) => idxOf(Number(id.slice(1)));

  if (file === 'loading' || file === undefined) {
    return <div className="bg-muted/15 border-t border-border px-3 py-4 text-xs text-muted-foreground animate-pulse">抓成分股 + 算近 1~20 日績效中…</div>;
  }
  if (file === 'error') {
    return <div className="bg-muted/15 border-t border-border px-3 py-4 text-xs text-muted-foreground">成分股載入失敗，稍後再試。</div>;
  }
  if (file.members.length === 0) {
    return <div className="bg-muted/15 border-t border-border px-3 py-4 text-xs text-muted-foreground">抓不到這個板塊的成分股。</div>;
  }

  const activeIdx = periodIndex(sortId);
  const sorted = applySort(file.members, sortId, dir, (m, id) => m.rets?.[periodIndex(id)] ?? null, { missingLast: true });
  const sortBy = (id: string) => { if (sortId === id) setDir(dir === 'desc' ? 'asc' : 'desc'); else { setSortId(id); setDir('desc'); } };
  const hottest = (m: CnMemberPerf): number | null => {
    let best = 0, bp: number | null = null;
    for (const p of PERF_PERIODS) { const v = m.rets?.[idxOf(p)]; if (v != null && v > 0 && v / p > best) { best = v / p; bp = p; } }
    return bp;
  };

  return (
    <div className="bg-muted/15 border-t border-border">
      <div className="px-3 py-2 text-[10px] text-muted-foreground/60 flex items-center gap-2 flex-wrap">
        <span>過去 N 日漲幅（前復權）· <span className="text-muted-foreground/45">🔸框＝發動最猛那段</span></span>
        {file.totalMembers > file.shown && <span className="text-muted-foreground/45">成分股 {file.totalMembers} 檔，依成交額顯示前 {file.shown} 檔</span>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs min-w-[720px]">
          <thead>
            <tr className="text-muted-foreground/50 text-[10px] border-b border-border/40">
              <th className="text-left font-medium pl-3 pr-2 py-2 sticky left-0 bg-card z-10">個股</th>
              <th className="text-right font-medium px-2 py-2">今日</th>
              {PERF_PERIODS.map((p) => (
                <th key={p} onClick={() => sortBy(`r${p}`)}
                  className={`text-right font-medium px-2 py-2 tabular-nums cursor-pointer select-none hover:text-foreground ${idxOf(p) === activeIdx ? 'text-sky-400' : ''}`}>
                  {p}日{idxOf(p) === activeIdx ? (dir === 'desc' ? ' ▼' : ' ▲') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((m) => {
              const hot = hottest(m);
              return (
                <tr key={m.code} className="border-b border-border/25 last:border-0 hover:bg-muted/40 transition-colors">
                  <td className="pl-3 pr-2 py-1.5 sticky left-0 bg-card">
                    <div className="flex items-center gap-1.5 whitespace-nowrap">
                      <Link href={`/?load=${m.symbol}`} className="hover:text-sky-400 inline-flex items-center gap-1.5">
                        <span className="text-foreground/90">{m.name}</span>
                        <span className="text-muted-foreground/50">{m.code}</span>
                      </Link>
                      <Link href={`/?load=${m.symbol}`} title="走圖"
                        className="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-sky-400 hover:border-sky-400/40">走圖</Link>
                    </div>
                  </td>
                  <td className="text-right px-2 py-1.5 font-mono tabular-nums"><Pct v={m.changePercent} /></td>
                  {PERF_PERIODS.map((p) => {
                    const i = idxOf(p);
                    return (
                      <td key={p} className={`text-right px-2 py-1.5 font-mono tabular-nums ${i === activeIdx ? 'bg-sky-500/5' : ''}`}>
                        <span className={p === hot ? 'ring-1 ring-amber-400/50 rounded px-1 py-0.5' : ''}><Pct v={m.rets?.[i] ?? null} /></span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── 板塊表（熱門板塊模式）──────────────────────────────────────────────────────

function BoardTable({ boards, date }: { boards: CnBoard[]; date: string }) {
  const [sortId, setSortId] = useState('pct');
  const [dir, setDir] = useState<SortDir>('desc');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [members, setMembers] = useState<Record<string, CnMembersFile | 'loading' | 'error'>>({});

  const sortBy = (id: string) => { if (sortId === id) setDir(dir === 'desc' ? 'asc' : 'desc'); else { setSortId(id); setDir('desc'); } };
  const sorted = applySort(boards, sortId, dir,
    (b, id) => id === 'pct' ? b.pct : id === 'pct5d' ? b.pct5d : id === 'main' ? b.mainNetCny : id === 'limitup' ? b.limitUpCount : id === 'rot' ? (b.rotation?.rankDelta ?? null) : null,
    { missingLast: true });

  const toggle = (code: string) => {
    if (expanded === code) { setExpanded(null); return; }
    setExpanded(code);
    if (!members[code]) {
      setMembers((m) => ({ ...m, [code]: 'loading' }));
      fetch(`/api/cn-sectors/board-members?code=${code}&date=${date}`)
        .then(r => r.json())
        .then(j => {
          if (j.ok === false) throw new Error(j.error ?? '載入失敗');
          setMembers((m) => ({ ...m, [code]: (j as CnMembersFile) }));
        })
        .catch(() => setMembers((m) => ({ ...m, [code]: 'error' })));
    }
  };

  return (
    <div className="rounded-xl ring-1 ring-foreground/10 bg-card/60 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted-foreground text-xs border-b border-border bg-secondary/30">
              <th className="text-left py-2.5 pl-3 pr-2 font-medium">#</th>
              <th className="text-left py-2.5 pr-3 font-medium">板塊</th>
              <SortTh id="rot" label="輪動" sortId={sortId} dir={dir} onSort={sortBy} align="left" />
              <SortTh id="pct" label="今日" sortId={sortId} dir={dir} onSort={sortBy} />
              <SortTh id="pct5d" label="5日" sortId={sortId} dir={dir} onSort={sortBy} />
              <SortTh id="main" label="主力淨流入" sortId={sortId} dir={dir} onSort={sortBy} />
              <SortTh id="limitup" label="漲停" sortId={sortId} dir={dir} onSort={sortBy} />
              <th className="text-center py-2.5 px-2 font-medium">階段</th>
              <th className="text-left py-2.5 pl-2 pr-3 font-medium">領漲股</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((b, i) => (
              <BoardRow key={b.code} b={b} rank={i + 1} expanded={expanded === b.code}
                onToggle={() => toggle(b.code)} membersFile={members[b.code]} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BoardRow({ b, rank, expanded, onToggle, membersFile }: {
  b: CnBoard; rank: number; expanded: boolean; onToggle: () => void; membersFile?: CnMembersFile | 'loading' | 'error';
}) {
  return (
    <>
      <tr onClick={onToggle}
        className={`border-b border-border last:border-0 hover:bg-muted/40 cursor-pointer transition-colors ${expanded ? 'bg-muted/30' : ''}`}>
        <td className="py-3 pl-3 pr-1"><RankBadge rank={rank} /></td>
        <td className="py-3 pr-3">
          <div className="flex items-center gap-1.5">
            <span className={`text-muted-foreground/40 transition-transform ${expanded ? 'rotate-90' : ''}`}>›</span>
            <span className="font-medium">{b.name}</span>
            {b.upCount != null && <span className="text-xs text-muted-foreground/50">{b.upCount}漲</span>}
          </div>
        </td>
        <td className="px-2"><RotationCell r={b.rotation} /></td>
        <td className="text-right px-2 font-mono tabular-nums"><Pct v={b.pct} /></td>
        <td className="text-right px-2 font-mono tabular-nums"><Pct v={b.pct5d} /></td>
        <td className="text-right px-2 font-mono tabular-nums"><Amt v={b.mainNetCny} /></td>
        <td className="text-right px-2 text-muted-foreground font-mono tabular-nums">{b.limitUpCount != null && b.limitUpCount > 0 ? `${b.limitUpCount}` : '—'}</td>
        <td className="text-center px-2">
          <span className={`text-xs px-1.5 py-0.5 rounded border ${STAGE_STYLE[b.stage] ?? STAGE_STYLE['盤整']}`}>{b.stage}</span>
        </td>
        <td className="py-3 pl-2 pr-3 text-foreground/80">
          {b.leaderName && b.leaderSymbol ? (
            <Link href={`/?load=${toFullSymbol(b.leaderSymbol)}`} className="hover:text-sky-400 whitespace-nowrap" onClick={e => e.stopPropagation()}>
              {b.leaderName} <Pct v={b.leaderPct} />
            </Link>
          ) : '—'}
        </td>
      </tr>
      {expanded && (
        <tr><td colSpan={9} className="p-0"><CnPerfGrid file={membersFile} /></td></tr>
      )}
    </>
  );
}

function FixedView({ date, concepts, industries }: { date: string; concepts: CnBoard[]; industries: CnBoard[] }) {
  const [kind, setKind] = useState<'concept' | 'industry'>('concept');
  const boards = kind === 'concept' ? concepts : industries;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        東方財富現成的板塊強弱（不是自選題材）· 階段為顯示用分類，<b>不參與選股</b>。
        <span className="text-bull">紅</span>=漲、<span className="text-bear">綠</span>=跌。<b>點欄位標題排序</b>，點一列看成分股近 1~20 日績效。
        「輪動」= 用近 5 日漲幅互相排名次，往上 <b>🟢 資金流進</b>、往下 <b>🔴 資金流出</b>（描述用，別當買賣訊號）。
      </p>
      <div className="inline-flex rounded-lg border border-border bg-secondary/30 p-0.5 text-sm">
        <button onClick={() => setKind('concept')}
          className={`px-3 py-1.5 rounded-md transition-colors ${kind === 'concept' ? 'bg-card text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}>概念 {concepts.length}</button>
        <button onClick={() => setKind('industry')}
          className={`px-3 py-1.5 rounded-md transition-colors ${kind === 'industry' ? 'bg-card text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}>行業 {industries.length}</button>
      </div>
      {boards.length > 0 && (
        <FlowRotationBoards
          moneyLabel="主力淨流入"
          items={boards.map((b): RankItem => ({
            key: b.code, name: b.name,
            pct: b.pct5d, money: b.mainNetCny,
            rotDelta: b.rotation?.rankDelta ?? null,
            rotPrev: b.rotation?.rankPrev ?? null,
            rotNow: b.rotation?.rankNow ?? null,
          }))}
        />
      )}
      {boards.length > 0
        ? <BoardTable boards={boards} date={date} />
        : <EmptyState icon="🔍" title="沒有板塊資料" description="這天的板塊快照可能沒抓到（歷史日無當日板塊）" />}
    </div>
  );
}

// ── 今日熱點（人氣榜 + 漲停/炸板池）───────────────────────────────────────────

function HotView({ hot }: { hot: CnHotFile }) {
  const [showBroken, setShowBroken] = useState(false);
  const limitUp = [...hot.limitUp].sort((a, b) => (b.consecBoards - a.consecBoards) || (b.pct - a.pct));

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        <b>人氣榜</b> = 東財關注度排名（誰最多人看）；<b>漲停池</b> = 今日封板的股（連板＝連續漲停天數）。
        <span className="text-bull">紅</span>=漲。純看熱度，<b>不是買賣訊號</b>。
      </p>

      {/* 人氣榜 */}
      <section className="space-y-2">
        <h3 className="text-sm font-medium">🔥 人氣榜（關注度 Top {hot.hotRank.length}）</h3>
        {hot.hotRank.length === 0 ? <EmptyState icon="😴" title="今天沒有人氣榜資料" /> : (
          <div className="rounded-xl ring-1 ring-foreground/10 bg-card/60 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground text-xs border-b border-border bg-secondary/30">
                    <th className="text-left py-2.5 pl-3 pr-2 font-medium">#</th>
                    <th className="text-left py-2.5 pr-3 font-medium">股票</th>
                    <th className="text-right py-2.5 px-2 font-medium">名次變化</th>
                    <th className="text-right py-2.5 pl-2 pr-3 font-medium">連續在榜</th>
                  </tr>
                </thead>
                <tbody>
                  {hot.hotRank.slice(0, 50).map((e) => (
                    <tr key={e.symbol} className="border-b border-border last:border-0 hover:bg-muted/40 transition-colors">
                      <td className="py-2.5 pl-3 pr-1"><RankBadge rank={e.rank} /></td>
                      <td className="py-2.5 pr-3">
                        <Link href={`/?load=${toFullSymbol(e.symbol)}`} className="hover:text-sky-400 whitespace-nowrap inline-flex items-center gap-1.5">
                          <span className="text-foreground/90">{e.name ?? e.symbol}</span>
                          <span className="text-muted-foreground/50 text-xs">{e.symbol}</span>
                        </Link>
                      </td>
                      <td className="text-right px-2 font-mono tabular-nums text-xs">
                        {e.rankChange == null || e.rankChange === 0 ? <span className="text-muted-foreground/40">—</span>
                          : <span className={e.rankChange > 0 ? 'text-bull' : 'text-bear'}>{e.rankChange > 0 ? `↑${e.rankChange}` : `↓${-e.rankChange}`}</span>}
                      </td>
                      <td className="text-right pl-2 pr-3 text-muted-foreground font-mono tabular-nums">{e.daysInTop100} 天</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* 漲停池 */}
      <section className="space-y-2">
        <h3 className="text-sm font-medium">📈 漲停池（{limitUp.length} 檔封板）</h3>
        {limitUp.length === 0 ? <EmptyState icon="😴" title="今天沒有漲停" /> : (
          <div className="rounded-xl ring-1 ring-foreground/10 bg-card/60 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground text-xs border-b border-border bg-secondary/30">
                    <th className="text-left py-2.5 pl-3 pr-3 font-medium">股票</th>
                    <th className="text-right py-2.5 px-2 font-medium">漲幅</th>
                    <th className="text-right py-2.5 px-2 font-medium">連板</th>
                    <th className="text-left py-2.5 px-2 font-medium">行業</th>
                    <th className="text-right py-2.5 pl-2 pr-3 font-medium">封板</th>
                  </tr>
                </thead>
                <tbody>
                  {limitUp.map((e) => (
                    <tr key={e.symbol} className="border-b border-border last:border-0 hover:bg-muted/40 transition-colors">
                      <td className="py-2.5 pl-3 pr-3">
                        <Link href={`/?load=${toFullSymbol(e.symbol, e.board)}`} className="hover:text-sky-400 whitespace-nowrap inline-flex items-center gap-1.5" onClick={e2 => e2.stopPropagation()}>
                          <span className="text-foreground/90">{e.name}</span>
                          <span className="text-muted-foreground/50 text-xs">{e.symbol}</span>
                          {e.isOneWord && <span className="text-[10px] px-1 py-0.5 rounded bg-red-500/15 text-red-400">一字</span>}
                          {e.isST && <span className="text-[10px] px-1 py-0.5 rounded bg-yellow-500/15 text-yellow-500">ST</span>}
                        </Link>
                      </td>
                      <td className="text-right px-2 font-mono tabular-nums"><Pct v={e.pct} /></td>
                      <td className="text-right px-2 font-mono tabular-nums">
                        {e.consecBoards >= 2 ? <span className="text-red-400 font-semibold">{e.consecBoards}連板</span> : <span className="text-muted-foreground">首板</span>}
                      </td>
                      <td className="px-2 text-muted-foreground text-xs whitespace-nowrap">{e.industry ?? '—'}</td>
                      <td className="text-right pl-2 pr-3 text-muted-foreground/70 font-mono tabular-nums text-xs">{e.firstSealTime ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* 炸板池（收合）*/}
      {hot.broken.length > 0 && (
        <section className="space-y-2">
          <button type="button" onClick={() => setShowBroken((s) => !s)}
            className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
            <span className={`transition-transform ${showBroken ? 'rotate-90' : ''}`}>›</span>
            💥 炸板池（盤中觸停又打開）· {hot.broken.length} 檔
          </button>
          {showBroken && (
            <div className="rounded-xl ring-1 ring-foreground/10 bg-card/60 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-muted-foreground text-xs border-b border-border bg-secondary/30">
                      <th className="text-left py-2.5 pl-3 pr-3 font-medium">股票</th>
                      <th className="text-right py-2.5 px-2 font-medium">漲幅</th>
                      <th className="text-right py-2.5 px-2 font-medium">開板次數</th>
                      <th className="text-left py-2.5 pl-2 pr-3 font-medium">行業</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hot.broken.map((e) => (
                      <tr key={e.symbol} className="border-b border-border last:border-0 hover:bg-muted/40 transition-colors">
                        <td className="py-2.5 pl-3 pr-3">
                          <Link href={`/?load=${toFullSymbol(e.symbol, e.board)}`} className="hover:text-sky-400 whitespace-nowrap inline-flex items-center gap-1.5">
                            <span className="text-foreground/90">{e.name}</span>
                            <span className="text-muted-foreground/50 text-xs">{e.symbol}</span>
                          </Link>
                        </td>
                        <td className="text-right px-2 font-mono tabular-nums"><Pct v={e.pct} /></td>
                        <td className="text-right px-2 text-muted-foreground font-mono tabular-nums">{e.brokenTimes ?? '—'}</td>
                        <td className="px-2 text-muted-foreground text-xs whitespace-nowrap">{e.industry ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

// ── 外層：抓資料 + 切視角 ──────────────────────────────────────────────────────

export function CnView({ mode }: { mode: Mode }) {
  const [ranking, setRanking] = useState<CnRankingFile | null>(null);
  const [rankErr, setRankErr] = useState<string | null>(null);
  const [hot, setHot] = useState<CnHotFile | null>(null);
  const [hotErr, setHotErr] = useState<string | null>(null);

  useEffect(() => {
    if (mode === 'fixed' && !ranking && !rankErr) {
      fetch('/api/cn-sectors/ranking')
        .then(r => r.json())
        .then(j => { if (j.ok === false) throw new Error(j.error ?? '載入失敗'); setRanking(j as CnRankingFile); })
        .catch(e => setRankErr(e instanceof Error ? e.message : String(e)));
    }
    if (mode === 'hot' && !hot && !hotErr) {
      fetch('/api/cn-sectors/hot')
        .then(r => r.json())
        .then(j => { if (j.ok === false) throw new Error(j.error ?? '載入失敗'); setHot(j as CnHotFile); })
        .catch(e => setHotErr(e instanceof Error ? e.message : String(e)));
    }
  }, [mode, ranking, rankErr, hot, hotErr]);

  if (mode === 'fixed') {
    if (rankErr) return <EmptyState icon="⚠️" title="尚無板塊資料" description={`${rankErr}（盤後 cn-agents-eod cron 產出板塊快照）`} />;
    if (!ranking) return <div className="text-muted-foreground text-sm py-12 text-center animate-pulse">載入板塊中…</div>;
    return <FixedView date={ranking.date} concepts={ranking.concepts} industries={ranking.industries} />;
  }
  if (hotErr) return <EmptyState icon="⚠️" title="尚無熱點資料" description={`${hotErr}（盤後 cn-agents-eod cron 產出人氣榜/漲停池）`} />;
  if (!hot) return <div className="text-muted-foreground text-sm py-12 text-center animate-pulse">載入熱點中…</div>;
  return <HotView hot={hot} />;
}
