'use client';

/**
 * 盤中即時題材／板塊（2026-06-22）— 首頁「題材分類」分頁的第三個模式「🔴 盤中即時」。
 *
 * 與既有兩個模式（盤後完整熱掃 / 盤後固定題材）分開：本模式盤中每 60s 自動刷新，給「正在動」的盯盤感。
 *   - 台股：/api/themes/live（讀全市場 L2 即時快照聚合，輕量版、不逐檔讀 L1）
 *   - 陸股：/api/cn-sectors/live（直接打東財 push2 即時板塊行情，行業＋概念）
 * 收盤後 API 回 marketOpen=false → 停止輪詢、顯示「已收盤（最後更新…）」。
 * 純顯示／觀察層，不參與選股（鐵則 #5）；只讀單一快照／板塊聚合端點（鐵則 #3）。
 */

import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/shared';
import { applySort } from '@/lib/sorting/sortEngine';
import type { SortDir } from '@/lib/sorting/registry';
import { bullBearClass } from '@/lib/format';
import { useIsChartCurrent } from '@/lib/chartListNav';
import { StockLink } from './StockLink';
import { CnBoardBadges } from './CnBoardBadges';

type Market = 'TW' | 'CN';

// ── API 回傳型別 ───────────────────────────────────────────────────────────────

interface LiveThemeMember {
  code: string; name: string;
  changePercent: number | null; volume: number | null; volRatio: number | null; isLimitUp: boolean;
}
interface LiveTheme {
  theme: string; memberCount: number; quotedCount: number; upCount: number;
  avgChange: number | null; maxChange: number | null;
  topStock: { code: string; name: string; changePercent: number } | null;
  members: LiveThemeMember[];
}
interface TwLivePayload {
  date: string; themeCount: number; themes: LiveTheme[];
  marketOpen: boolean; stale: boolean; staleReason: string | null; updatedAt: string;
}

interface LiveBoard {
  code: string; name: string; kind: 'industry' | 'concept';
  pct: number; turnoverCny: number | null; mainNetCny: number | null;
  upCount: number | null; downCount: number | null;
  leaderSymbol: string | null; leaderName: string | null; leaderPct: number | null;
  limitUpCount: number | null; rank: number; stage: string;
}
interface CnLivePayload {
  marketOpen: boolean; stale: boolean; staleReason: string | null;
  updatedAt: string; snapshotUpdatedAt: string; generatedAt: string; date: string | null;
  industries: LiveBoard[]; concepts: LiveBoard[];
}

// ── 小 primitive（與 SectorsPanel／CnView 同視覺，紅漲綠跌）────────────────────────

function Pct({ v, big }: { v: number | null; big?: boolean }) {
  if (v == null) return <span className="text-muted-foreground/40">—</span>;
  const a = Math.abs(v);
  const tone = a >= 9.5 ? 'font-semibold' : a >= 4 ? 'opacity-90' : 'opacity-60';
  return <span className={`${bullBearClass(v)} ${tone} tabular-nums ${big ? 'text-sm' : ''}`}>{v > 0 ? '+' : ''}{v.toFixed(2)}%</span>;
}

// 主力淨流入（元 → 億/萬）。流入(+)=紅、流出=綠。
function Amt({ v }: { v: number | null }) {
  if (v == null) return <span className="text-muted-foreground/40">—</span>;
  const a = Math.abs(v);
  const text = a >= 1e8 ? `${(v / 1e8).toFixed(1)}億` : a >= 1e4 ? `${Math.round(v / 1e4)}萬` : `${Math.round(v)}`;
  if (a < 1e7) return <span className="text-muted-foreground/55 tabular-nums">{v > 0 ? '+' : ''}{text}</span>;
  return <span className={`${bullBearClass(v)} tabular-nums`}>{v > 0 ? '+' : ''}{text}</span>;
}

function fmtTurnover(v: number | null | undefined): string {
  if (v == null) return '—';
  const a = Math.abs(v);
  return a >= 1e8 ? `${(v / 1e8).toFixed(0)}億` : a >= 1e4 ? `${Math.round(v / 1e4)}萬` : `${Math.round(v)}`;
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

const STAGE_STYLE: Record<string, string> = {
  '剛啟動': 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  '主升段': 'bg-red-500/15 text-red-400 border-red-500/30',
  '高潮噴出': 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  '退潮': 'bg-muted text-muted-foreground border-border',
  '盤整': 'bg-secondary text-muted-foreground border-border',
};

/** 6 位裸碼 → 帶後綴 symbol（走圖用）。6/9→.SS、0/2/3→.SZ、4/8→.BJ */
function toFullSymbol(code: string): string {
  const c = code[0];
  if (c === '6' || c === '9') return `${code}.SS`;
  if (c === '0' || c === '2' || c === '3') return `${code}.SZ`;
  return `${code}.BJ`;
}

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

// ── LIVE 狀態列（紅點 + 更新時間 + 手動刷新）──────────────────────────────────────

function LiveBar({ market, marketOpen, stale, staleReason, updatedAt, refreshing, onRefresh, note }: {
  market: Market; marketOpen: boolean; stale?: boolean; updatedAt: string | null;
  staleReason?: string | null; refreshing: boolean; onRefresh: () => void; note?: string;
}) {
  const tz = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
  const timeStr = updatedAt
    ? new Date(updatedAt).toLocaleTimeString('zh-TW', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    : '—';
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card/40 px-3 py-1.5">
      <div className="flex items-center gap-2 text-xs">
        {marketOpen && !stale ? (
          <span className="inline-flex items-center gap-1.5 text-red-400 font-medium">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75 animate-ping" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
            </span>
            盤中即時
          </span>
        ) : marketOpen && stale ? (
          <span className="inline-flex items-center gap-1.5 text-yellow-500 font-medium">
            <span className="inline-flex rounded-full h-2 w-2 bg-yellow-500" />
            即時資料中斷
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span className="inline-flex rounded-full h-2 w-2 bg-muted-foreground/50" />
            已收盤
          </span>
        )}
        <span className="text-muted-foreground/60">更新 {timeStr}</span>
        {stale && <span title={staleReason ?? undefined} className="text-[10px] px-1 py-0.5 rounded bg-yellow-500/15 text-yellow-500">行情快照過期</span>}
        {note && <span className="text-muted-foreground/40">{note}</span>}
      </div>
      <button type="button" onClick={onRefresh} disabled={refreshing}
        className="text-xs px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 disabled:opacity-50">
        {refreshing ? '更新中…' : '↻ 刷新'}
      </button>
    </div>
  );
}

// ── 台股：題材卡（完整成分股，可展開）──────────────────────────────────────────

// 成分股一列（抽成元件才能用 useIsChartCurrent 高亮目前走圖那檔）
function TwLiveMemberRow({ m }: { m: LiveThemeMember }) {
  const isCur = useIsChartCurrent(m.code);
  return (
    <div className={`flex items-center justify-between gap-2 rounded border bg-card/40 px-2.5 py-1.5 ${isCur ? 'border-sky-400/70 ring-1 ring-sky-400/50 bg-sky-500/5' : 'border-foreground/15'}`}>
      <div className="flex items-center gap-1.5 flex-wrap min-w-0">
        <StockLink code={m.code} className="hover:text-sky-400 inline-flex items-baseline gap-1.5">
          <span className="font-medium text-foreground text-sm">{m.name}</span>
          <span className="text-muted-foreground/45 text-[11px]">{m.code}</span>
        </StockLink>
        {m.isLimitUp && <span className="text-[10px] px-1 py-0.5 rounded bg-red-500/15 text-red-400">漲停</span>}
        <span className="text-[10px] text-muted-foreground/55">量 {m.volRatio != null ? `${m.volRatio.toFixed(1)}×` : '—'}</span>
      </div>
      <span className="font-mono tabular-nums shrink-0"><Pct v={m.changePercent} /></span>
    </div>
  );
}

function TwThemeCard({ t, rank, expanded, onToggle }: {
  t: LiveTheme; rank: number; expanded: boolean; onToggle: () => void;
}) {
  // 成分股按今日漲幅 高→低；沒報價（停牌/未成交）沉底
  const members = [...t.members].sort((a, b) => (b.changePercent ?? -Infinity) - (a.changePercent ?? -Infinity));
  return (
    <div className={expanded ? 'bg-muted/20' : ''}>
      <div onClick={onToggle}
        className="rounded-lg border border-foreground/20 bg-card/40 px-3 py-2 cursor-pointer hover:border-foreground/40 hover:bg-muted/30 transition-colors">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
            <RankBadge rank={rank} />
            <span className={`text-muted-foreground/40 transition-transform ${expanded ? 'rotate-90' : ''}`}>›</span>
            <span className="font-semibold text-foreground text-sm">{t.theme}</span>
            <span className="text-[11px] text-muted-foreground/50">{t.memberCount}檔</span>
            <span className="text-[10px] text-muted-foreground/55">{t.upCount}↑</span>
          </div>
          <span className="shrink-0"><Pct v={t.avgChange} big /></span>
        </div>
        <div className="flex items-center gap-x-3 gap-y-0.5 flex-wrap mt-1 text-[10px]">
          <span className="font-mono tabular-nums text-muted-foreground/55">最強 <Pct v={t.maxChange} /></span>
          {t.topStock && (
            <span className="text-muted-foreground/55 inline-flex items-center gap-0.5">領漲
              <StockLink code={t.topStock.code} className="hover:text-sky-400 font-mono tabular-nums">{t.topStock.name} <Pct v={t.topStock.changePercent} /></StockLink>
            </span>
          )}
        </div>
      </div>
      {expanded && (
        // data-navlist：鍵盤 ↑↓ 跳股的清單範圍（題材成分股共用 sector-members）
        <div className="bg-muted/20 border-t border-border border-l-2 border-l-sky-500/40 p-1.5 space-y-1" data-navlist="sector-members">
          {members.map((m) => <TwLiveMemberRow key={m.code} m={m} />)}
        </div>
      )}
    </div>
  );
}

const TW_SORTS = [
  { id: 'avg', label: '即時漲' }, { id: 'up', label: '上漲家數' }, { id: 'max', label: '最強漲' }, { id: 'count', label: '檔數' },
];

function TwLive({ data }: { data: TwLivePayload }) {
  const [sortId, setSortId] = useState('avg');
  const [dir, setDir] = useState<SortDir>('desc');
  const [expanded, setExpanded] = useState<string | null>(null);
  const sortBy = (id: string) => { if (sortId === id) setDir(dir === 'desc' ? 'asc' : 'desc'); else { setSortId(id); setDir('desc'); } };

  const themes = applySort(data.themes, sortId, dir,
    (t, id) => id === 'avg' ? t.avgChange : id === 'up' ? t.upCount : id === 'max' ? t.maxChange : id === 'count' ? t.memberCount : null,
    { missingLast: true });

  if (themes.length === 0) {
    return <EmptyState icon="😴" title="沒有題材資料" description="需要當日 L2 全市場快照" />;
  }
  return (
    <div className="rounded-xl ring-1 ring-foreground/10 bg-card/60 overflow-hidden">
      <SortBar sorts={TW_SORTS} sortId={sortId} dir={dir} onSort={sortBy} hint="點題材看完整成分股" />
      <div className="p-1.5 space-y-1.5">
        {themes.map((t, i) => (
          <TwThemeCard key={t.theme} t={t} rank={i + 1} expanded={expanded === t.theme}
            onToggle={() => setExpanded(expanded === t.theme ? null : t.theme)} />
        ))}
      </div>
    </div>
  );
}

// ── 陸股：板塊卡（行業／概念）──────────────────────────────────────────────────

const CN_SORTS = [
  { id: 'pct', label: '即時漲' }, { id: 'main', label: '主力流入' }, { id: 'turn', label: '成交額' }, { id: 'up', label: '上漲家數' },
];

/** 板塊成分股一筆（/api/cn-sectors/board-members?light=1 回傳） */
interface CnLiveMember {
  code: string; name: string; symbol: string;
  pct: number; turnoverCny: number | null; mainNetCny: number | null;
}

// 陸股板塊成分股一列（抽成元件才能用 useIsChartCurrent 高亮目前走圖那檔）
function CnLiveMemberRow({ m }: { m: CnLiveMember }) {
  const isCur = useIsChartCurrent(m.symbol);
  return (
    <div className={`flex items-center justify-between gap-2 rounded border bg-card/40 px-2.5 py-1.5 ${isCur ? 'border-sky-400/70 ring-1 ring-sky-400/50 bg-sky-500/5' : 'border-foreground/15'}`}>
      <div className="flex items-center gap-1.5 flex-wrap min-w-0">
        <StockLink code={m.symbol} className="hover:text-sky-400 inline-flex items-baseline gap-1.5">
          <span className="font-medium text-foreground text-sm">{m.name}</span>
          <span className="text-muted-foreground/45 text-[11px]">{m.code}</span>
        </StockLink>
        <CnBoardBadges code={m.code} name={m.name} />
        <span className="text-[10px] text-muted-foreground/55">成交 {fmtTurnover(m.turnoverCny)}</span>
        <span className="text-[10px] text-muted-foreground/55 inline-flex items-baseline gap-0.5">主力 <Amt v={m.mainNetCny} /></span>
      </div>
      <span className="font-mono tabular-nums shrink-0"><Pct v={m.pct} /></span>
    </div>
  );
}

function CnBoardRow({ b, rank, sortId, dir }: { b: LiveBoard; rank: number; sortId: string; dir: SortDir }) {
  const [expanded, setExpanded] = useState(false);
  const [members, setMembers] = useState<CnLiveMember[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 成分股跟著上方選的排序欄位走（即時漲/主力流入/成交額；上漲家數無個股對應 → 退回即時漲）
  const sortedMembers = members
    ? applySort(members, sortId, dir,
        (m, id) => id === 'main' ? m.mainNetCny : id === 'turn' ? m.turnoverCny : m.pct,
        { missingLast: true })
    : null;

  // 首次展開才抓成分股（lazy）；之後切換不重抓
  // 依賴只放 [expanded, b.code]：members/loading 不可入依賴 —— 否則 setLoading(true) 會
  // 自己觸發 effect 重跑 → cleanup 把進行中的 fetch 標 cancelled → 資料回來被忽略、loading
  // 永遠 true（「一直在抓成分股」的 bug 根因，2026-06-22 修）。
  useEffect(() => {
    if (!expanded || members != null) return;
    let cancelled = false;
    setLoading(true); setErr(null);
    fetch(`/api/cn-sectors/board-members?code=${encodeURIComponent(b.code)}&light=1`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j.ok === false || j.error) { setErr(j.error ?? '抓取失敗'); return; }
        setMembers((j.data?.members ?? j.members ?? []) as CnLiveMember[]);
      })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, b.code]);

  return (
    <div className={expanded ? 'bg-muted/20' : ''}>
      <div onClick={() => setExpanded((v) => !v)}
        className="rounded-lg border border-foreground/20 bg-card/40 px-3 py-2 cursor-pointer hover:border-foreground/40 hover:bg-muted/30 transition-colors">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
            <RankBadge rank={rank} />
            <span className={`text-muted-foreground/40 transition-transform ${expanded ? 'rotate-90' : ''}`}>›</span>
            <span className="font-semibold text-foreground text-sm">{b.name}</span>
            {b.upCount != null && <span className="text-[11px] text-muted-foreground/50">{b.upCount}漲{b.downCount != null ? `/${b.downCount}跌` : ''}</span>}
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STAGE_STYLE[b.stage] ?? STAGE_STYLE['盤整']}`}>{b.stage}</span>
            {b.limitUpCount != null && b.limitUpCount > 0 && <span className="text-[10px] text-red-400">漲停{b.limitUpCount}</span>}
            {b.leaderName && b.leaderSymbol && (
              <span className="text-[10px] text-muted-foreground/55 inline-flex items-baseline gap-1">領漲
                <StockLink code={toFullSymbol(b.leaderSymbol)} className="hover:text-sky-400 text-foreground/80 inline-flex items-baseline gap-1">
                  <span>{b.leaderName}</span> <Pct v={b.leaderPct} />
                </StockLink>
              </span>
            )}
          </div>
          <span className="shrink-0"><Pct v={b.pct} big /></span>
        </div>
        <div className="flex items-center gap-x-3 flex-wrap mt-1 text-[10px] text-muted-foreground/55">
          <span>主力 <Amt v={b.mainNetCny} /></span>
          <span>成交 {fmtTurnover(b.turnoverCny)}</span>
        </div>
      </div>
      {expanded && (
        // data-navlist：鍵盤 ↑↓ 跳股的清單範圍（題材成分股共用 sector-members）
        <div className="bg-muted/20 border-t border-border border-l-2 border-l-sky-500/40 p-1.5 space-y-1" data-navlist="sector-members">
          {loading && <div className="text-[11px] text-muted-foreground/60 py-3 text-center animate-pulse">抓成分股中…</div>}
          {err && !loading && <div className="text-[11px] text-amber-400/80 py-3 text-center">成分股抓不到（{err}）</div>}
          {members && members.length === 0 && !loading && <div className="text-[11px] text-muted-foreground/60 py-3 text-center">無成分股資料</div>}
          {sortedMembers && sortedMembers.map((m) => <CnLiveMemberRow key={m.code} m={m} />)}
        </div>
      )}
    </div>
  );
}

function CnLive({ data }: { data: CnLivePayload }) {
  const [kind, setKind] = useState<'concept' | 'industry'>('concept');
  const [sortId, setSortId] = useState('pct');
  const [dir, setDir] = useState<SortDir>('desc');
  const sortBy = (id: string) => { if (sortId === id) setDir(dir === 'desc' ? 'asc' : 'desc'); else { setSortId(id); setDir('desc'); } };

  const boards = applySort(kind === 'concept' ? data.concepts : data.industries, sortId, dir,
    (b, id) => id === 'pct' ? b.pct : id === 'main' ? b.mainNetCny : id === 'turn' ? b.turnoverCny : id === 'up' ? b.upCount : null,
    { missingLast: true });

  return (
    <div className="space-y-3">
      <div className="inline-flex rounded-lg border border-border bg-secondary/30 p-0.5 text-sm">
        <button onClick={() => setKind('concept')}
          className={`px-3 py-1.5 rounded-md transition-colors ${kind === 'concept' ? 'bg-card text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}>概念題材 {data.concepts.length}</button>
        <button onClick={() => setKind('industry')}
          className={`px-3 py-1.5 rounded-md transition-colors ${kind === 'industry' ? 'bg-card text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}>行業板塊 {data.industries.length}</button>
      </div>
      {boards.length === 0 ? (
        <EmptyState icon="🔍" title="沒有板塊資料" description="東財板塊行情暫時抓不到（盤前或來源忙線）" />
      ) : (
        <div className="rounded-xl ring-1 ring-foreground/10 bg-card/60 overflow-hidden">
          <SortBar sorts={CN_SORTS} sortId={sortId} dir={dir} onSort={sortBy} hint="點板塊看成分股" />
          <div className="p-1.5 space-y-1.5">
            {boards.map((b, i) => <CnBoardRow key={b.code} b={b} rank={i + 1} sortId={sortId} dir={dir} />)}
          </div>
        </div>
      )}
    </div>
  );
}

// ── 外層：輪詢 + LIVE 狀態 ─────────────────────────────────────────────────────

export function LiveThemesView({ market }: { market: Market }) {
  const endpoint = market === 'TW' ? '/api/themes/live' : '/api/cn-sectors/live';
  const [tw, setTw] = useState<TwLivePayload | null>(null);
  const [cn, setCn] = useState<CnLivePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // 切市場 → 清掉上一個市場的資料（避免閃舊）
  useEffect(() => { setTw(null); setCn(null); setError(null); }, [endpoint]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const load = async () => {
      try {
        const j = await fetch(endpoint).then((r) => r.json());
        if (cancelled) return;
        if (j.ok === false || j.error) { setError(j.error ?? '載入失敗'); return; }
        setError(null);
        if (market === 'TW') setTw(j as TwLivePayload); else setCn(j as CnLivePayload);
        // 收盤 → 停止輪詢（保留最後一筆顯示）
        if (!j.marketOpen && timer) { clearInterval(timer); timer = null; }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setRefreshing(false);
      }
    };
    load();
    timer = setInterval(load, 60_000);
    return () => { cancelled = true; if (timer) clearInterval(timer); };
  }, [endpoint, market, reloadKey]);

  const refresh = () => { setRefreshing(true); setReloadKey((k) => k + 1); };

  const payload = market === 'TW' ? tw : cn;
  const marketOpen = payload?.marketOpen ?? false;
  const stale = market === 'TW' ? (tw?.stale ?? false) : (cn?.stale ?? false);
  const staleReason = market === 'TW' ? tw?.staleReason : cn?.staleReason;
  const updatedAt = payload?.updatedAt ?? null;
  const note = market === 'TW' && tw
    ? `資料日 ${tw.date} · ${tw.themeCount} 個題材（完整成分）`
    : market === 'CN' && cn?.date
      ? `資料日 ${cn.date}`
      : undefined;

  return (
    <div className="space-y-3">
      <LiveBar market={market} marketOpen={marketOpen} stale={stale} staleReason={staleReason} updatedAt={updatedAt}
        refreshing={refreshing} onRefresh={refresh} note={note} />

      {error && !payload && (
        <EmptyState icon="⚠️" title="即時資料抓不到" description={market === 'TW' ? `${error}（需要當日 L2 全市場快照）` : `${error}（東財板塊行情；盤中需網路代理正常）`} />
      )}
      {!payload && !error && (
        <div className="text-muted-foreground text-sm py-12 text-center animate-pulse">{market === 'TW' ? '掃描全市場中…' : '抓東財即時板塊中…'}</div>
      )}

      {market === 'TW' && tw && <TwLive data={tw} />}
      {market === 'CN' && cn && <CnLive data={cn} />}

      {!marketOpen && payload && (
        <p className="text-[11px] text-muted-foreground/45 text-center">收盤了，顯示的是最後一筆。盤中會每分鐘自動更新。</p>
      )}
    </div>
  );
}
