'use client';

/**
 * TeacherLeaderboard — /youtube/teachers 老師推薦績效排行榜
 *
 * 資料：/api/youtube/teacher-leaderboard?days=30|60|90（事件凍結基準價 + 即時 derive 報酬）
 * Drill-down：點老師列展開 → /api/youtube/teacher-events 逐筆事件。
 * 排序：純前端（server 不吃 sort 參數，同 /backtest/leaderboard 慣例）。
 *
 * 設計（2026-06-13 重做，為閱讀障礙優化）：
 *   - D1~D20 每日漲幅改「色塊熱力條」：顏色深淺＝漲跌幅度，用看的就懂、不必逐格讀數字。
 *   - 老師／節目列改成「大名字 + 樣本徽章 + 熱力條 + 一個重點」，留白多、欄位少。
 *   - 正式榜（樣本≥10）與潛力榜（樣本不足）分區，不再灰顯混在一起。
 */

import { Fragment, useEffect, useMemo, useState } from 'react';
import { bullBearClass } from '@/lib/format';
import { cn } from '@/lib/utils';
import { readJsonResponse } from '@/lib/api/clientResponse';
import type {
  ExtremeEvent, ProgramRow, RecoEventWithReturns, RecoHorizon, RecoHorizonStats,
  StockAggRow, TeacherLeaderboardResponse, TeacherRow,
} from '@/lib/youtube/recoTypes';
import type { TargetStopEval } from '@/lib/youtube/recoPerformance';
import type { SectorExcess } from '@/app/api/youtube/teacher-events/route';
import { TimeMachinePanel } from './TimeMachinePanel';

const DATA_START = '2026-05-18';
/** 時光機 as-of 預設：今天往前 9 天，clamp 到資料起點+一週 */
function defaultAsOf(): string {
  const d = new Date();
  d.setDate(d.getDate() - 9);
  const s = d.toISOString().slice(0, 10);
  const min = '2026-05-25';
  const maxD = new Date();
  maxD.setDate(maxD.getDate() - 3);
  const max = maxD.toISOString().slice(0, 10);
  return s < min ? min : s > max ? max : s;
}
function asOfBounds(): { min: string; max: string } {
  const maxD = new Date();
  maxD.setDate(maxD.getDate() - 3);
  return { min: '2026-05-25', max: maxD.toISOString().slice(0, 10) };
}

type WindowDays = 30 | 60 | 90;
type SortKey = 'scored' | 'payoff' | 'd20_ex' | `${RecoHorizon}_avg` | `${RecoHorizon}_win`;
/** 動態欄位設定：哪幾天有資料、贏大盤用哪個橫斷、賺賠比是否顯示、最佳/最雷是否顯示 */
type Cols = { horizons: RecoHorizon[]; lastHz: RecoHorizon; showExcess: boolean; showPayoff: boolean; showPicks: boolean; excessLabel: string };

/** 熱力條顯示哪幾天（D60 資料還沒走完，先不顯示） */
const SHOW_HORIZONS: RecoHorizon[] = ['d1', 'd2', 'd3', 'd4', 'd5', 'd10', 'd20'];
/** 每天的白話標籤（hover 用） */
const HORIZON_NOTE: Record<RecoHorizon, string> = {
  d1: '買進當天收盤', d2: '第 2 天', d3: '第 3 天', d4: '第 4 天',
  d5: '約一週', d10: '約兩週', d20: '約一個月', d60: '約一季',
};

const fmtPct = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
const fmtPct2 = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

/**
 * 熱力色：跟 bullBearClass 同步走主題變數（台股預設 紅=漲 綠=跌；.western 自動互換）。
 * |幅度| 越大顏色越濃（8% 封頂滿濃）。
 */
function heatBg(v: number | null, n: number): string {
  if (n === 0 || v == null || !Number.isFinite(v)) return 'transparent';
  const mag = Math.min(Math.abs(v) / 8, 1);
  const pct = Math.round(12 + mag * 48); // 12%..60%
  return `color-mix(in oklch, var(${v >= 0 ? '--bull' : '--bear'}) ${pct}%, transparent)`;
}

// ── 小型 SVG 圖示（取代 emoji，專業感 + 一致大小 16px）────────────────────────
function Icon({ path, className }: { path: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" className={cn('w-4 h-4 shrink-0', className)}>
      {path.split('|').map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}
const ICONS = {
  trophy: 'M8 21h8|M12 17v4|M7 4h10v5a5 5 0 0 1-10 0V4Z|M17 5h3v2a3 3 0 0 1-3 3|M7 5H4v2a3 3 0 0 0 3 3',
  alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z|M12 9v4|M12 17h.01',
  tv: 'M2 7h20v12H2z|M7 3l5 4 5-4',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2|M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8|M22 21v-2a4 4 0 0 0-3-3.9|M16 3.1a4 4 0 0 1 0 7.8',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z|M12 6v6l4 2',
  trend: 'M3 3v18h18|M7 13l3-3 3 3 5-5',
};

function SectionTitle({ icon, title, subtitle, tone = 'default' }: {
  icon: keyof typeof ICONS; title: string; subtitle?: string;
  tone?: 'default' | 'danger';
}) {
  return (
    <div className="flex items-start gap-2 pt-1">
      <span className={cn('mt-0.5', tone === 'danger' ? 'text-red-400' : 'text-sky-400')}>
        <Icon path={ICONS[icon]} />
      </span>
      <div>
        <h2 className={cn('text-sm font-semibold leading-tight', tone === 'danger' && 'text-red-300')}>{title}</h2>
        {subtitle && <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">{subtitle}</p>}
      </div>
    </div>
  );
}

/** 樣本徽章：有效 X / 推薦 Y（hover 看完整拆解） */
function SampleBadge({ scored, total, open, unfillable, watch, bearish }: {
  scored: number; total: number; open?: number; unfillable?: number; watch?: number; bearish?: number;
}) {
  return (
    <span
      className="inline-flex items-baseline gap-1 rounded-md bg-secondary/50 px-1.5 py-0.5 whitespace-nowrap"
      title={`有效 ${scored}（明確買進/看多 且買得到，才算成績）｜推薦總數 ${total}` +
        (open ? `｜追蹤中 ${open}（還沒滿 60 天）` : '') +
        (unfillable ? `｜買不到 ${unfillable}（隔天漲停鎖死）` : '') +
        (watch ? `｜觀察 ${watch}` : '') + (bearish ? `｜偏空 ${bearish}` : '')}
    >
      <span className="text-[11px] text-muted-foreground">有效</span>
      <span className="text-sm font-bold text-foreground tabular-nums">{scored}</span>
      <span className="text-[11px] text-muted-foreground">/ {total}</span>
    </span>
  );
}

/** 熱力條 <td>s — 老師/節目/股票列共用（都有 byHorizon） */
function HeatCells({ byHorizon, horizons, onSort, sortKey }: {
  byHorizon: Record<RecoHorizon, RecoHorizonStats>; horizons: RecoHorizon[];
  onSort?: (hz: RecoHorizon) => void; sortKey?: SortKey;
}) {
  return (
    <>
      {horizons.map(hz => {
        const s = byHorizon[hz];
        const active = sortKey === `${hz}_avg`;
        return (
          <td
            key={hz}
            onClick={onSort ? e => { e.stopPropagation(); onSort(hz); } : undefined}
            style={{ background: heatBg(s.n > 0 ? s.avgPct : null, s.n) }}
            className={cn(
              'text-center align-middle px-0 py-1.5 border-l border-border/20',
              onSort && 'cursor-pointer',
              active && 'outline outline-1 outline-sky-400/60',
            )}
            title={s.n > 0
              ? `${HORIZON_NOTE[hz]}：平均 ${fmtPct2(s.avgPct)}｜中位 ${fmtPct2(s.medianPct)}｜勝率 ${s.winRatePct.toFixed(0)}%｜${s.n} 筆`
              : `${HORIZON_NOTE[hz]}：推薦太新、還沒走完`}
          >
            {s.n > 0 ? (
              <>
                <div className="text-[12px] font-semibold text-white/95 tabular-nums leading-none">{fmtPct(s.avgPct)}</div>
                <div className="text-[9px] text-white/55 leading-none mt-0.5">勝{s.winRatePct.toFixed(0)}</div>
              </>
            ) : (
              <span className="text-[11px] text-muted-foreground/40">—</span>
            )}
          </td>
        );
      })}
    </>
  );
}

/** 熱力條表頭 <th>s */
function HeatHeaders({ horizons, onSort, sortKey }: { horizons: RecoHorizon[]; onSort: (hz: RecoHorizon) => void; sortKey: SortKey }) {
  return (
    <>
      {horizons.map(hz => (
        <th key={hz} className="px-0 py-2 text-center border-l border-border/20">
          <button
            onClick={() => onSort(hz)}
            title={`推薦後 ${HORIZON_NOTE[hz]} 的平均漲幅，點一下按這天排序`}
            className={cn('w-full hover:text-foreground tabular-nums',
              sortKey === `${hz}_avg` ? 'text-sky-400 font-semibold' : '')}
          >
            {hz.slice(1) === '1' ? '隔日' : hz.toUpperCase()}{sortKey === `${hz}_avg` ? ' ↓' : ''}
          </button>
        </th>
      ))}
    </>
  );
}

/** 最佳(▲綠)/最雷(▼紅)一檔一行 */
function PickLine({ pick, dir }: {
  pick: { date: string; stock_code: string; stock_name: string; d20: number | null; d5: number | null } | null;
  dir: 'best' | 'worst';
}) {
  if (!pick) return null;
  const href = `/?load=${pick.stock_code}${pick.date ? `&asOf=${pick.date}` : ''}`;
  return (
    <div className="whitespace-nowrap leading-tight">
      <span className={dir === 'best' ? 'text-green-500' : 'text-red-500'}>{dir === 'best' ? '▲' : '▼'}</span>{' '}
      <a href={href} onClick={e => e.stopPropagation()} className="text-sky-300 hover:underline">
        {pick.stock_code} {pick.stock_name}
      </a>
      <span className={cn('ml-1 tabular-nums', bullBearClass(pick.d20 ?? pick.d5))}>
        {pick.d20 != null ? fmtPct(pick.d20) : `${fmtPct(pick.d5)}(週)`}
      </span>
    </div>
  );
}

const COHORT_LABEL: Record<string, { text: string; cls: string }> = {
  scored: { text: '評分', cls: 'text-green-400' },
  watch: { text: '觀察', cls: 'text-yellow-400' },
  bearish: { text: '偏空', cls: 'text-red-400' },
  excluded: { text: '不計', cls: 'text-muted-foreground' },
};

const STATUS_LABEL: Record<string, string> = {
  filled: '', pending: '待結算', no_fill: '買不到(鎖死)', no_data: '無K線',
};

function sortVal(t: TeacherRow, key: SortKey): number {
  if (key === 'scored') return t.scored_events;
  if (key === 'payoff') return t.payoffRatio ?? -1;
  if (key === 'd20_ex') return t.byHorizon.d20.excessAvgPct ?? -999;
  const us = key.lastIndexOf('_');
  const hz = key.slice(0, us) as RecoHorizon;
  const metric = key.slice(us + 1);
  const s = t.byHorizon[hz];
  if (!s || s.n === 0) return metric === 'win' ? -1 : -999;
  return metric === 'win' ? s.winRatePct : s.avgPct;
}

export function TeacherLeaderboard({ compact = false }: { compact?: boolean } = {}) {
  const [days, setDays] = useState<WindowDays>(30);
  const [data, setData] = useState<TeacherLeaderboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('d5_avg');
  const [expanded, setExpanded] = useState<string | null>(null);
  // 時光機（回到過去驗證）
  const [timeMachine, setTimeMachine] = useState(false);
  const [asOf, setAsOf] = useState<string>(defaultAsOf());
  const [topK, setTopK] = useState(3);
  const [selectBy, setSelectBy] = useState<'d1' | 'd5' | 'd20'>('d5');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = timeMachine ? `asOf=${asOf}&days=90` : `days=${days}`;
    fetch(`/api/youtube/teacher-leaderboard?${qs}`)
      .then(r => readJsonResponse<TeacherLeaderboardResponse & { ok?: boolean; error?: string }>(r))
      .then((json: TeacherLeaderboardResponse & { ok?: boolean; error?: string }) => {
        if (cancelled) return;
        if (json.error) { setError(json.error); setData(null); return; }
        setData(json);
      })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [days, timeMachine, asOf]);

  const bounds = asOfBounds();

  const teachers = useMemo(() => {
    if (!data) return [];
    return [...data.teachers].sort((a, b) => sortVal(b, sortKey) - sortVal(a, sortKey));
  }, [data, sortKey]);

  const minScored = data?.meta.minScored ?? 10;
  const formal = teachers.filter(t => t.scored_events >= minScored);
  const potential = teachers.filter(t => t.scored_events < minScored);

  // 只顯示「有資料」的天數欄：D20 等橫斷還沒走完時整欄空，自動隱藏、走完自動補回
  const activeHorizons = useMemo<RecoHorizon[]>(() => {
    if (!data) return SHOW_HORIZONS;
    const has = (hz: RecoHorizon) =>
      data.teachers.some(t => t.byHorizon[hz]?.n > 0) || data.programs.some(p => p.byHorizon[hz]?.n > 0);
    const act = SHOW_HORIZONS.filter(has);
    return act.length > 0 ? act : ['d1'];
  }, [data]);
  const lastHz = activeHorizons[activeHorizons.length - 1];
  // 贏大盤：用「最長且有資料」的橫斷（現在是 D10，D20 走完會自動換成 D20）
  const showExcess = useMemo(() => !!data && data.teachers.some(t => t.byHorizon[lastHz]?.excessAvgPct != null), [data, lastHz]);
  // compact（嵌進首頁窄面板）：砍掉最寬的「賺賠比 + 最佳/最雷」兩欄，只留 老師｜樣本｜熱力條｜贏大盤
  const showPayoff = useMemo(() => !compact && !!data && data.teachers.some(t => t.payoffRatio != null), [data, compact]);
  const showPicks = !compact;
  const excessLabel = `贏大盤(${lastHz.toUpperCase()})`;
  const cols = { horizons: activeHorizons, lastHz, showExcess, showPayoff, showPicks, excessLabel };
  // colSpan：老師 + 樣本 + 天數欄 + 贏大盤? + 賺賠比? + 最佳/最雷?
  const fullSpan = 2 + activeHorizons.length + (showExcess ? 1 : 0) + (showPayoff ? 1 : 0) + (showPicks ? 1 : 0);

  const sortByHz = (hz: RecoHorizon) => setSortKey(`${hz}_avg`);

  return (
    <div className="space-y-5">
      {/* ── 控制列：視窗 / 回測切換 ── */}
      <div className="flex items-center gap-3 flex-wrap">
        {!timeMachine ? (
          <div className="flex rounded-lg border border-border overflow-hidden">
            {([30, 60, 90] as WindowDays[]).map(d => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={cn(
                  'px-3.5 py-1.5 text-xs cursor-pointer transition-colors',
                  days === d ? 'bg-sky-900/60 text-sky-100 font-medium' : 'text-muted-foreground hover:bg-secondary/40',
                )}
              >
                近 {d} 天
              </button>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <Icon path={ICONS.clock} className="text-amber-300" />
            <span className="text-amber-300 font-medium">回到</span>
            <input
              type="date"
              value={asOf}
              min={bounds.min}
              max={bounds.max}
              onChange={e => e.target.value && setAsOf(e.target.value)}
              className="bg-secondary/40 border border-border rounded px-1.5 py-0.5 text-foreground cursor-pointer"
            />
            <span className="text-muted-foreground">選最準</span>
            <select value={topK} onChange={e => setTopK(Number(e.target.value))} className="bg-secondary/40 border border-border rounded px-1.5 py-0.5 cursor-pointer">
              {[1, 3, 5].map(k => <option key={k} value={k}>{k} 位</option>)}
            </select>
            <span className="text-muted-foreground">老師（依</span>
            <select value={selectBy} onChange={e => setSelectBy(e.target.value as 'd1' | 'd5' | 'd20')} className="bg-secondary/40 border border-border rounded px-1.5 py-0.5 cursor-pointer">
              <option value="d1">隔日</option>
              <option value="d5">一週</option>
              <option value="d20">一個月</option>
            </select>
            <span className="text-muted-foreground">報酬挑）</span>
          </div>
        )}
        <button
          onClick={() => setTimeMachine(v => !v)}
          className={cn(
            'ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border whitespace-nowrap cursor-pointer transition-colors',
            timeMachine ? 'bg-amber-900/50 text-amber-100 border-amber-700' : 'border-border text-muted-foreground hover:bg-secondary/40',
          )}
          title="挑過去某一天，只用那天以前的資料選出當時最準的老師，看他們之後推薦的股票到今天是漲還跌 — 驗證『跟老師買』有沒有用"
        >
          <Icon path={ICONS.clock} />
          推薦準確度回測{timeMachine ? '（開）' : ''}
        </button>
      </div>

      {data && (
        <p className="text-[11px] text-muted-foreground -mt-2">
          {timeMachine && <span className="text-amber-300">站在 {asOf} 回看 · </span>}
          {data.window.start} → {data.window.end} ·
          共 <b className="text-foreground/90">{data.window.eventDates}</b> 個分析日 ·
          <b className="text-foreground/90"> {data.coverage?.uniquePrograms ?? '—'}</b> 個節目 ·
          <b className="text-foreground/90"> {data.coverage?.uniqueVideos ?? '—'}</b> 集 ·
          <b className="text-foreground/90"> {data.coverage?.totalEvents ?? '—'}</b> 筆推薦
          （<b className="text-foreground/90">{data.coverage?.scoredEvents ?? '—'}</b> 筆進統計）
        </p>
      )}

      {/* 時光機跟單回測結果 */}
      {timeMachine && <TimeMachinePanel asOf={asOf} topK={topK} selectBy={selectBy} />}

      {/* ── 怎麼看這頁（白話、預設收起細節）── */}
      <div className="rounded-xl border border-border/60 bg-secondary/15 px-4 py-3 text-[12px] leading-relaxed">
        <p className="text-foreground/90">
          老師在節目推一檔股票 → 假設你<b className="text-amber-300">隔天開盤用市價買進</b> → 追蹤之後幾天漲跌。
          <span className="text-muted-foreground">下面色塊：</span>
          <span className="inline-block px-1.5 rounded text-white/95 font-medium" style={{ background: 'color-mix(in oklch, var(--bull) 50%, transparent)' }}>漲</span>
          <span className="mx-1 text-muted-foreground">/</span>
          <span className="inline-block px-1.5 rounded text-white/95 font-medium" style={{ background: 'color-mix(in oklch, var(--bear) 50%, transparent)' }}>跌</span>
          <span className="text-muted-foreground">，顏色越深幅度越大。格子裡上面是平均漲幅、下面小字是勝率。</span>
        </p>
        <details className="mt-1.5">
          <summary className="cursor-pointer text-sky-400 hover:underline text-[11.5px]">每個詞是什麼意思（點開）</summary>
          <ul className="mt-1.5 space-y-1 text-muted-foreground list-disc pl-4 text-[11.5px]">
            <li><b className="text-foreground/80">有效 X / 推薦 Y</b>：推薦 Y 檔裡，X 檔是「明確買進/看多」且買得到，才進成績。滑到徽章上看「追蹤中／買不到」拆解。</li>
            <li><b className="text-foreground/80">隔日 / D2…D20</b>：買進後第幾個交易日的收盤漲幅。隔日＝買進當天收盤、D5≈一週、D20≈一個月。</li>
            <li><b className="text-foreground/80">贏大盤</b>：這檔 D20 漲幅減掉同期加權指數。正＝贏過大盤，不是只搭順風車。</li>
            <li><b className="text-foreground/80">賺賠比</b>：賺錢推薦的平均漲幅 ÷ 賠錢推薦的平均跌幅。&gt;1＝賺的比賠的多。</li>
            <li><b className="text-foreground/80">最佳▲ / 最雷▼</b>：這位老師推得最好、最慘的各一檔。</li>
            <li>「—」＝推薦日太新、那天還沒走完，時間到會自動補（資料從 {DATA_START} 起算）。</li>
          </ul>
        </details>
      </div>

      {loading && <div className="text-center py-10 text-sm text-muted-foreground">載入中…</div>}
      {error && <div className="text-sm text-red-400 p-2 border border-red-700/40 rounded">載入失敗：{error}</div>}

      {!loading && data && (
        <>
          {/* ── 老師排行榜 ── */}
          <section className="space-y-2.5">
            <SectionTitle
              icon="trophy"
              title="老師排行榜"
              subtitle={`誰推得準。預設按「一週漲幅」排，點色塊上方標題可換天排序。樣本 ≥ ${minScored} 進正式榜。`}
            />
            <div className="rounded-xl ring-1 ring-foreground/10 bg-card overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead className="text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="px-3 py-2 text-left font-medium">老師</th>
                    <th className="px-2 py-2 text-left font-medium">
                      <button onClick={() => setSortKey('scored')} className={cn('cursor-pointer hover:text-foreground', sortKey === 'scored' && 'text-sky-400 font-semibold')}>
                        樣本{sortKey === 'scored' ? ' ↓' : ''}
                      </button>
                    </th>
                    <HeatHeaders horizons={cols.horizons} onSort={sortByHz} sortKey={sortKey} />
                    {showExcess && (
                      <th className="px-2 py-2 text-right font-medium border-l border-border/20" title={`${lastHz.toUpperCase()} 漲幅減同期加權指數`}>{excessLabel}</th>
                    )}
                    {showPayoff && (
                      <th className="px-2 py-2 text-right font-medium" title="平均賺 ÷ 平均賠">賺賠比</th>
                    )}
                    {showPicks && <th className="px-3 py-2 text-left font-medium">最佳 / 最雷</th>}
                  </tr>
                </thead>
                <tbody>
                  {formal.map(t => (
                    <TeacherRowView key={t.teacher} teacher={t} cols={cols} fullSpan={fullSpan} isOpen={expanded === t.teacher} days={days}
                      onToggle={() => setExpanded(expanded === t.teacher ? null : t.teacher)} />
                  ))}
                  {potential.length > 0 && (
                    <tr className="bg-secondary/20 border-y border-border/50">
                      <td colSpan={fullSpan} className="px-3 py-1.5 text-[11px] text-muted-foreground">
                        ─ 潛力觀察榜（樣本 &lt; {minScored} 筆，可信度待累積，僅供參考）─
                      </td>
                    </tr>
                  )}
                  {potential.map(t => (
                    <TeacherRowView key={t.teacher} teacher={t} cols={cols} fullSpan={fullSpan} isOpen={expanded === t.teacher} days={days} dim
                      onToggle={() => setExpanded(expanded === t.teacher ? null : t.teacher)} />
                  ))}
                  {teachers.length === 0 && (
                    <tr><td colSpan={fullSpan} className="text-center py-8 text-muted-foreground">視窗內無推薦事件</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="text-[10.5px] text-muted-foreground/80">{data.meta.survivorshipNote}</p>
          </section>

          {/* ── 節目排行榜 ── */}
          <ProgramSection programs={data.programs} minScored={minScored} cols={cols} fullSpan={fullSpan} sortByHz={sortByHz} sortKey={sortKey} />

          {/* ── 共識股（最多老師推）── */}
          {data.consensusStocks?.length > 0 && (
            <StockCardGrid icon="users" title="共識股" countOf="teacher"
              subtitle="被最多「不同老師」一起推的股票。越多人同推＝市場共識越強（但不保證會漲）。"
              rows={data.consensusStocks} horizons={cols.horizons} />
          )}

          {/* ── 最多節目提到 ── */}
          {data.topByProgram?.length > 0 && (
            <StockCardGrid icon="tv" title="最多節目提到" countOf="program"
              subtitle="被最多「不同節目」談到的股票。跨節目都在講＝聲量大、市場關注度高。"
              rows={data.topByProgram} horizons={cols.horizons} />
          )}

          {/* ── 推薦後漲最多 / 跌最多 ── */}
          <ExtremesSection gainers={data.gainers} losers={data.losers} horizons={cols.horizons} />

          {/* ── 共識地雷股 ── */}
          {data.worstStocks?.length > 0 && (
            <WorstStocksSection rows={data.worstStocks} horizons={cols.horizons} />
          )}
        </>
      )}
    </div>
  );
}

// ── 老師列 ────────────────────────────────────────────────────────────────────
function TeacherRowView({ teacher: t, cols, fullSpan, isOpen, days, onToggle, dim }: {
  teacher: TeacherRow; cols: Cols; fullSpan: number; isOpen: boolean; days: WindowDays; onToggle: () => void; dim?: boolean;
}) {
  const h = t.byHorizon;
  return (
    <>
      <tr
        onClick={onToggle}
        className={cn(
          'border-b border-border/40 cursor-pointer hover:bg-secondary/30 transition-colors',
          dim && 'opacity-60', isOpen && 'bg-secondary/20',
        )}
      >
        {/* 老師 + 節目 */}
        <td className="px-3 py-2.5 align-middle">
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground/60 text-[10px]">{isOpen ? '▾' : '▸'}</span>
            <span className="text-sm font-semibold text-amber-200 whitespace-nowrap">{t.teacher}</span>
          </div>
          <div className="text-[10.5px] text-muted-foreground max-w-[150px] truncate pl-3.5" title={t.programs.map(p => p.display_name).join('、')}>
            {t.programs.map(p => p.display_name).join('、')}
          </div>
        </td>
        {/* 樣本 */}
        <td className="px-2 py-2.5 align-middle">
          <SampleBadge scored={t.scored_events} total={t.total_events} open={t.open_events}
            unfillable={t.unfillable} watch={t.watch_events} bearish={t.bearish_events} />
        </td>
        {/* 熱力條 */}
        <HeatCells byHorizon={h} horizons={cols.horizons} />
        {/* 贏大盤（用最長且有資料的橫斷） */}
        {cols.showExcess && (
          <td className={cn('px-2 py-2.5 text-right align-middle tabular-nums border-l border-border/20', bullBearClass(h[cols.lastHz].excessAvgPct))}>
            {fmtPct(h[cols.lastHz].excessAvgPct)}
          </td>
        )}
        {/* 賺賠比 */}
        {cols.showPayoff && (
          <td className="px-2 py-2.5 text-right align-middle tabular-nums text-foreground/80">{t.payoffRatio ?? '—'}</td>
        )}
        {/* 最佳/最雷 */}
        {cols.showPicks && (
          <td className="px-3 py-2.5 align-middle text-[11px]" onClick={e => e.stopPropagation()}>
            <PickLine pick={t.bestPick} dir="best" />
            {t.worstPick && !(t.worstPick.stock_code === t.bestPick?.stock_code && t.worstPick.date === t.bestPick?.date) && (
              <PickLine pick={t.worstPick} dir="worst" />
            )}
            {!t.bestPick && !t.worstPick && '—'}
          </td>
        )}
      </tr>
      {isOpen && (
        <tr className="border-b border-border/40 bg-secondary/10">
          <td colSpan={fullSpan} className="p-2">
            <div className="mb-1.5 text-[11px] text-muted-foreground">
              最賺/最賠（推薦後 60 天內盤中）：
              <span className="text-bull tabular-nums ml-1">{fmtPct(t.mfeAvgPct)}</span>
              <span className="text-muted-foreground"> / </span>
              <span className="text-bear tabular-nums">{fmtPct(t.maeAvgPct)}</span>
            </div>
            <TeacherEvents teacher={t.teacher} days={days} />
          </td>
        </tr>
      )}
    </>
  );
}

/** Drill-down：逐筆事件表 */
function TeacherEvents({ teacher, days }: { teacher: string; days: WindowDays }) {
  const [events, setEvents] = useState<Array<RecoEventWithReturns & {
    video_titles: Record<string, string>; display_names: Record<string, string>;
    targetStop: TargetStopEval | null;
    sector: SectorExcess | null;
  }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    fetch(`/api/youtube/teacher-events?teacher=${encodeURIComponent(teacher)}&days=${days}`)
      .then(r => r.json())
      .then(json => { if (!cancelled) { if (json.error) setError(json.error); else setEvents(json.events); } })
      .catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [teacher, days]);

  if (error) return <div className="text-red-400 text-xs p-2">載入失敗：{error}</div>;
  if (!events) return <div className="text-muted-foreground text-xs p-2">載入事件中…</div>;
  if (events.length === 0) return <div className="text-muted-foreground text-xs p-2">無事件</div>;

  const horizons: RecoHorizon[] = ['d1', 'd5', 'd20', 'd60'];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead className="text-muted-foreground">
          <tr className="[&>th]:px-1.5 [&>th]:py-1 [&>th]:text-right [&>th:nth-child(-n+4)]:text-left">
            <th>日期</th><th>股票</th><th>型態</th><th>原話</th><th>進場價</th>
            {horizons.map(h => <th key={h}>{h === 'd1' ? '隔日' : h.toUpperCase()}</th>)}
            <th>贏大盤</th><th title="持有至今 vs 同官方產業成分股同期平均 — 正=贏過同產業">贏同類</th><th>最賺/最賠</th><th title="老師簡報喊的目標價/停損價有沒有打到">目標/停損</th><th>狀態</th><th>影片</th>
          </tr>
        </thead>
        <tbody>
          {events.map(e => {
            const cohort = COHORT_LABEL[e.cohort] ?? COHORT_LABEL.excluded;
            const quote = e.videos[0]?.context || e.videos[0]?.reason || '';
            const statusText = e.conflict ? '多空衝突' : STATUS_LABEL[e.baseline.status] || (e.returns?.isOpen ? '追蹤中' : '已完結');
            return (
              <tr key={e.id} className="border-t border-border/30 [&>td]:px-1.5 [&>td]:py-1 [&>td]:text-right [&>td:nth-child(-n+4)]:text-left">
                <td className="whitespace-nowrap">{e.date}</td>
                <td className="whitespace-nowrap">
                  <a href={`/?load=${e.stock_code}&asOf=${e.date}`} className="text-sky-300 hover:underline font-mono">{e.stock_code}</a>
                  <span className="ml-1">{e.stock_name}</span>
                </td>
                <td className={cn('whitespace-nowrap', cohort.cls)}>{e.recommendation_type}</td>
                <td className="max-w-[280px] truncate text-foreground/70" title={quote}>{quote}</td>
                <td>{e.baseline.entry_open ?? '—'}</td>
                {horizons.map(h => (
                  <td key={h} className={cn('tabular-nums', bullBearClass(e.returns?.[h]))}>{fmtPct(e.returns?.[h])}</td>
                ))}
                <td className={cn('tabular-nums', bullBearClass(e.returns?.excess?.d20))}>{fmtPct(e.returns?.excess?.d20)}</td>
                <td className={cn('whitespace-nowrap tabular-nums', bullBearClass(e.sector?.excess))} title={e.sector ? `${e.sector.themes.join('、')}｜同族群${e.sector.peerCount}檔均${fmtPct(e.sector.peerAvg)}` : ''}>
                  {e.sector?.excess != null ? fmtPct(e.sector.excess) : '—'}
                </td>
                <td className="whitespace-nowrap tabular-nums">
                  <span className="text-bull">{fmtPct(e.returns?.mfe)}</span>
                  <span className="text-muted-foreground">/</span>
                  <span className="text-bear">{fmtPct(e.returns?.mae)}</span>
                </td>
                <td className="whitespace-nowrap text-[10px]">
                  {e.targetStop ? (
                    <>
                      {e.targetStop.target != null && (
                        <span className={e.targetStop.hitTarget ? 'text-green-400' : 'text-muted-foreground'} title={e.targetStop.hitTarget ? `${e.targetStop.hitTarget.date} 達標` : '尚未到目標價'}>
                          目標{e.targetStop.target}{e.targetStop.hitTarget ? '✓' : ''}
                        </span>
                      )}
                      {e.targetStop.stop != null && (
                        <span className={cn('ml-1', e.targetStop.hitStop ? 'text-red-400' : 'text-muted-foreground')} title={e.targetStop.hitStop ? `${e.targetStop.hitStop.date} 破停損` : '未破停損'}>
                          停損{e.targetStop.stop}{e.targetStop.hitStop ? '✗' : ''}
                        </span>
                      )}
                    </>
                  ) : <span className="text-muted-foreground">—</span>}
                </td>
                <td className="whitespace-nowrap text-muted-foreground">{statusText}</td>
                <td className="whitespace-nowrap">
                  {e.videos.map(v => (
                    <a
                      key={v.video_id}
                      href={`https://www.youtube.com/watch?v=${v.video_id}`}
                      target="_blank"
                      rel="noreferrer"
                      title={e.video_titles[v.video_id] || v.video_id}
                      className="text-sky-400 hover:underline mr-1"
                    >
                      ↗
                    </a>
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── 節目排行榜 ────────────────────────────────────────────────────────────────
function ProgramSection({ programs, minScored, cols, fullSpan, sortByHz, sortKey }: {
  programs: ProgramRow[]; minScored: number; cols: Cols; fullSpan: number;
  sortByHz: (hz: RecoHorizon) => void; sortKey: SortKey;
}) {
  if (programs.length === 0) return null;
  const formal = programs.filter(p => p.scored_events >= minScored);
  const potential = programs.filter(p => p.scored_events < minScored);
  const Row = (p: ProgramRow, dim: boolean) => (
    <tr key={p.source_id} className={cn('border-b border-border/40 hover:bg-secondary/20 transition-colors', dim && 'opacity-60')}>
      <td className="px-3 py-2.5 align-middle">
        <div className="text-sm font-semibold text-foreground whitespace-nowrap">{p.display_name}</div>
        <div className="text-[10.5px] text-muted-foreground max-w-[180px] truncate" title={p.teachers.join('、')}>{p.teachers.join('、') || '—'}</div>
      </td>
      <td className="px-2 py-2.5 align-middle">
        <SampleBadge scored={p.scored_events} total={p.total_events} open={p.open_events} unfillable={p.unfillable} />
      </td>
      <HeatCells byHorizon={p.byHorizon} horizons={cols.horizons} />
      {cols.showExcess && (
        <td className={cn('px-2 py-2.5 text-right align-middle tabular-nums border-l border-border/20', bullBearClass(p.byHorizon[cols.lastHz].excessAvgPct))}>
          {fmtPct(p.byHorizon[cols.lastHz].excessAvgPct)}
        </td>
      )}
      {cols.showPayoff && (
        <td className="px-2 py-2.5 text-right align-middle tabular-nums text-foreground/80">{p.payoffRatio ?? '—'}</td>
      )}
      {cols.showPicks && (
        <td className="px-3 py-2.5 align-middle text-[11px]">
          <PickLine pick={p.bestPick} dir="best" />
          {p.worstPick && !(p.worstPick.stock_code === p.bestPick?.stock_code && p.worstPick.date === p.bestPick?.date) && (
            <PickLine pick={p.worstPick} dir="worst" />
          )}
          {!p.bestPick && !p.worstPick && '—'}
        </td>
      )}
    </tr>
  );
  return (
    <section className="space-y-2.5">
      <SectionTitle icon="tv" title="節目排行榜" subtitle="同節目多位老師同日同股已去重；含未指名老師的事件。" />
      <div className="rounded-xl ring-1 ring-foreground/10 bg-card overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead className="text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-3 py-2 text-left font-medium">節目</th>
              <th className="px-2 py-2 text-left font-medium">樣本</th>
              <HeatHeaders horizons={cols.horizons} onSort={sortByHz} sortKey={sortKey} />
              {cols.showExcess && <th className="px-2 py-2 text-right font-medium border-l border-border/20">{cols.excessLabel}</th>}
              {cols.showPayoff && <th className="px-2 py-2 text-right font-medium">賺賠比</th>}
              {cols.showPicks && <th className="px-3 py-2 text-left font-medium">最佳 / 最雷</th>}
            </tr>
          </thead>
          <tbody>
            {formal.map(p => Row(p, false))}
            {potential.length > 0 && (
              <tr className="bg-secondary/20 border-y border-border/50">
                <td colSpan={fullSpan} className="px-3 py-1.5 text-[11px] text-muted-foreground">
                  ─ 潛力觀察（樣本 &lt; {minScored} 筆）─
                </td>
              </tr>
            )}
            {potential.map(p => Row(p, true))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** 股票迷你熱力條（卡片用） */
function MiniHeat({ byHorizon, horizons }: { byHorizon: Record<RecoHorizon, RecoHorizonStats>; horizons: RecoHorizon[] }) {
  return (
    <div className="flex gap-px rounded overflow-hidden">
      {horizons.map(hz => {
        const st = byHorizon[hz];
        return (
          <div key={hz} className="flex-1 text-center py-1" style={{ background: heatBg(st.n > 0 ? st.avgPct : null, st.n) }}
            title={`${HORIZON_NOTE[hz]}：${st.n > 0 ? fmtPct2(st.avgPct) : '—'}`}>
            <div className="text-[8px] text-white/50 leading-none">{hz === 'd1' ? '隔' : hz.slice(1)}</div>
            <div className="text-[10px] font-semibold text-white/90 tabular-nums leading-none mt-0.5">{st.n > 0 ? fmtPct(st.avgPct) : '—'}</div>
          </div>
        );
      })}
    </div>
  );
}

// ── 共識股 / 最多節目提到（卡片格，countOf 切換「位老師」或「個節目」）──────────────
function StockCardGrid({ rows, horizons, title, subtitle, icon, countOf }: {
  rows: StockAggRow[]; horizons: RecoHorizon[]; title: string; subtitle: string;
  icon: keyof typeof ICONS; countOf: 'teacher' | 'program';
}) {
  return (
    <section className="space-y-2.5">
      <SectionTitle icon={icon} title={title} subtitle={subtitle} />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
        {rows.map(s => {
          const count = countOf === 'teacher' ? s.teacherCount : s.programCount;
          const names = countOf === 'teacher' ? s.teachers : s.programs;
          return (
            <div key={s.stock_code} className="rounded-xl ring-1 ring-foreground/10 bg-card p-3 space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <a href={`/?load=${s.stock_code}`} className="text-sm font-semibold text-sky-300 hover:underline whitespace-nowrap">
                  {s.stock_code} {s.stock_name}
                </a>
                <span className="text-[11px] text-amber-200 whitespace-nowrap">{count} {countOf === 'teacher' ? '位老師' : '個節目'}</span>
              </div>
              <div className="text-[10.5px] text-muted-foreground truncate" title={names.join('、')}>{names.join('、')}</div>
              <MiniHeat byHorizon={s.byHorizon} horizons={horizons} />
              <div className="text-[10px] text-muted-foreground">{s.firstDate} 起 · 共 {s.totalMentions} 次提及{s.themes.length > 0 && ` · ${s.themes.slice(0, 2).join('、')}`}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ExtremeEventList({ items, dir }: { items: ExtremeEvent[]; dir: 'gain' | 'loss' }) {
  return (
    <div className="rounded-xl ring-1 ring-foreground/10 bg-card overflow-hidden">
      <div className={cn('px-3 py-2 text-xs font-semibold border-b border-border', dir === 'gain' ? 'text-bull' : 'text-bear')}>
        {dir === 'gain' ? '▲ 漲最多' : '▼ 跌最多'}
      </div>
      <ul className="divide-y divide-border/30">
        {items.map((e, i) => (
          <li key={`${e.stock_code}-${e.date}-${i}`} className="px-3 py-2 flex items-center gap-2.5 text-xs hover:bg-secondary/20 transition-colors">
            <span className="w-4 text-center text-muted-foreground/60 tabular-nums">{i + 1}</span>
            <div className="flex-1 min-w-0">
              <a href={`/?load=${e.stock_code}&asOf=${e.date}`} className="text-sky-300 hover:underline font-medium whitespace-nowrap">{e.stock_code} {e.stock_name}</a>
              <div className="text-[10px] text-muted-foreground truncate">{e.teacher} · {e.date}{e.programs.length > 0 && ` · ${e.programs[0]}`}</div>
            </div>
            <span className={cn('tabular-nums font-semibold whitespace-nowrap', bullBearClass(e.ret))}>{fmtPct(e.ret)}</span>
          </li>
        ))}
        {items.length === 0 && <li className="px-3 py-3 text-muted-foreground text-center text-[11px]">這天還沒有資料</li>}
      </ul>
    </div>
  );
}

// ── 推薦後漲最多 / 跌最多（每個橫斷各取前幾名，下拉切換）─────────────────────────
function ExtremesSection({ gainers, losers, horizons }: {
  gainers: Record<RecoHorizon, ExtremeEvent[]>; losers: Record<RecoHorizon, ExtremeEvent[]>; horizons: RecoHorizon[];
}) {
  const [hz, setHz] = useState<RecoHorizon>(horizons.includes('d5') ? 'd5' : horizons[horizons.length - 1]);
  const g = gainers?.[hz] ?? [];
  const l = losers?.[hz] ?? [];
  if (g.length === 0 && l.length === 0) return null;

  return (
    <section className="space-y-2.5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <SectionTitle icon="trend" title="推薦後漲最多 / 跌最多"
          subtitle="所有推薦裡，到這個時間點漲最多和跌最多的個股。換右邊的天數看不同時間點。" />
        <select value={hz} onChange={e => setHz(e.target.value as RecoHorizon)}
          className="bg-secondary/40 border border-border rounded-md px-2.5 py-1.5 text-xs cursor-pointer">
          {horizons.map(h => <option key={h} value={h}>{h === 'd1' ? '隔日' : h.toUpperCase()}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5">
        <ExtremeEventList items={g} dir="gain" />
        <ExtremeEventList items={l} dir="loss" />
      </div>
    </section>
  );
}

// ── 共識地雷股（可展開看 D1~D20、節目、日期、為何判定）─────────────────────────
function WorstStocksSection({ rows, horizons }: { rows: StockAggRow[]; horizons: RecoHorizon[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="space-y-2.5">
      <SectionTitle icon="alert" tone="danger" title="共識地雷股"
        subtitle="≥2 位老師同時推、但「隔天開盤買抱到現在」平均虧最多的股票。越多人同推卻跌越兇＝集體誤判越嚴重。點一列看細節。" />
      <div className="rounded-xl border border-red-900/40 bg-red-950/10 overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead className="text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-3 py-2 text-left font-medium">股票</th>
              <th className="px-2 py-2 text-right font-medium">幾位老師</th>
              <th className="px-2 py-2 text-right font-medium">持有至今</th>
              <th className="px-2 py-2 text-right font-medium">提及次數</th>
              <th className="px-3 py-2 text-left font-medium">哪些老師</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(s => {
              const isOpen = open === s.stock_code;
              return (
                <Fragment key={s.stock_code}>
                  <tr onClick={() => setOpen(isOpen ? null : s.stock_code)}
                    className="border-b border-border/30 hover:bg-red-950/20 transition-colors cursor-pointer">
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <span className="text-muted-foreground/60 text-[10px] mr-1">{isOpen ? '▾' : '▸'}</span>
                      <a href={`/?load=${s.stock_code}`} onClick={e => e.stopPropagation()} className="font-mono text-sky-300 hover:underline">{s.stock_code}</a>
                      <span className="ml-1 text-foreground/90">{s.stock_name}</span>
                    </td>
                    <td className="px-2 py-2.5 text-right font-semibold text-red-300 tabular-nums">{s.teacherCount} 位</td>
                    <td className={cn('px-2 py-2.5 text-right tabular-nums font-semibold', bullBearClass(s.avgHold))}>{fmtPct(s.avgHold)}</td>
                    <td className="px-2 py-2.5 text-right text-muted-foreground tabular-nums">{s.totalMentions}</td>
                    <td className="px-3 py-2.5 text-amber-300/80 max-w-[260px] truncate" title={s.teachers.join('、')}>{s.teachers.join('、')}</td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-red-950/20 border-b border-border/30">
                      <td colSpan={5} className="px-3 py-3 space-y-2">
                        <p className="text-[11.5px] text-amber-200/90">
                          為什麼是地雷：<b>{s.teacherCount} 位</b>不同老師都推這檔，但隔天買進抱到現在平均
                          <b className={cn('mx-1', bullBearClass(s.avgHold))}>{fmtPct(s.avgHold)}</b>
                          — 越多人一起看好卻越跌，代表是集體誤判。
                        </p>
                        <div className="max-w-md"><MiniHeat byHorizon={s.byHorizon} horizons={horizons} /></div>
                        <p className="text-[10.5px] text-muted-foreground">
                          被這些節目提到：{s.programs.join('、') || '—'}　·　{s.firstDate} ~ {s.lastDate} 期間
                          {s.themes.length > 0 && <>　·　官方產業：{s.themes.join('、')}</>}
                        </p>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
