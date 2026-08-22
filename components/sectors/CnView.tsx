'use client';

/**
 * 題材分類陸股視圖（market=CN）— 2026-06-19（從 app/sectors/ 移入 components/sectors/）
 *
 * 東方財富現成的行業/概念板塊（盤後 cn-agents-eod 已存）+ 人氣榜 + 漲停池，做成跟台股一樣的
 * 「熱門板塊（可排序/看輪動/點開逐檔績效）+ 今日熱點」。純顯示層，不參與選股（鐵則 #5）。
 *
 * 乾淨化（2026-06-19）：拿掉上方資金流入三欄小卡（資訊已在板塊表的「輪動 / 主力淨流入」欄）、
 * 板塊/成分股都改卡片版（避免寬表格橫向捲動），上方排序鈕。個股連結走 StockLink（首頁分頁可原地換股）。
 */

import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/shared';
import { applySort } from '@/lib/sorting/sortEngine';
import type { SortDir } from '@/lib/sorting/registry';
import { bullBearClass } from '@/lib/format';
import { useIsChartCurrent } from '@/lib/chartListNav';
import { PERF_PERIODS, INST_PERIODS } from '@/lib/themes/perfPeriods';
import { StockLink, AddWatchBtn } from './StockLink';
import { CnBoardBadges } from './CnBoardBadges';
import { stockDisplayName } from '@/lib/stocks/stockIdentity';

// ── 型別（對齊 /api/cn-sectors/* 回傳）─────────────────────────────────────────

interface CnRotation { rankNow?: number; rankPrev?: number | null; rankDelta: number | null; bucket: 'in' | 'mid' | 'out' }
interface CnBoard {
  code: string; name: string; kind: 'industry' | 'concept';
  pct: number; turnoverCny: number | null; mainNetCny: number | null;
  upCount: number | null; downCount: number | null;
  leaderSymbol: string | null; leaderName: string | null; leaderPct: number | null;
  limitUpCount: number | null; rank: number; pct5d: number | null;
  rotation: CnRotation | null; stage: string;
  rets?: (number | null)[]; mainFlow?: (number | null)[]; // 漲幅/主力 視窗（對齊 CN_RET_COLS）
}
interface CnRankingFile { date: string; priorDate: string | null; concepts: CnBoard[]; industries: CnBoard[] }

interface CnMemberPerf { code: string; name: string; symbol: string; changePercent: number; turnoverCny: number | null; mainNetCny: number | null; mainFlow: (number | null)[]; marginChg: (number | null)[]; rets: (number | null)[] }
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
    return <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-semibold ring-1 ${tone} tabular-nums`}>{rank}</span>;
  }
  return <span className="inline-flex items-center justify-center w-6 text-sm text-muted-foreground/50 tabular-nums">{rank}</span>;
}

function RotationCell({ r }: { r?: CnRotation | null }) {
  const move = r?.rankPrev != null && r?.rankNow != null ? `${r.rankPrev}→${r.rankNow}名` : '';
  if (r?.bucket === 'in') return <span className="text-xs whitespace-nowrap" title="今日漲幅名次往上爬（昨天→今天）＝資金流進（描述用，非買賣訊號）">🟢 流進 <span className="text-muted-foreground/70">{move}</span></span>;
  if (r?.bucket === 'out') return <span className="text-xs whitespace-nowrap" title="今日漲幅名次往下掉（昨天→今天）＝資金流出（描述用，非買賣訊號）">🔴 流出 <span className="text-muted-foreground/70">{move}</span></span>;
  if (r?.rankNow != null) return <span className="text-xs whitespace-nowrap text-muted-foreground/65" title="名次沒大變動">{r.rankNow <= 3 ? '🔥 ' : ''}第{r.rankNow}名</span>;
  return <span className="text-xs text-muted-foreground/45 whitespace-nowrap">—</span>;
}

// ── 成分股績效格（1~10,20 日滾動報酬；卡片版，上方排序鈕）──────────────────────────

// 成交額（元 → 億/萬，中性色）
function fmtAmtCn(v: number | null | undefined): string {
  if (v == null) return '—';
  const a = Math.abs(v);
  return a >= 1e8 ? `${(v / 1e8).toFixed(0)}億` : a >= 1e4 ? `${Math.round(v / 1e4)}萬` : `${Math.round(v)}`;
}

// 卡片排序列（取代寬表格欄位標題）
function SortBar({ sorts, sortId, dir, onSort, hint }: {
  sorts: Array<{ id: string; label: string }>; sortId: string; dir: SortDir; onSort: (id: string) => void; hint?: string;
}) {
  return (
    <div className="px-3 py-1.5 flex items-center gap-1.5 flex-wrap text-[10px] border-b border-border/40 bg-secondary/20">
      <span className="text-muted-foreground/45">排序</span>
      {sorts.map((s) => (
        <button key={s.id} type="button" onClick={() => onSort(s.id)}
          className={`px-1.5 py-0.5 rounded ${sortId === s.id ? 'bg-sky-700 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
          {s.label}{sortId === s.id ? (dir === 'desc' ? ' ▼' : ' ▲') : ''}
        </button>
      ))}
      {hint && <span className="text-muted-foreground/35 ml-1">{hint}</span>}
    </div>
  );
}
const BOARD_SORTS = [
  { id: 'rank', label: '排名' }, { id: 'rot', label: '排名變化' },
  { id: 'r1', label: '今日' }, { id: 'r2', label: '2日' }, { id: 'r3', label: '3日' }, { id: 'r4', label: '4日' },
  { id: 'r5', label: '5日' }, { id: 'r10', label: '10日' }, { id: 'r20', label: '20日' },
  { id: 'main', label: '主力' }, { id: 'limitup', label: '漲停' },
];
const CN_RET_COLS = [1, 2, 3, 4, 5, 10, 20];
// 主力/兩融金額對齊 INST_PERIODS（[1,2,3,4,5,10,20]）；漲幅對齊 PERF_PERIODS。
const cnIIdxOf = (p: number) => (INST_PERIODS as readonly number[]).indexOf(p);

// 成分股卡片（陸股：漲幅 + 主力淨流入 + 成交額；A股無台股那種法人/融資）
function CnStockCard({ m, idxOf }: { m: CnMemberPerf; idxOf: (p: number) => number }) {
  const isCur = useIsChartCurrent(m.symbol);
  return (
    <div className={`rounded-lg border bg-card/40 px-3 py-2 hover:border-foreground/40 hover:bg-muted/30 transition-colors ${isCur ? 'border-sky-400/70 ring-1 ring-sky-400/50 bg-sky-500/5' : 'border-foreground/20'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
          <StockLink code={m.symbol} className="hover:text-sky-400 inline-flex items-baseline gap-1.5">
            <span className="font-semibold text-foreground text-sm">{m.name}</span>
            <span className="text-muted-foreground/45 text-[11px]">{m.code}</span>
          </StockLink>
          <CnBoardBadges code={m.code} name={m.name} />
          <StockLink code={m.symbol} title="走圖"
            className="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-sky-400 hover:border-sky-400/40">走圖</StockLink>
          <AddWatchBtn code={m.symbol} name={m.name} />
          <span className="text-[10px] text-muted-foreground/55">成交 {fmtAmtCn(m.turnoverCny)}<span className="text-muted-foreground/35">（今）</span></span>
        </div>
        <span className="font-mono tabular-nums text-sm shrink-0"><Pct v={m.changePercent} /></span>
      </div>
      {/* 仿台股卡：漲幅／主力（淨流入）／兩融（融資融券餘額變化）× 今/2/3/4/5/10/20 日，固定欄位寬 → 對齊 */}
      <div className="mt-1">
        <table className="w-full table-fixed text-[10px] font-mono tabular-nums">
          <thead>
            <tr className="text-muted-foreground/30">
              <th className="w-7 pr-1 font-normal"></th>
              {CN_RET_COLS.map((p) => <th key={p} className="px-0.5 text-right font-normal">{p === 1 ? '今' : `${p}日`}</th>)}
            </tr>
          </thead>
          <tbody>
            <tr><td className="pr-1 text-left text-muted-foreground/45">漲幅</td>{CN_RET_COLS.map((p) => <td key={p} className="px-0.5 text-right"><Pct v={m.rets?.[idxOf(p)] ?? null} /></td>)}</tr>
            <tr><td className="pr-1 text-left text-muted-foreground/45">主力</td>{CN_RET_COLS.map((p) => <td key={p} className="px-0.5 text-right"><Amt v={m.mainFlow?.[cnIIdxOf(p)] ?? null} /></td>)}</tr>
            <tr><td className="pr-1 text-left text-muted-foreground/45">兩融</td>{CN_RET_COLS.map((p) => <td key={p} className="px-0.5 text-right"><Amt v={m.marginChg?.[cnIIdxOf(p)] ?? null} /></td>)}</tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CnPerfGrid({ file }: { file: CnMembersFile | 'loading' | 'error' | undefined }) {
  const [sortId, setSortId] = useState('today'); // 預設今日漲幅 高→低
  const [dir, setDir] = useState<SortDir>('desc');
  const [onlyBull, setOnlyBull] = useState(false); // 只看多頭（短線偏多）
  const idxOf = (p: number) => (PERF_PERIODS as readonly number[]).indexOf(p);

  if (file === 'loading' || file === undefined) {
    return <div className="bg-muted/15 border-t border-border px-3 py-4 text-xs text-muted-foreground animate-pulse">抓成分股 + 算近 1~20 日績效中…</div>;
  }
  if (file === 'error') {
    return <div className="bg-muted/15 border-t border-border px-3 py-4 text-xs text-muted-foreground">成分股載入失敗，稍後再試。</div>;
  }
  if (file.members.length === 0) {
    return <div className="bg-muted/15 border-t border-border px-3 py-4 text-xs text-muted-foreground">抓不到這個板塊的成分股。</div>;
  }

  const sorted = applySort(file.members, sortId, dir,
    (m, id) => id === 'today' ? m.changePercent
      : id === 'main' ? (m.mainFlow?.[cnIIdxOf(1)] ?? null)
      : id === 'fin' ? (m.marginChg?.[cnIIdxOf(1)] ?? null)
      : id === 'turn' ? (m.turnoverCny ?? null)
      : (m.rets?.[idxOf(Number(id.slice(1)))] ?? null),
    { missingLast: true });
  const sortBy = (id: string) => { if (sortId === id) setDir(dir === 'desc' ? 'asc' : 'desc'); else { setSortId(id); setDir('desc'); } };
  const CN_MEMBER_SORTS = [
    { id: 'today', label: '今日' }, { id: 'r2', label: '2日' }, { id: 'r3', label: '3日' }, { id: 'r4', label: '4日' },
    { id: 'r5', label: '5日' }, { id: 'r10', label: '10日' }, { id: 'r20', label: '20日' },
    { id: 'main', label: '主力' }, { id: 'fin', label: '兩融' }, { id: 'turn', label: '成交額' },
  ];
  // 只看多頭（陸股無六條件趨勢）：今日紅 + 5日紅 = 短線偏多
  const shown = onlyBull
    ? sorted.filter((m) => (m.changePercent ?? 0) > 0 && (m.rets?.[idxOf(5)] ?? -1) > 0)
    : sorted;
  return (
    <div className="bg-muted/20 border-t border-border border-l-2 border-l-sky-500/40">
      <SortBar sorts={CN_MEMBER_SORTS} sortId={sortId} dir={dir} onSort={sortBy}
        hint={file.totalMembers > file.shown ? `前復權 · 成分股 ${file.totalMembers} 檔顯示前 ${file.shown}` : '前復權'} />
      <div className="px-3 py-1 border-b border-border/30 flex items-center gap-2 text-[10px]">
        <button type="button" onClick={() => setOnlyBull((v) => !v)}
          title="只留今日紅且 5 日紅（短線偏多）的成分股"
          className={`px-1.5 py-0.5 rounded border ${onlyBull ? 'bg-red-600 border-red-500 text-foreground' : 'border-border text-muted-foreground hover:text-foreground'}`}>
          {onlyBull ? '✓ ' : ''}只看多頭
        </button>
        {onlyBull && <span className="text-muted-foreground/45">今日紅 + 5日紅 · {shown.length} 檔</span>}
      </div>
      {/* data-navlist：鍵盤 ↑↓ 跳股的清單範圍（題材成分股共用 sector-members） */}
      <div className="p-1.5 space-y-1.5" data-navlist="sector-members">
        {shown.map((m) => <CnStockCard key={m.code} m={m} idxOf={idxOf} />)}
        {onlyBull && shown.length === 0 && (
          <div className="px-2 py-3 text-center text-[11px] text-muted-foreground/55">這個板塊沒有「今日紅＋5日紅」的成分股</div>
        )}
      </div>
    </div>
  );
}

// ── 板塊表（熱門板塊模式）──────────────────────────────────────────────────────

function BoardTable({ boards, date }: { boards: CnBoard[]; date: string }) {
  const [sortId, setSortId] = useState('r1'); // 預設今日漲幅 高→低
  const [dir, setDir] = useState<SortDir>('desc');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [members, setMembers] = useState<Record<string, CnMembersFile | 'loading' | 'error'>>({});

  const sortBy = (id: string) => { if (sortId === id) setDir(dir === 'desc' ? 'asc' : 'desc'); else { setSortId(id); setDir('desc'); } };
  const sorted = applySort(boards, sortId, dir,
    (b, id) => id === 'rank' ? (b.rotation?.rankNow != null ? -b.rotation.rankNow : null) // 負號：desc 讓第1名在最上
      : id === 'rot' ? (b.rotation?.rankDelta ?? null)
      : id === 'main' ? (b.mainFlow?.[cnIIdxOf(5)] ?? b.mainNetCny) // 主力 5 日（fallback 今日）
      : id === 'limitup' ? b.limitUpCount
      : id[0] === 'r' ? (b.rets?.[cnIIdxOf(Number(id.slice(1)))] ?? (id === 'r1' ? b.pct : id === 'r5' ? b.pct5d : null))
      : null,
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
      <SortBar sorts={BOARD_SORTS} sortId={sortId} dir={dir} onSort={sortBy} />
      <div className="p-1.5 space-y-1.5">
        {sorted.map((b, i) => (
          <CnBoardCard key={b.code} b={b} rank={i + 1} expanded={expanded === b.code}
            onToggle={() => toggle(b.code)} membersFile={members[b.code]} />
        ))}
      </div>
    </div>
  );
}

// 板塊卡片（取代寬表格列）— 一個板塊一張卡，點開看成分股
function CnBoardCard({ b, rank, expanded, onToggle, membersFile }: {
  b: CnBoard; rank: number; expanded: boolean; onToggle: () => void; membersFile?: CnMembersFile | 'loading' | 'error';
}) {
  return (
    <div className={expanded ? 'bg-muted/20' : ''}>
      <div onClick={onToggle}
        className="rounded-lg border border-foreground/20 bg-card/40 px-3 py-2 hover:border-foreground/40 hover:bg-muted/30 cursor-pointer transition-colors">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
            <RankBadge rank={rank} />
            <span className={`text-muted-foreground/40 transition-transform ${expanded ? 'rotate-90' : ''}`}>›</span>
            <span className="font-semibold text-foreground text-sm">{b.name}</span>
            {b.upCount != null && <span className="text-[11px] text-muted-foreground/50">{b.upCount}漲</span>}
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STAGE_STYLE[b.stage] ?? STAGE_STYLE['盤整']}`}>{b.stage}</span>
            <span className="text-[10px] text-muted-foreground/55"><RotationCell r={b.rotation} /></span>
            {b.limitUpCount != null && b.limitUpCount > 0 && <span className="text-[10px] text-red-400">漲停{b.limitUpCount}</span>}
            {b.leaderName && b.leaderSymbol && (
              <span className="text-[10px] text-muted-foreground/55 inline-flex items-baseline gap-1">領漲
                <StockLink code={toFullSymbol(b.leaderSymbol)} className="hover:text-sky-400 text-foreground/80 inline-flex items-baseline gap-1">
                  <span>{b.leaderName}</span> <Pct v={b.leaderPct} />
                </StockLink>
              </span>
            )}
          </div>
          <span className="font-mono tabular-nums text-sm shrink-0"><Pct v={b.pct} /></span>
        </div>
        {/* 仿個股卡：漲幅／主力 × 今/2/3/4/5/10/20（板塊層無「兩融」，那是個股欄位）*/}
        <div className="mt-1">
          <table className="w-full table-fixed text-[10px] font-mono tabular-nums">
            <thead>
              <tr className="text-muted-foreground/30">
                <th className="w-7 pr-1 font-normal"></th>
                {CN_RET_COLS.map((p) => <th key={p} className="px-0.5 text-right font-normal">{p === 1 ? '今' : `${p}日`}</th>)}
              </tr>
            </thead>
            <tbody>
              <tr><td className="pr-1 text-left text-muted-foreground/45">漲幅</td>{CN_RET_COLS.map((p) => <td key={p} className="px-0.5 text-right"><Pct v={b.rets?.[cnIIdxOf(p)] ?? (p === 1 ? b.pct : p === 5 ? b.pct5d : null)} /></td>)}</tr>
              <tr><td className="pr-1 text-left text-muted-foreground/45">主力</td>{CN_RET_COLS.map((p) => <td key={p} className="px-0.5 text-right"><Amt v={b.mainFlow?.[cnIIdxOf(p)] ?? (p === 1 ? b.mainNetCny : null)} /></td>)}</tr>
            </tbody>
          </table>
        </div>
      </div>
      {expanded && <CnPerfGrid file={membersFile} />}
    </div>
  );
}

function FixedView({ date, concepts, industries }: { date: string; concepts: CnBoard[]; industries: CnBoard[] }) {
  const [kind, setKind] = useState<'concept' | 'industry'>('concept');
  const boards = kind === 'concept' ? concepts : industries;
  return (
    <div className="space-y-3">
      <div className="inline-flex rounded-lg border border-border bg-secondary/30 p-0.5 text-sm">
        <button onClick={() => setKind('concept')}
          className={`px-3 py-1.5 rounded-md transition-colors ${kind === 'concept' ? 'bg-card text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}>概念 {concepts.length}</button>
        <button onClick={() => setKind('industry')}
          className={`px-3 py-1.5 rounded-md transition-colors ${kind === 'industry' ? 'bg-card text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}>行業 {industries.length}</button>
      </div>
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
      {/* 人氣榜 */}
      <section className="space-y-2">
        <h3 className="text-sm font-medium">🔥 人氣榜（關注度 Top {hot.hotRank.length}）</h3>
        {hot.hotRank.length === 0 ? <EmptyState icon="😴" title="今天沒有人氣榜資料" /> : (
          <div className="rounded-xl ring-1 ring-foreground/10 bg-card/60 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead>
                  <tr className="text-muted-foreground text-xs border-b border-border bg-secondary/30">
                    <th className="text-left py-1.5 pl-3 pr-2 font-medium">#</th>
                    <th className="text-left py-1.5 pr-3 font-medium">股票</th>
                    <th className="text-right py-1.5 px-2 font-medium">名次變化</th>
                    <th className="text-right py-1.5 pl-2 pr-3 font-medium">連續在榜</th>
                  </tr>
                </thead>
                <tbody>
                  {hot.hotRank.slice(0, 50).map((e) => (
                    <tr key={e.symbol} className="border-b border-border last:border-0 hover:bg-muted/40 transition-colors">
                      <td className="py-1.5 pl-3 pr-1"><RankBadge rank={e.rank} /></td>
                      <td className="py-1.5 pr-3">
                        <StockLink code={toFullSymbol(e.symbol)} className="hover:text-sky-400 whitespace-nowrap inline-flex items-center gap-1.5">
                          <span className="text-foreground/90">{stockDisplayName(e.name, e.symbol)}</span>
                          <span className="text-muted-foreground/50 text-xs">{e.symbol}</span>
                        </StockLink>
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
              <table className="w-full text-sm whitespace-nowrap">
                <thead>
                  <tr className="text-muted-foreground text-xs border-b border-border bg-secondary/30">
                    <th className="text-left py-1.5 pl-3 pr-3 font-medium">股票</th>
                    <th className="text-right py-1.5 px-2 font-medium">漲幅</th>
                    <th className="text-right py-1.5 px-2 font-medium">連板</th>
                    <th className="text-left py-1.5 px-2 font-medium">行業</th>
                    <th className="text-right py-1.5 pl-2 pr-3 font-medium">封板</th>
                  </tr>
                </thead>
                <tbody>
                  {limitUp.map((e) => (
                    <tr key={e.symbol} className="border-b border-border last:border-0 hover:bg-muted/40 transition-colors">
                      <td className="py-1.5 pl-3 pr-3">
                        <StockLink code={toFullSymbol(e.symbol, e.board)} className="hover:text-sky-400 whitespace-nowrap inline-flex items-center gap-1.5">
                          <span className="text-foreground/90">{stockDisplayName(e.name, toFullSymbol(e.symbol, e.board))}</span>
                          <span className="text-muted-foreground/50 text-xs">{e.symbol}</span>
                          {e.isOneWord && <span className="text-[10px] px-1 py-0.5 rounded bg-red-500/15 text-red-400">一字</span>}
                          {e.isST && <span className="text-[10px] px-1 py-0.5 rounded bg-yellow-500/15 text-yellow-500">ST</span>}
                        </StockLink>
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
                <table className="w-full text-sm whitespace-nowrap">
                  <thead>
                    <tr className="text-muted-foreground text-xs border-b border-border bg-secondary/30">
                      <th className="text-left py-1.5 pl-3 pr-3 font-medium">股票</th>
                      <th className="text-right py-1.5 px-2 font-medium">漲幅</th>
                      <th className="text-right py-1.5 px-2 font-medium">開板次數</th>
                      <th className="text-left py-1.5 pl-2 pr-3 font-medium">行業</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hot.broken.map((e) => (
                      <tr key={e.symbol} className="border-b border-border last:border-0 hover:bg-muted/40 transition-colors">
                        <td className="py-1.5 pl-3 pr-3">
                          <StockLink code={toFullSymbol(e.symbol, e.board)} className="hover:text-sky-400 whitespace-nowrap inline-flex items-center gap-1.5">
                            <span className="text-foreground/90">{stockDisplayName(e.name, toFullSymbol(e.symbol, e.board))}</span>
                            <span className="text-muted-foreground/50 text-xs">{e.symbol}</span>
                          </StockLink>
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
