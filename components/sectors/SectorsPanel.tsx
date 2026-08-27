'use client';

/**
 * 產業／板塊面板 — 台股採 TWSE／TPEx 官方產業分類；陸股沿用交易所板塊資料。
 *
 * 從 app/sectors/page.tsx 抽出內層內容（不含 PageShell/PageHeader）。台股兩視角 + 陸股 <CnView/>。
 * 純顯示層，不參與選股（鐵則 #5）。
 *
 * 乾淨化（2026-06-19）：熱度只留數字（拿掉進度條）、成分股表拿掉上方排序/收合 icon（改點欄位標題排序）、
 * 籌碼法人預設展開、熱門題材主表拿掉上方三欄小卡（改成可排序欄位：排名變化/法人1·5·10日/最強/量能）。
 */

import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/shared';
import { applySort } from '@/lib/sorting/sortEngine';
import type { SortDir } from '@/lib/sorting/registry';
import { bullBearClass } from '@/lib/format';
import { PERF_PERIODS, INST_PERIODS } from '@/lib/themes/perfPeriods';
import { useIsChartCurrent } from '@/lib/chartListNav';
import { SectorsNavContext, SectorsBadgesContext, useSectorBadges, StockLink, StockBadges, AddWatchBtn, type SectorSelectStock, type SectorBadgeSets, type ScanSig, type SixCondSig } from './StockLink';
import { CnView } from './CnView';
import { LiveThemesView } from './LiveThemesView';
import { stockDisplayName } from '@/lib/stocks/stockIdentity';

// ── 型別 ──────────────────────────────────────────────────────────────────────

interface ThemeStockPerf {
  code: string; name: string; symbol: string;
  d1: number | null; d5: number | null; d20: number | null; d60: number | null;
  volRatio: number | null; turnover?: number | null; instNet5: number | null;
  rets?: (number | null)[];
  instAmt?: (number | null)[];
  retailAmt?: (number | null)[];
}
interface ThemeRotation {
  rankNow?: number; rankPrev?: number | null;
  rankDelta: number | null; accel: number | null; bucket: 'in' | 'mid' | 'out';
}
interface ThemeRank {
  theme: string; stockCount: number;
  avgD1: number | null; avgD5: number | null; avgD20: number | null; avgD60: number | null;
  avgVolRatio: number | null; breadth: number | null; instNet5: number | null; instAmt5?: number | null;
  stage: string;
  topStock: { code: string; name: string; symbol: string; d1: number } | null;
  members: ThemeStockPerf[];
  rotation?: ThemeRotation | null;
}
interface RankingFile { date: string; generatedAt: string; themes: ThemeRank[] }

interface HotStock {
  code: string; symbol: string; name: string; changePercent: number; volume: number;
  volRatio: number | null; turnover?: number | null; instNet: number | null;
  isLimitUp: boolean; isNotice: boolean; heat: number;
  theme: string; themeSource: 'concept' | 'industry' | 'other';
  rets?: (number | null)[];
  instAmt?: (number | null)[];
  retailAmt?: (number | null)[];
}
interface HotTheme {
  theme: string; source: 'concept' | 'industry' | 'other';
  hotCount: number; avgChange: number; maxChange: number; avgHeat: number; score: number;
  topStock: { code: string; symbol: string; name: string; changePercent: number } | null;
  members: HotStock[];
}
interface HotFile {
  date: string; generatedAt: string; market: string;
  totalScanned: number; hotStockCount: number; uncategorizedCount: number; instFresh: boolean;
  themes: HotTheme[];
}

type Mode = 'fixed' | 'hot';
type Market = 'TW' | 'CN';

const idxOf = (p: number) => (PERF_PERIODS as readonly number[]).indexOf(p);
const iIdxOf = (p: number) => (INST_PERIODS as readonly number[]).indexOf(p);

const STAGE_STYLE: Record<string, string> = {
  '剛啟動': 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  '主升段': 'bg-red-500/15 text-red-400 border-red-500/30',
  '高潮噴出': 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  '震盪換手': 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  '退潮': 'bg-muted text-muted-foreground border-border',
  '補跌': 'bg-green-500/15 text-green-400 border-green-500/30',
  '盤整': 'bg-secondary text-muted-foreground border-border',
};

// ── 小 primitive ─────────────────────────────────────────────────────────────

function Pct({ v }: { v: number | null }) {
  if (v == null) return <span className="text-muted-foreground/40">—</span>;
  const a = Math.abs(v);
  if (a < 1) return <span className="text-muted-foreground/55 tabular-nums">{v > 0 ? '+' : ''}{v.toFixed(1)}%</span>;
  const tone = a >= 12 ? 'font-semibold' : a >= 5 ? 'opacity-90' : 'opacity-55';
  return <span className={`${bullBearClass(v)} ${tone} tabular-nums`}>{v > 0 ? '+' : ''}{v.toFixed(1)}%</span>;
}

// 法人買超金額（元 → 億/萬）。買超(+)=紅、賣超=綠；接近 0 灰。
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
    return (
      <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-semibold ring-1 ${tone} tabular-nums`}>{rank}</span>
    );
  }
  return <span className="inline-flex items-center justify-center w-6 text-sm text-muted-foreground/50 tabular-nums">{rank}</span>;
}

// 排名變化（昨天名→今天名）：往上爬=🟢資金流進、往下=🔴資金流出。描述用，非買賣訊號。
function RotationCell({ r }: { r?: ThemeRotation | null }) {
  const move = r?.rankPrev != null && r?.rankNow != null ? `${r.rankPrev}→${r.rankNow}名` : '';
  if (r?.bucket === 'in') return <span className="text-xs whitespace-nowrap" title="名次往上爬＝資金流進（描述用，非買賣訊號）">🟢 流進 <span className="text-muted-foreground/70">{move}</span></span>;
  if (r?.bucket === 'out') return <span className="text-xs whitespace-nowrap" title="名次往下掉＝資金流出（描述用，非買賣訊號）">🔴 流出 <span className="text-muted-foreground/70">{move}</span></span>;
  if (r?.rankNow != null) return <span className="text-xs whitespace-nowrap text-muted-foreground/65" title="名次沒大變動">{r.rankNow <= 3 ? '🔥 ' : ''}第{r.rankNow}名</span>;
  return <span className="text-xs text-muted-foreground/45 whitespace-nowrap">—</span>;
}


// ── 成分股績效表（漲幅格子 / 籌碼法人vs散戶；上方只留視角切換，排序交給欄位標題）──

type PerfMember = { code: string; symbol?: string; name: string; rets?: (number | null)[]; instAmt?: (number | null)[]; retailAmt?: (number | null)[]; volRatio?: number | null; turnover?: number | null; isLimitUp?: boolean; isNotice?: boolean };

// 展開卡片的日報酬週期：今日/2/3/4/5/10/20 日
const RET_COLS = [1, 2, 3, 4, 5, 10, 20];

// 成交金額（元 → 億/萬，中性色不分紅綠）
function fmtTurnover(v: number | null | undefined): string {
  if (v == null) return '—';
  const a = Math.abs(v);
  return a >= 1e8 ? `${(v / 1e8).toFixed(0)}億` : a >= 1e4 ? `${Math.round(v / 1e4)}萬` : `${Math.round(v)}`;
}

// 題材展開＝題材內個股「卡片」排行（仿策略掃描卡片）：股名+漲跌幅大、跨來源徽章、一排日報酬、量/成交/法人/融資 + 走圖/＋。
const CARD_SORTS: Array<{ id: string; label: string }> = [
  { id: 'r1', label: '今日' }, { id: 'r2', label: '2日' }, { id: 'r3', label: '3日' }, { id: 'r4', label: '4日' },
  { id: 'r5', label: '5日' }, { id: 'r10', label: '10日' }, { id: 'r20', label: '20日' },
  { id: 'inst', label: '法人' }, { id: 'fin', label: '融資' }, { id: 'turn', label: '成交額' }, { id: 'vol', label: '量' },
];

function StockCard({ m }: { m: PerfMember }) {
  const badges = useSectorBadges();
  const sc = badges?.scan.get(m.code);
  const isCur = useIsChartCurrent(m.code);
  const symbol = m.symbol ?? m.code;
  return (
    <div className={`rounded-lg border bg-card/40 px-3 py-2 hover:border-foreground/40 hover:bg-muted/30 transition-colors ${isCur ? 'border-sky-400/70 ring-1 ring-sky-400/50 bg-sky-500/5' : 'border-foreground/20'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
          <StockLink code={symbol} className="hover:text-sky-400 inline-flex items-baseline gap-1.5">
            <span className="font-semibold text-foreground text-sm">{stockDisplayName(m.name, m.code)}</span>
            <span className="text-muted-foreground/45 text-[11px]">{m.code}</span>
          </StockLink>
          <StockLink code={symbol} title="走圖"
            className="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-sky-400 hover:border-sky-400/40">走圖</StockLink>
          <AddWatchBtn code={m.code} name={m.name} />
          <StockBadges code={m.code} />
          {m.isLimitUp && <span className="text-[10px] px-1 py-0.5 rounded bg-red-500/15 text-red-400">漲停</span>}
          {m.isNotice && <span className="text-[10px] px-1 py-0.5 rounded bg-yellow-500/15 text-yellow-500">注意</span>}
          <span className="text-[10px] text-muted-foreground/55">量 {m.volRatio != null ? `${m.volRatio.toFixed(1)}×` : '—'}</span>
          <span className="text-[10px] text-muted-foreground/55">成交 {fmtTurnover(m.turnover)}<span className="text-muted-foreground/35">（今）</span></span>
        </div>
        <span className="font-mono tabular-nums text-sm shrink-0"><Pct v={m.rets?.[idxOf(1)] ?? null} /></span>
      </div>

      {sc?.pos && <div className="text-[10px] text-muted-foreground/55 mt-0.5">{sc.pos}</div>}

      {/* 三排對齊：漲幅／法人／融資 × 今/2/3/4/5/10/20 日（固定欄位寬 → 每檔股票對齊；皆累計到該天，今＝今天）*/}
      <div className="mt-1">
        <table className="w-full table-fixed text-[10px] font-mono tabular-nums">
          <thead>
            <tr className="text-muted-foreground/30">
              <th className="w-7 pr-1 font-normal"></th>
              {RET_COLS.map((p) => <th key={p} className="px-0.5 text-right font-normal">{p === 1 ? '今' : `${p}日`}</th>)}
            </tr>
          </thead>
          <tbody>
            <tr><td className="pr-1 text-left text-muted-foreground/45">漲幅</td>{RET_COLS.map((p) => <td key={p} className="px-0.5 text-right"><Pct v={m.rets?.[idxOf(p)] ?? null} /></td>)}</tr>
            <tr><td className="pr-1 text-left text-muted-foreground/45">法人</td>{RET_COLS.map((p) => <td key={p} className="px-0.5 text-right"><Amt v={m.instAmt?.[iIdxOf(p)] ?? null} /></td>)}</tr>
            <tr><td className="pr-1 text-left text-muted-foreground/45">融資</td>{RET_COLS.map((p) => <td key={p} className="px-0.5 text-right"><Amt v={m.retailAmt?.[iIdxOf(p)] ?? null} /></td>)}</tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PerfGrid({ members }: { members: PerfMember[] }) {
  const [sortId, setSortId] = useState('r1'); // 預設今日漲幅 高→低
  const [dir, setDir] = useState<SortDir>('desc');
  const [onlyBull, setOnlyBull] = useState(false); // 只看多頭（趨勢=多頭）
  const badges = useSectorBadges();

  const accessor = (m: PerfMember, id: string): number | null => {
    if (id === 'vol') return m.volRatio ?? null;
    if (id === 'turn') return m.turnover ?? null;
    if (id === 'inst') return m.instAmt?.[iIdxOf(1)] ?? null;
    if (id === 'fin') return m.retailAmt?.[iIdxOf(1)] ?? null;
    if (id[0] === 'r') return m.rets?.[idxOf(Number(id.slice(1)))] ?? null;
    return null;
  };
  const sorted = applySort(members ?? [], sortId, dir, accessor, { missingLast: true });
  // 只看多頭：用逐檔六條件判讀的趨勢過濾（趨勢未判讀到的先排除）
  const shown = onlyBull ? sorted.filter((m) => badges?.six.get(m.code)?.trend === '多頭') : sorted;

  return (
    <div className="bg-muted/20 border-t border-border border-l-2 border-l-sky-500/40">
      <div className="px-3 py-1.5 flex items-center gap-1.5 flex-wrap text-[10px]">
        <span className="text-muted-foreground/45">排序</span>
        {CARD_SORTS.map((s) => (
          <button key={s.id} type="button"
            onClick={() => { if (sortId === s.id) setDir(dir === 'desc' ? 'asc' : 'desc'); else { setSortId(s.id); setDir('desc'); } }}
            className={`px-1.5 py-0.5 rounded ${sortId === s.id ? 'bg-sky-700 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
            {s.label}{sortId === s.id ? (dir === 'desc' ? ' ▼' : ' ▲') : ''}
          </button>
        ))}
        <span className="mx-0.5 text-muted-foreground/25">|</span>
        <button type="button" onClick={() => setOnlyBull((v) => !v)}
          title="只留趨勢為「多頭」（頭頭高、底底高）的個股"
          className={`px-1.5 py-0.5 rounded border ${onlyBull ? 'bg-red-600 border-red-500 text-foreground' : 'border-border text-muted-foreground hover:text-foreground'}`}>
          {onlyBull ? '✓ ' : ''}只看多頭
        </button>
      </div>
      {/* data-navlist：鍵盤 ↑↓ 跳股的清單範圍（題材成分股共用 sector-members，同時只展開一個） */}
      <div className="p-1.5 space-y-1.5" data-navlist="sector-members">
        {shown.map((m) => <StockCard key={m.code} m={m} />)}
        {onlyBull && shown.length === 0 && (
          <div className="px-2 py-3 text-center text-[11px] text-muted-foreground/55">此產業沒有趨勢為多頭的成分股（或六條件判讀中…）</div>
        )}
      </div>
    </div>
  );
}

// ── 今日全市場熱點 ────────────────────────────────────────────────────────────

function SourceTag({ source }: { source: HotTheme['source'] }) {
  const label = source === 'industry' ? '官方' : source === 'other' ? '未分類' : '舊題材';
  return <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground/70 align-middle">{label}</span>;
}

function HotThemeList({ rows, rankBase, expanded, setExpanded }: {
  rows: HotTheme[]; rankBase: number; expanded: string | null; setExpanded: (s: string | null) => void;
}) {
  return (
    <div className="rounded-xl ring-1 ring-foreground/10 bg-card/60 overflow-hidden">
      <div className="p-1.5 space-y-1.5">
        {rows.map((t, i) => (
          <HotThemeCard key={t.theme} t={t} rank={rankBase + i + 1}
            expanded={expanded === t.theme}
            onToggle={() => setExpanded(expanded === t.theme ? null : t.theme)} />
        ))}
      </div>
    </div>
  );
}

function HotView({ hot, error, expanded, setExpanded }: {
  hot: HotFile | null; error: string | null;
  expanded: string | null; setExpanded: (s: string | null) => void;
}) {
  const [sortId, setSortId] = useState('score');
  const [dir, setDir] = useState<SortDir>('desc');
  const [showUnclassified, setShowUnclassified] = useState(false);
  const sortBy = (id: string) => { if (sortId === id) setDir(dir === 'desc' ? 'asc' : 'desc'); else { setSortId(id); setDir('desc'); } };
  const themes = hot?.themes
    ? applySort(hot.themes, sortId, dir,
        (t, id) => id === 'score' ? t.score : id === 'count' ? t.hotCount : id === 'avg' ? t.avgChange : id === 'max' ? t.maxChange : null,
        { missingLast: true })
    : [];
  const official = themes.filter((t) => t.source === 'industry');
  const unclassified = themes.filter((t) => t.source !== 'industry');
  const unclassifiedHot = unclassified.reduce((a, t) => a + t.hotCount, 0);

  return (
    <div className="space-y-3">
      {error && <EmptyState icon="⚠️" title="尚無資料" description={`${error}（需要當日 L2 全市場快照）`} />}
      {!hot && !error && <div className="text-muted-foreground text-sm py-12 text-center animate-pulse">掃描全市場中…</div>}

      {hot && hot.themes.length === 0 && (
        <EmptyState icon="😴" title="今天沒什麼在熱" description={`掃了 ${hot.totalScanned} 檔，沒有達到熱度門檻的個股`} />
      )}

      {hot && hot.themes.length > 0 && (
        <>
          <div className="rounded-lg ring-1 ring-foreground/10 bg-card/40 overflow-hidden">
            <SortBar sorts={HOT_SORTS} sortId={sortId} dir={dir} onSort={sortBy} hint="點產業看成分股" />
          </div>
          {official.length > 0 ? (
            <HotThemeList rows={official} rankBase={0} expanded={expanded} setExpanded={setExpanded} />
          ) : (
            <EmptyState icon="🔍" title="今天沒有官方產業熱點" description="目前熱門個股沒有取得 TWSE／TPEx 官方產業別" />
          )}

          {unclassified.length > 0 && (
            <div className="space-y-2">
              <button type="button" onClick={() => setShowUnclassified((s) => !s)}
                className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
                <span className={`transition-transform ${showUnclassified ? 'rotate-90' : ''}`}>›</span>
                官方資料待補 · {unclassified.length} 群 · {unclassifiedHot} 檔
              </button>
              {showUnclassified && <HotThemeList rows={unclassified} rankBase={official.length} expanded={expanded} setExpanded={setExpanded} />}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// 一個熱點題材一張卡：名次+題材+來源+檔數 ｜ 平均漲；熱度分/最強漲/代表股。
function HotThemeCard({ t, rank, expanded, onToggle }: {
  t: HotTheme; rank: number; expanded: boolean; onToggle: () => void;
}) {
  return (
    <div className={expanded ? 'bg-muted/20' : ''}>
      <div onClick={onToggle}
        className="rounded-lg border border-foreground/20 bg-card/40 px-3 py-2 cursor-pointer hover:border-foreground/40 hover:bg-muted/30 transition-colors">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
            <RankBadge rank={rank} />
            <span className={`text-muted-foreground/40 transition-transform ${expanded ? 'rotate-90' : ''}`}>›</span>
            <span className="font-semibold text-foreground text-sm">{t.theme}</span>
            <SourceTag source={t.source} />
            <span className="text-[11px] text-muted-foreground/50">{t.hotCount}檔</span>
          </div>
          <span className="font-mono tabular-nums text-sm shrink-0"><Pct v={t.avgChange} /></span>
        </div>
        <div className="flex items-center gap-x-3 gap-y-0.5 flex-wrap mt-1 text-[10px]">
          <span className="text-muted-foreground/55" title={`熱度 ${t.avgHeat}（個股平均）＋檔數加分 → 排名分 ${t.score}`}>熱度 <span className="text-orange-400 font-mono tabular-nums">{t.score.toFixed(0)}</span></span>
          <span className="font-mono tabular-nums text-muted-foreground/55">最強漲 <Pct v={t.maxChange} /></span>
          {t.topStock && (
            <span className="text-muted-foreground/55 inline-flex items-center gap-0.5">代表
              <StockLink code={t.topStock.symbol} className="hover:text-sky-400 font-mono tabular-nums">{t.topStock.name} <Pct v={t.topStock.changePercent} /></StockLink>
            </span>
          )}
        </div>
      </div>
      {expanded && <PerfGrid members={t.members} />}
    </div>
  );
}

// 卡片排序列（題材卡片用，取代寬表格的欄位標題排序）
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
const FIXED_SORTS = [
  { id: 'rank', label: '排名' }, { id: 'rot', label: '排名變化' },
  { id: 'd1', label: '今日' }, { id: 'd2', label: '2日' }, { id: 'd3', label: '3日' }, { id: 'd4', label: '4日' },
  { id: 'd5', label: '5日' }, { id: 'd10', label: '10日' }, { id: 'd20', label: '20日' },
  { id: 'fin', label: '融資' }, { id: 'max', label: '最強' },
];
const HOT_SORTS = [
  { id: 'score', label: '熱度' }, { id: 'count', label: '熱門數' }, { id: 'avg', label: '平均漲' }, { id: 'max', label: '最強漲' },
];

// ── 官方產業盤後排行 ──────────────────────────────────────────────────────────

// 題材級法人買超金額 = 成分股 instAmt[該天數] 加總
function instSum(t: ThemeRank, win: number): number | null {
  const idx = iIdxOf(win);
  if (idx < 0) return null;
  const vals = t.members.map((m) => m.instAmt?.[idx]).filter((x): x is number => x != null);
  return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : null;
}
// 題材級融資淨變化金額 = 成分股 retailAmt[該天數] 加總
function retailSum(t: ThemeRank, win: number): number | null {
  const idx = iIdxOf(win);
  if (idx < 0) return null;
  const vals = t.members.map((m) => m.retailAmt?.[idx]).filter((x): x is number => x != null);
  return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : null;
}
// 題材級漲幅 = 成分股 rets[該天數] 平均（非空）
function themeRet(t: ThemeRank, win: number): number | null {
  const idx = idxOf(win);
  if (idx < 0) return null;
  const vals = t.members.map((m) => m.rets?.[idx]).filter((x): x is number => x != null);
  return vals.length > 0 ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : null;
}

function FixedView({ data, error, expanded, setExpanded }: {
  data: RankingFile | null; error: string | null;
  expanded: string | null; setExpanded: (s: string | null) => void;
}) {
  const [sortId, setSortId] = useState('d5'); // 預設按 5 日漲幅（近期最強排前面）
  const [dir, setDir] = useState<SortDir>('desc');
  const sortBy = (id: string) => { if (sortId === id) setDir(dir === 'desc' ? 'asc' : 'desc'); else { setSortId(id); setDir('desc'); } };
  const themes = data?.themes
    ? applySort(data.themes, sortId, dir,
        (t, id) => id === 'rot' ? (t.rotation?.rankDelta ?? null)
          : id === 'rank' ? (t.rotation?.rankNow != null ? -t.rotation.rankNow : null) // 負號：desc 讓第1名在最上
          : id === 'max' ? (t.topStock?.d1 ?? null)
          : id === 'inst' ? instSum(t, 5)
          : id === 'fin' ? retailSum(t, 5)
          : id[0] === 'd' ? themeRet(t, Number(id.slice(1)))
          : null,
        { missingLast: true })
    : [];

  return (
    <div className="space-y-3">
      {error && (
        <EmptyState icon="⚠️" title="尚未產生資料" description={`${error}（盤後 17:10 cron 產出 compute-sector-strength）`} />
      )}
      {!data && !error && (
        <div className="text-muted-foreground text-sm py-12 text-center animate-pulse">載入中…</div>
      )}

      {data && (
        <div className="rounded-xl ring-1 ring-foreground/10 bg-card/60 overflow-hidden">
          <SortBar sorts={FIXED_SORTS} sortId={sortId} dir={dir} onSort={sortBy} hint="法人=三大法人買超、融資=融資增減（皆成分股加總金額）" />
          <div className="p-1.5 space-y-1.5">
            {themes.map((t, i) => (
              <FixedThemeCard key={t.theme} t={t} rank={i + 1}
                expanded={expanded === t.theme}
                onToggle={() => setExpanded(expanded === t.theme ? null : t.theme)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// 一個題材一張卡（仿個股卡：外框＋對齊欄位）：名次+題材+階段 ｜ 今日漲；漲幅/資金流入 × 今/5日/20日；排名變化/量能/最強。
function FixedThemeCard({ t, rank, expanded, onToggle }: {
  t: ThemeRank; rank: number; expanded: boolean; onToggle: () => void;
}) {
  return (
    <div className={expanded ? 'bg-muted/20' : ''}>
      <div onClick={onToggle}
        className="rounded-lg border border-foreground/20 bg-card/40 px-3 py-2 cursor-pointer hover:border-foreground/40 hover:bg-muted/30 transition-colors">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
            <RankBadge rank={rank} />
            <span className={`text-muted-foreground/40 transition-transform ${expanded ? 'rotate-90' : ''}`}>›</span>
            <span className="font-semibold text-foreground text-sm">{t.theme}</span>
            <span className="text-[11px] text-muted-foreground/50">{t.stockCount}檔</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STAGE_STYLE[t.stage] ?? STAGE_STYLE['盤整']}`}>{t.stage}</span>
            <span className="text-[10px] text-muted-foreground/55"><RotationCell r={t.rotation} /></span>
            <span className="text-[10px] text-muted-foreground/55">量能 {t.avgVolRatio != null ? `${t.avgVolRatio.toFixed(1)}×` : '—'}</span>
            {t.topStock && (
              <span className="text-[10px] text-muted-foreground/55 inline-flex items-center gap-0.5">最強
                <StockLink code={t.topStock.symbol} className="hover:text-sky-400 font-mono tabular-nums">{t.topStock.name} <Pct v={t.topStock.d1} /></StockLink>
              </span>
            )}
          </div>
          <span className="font-mono tabular-nums text-sm shrink-0"><Pct v={t.avgD1} /></span>
        </div>

        {/* 仿個股卡：漲幅／法人／融資 × 今/2/3/4/5/10/20 日（題材＝成分股加總/平均）*/}
        <div className="mt-1">
          <table className="w-full table-fixed text-[10px] font-mono tabular-nums">
            <thead>
              <tr className="text-muted-foreground/30">
                <th className="w-7 pr-1 font-normal"></th>
                {RET_COLS.map((p) => <th key={p} className="px-0.5 text-right font-normal">{p === 1 ? '今' : `${p}日`}</th>)}
              </tr>
            </thead>
            <tbody>
              <tr><td className="pr-1 text-left text-muted-foreground/45">漲幅</td>{RET_COLS.map((p) => <td key={p} className="px-0.5 text-right"><Pct v={themeRet(t, p)} /></td>)}</tr>
              <tr><td className="pr-1 text-left text-muted-foreground/45">法人</td>{RET_COLS.map((p) => <td key={p} className="px-0.5 text-right"><Amt v={instSum(t, p)} /></td>)}</tr>
              <tr><td className="pr-1 text-left text-muted-foreground/45">融資</td>{RET_COLS.map((p) => <td key={p} className="px-0.5 text-right"><Amt v={retailSum(t, p)} /></td>)}</tr>
            </tbody>
          </table>
        </div>
      </div>
      {expanded && <PerfGrid members={t.members} />}
    </div>
  );
}

// ── 外層：市場/視角切換 + 抓資料 ──────────────────────────────────────────────

export function SectorsPanel({ onSelectStock, selectedCode: _selectedCode }: {
  onSelectStock?: SectorSelectStock;
  selectedCode?: string | null;
}) {
  // 台股 / 陸股切換（2026-06-21 復原；陸股走 <CnView/>，台股走下方兩視角）
  const [market, setMarket] = useState<Market>('TW');
  // 預設停在「熱門題材」（裡面預設＝盤中即時）
  const [mode, setMode] = useState<Mode>('fixed');
  // 熱門題材／熱門板塊內的子切換：盤中即時(預設) ↔ 盤後多日排行
  const [liveMode, setLiveMode] = useState(true);

  const [data, setData] = useState<RankingFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const [hot, setHot] = useState<HotFile | null>(null);
  const [hotError, setHotError] = useState<string | null>(null);
  const [hotExpanded, setHotExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (market !== 'TW') return;
    // 盤後多日排行只有在「熱門題材 → 盤後排行」子視角才需要（盤中即時走 LiveThemesView 自己抓）
    if (mode === 'fixed' && !liveMode && !data && !error) {
      fetch('/api/themes/ranking')
        .then(r => r.json())
        .then(j => { if (j.ok === false) throw new Error(j.error ?? '載入失敗'); setData((j.data ?? j) as RankingFile); })
        .catch(e => setError(e instanceof Error ? e.message : String(e)));
    }
    if (mode === 'hot' && !hot && !hotError) {
      fetch('/api/themes/hot')
        .then(r => r.json())
        .then(j => { if (j.ok === false) throw new Error(j.error ?? '載入失敗'); setHot((j.data ?? j) as HotFile); })
        .catch(e => setHotError(e instanceof Error ? e.message : String(e)));
    }
  }, [market, mode, liveMode, data, error, hot, hotError]);

  // 跨來源徽章：近期 YouTube 提及 + 今日三色選中 + 策略掃描信號（台股；命中個股顯示 📺 / 🎨三色 / 6/6 等）
  const [badges, setBadges] = useState<SectorBadgeSets>({ youtube: new Set(), sanse: new Set(), scan: new Map(), six: new Map() });
  const badgeDate = hot?.date ?? data?.date ?? null;
  useEffect(() => {
    if (market !== 'TW') { setBadges({ youtube: new Set(), sanse: new Set(), scan: new Map(), six: new Map() }); return; }
    let cancelled = false;
    const bare = (s: string) => s.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    (async () => {
      const youtube = new Set<string>();
      const sanse = new Set<string>();
      const scan = new Map<string, ScanSig>();
      const d = badgeDate ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
      try {
        const j = await fetch(`/api/youtube/performance?date=${d}`).then((r) => r.json());
        (j.items ?? []).forEach((i: { stock_code?: string }) => { if (i.stock_code) youtube.add(bare(String(i.stock_code))); });
      } catch { /* youtube optional */ }
      try {
        const j = await fetch('/api/tw-sanse/scan').then((r) => r.json());
        (j.records ?? []).forEach((r: { symbol?: string }) => { if (r.symbol) sanse.add(bare(String(r.symbol))); });
      } catch { /* 三色 optional */ }
      try {
        const j: { sessions?: Array<{ results?: Array<{ symbol?: string; sixConditionsScore?: number; trendState?: string; trendPosition?: string; winnerBullishPatterns?: string[]; matchedMethods?: string[] }> }> } =
          await fetch(`/api/scanner/results?market=TW&date=${d}&direction=long`).then((r) => r.json());
        for (const s of j.sessions ?? []) {
          for (const st of s.results ?? []) {
            if (!st.symbol) continue;
            scan.set(bare(String(st.symbol)), {
              six: st.sixConditionsScore ?? 0,
              trend: st.trendState ?? '',
              pos: st.trendPosition ?? '',
              patterns: Array.isArray(st.winnerBullishPatterns) ? st.winnerBullishPatterns.slice(0, 2) : [],
              methods: Array.isArray(st.matchedMethods) ? st.matchedMethods : [],
            });
          }
        }
      } catch { /* 掃描 optional */ }
      if (!cancelled) setBadges((b) => ({ ...b, youtube, sanse, scan }));
    })();
    return () => { cancelled = true; };
  }, [market, badgeDate]);

  // 六條件 + 趨勢：對題材內全部成分股逐檔即時判讀（覆蓋掃描器只封存合格股的漏洞）→ 撐起六條件徽章 + 只看多頭篩選
  useEffect(() => {
    if (market !== 'TW') return;
    const bare = (s: string) => s.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    const codes = new Set<string>();
    hot?.themes.forEach((t) => t.members.forEach((m) => codes.add(bare(m.code))));
    data?.themes.forEach((t) => t.members.forEach((m) => codes.add(bare(m.code))));
    if (codes.size === 0) return;
    const d = badgeDate ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
    let cancelled = false;
    (async () => {
      const list = [...codes];
      const six = new Map<string, SixCondSig>();
      for (let i = 0; i < list.length; i += 120) {
        const part = list.slice(i, i + 120);
        try {
          const j: { items?: Record<string, SixCondSig> } =
            await fetch(`/api/themes/six-conditions?market=TW&date=${d}&codes=${part.join(',')}`).then((r) => r.json());
          for (const [code, v] of Object.entries(j.items ?? {})) six.set(code, v);
        } catch { /* 六條件 optional */ }
      }
      if (!cancelled) setBadges((b) => ({ ...b, six }));
    })();
    return () => { cancelled = true; };
  }, [market, hot, data, badgeDate]);

  const hotLabel = market === 'CN' ? '🔥 今日熱點（人氣／漲停）' : '🔥 今日產業熱點';
  const fixedLabel = market === 'CN' ? '📋 熱門板塊' : '📋 官方產業';

  return (
    <SectorsNavContext.Provider value={onSelectStock ?? null}>
     <SectorsBadgesContext.Provider value={badges}>
      <div className="p-4 space-y-3 h-full overflow-y-auto">
        <div className="flex flex-wrap items-stretch gap-2">
          {/* 市場切換（台股 / 陸股）*/}
          <div className="inline-flex items-center rounded-lg border border-border bg-secondary/30 p-0.5 text-sm">
            <button onClick={() => setMarket('TW')}
              className={`px-3 py-1.5 rounded-md transition-colors ${market === 'TW' ? 'bg-card text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}>台股</button>
            <button onClick={() => setMarket('CN')}
              className={`px-3 py-1.5 rounded-md transition-colors ${market === 'CN' ? 'bg-card text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}>陸股</button>
          </div>
          {/* 視角切換（熱點 / 熱門題材或板塊）*/}
          <div className="inline-flex items-center rounded-lg border border-border bg-secondary/30 p-0.5 text-sm">
            <button onClick={() => setMode('fixed')}
              className={`px-3 py-1.5 rounded-md transition-colors ${mode === 'fixed' ? 'bg-card text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}>{fixedLabel}</button>
            <button onClick={() => setMode('hot')}
              className={`px-3 py-1.5 rounded-md transition-colors ${mode === 'hot' ? 'bg-card text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}>{hotLabel}</button>
          </div>
          {/* 熱門題材／熱門板塊內：盤中即時 ↔ 盤後多日排行（盤中即時做在這裡，不另開頂層分頁）*/}
          {mode === 'fixed' && (
            <div className="inline-flex items-center rounded-lg border border-border bg-secondary/30 p-0.5 text-sm">
              <button onClick={() => setLiveMode(true)}
                className={`px-3 py-1.5 rounded-md transition-colors ${liveMode ? 'bg-card text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}>🔴 盤中即時</button>
              <button onClick={() => setLiveMode(false)}
                className={`px-3 py-1.5 rounded-md transition-colors ${!liveMode ? 'bg-card text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}>📊 盤後排行</button>
            </div>
          )}
        </div>

        {market === 'TW' && (
          <div className="rounded-lg border border-teal-500/20 bg-teal-500/5 px-3 py-2 text-[11px] text-muted-foreground">
            分類依據：TWSE／TPEx 公司基本資料正式產業別；一家公司只歸入一個官方產業，不混入 CPO、AI、CoWoS 等市場題材。
          </div>
        )}

        {mode === 'fixed' ? (
          liveMode ? (
            <LiveThemesView market={market} />
          ) : market === 'CN' ? (
            <CnView mode="fixed" />
          ) : (
            <FixedView data={data} error={error} expanded={expanded} setExpanded={setExpanded} />
          )
        ) : market === 'CN' ? (
          <CnView mode="hot" />
        ) : (
          <HotView hot={hot} error={hotError} expanded={hotExpanded} setExpanded={setHotExpanded} />
        )}
      </div>
     </SectorsBadgesContext.Provider>
    </SectorsNavContext.Provider>
  );
}
