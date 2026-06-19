'use client';

/**
 * /sectors — 板塊（題材）強弱排名頁（2026-06-12 A2；2026-06-14 套用統一版面；
 *            2026-06-19 加「今日全市場熱點」切換）
 *
 * 兩種視角（顯示層參考，不參與選股 鐵則 #5）：
 *   - 固定25題材：寫死的 25 題材成分股聚合報酬（/api/themes/ranking，盤後 17:10 cron）。
 *   - 今日全市場熱點：掃全市場 L2 快照找今天在熱的股（漲幅+爆量+法人），自動歸題材後排名
 *     （/api/themes/hot，即時算）。能抓到固定清單外的新熱點。
 *
 * 版面：統一走 PageShell + PageHeader + 主題 CSS 變數（不再寫死深灰固定底色）。
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { PageShell, PageHeader, EmptyState } from '@/components/shared';
import { SortControl } from '@/components/shared/SortControl';
import { applySort } from '@/lib/sorting/sortEngine';
import type { SortDir } from '@/lib/sorting/registry';
import { useWatchlistStore } from '@/store/watchlistStore';
import { bullBearClass } from '@/lib/format';
import { PERF_PERIODS, INST_PERIODS } from '@/lib/themes/perfPeriods';
import { CnView } from './CnView';

// 績效格預設只看的關鍵天數（其餘點「展開」才出現）
const KEY_PERIODS = [1, 5, 10, 20];
const periodIndex = (id: string) => (PERF_PERIODS as readonly number[]).indexOf(Number(id.slice(1)));

// 加入自選鈕（reactive：加入後即時顯示 ✓）
function AddWatchBtn({ code, name }: { code: string; name: string }) {
  const has = useWatchlistStore((s) => s.items.some((i) => i.symbol === code));
  return (
    <button type="button" title={has ? '已在自選' : '加入自選'}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); useWatchlistStore.getState().add(code, name); }}
      className={`text-[10px] px-1.5 py-0.5 rounded border whitespace-nowrap ${has ? 'border-emerald-500/40 text-emerald-400' : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/30'}`}>
      {has ? '✓' : '＋'}
    </button>
  );
}

interface ThemeStockPerf {
  code: string; name: string;
  d1: number | null; d5: number | null; d20: number | null; d60: number | null;
  volRatio: number | null; instNet5: number | null;
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
  topStock: { code: string; name: string; d1: number } | null;
  members: ThemeStockPerf[];
  rotation?: ThemeRotation | null;
}
interface RankingFile { date: string; generatedAt: string; themes: ThemeRank[] }

interface HotStock {
  code: string; name: string; changePercent: number; volume: number;
  volRatio: number | null; instNet: number | null;
  isLimitUp: boolean; isNotice: boolean; heat: number;
  theme: string; themeSource: 'concept' | 'industry' | 'other';
  rets?: (number | null)[];
  instAmt?: (number | null)[];
  retailAmt?: (number | null)[];
}
interface HotTheme {
  theme: string; source: 'concept' | 'industry' | 'other';
  hotCount: number; avgChange: number; maxChange: number; avgHeat: number; score: number;
  topStock: { code: string; name: string; changePercent: number } | null;
  members: HotStock[];
}
interface HotFile {
  date: string; generatedAt: string; market: string;
  totalScanned: number; hotStockCount: number; uncategorizedCount: number; instFresh: boolean;
  themes: HotTheme[];
}

type Mode = 'fixed' | 'hot';
type Market = 'TW' | 'CN';

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
  if (v == null) return <span className="text-muted-foreground/40">—</span>;
  const a = Math.abs(v);
  // 接近持平用中性灰（不染紅綠）→ 減少滿屏一片紅
  if (a < 1) return <span className="text-muted-foreground/55 tabular-nums">{v > 0 ? '+' : ''}{v.toFixed(1)}%</span>;
  // 紅漲綠跌＋「強度分層」：小漲淡、大漲才亮且粗 → 一片紅變成有層次、強的跳出來
  const tone = a >= 12 ? 'font-semibold' : a >= 5 ? 'opacity-90' : 'opacity-55';
  return <span className={`${bullBearClass(v)} ${tone} tabular-nums`}>{v > 0 ? '+' : ''}{v.toFixed(1)}%</span>;
}

// 法人買超金額（元 → 億/萬）。買超(+)=紅(資金流入)、賣超=綠；接近 0 灰。
function Amt({ v }: { v: number | null }) {
  if (v == null) return <span className="text-muted-foreground/40">—</span>;
  const a = Math.abs(v);
  const text = a >= 1e8 ? `${(v / 1e8).toFixed(1)}億` : a >= 1e4 ? `${Math.round(v / 1e4)}萬` : `${Math.round(v)}`;
  if (a < 1e7) return <span className="text-muted-foreground/55 tabular-nums">{v > 0 ? '+' : ''}{text}</span>;
  return <span className={`${bullBearClass(v)} tabular-nums`}>{v > 0 ? '+' : ''}{text}</span>;
}

// 名次徽章：前 3 名用暖色強調，其餘淡灰數字（顏色 + 數字雙重，不只靠顏色）
function RankBadge({ rank }: { rank: number }) {
  if (rank <= 3) {
    const tone = ['bg-orange-500/20 text-orange-400 ring-orange-500/30',
      'bg-amber-500/15 text-amber-400 ring-amber-500/25',
      'bg-yellow-500/15 text-yellow-500 ring-yellow-500/25'][rank - 1];
    return (
      <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-semibold ring-1 ${tone} tabular-nums`}>
        {rank}
      </span>
    );
  }
  return <span className="inline-flex items-center justify-center w-6 text-sm text-muted-foreground/50 tabular-nums">{rank}</span>;
}

// 輪動標籤（描述性，非買賣訊號）：🟢轉入 / 🔴轉出 / 主流。
// 用 🟢🟡🔴 表「錢進/出」，刻意跟漲跌紅綠分開避免混淆；名次變化用淡字。
function RotationCell({ r }: { r?: ThemeRotation | null }) {
  // 名次怎麼變：5天前第幾名 → 今天第幾名（最白話）
  const move = r?.rankPrev != null && r?.rankNow != null ? `${r.rankPrev}→${r.rankNow}名` : '';
  if (r?.bucket === 'in') {
    return <span className="text-xs whitespace-nowrap" title="名次往上爬＝資金流進（描述用，非買賣訊號）">🟢 資金流進 <span className="text-muted-foreground/70">{move}</span></span>;
  }
  if (r?.bucket === 'out') {
    return <span className="text-xs whitespace-nowrap" title="名次往下掉＝資金流出（描述用，非買賣訊號）">🔴 資金流出 <span className="text-muted-foreground/70">{move}</span></span>;
  }
  // 名次沒大變（資金沒明顯進出）：直接寫目前是第幾名（最強前3名加🔥）
  if (r?.rankNow != null) {
    return <span className="text-xs whitespace-nowrap text-muted-foreground/65" title="名次沒大變動，資金沒明顯進出（維持原本強弱）">
      {r.rankNow <= 3 ? '🔥 ' : ''}第{r.rankNow}名
    </span>;
  }
  return <span className="text-xs text-muted-foreground/45 whitespace-nowrap">—</span>;
}

// 可點排序的欄位標題（點同欄切升降序、點別欄換欄）
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

// 熱度小橫條：視覺強度 + 數字（0-100）
function HeatBar({ v }: { v: number }) {
  const pct = Math.max(4, Math.min(100, v));
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="hidden sm:block w-12 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full bg-gradient-to-r from-amber-500 to-orange-500" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-orange-400 font-mono tabular-nums w-7 text-right">{v.toFixed(0)}</span>
    </div>
  );
}

// 成分股績效表。預設只看 1/5/10/20 日（可展開全部）；可排序；每列框出「發動最猛的那段」。
function PerfGrid({ members }: {
  members: Array<{ code: string; name: string; rets?: (number | null)[]; instAmt?: (number | null)[]; retailAmt?: (number | null)[]; isLimitUp?: boolean; isNotice?: boolean }>;
}) {
  const [view, setView] = useState<'ret' | 'inst'>('ret');
  const [chipWin, setChipWin] = useState(5); // 籌碼比較的天數視窗（1/3/5/10）
  const [showAll, setShowAll] = useState(true); // 預設顯示全部 1~10,20 日（看績效固定要求）
  const [sortId, setSortId] = useState('r5');
  const [dir, setDir] = useState<SortDir>('desc');
  const periods = showAll ? [...PERF_PERIODS] : KEY_PERIODS;
  const activeIdx = periodIndex(sortId);
  const idxOf = (p: number) => (PERF_PERIODS as readonly number[]).indexOf(p);

  const sorted = applySort(members, sortId, dir, (m, id) => m.rets?.[periodIndex(id)] ?? null, { missingLast: true });
  const sortBy = (id: string) => { if (sortId === id) setDir(dir === 'desc' ? 'asc' : 'desc'); else { setSortId(id); setDir('desc'); } };

  // 「發動最猛的那段」= 目前顯示天數中，每天平均漲最兇的那一格（短線剛噴 vs 長線累積）
  const hottestPeriod = (m: { rets?: (number | null)[] }): number | null => {
    let best = 0, bp: number | null = null;
    for (const p of periods) { const v = m.rets?.[idxOf(p)]; if (v != null && v > 0 && v / p > best) { best = v / p; bp = p; } }
    return bp;
  };

  // 個股名稱欄（兩種視角共用）
  const NameCell = (m: typeof members[number]) => (
    <td className="pl-3 pr-2 py-1.5 sticky left-0 bg-card">
      <div className="flex items-center gap-1.5 whitespace-nowrap">
        <Link href={`/?load=${m.code}`} className="hover:text-sky-400 inline-flex items-center gap-1.5">
          <span className="text-foreground/90">{m.name}</span>
          <span className="text-muted-foreground/50">{m.code}</span>
        </Link>
        {m.isLimitUp && <span className="text-[10px] px-1 py-0.5 rounded bg-red-500/15 text-red-400">漲停</span>}
        {m.isNotice && <span className="text-[10px] px-1 py-0.5 rounded bg-yellow-500/15 text-yellow-500">注意</span>}
        <Link href={`/?load=${m.code}`} title="走圖"
          className="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-sky-400 hover:border-sky-400/40">走圖</Link>
        <AddWatchBtn code={m.code} name={m.name} />
      </div>
    </td>
  );

  const Toggle = (
    <div className="inline-flex rounded-md border border-border overflow-hidden text-[10px]">
      <button type="button" onClick={() => setView('ret')}
        className={`px-2 py-0.5 ${view === 'ret' ? 'bg-sky-700 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>漲幅</button>
      <button type="button" onClick={() => setView('inst')}
        className={`px-2 py-0.5 ${view === 'inst' ? 'bg-sky-700 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>籌碼(法人vs散戶)</button>
    </div>
  );

  // ── 籌碼視角：法人 vs 散戶(融資) 並排 + 判讀（選 1/3/5/10 日視窗）──
  if (view === 'inst') {
    const wi = (INST_PERIODS as readonly number[]).indexOf(chipWin);
    const FLOOR = 1e7; // 1000萬以上才算「明顯買/賣」
    const chipVerdict = (inst: number | null | undefined, retail: number | null | undefined) => {
      if (inst == null || retail == null) return { t: '—', c: 'text-muted-foreground/40' };
      const ib = inst > FLOOR, is = inst < -FLOOR, rb = retail > FLOOR, rs = retail < -FLOOR;
      if (ib && rs) return { t: '✅ 法人買·散戶賣', c: 'text-bull' };       // 籌碼沉澱到法人=好
      if (is && rb) return { t: '⚠️ 法人賣·散戶接', c: 'text-bear' };       // 散戶接刀=危險
      if (ib && rb) return { t: '🟡 兩邊都買', c: 'text-muted-foreground/70' };
      if (is && rs) return { t: '🟢 兩邊都賣', c: 'text-muted-foreground/70' };
      return { t: '—', c: 'text-muted-foreground/40' };
    };
    return (
      <div className="bg-muted/15 border-t border-border">
        <div className="px-3 py-2 flex items-center gap-2 flex-wrap">
          {Toggle}
          <span className="text-[10px] text-muted-foreground/50">天數</span>
          <div className="inline-flex rounded-md border border-border overflow-hidden text-[10px]">
            {INST_PERIODS.map((p) => (
              <button key={p} type="button" onClick={() => setChipWin(p)}
                className={`px-2 py-0.5 ${chipWin === p ? 'bg-sky-700 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>{p}日</button>
            ))}
          </div>
          <span className="text-[10px] text-muted-foreground/45">金額：紅=買進、綠=賣出</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground/50 text-[10px] border-b border-border/40">
                <th className="text-left font-medium pl-3 pr-2 py-2 sticky left-0 bg-card z-10">個股</th>
                <th className="text-right font-medium px-2 py-2">法人{chipWin}日</th>
                <th className="text-right font-medium px-2 py-2">散戶融資{chipWin}日</th>
                <th className="text-left font-medium px-2 py-2">籌碼判讀</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const iv = m.instAmt?.[wi] ?? null;
                const rv = m.retailAmt?.[wi] ?? null;
                const vd = chipVerdict(iv, rv);
                return (
                  <tr key={m.code} className="border-b border-border/25 last:border-0 hover:bg-muted/40 transition-colors">
                    {NameCell(m)}
                    <td className="text-right px-2 py-1.5 font-mono tabular-nums"><Amt v={iv} /></td>
                    <td className="text-right px-2 py-1.5 font-mono tabular-nums"><Amt v={rv} /></td>
                    <td className={`px-2 py-1.5 text-xs whitespace-nowrap ${vd.c}`}>{vd.t}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // ── 漲幅視角（過去 1~10,20 日）──
  const sortOpts = periods.map((p) => ({ id: `r${p}`, label: `${p}日`, tip: `按過去 ${p} 日漲幅排序`, defaultDir: 'desc' as SortDir }));
  return (
    <div className="bg-muted/15 border-t border-border">
      <div className="px-3 py-2 flex items-center gap-2 flex-wrap">
        {Toggle}
        <SortControl options={sortOpts} value={sortId} dir={dir}
          onChange={(id, d) => { setSortId(id); setDir(d); }} leading="排序" size="compact" />
        <button type="button" onClick={() => setShowAll((s) => !s)}
          className="text-[10px] px-2 py-0.5 rounded-full border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30">
          {showAll ? '收合（只看 1/5/10/20）' : '展開全部天數'}
        </button>
        <span className="text-[10px] text-muted-foreground/45">🔸框＝發動最猛那段</span>
      </div>
      <div className="overflow-x-auto">
        <table className={`w-full text-xs ${showAll ? 'min-w-[720px]' : ''}`}>
          <thead>
            <tr className="text-muted-foreground/50 text-[10px] border-b border-border/40">
              <th className="text-left font-medium pl-3 pr-2 py-2 sticky left-0 bg-card z-10">個股</th>
              {periods.map((p) => (
                <th key={p} onClick={() => sortBy(`r${p}`)}
                  className={`text-right font-medium px-2 py-2 tabular-nums cursor-pointer select-none hover:text-foreground ${idxOf(p) === activeIdx ? 'text-sky-400' : ''}`}>
                  {p}日{idxOf(p) === activeIdx ? (dir === 'desc' ? ' ▼' : ' ▲') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((m) => {
              const hot = hottestPeriod(m);
              return (
                <tr key={m.code} className="border-b border-border/25 last:border-0 hover:bg-muted/40 transition-colors">
                  {NameCell(m)}
                  {periods.map((p) => {
                    const i = idxOf(p);
                    return (
                      <td key={p} className={`text-right px-2 py-1.5 font-mono tabular-nums ${i === activeIdx ? 'bg-sky-500/5' : ''}`}>
                        <span className={p === hot ? 'ring-1 ring-amber-400/50 rounded px-1 py-0.5' : ''}>
                          <Pct v={m.rets?.[i] ?? null} />
                        </span>
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

export default function SectorsPage() {
  const [market, setMarket] = useState<Market>('TW');
  const [mode, setMode] = useState<Mode>('hot');

  const [data, setData] = useState<RankingFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const [hot, setHot] = useState<HotFile | null>(null);
  const [hotError, setHotError] = useState<string | null>(null);
  const [hotExpanded, setHotExpanded] = useState<string | null>(null);

  // 初次掛載讀 ?market=（SSR 預設 TW，避免 hydration 不一致；effect 內再校正）
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('market') === 'CN') setMarket('CN');
  }, []);

  // 市場切換寫回網址（書籤用，不導航）
  useEffect(() => {
    const url = new URL(window.location.href);
    if (market === 'CN') url.searchParams.set('market', 'CN'); else url.searchParams.delete('market');
    window.history.replaceState(null, '', url.toString());
  }, [market]);

  useEffect(() => {
    if (market !== 'TW') return;
    if (mode === 'fixed' && !data && !error) {
      fetch('/api/themes/ranking')
        .then(r => r.json())
        .then(j => {
          if (j.ok === false) throw new Error(j.error ?? '載入失敗');
          setData((j.data ?? j) as RankingFile);
        })
        .catch(e => setError(e instanceof Error ? e.message : String(e)));
    }
    if (mode === 'hot' && !hot && !hotError) {
      fetch('/api/themes/hot')
        .then(r => r.json())
        .then(j => {
          if (j.ok === false) throw new Error(j.error ?? '載入失敗');
          setHot((j.data ?? j) as HotFile);
        })
        .catch(e => setHotError(e instanceof Error ? e.message : String(e)));
    }
  }, [market, mode, data, error, hot, hotError]);

  const twSubtitle = mode === 'hot'
    ? (hot ? `資料日 ${hot.date} · 全市場 ${hot.hotStockCount} 檔在熱` : '全市場自動歸類熱點')
    : (data ? `資料日 ${data.date} · ${data.themes.length} 個熱門題材` : '熱門題材聚合報酬');
  const subtitle = market === 'CN' ? '陸股板塊／概念強弱 · 人氣榜 · 漲停池' : twSubtitle;

  const hotLabel = market === 'CN' ? '🔥 今日熱點（人氣／漲停）' : '🔥 今日全市場熱點';
  const fixedLabel = market === 'CN' ? '📋 熱門板塊' : '📋 熱門題材';

  return (
    <PageShell
      headerSlot={<PageHeader title="📊 題材分類" subtitle={subtitle} backButton />}
    >
      <div className="p-4 space-y-3">
        {/* 市場切換 + 視角切換：同一水平列（窄螢幕才換行）。
            items-stretch + 各 pill items-center → 兩 pill 等高、按鈕垂直置中，
            避免不同瀏覽器（如 Firefox）國旗 emoji 較高造成上下錯位。*/}
        <div className="flex flex-wrap items-stretch gap-2">
          {/* 市場切換（台股/陸股）*/}
          <div className="inline-flex items-center rounded-lg border border-border bg-secondary/30 p-0.5 text-sm">
            <button
              onClick={() => setMarket('TW')}
              className={`px-3 py-1.5 rounded-md transition-colors ${market === 'TW' ? 'bg-card text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}
            >🇹🇼 台股</button>
            <button
              onClick={() => setMarket('CN')}
              className={`px-3 py-1.5 rounded-md transition-colors ${market === 'CN' ? 'bg-card text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}
            >🇨🇳 陸股</button>
          </div>

          {/* 視角切換（熱點 / 熱門題材或板塊）*/}
          <div className="inline-flex items-center rounded-lg border border-border bg-secondary/30 p-0.5 text-sm">
            <button
              onClick={() => setMode('hot')}
              className={`px-3 py-1.5 rounded-md transition-colors ${mode === 'hot' ? 'bg-card text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}
            >{hotLabel}</button>
            <button
              onClick={() => setMode('fixed')}
              className={`px-3 py-1.5 rounded-md transition-colors ${mode === 'fixed' ? 'bg-card text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}
            >{fixedLabel}</button>
          </div>
        </div>

        {market === 'CN' ? (
          <CnView mode={mode} />
        ) : mode === 'hot' ? (
          <HotView hot={hot} error={hotError} expanded={hotExpanded} setExpanded={setHotExpanded} />
        ) : (
          <FixedView data={data} error={error} expanded={expanded} setExpanded={setExpanded} />
        )}
      </div>
    </PageShell>
  );
}

// ── 今日全市場熱點 ────────────────────────────────────────────────────────────

function SourceTag({ source }: { source: HotTheme['source'] }) {
  if (source === 'concept') return null;
  const label = source === 'industry' ? '產業' : '未分類';
  return <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground/70 align-middle">{label}</span>;
}

function HotThemeTable({ rows, rankBase, expanded, setExpanded, sortId, dir, onSort }: {
  rows: HotTheme[]; rankBase: number; expanded: string | null; setExpanded: (s: string | null) => void;
  sortId: string; dir: SortDir; onSort: (id: string) => void;
}) {
  return (
    <div className="rounded-xl ring-1 ring-foreground/10 bg-card/60 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted-foreground text-xs border-b border-border bg-secondary/30">
              <th className="text-left py-2.5 pl-3 pr-2 font-medium">#</th>
              <th className="text-left py-2.5 pr-3 font-medium">題材</th>
              <SortTh id="count" label="熱門數" sortId={sortId} dir={dir} onSort={onSort} />
              <SortTh id="avg" label="平均漲" sortId={sortId} dir={dir} onSort={onSort} />
              <SortTh id="max" label="最強漲" sortId={sortId} dir={dir} onSort={onSort} />
              <SortTh id="score" label="熱度" sortId={sortId} dir={dir} onSort={onSort} />
              <th className="text-left py-2.5 pl-2 pr-3 font-medium">代表股</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t, i) => (
              <HotRow key={t.theme} t={t} rank={rankBase + i + 1}
                expanded={expanded === t.theme}
                onToggle={() => setExpanded(expanded === t.theme ? null : t.theme)} />
            ))}
          </tbody>
        </table>
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
  const [showCoarse, setShowCoarse] = useState(false);
  const sortBy = (id: string) => { if (sortId === id) setDir(dir === 'desc' ? 'asc' : 'desc'); else { setSortId(id); setDir('desc'); } };
  const themes = hot
    ? applySort(hot.themes, sortId, dir,
        (t, id) => id === 'score' ? t.score : id === 'count' ? t.hotCount : id === 'avg' ? t.avgChange : id === 'max' ? t.maxChange : null,
        { missingLast: true })
    : [];
  // 細題材（概念）排上面；廣義「產業別/未分類」收進可展開區（雜訊）
  const concept = themes.filter((t) => t.source === 'concept');
  const coarse = themes.filter((t) => t.source !== 'concept');
  const coarseHot = coarse.reduce((a, t) => a + t.hotCount, 0);

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        先掃全市場找今天在熱的股（漲幅＋爆量{hot?.instFresh ? '＋法人買超' : ''}），自動歸題材。
        <b>細題材排上面</b>；廣義的「產業別／未分類」收進下面（雜訊，點開才看）。
        <span className="text-bull">紅</span>=漲，點一列看成分股。
      </p>

      {error && <EmptyState icon="⚠️" title="尚無資料" description={`${error}（需要當日 L2 全市場快照）`} />}
      {!hot && !error && <div className="text-muted-foreground text-sm py-12 text-center animate-pulse">掃描全市場中…</div>}

      {hot && hot.themes.length === 0 && (
        <EmptyState icon="😴" title="今天沒什麼在熱" description={`掃了 ${hot.totalScanned} 檔，沒有達到熱度門檻的個股`} />
      )}

      {hot && hot.themes.length > 0 && (
        <>
          {concept.length > 0 ? (
            <HotThemeTable rows={concept} rankBase={0} expanded={expanded} setExpanded={setExpanded}
              sortId={sortId} dir={dir} onSort={sortBy} />
          ) : (
            <EmptyState icon="🔍" title="今天沒有明確的細題材在熱" description="熱門股都落在廣義產業（見下方展開）" />
          )}

          {coarse.length > 0 && (
            <div className="space-y-2">
              <button type="button" onClick={() => setShowCoarse((s) => !s)}
                className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
                <span className={`transition-transform ${showCoarse ? 'rotate-90' : ''}`}>›</span>
                廣義分類（產業別／未分類）· {coarse.length} 群 · {coarseHot} 檔
              </button>
              {showCoarse && <HotThemeTable rows={coarse} rankBase={concept.length} expanded={expanded} setExpanded={setExpanded}
                sortId={sortId} dir={dir} onSort={sortBy} />}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function HotRow({ t, rank, expanded, onToggle }: {
  t: HotTheme; rank: number; expanded: boolean; onToggle: () => void;
}) {
  return (
    <>
      <tr onClick={onToggle}
        className={`border-b border-border last:border-0 hover:bg-muted/40 cursor-pointer transition-colors ${expanded ? 'bg-muted/30' : ''}`}>
        <td className="py-3 pl-3 pr-1"><RankBadge rank={rank} /></td>
        <td className="py-3 pr-3">
          <div className="flex items-center gap-1.5">
            <span className={`text-muted-foreground/40 transition-transform ${expanded ? 'rotate-90' : ''}`}>›</span>
            <span className="font-medium">{t.theme}</span>
            <SourceTag source={t.source} />
          </div>
        </td>
        <td className="text-right px-2 text-muted-foreground font-mono tabular-nums whitespace-nowrap">{t.hotCount} 檔</td>
        <td className="text-right px-2 font-mono tabular-nums"><Pct v={t.avgChange} /></td>
        <td className="text-right px-2 font-mono tabular-nums"><Pct v={t.maxChange} /></td>
        <td className="px-2" title={`熱度 ${t.avgHeat}（個股平均）＋檔數加分 → 排名分 ${t.score}`}><HeatBar v={t.score} /></td>
        <td className="py-3 pl-2 pr-3 text-foreground/80">
          {t.topStock ? (
            <Link href={`/?load=${t.topStock.code}`} className="hover:text-sky-400 whitespace-nowrap"
              onClick={e => e.stopPropagation()}>
              {t.topStock.name} <Pct v={t.topStock.changePercent} />
            </Link>
          ) : '—'}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} className="p-0">
            <PerfGrid members={t.members} />
          </td>
        </tr>
      )}
    </>
  );
}

// ── 固定 25 題材（原視角）─────────────────────────────────────────────────────

function FixedView({ data, error, expanded, setExpanded }: {
  data: RankingFile | null; error: string | null;
  expanded: string | null; setExpanded: (s: string | null) => void;
}) {
  const [sortId, setSortId] = useState('rot');
  const [dir, setDir] = useState<SortDir>('desc');
  const sortBy = (id: string) => { if (sortId === id) setDir(dir === 'desc' ? 'asc' : 'desc'); else { setSortId(id); setDir('desc'); } };
  const themes = data
    ? applySort(data.themes, sortId, dir,
        (t, id) => id === 'rot' ? (t.rotation?.rankDelta ?? null) : id === 'd1' ? t.avgD1 : id === 'd5' ? t.avgD5 : id === 'd20' ? t.avgD20 : id === 'd60' ? t.avgD60 : id === 'breadth' ? t.breadth : id === 'inst' ? (t.instAmt5 ?? null) : null,
        { missingLast: true })
    : [];

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        熱門題材聚合報酬（成分股單純平均）· 階段為顯示用分類，<b>不參與選股</b>。
        <span className="text-bull">紅</span>=漲、<span className="text-bear">綠</span>=跌。<b>點欄位標題可排序</b>，點一列看成分股近 1~20 日績效。
        <br />
        <span className="text-muted-foreground/70">
          題材用「最近 5 日漲幅」互相排名次。「輪動」欄的 <b>a→b名</b> = 5 天前第 a 名 → 今天第 b 名：
          名次往上 = <b>🟢 資金流進</b>、往下 = <b>🔴 資金流出</b>。
          例：面板 <b>25→2 名</b>（從墊底衝到第 2，資金大量流進）。
          預設流進排最上、流出排最下；只看錢流向，<b>別當買賣訊號</b>。
        </span>
      </p>

      {error && (
        <EmptyState icon="⚠️" title="尚未產生資料" description={`${error}（盤後 17:10 cron 產出，可先手動跑 compute-sector-strength）`} />
      )}
      {!data && !error && (
        <div className="text-muted-foreground text-sm py-12 text-center animate-pulse">載入中…</div>
      )}

      {data && (
        <>
          <div className="rounded-xl ring-1 ring-foreground/10 bg-card/60 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground text-xs border-b border-border bg-secondary/30">
                    <th className="text-left py-2.5 pl-3 pr-2 font-medium">#</th>
                    <th className="text-left py-2.5 pr-3 font-medium">題材</th>
                    <SortTh id="rot" label="輪動" sortId={sortId} dir={dir} onSort={sortBy} align="left" />
                    <SortTh id="d1" label="今日" sortId={sortId} dir={dir} onSort={sortBy} />
                    <SortTh id="d5" label="5日" sortId={sortId} dir={dir} onSort={sortBy} />
                    <SortTh id="d20" label="20日" sortId={sortId} dir={dir} onSort={sortBy} />
                    <SortTh id="d60" label="60日" sortId={sortId} dir={dir} onSort={sortBy} />
                    <SortTh id="breadth" label="廣度" sortId={sortId} dir={dir} onSort={sortBy} />
                    <SortTh id="inst" label="法人5日金額" sortId={sortId} dir={dir} onSort={sortBy} />
                    <th className="text-center py-2.5 px-2 font-medium">階段</th>
                    <th className="text-left py-2.5 pl-2 pr-3 font-medium">當日最強</th>
                  </tr>
                </thead>
                <tbody>
                  {themes.map((t, i) => (
                    <SectorRow key={t.theme} t={t} rank={i + 1}
                      expanded={expanded === t.theme}
                      onToggle={() => setExpanded(expanded === t.theme ? null : t.theme)} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function SectorRow({ t, rank, expanded, onToggle }: {
  t: ThemeRank; rank: number; expanded: boolean; onToggle: () => void;
}) {
  return (
    <>
      <tr onClick={onToggle}
        className={`border-b border-border last:border-0 hover:bg-muted/40 cursor-pointer transition-colors ${expanded ? 'bg-muted/30' : ''}`}>
        <td className="py-3 pl-3 pr-1"><RankBadge rank={rank} /></td>
        <td className="py-3 pr-3">
          <div className="flex items-center gap-1.5">
            <span className={`text-muted-foreground/40 transition-transform ${expanded ? 'rotate-90' : ''}`}>›</span>
            <span className="font-medium">{t.theme}</span>
            <span className="text-xs text-muted-foreground/50">{t.stockCount}</span>
          </div>
        </td>
        <td className="px-2"><RotationCell r={t.rotation} /></td>
        <td className="text-right px-2 font-mono tabular-nums"><Pct v={t.avgD1} /></td>
        <td className="text-right px-2 font-mono tabular-nums"><Pct v={t.avgD5} /></td>
        <td className="text-right px-2 font-mono tabular-nums"><Pct v={t.avgD20} /></td>
        <td className="text-right px-2 font-mono tabular-nums"><Pct v={t.avgD60} /></td>
        <td className="text-right px-2 text-muted-foreground font-mono tabular-nums">
          {t.breadth != null ? `${Math.round(t.breadth * 100)}%` : '—'}
        </td>
        <td className="text-right px-2 font-mono tabular-nums"><Amt v={t.instAmt5 ?? null} /></td>
        <td className="text-center px-2">
          <span className={`text-xs px-1.5 py-0.5 rounded border ${STAGE_STYLE[t.stage] ?? STAGE_STYLE['盤整']}`}>
            {t.stage}
          </span>
        </td>
        <td className="py-3 pl-2 pr-3 text-foreground/80">
          {t.topStock ? (
            <Link href={`/?load=${t.topStock.code}`} className="hover:text-sky-400 whitespace-nowrap"
              onClick={e => e.stopPropagation()}>
              {t.topStock.name} <Pct v={t.topStock.d1} />
            </Link>
          ) : '—'}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={11} className="p-0">
            <PerfGrid members={t.members} />
          </td>
        </tr>
      )}
    </>
  );
}
