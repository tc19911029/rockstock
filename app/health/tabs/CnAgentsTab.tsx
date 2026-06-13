'use client';

/**
 * /health → 陸股情緒 tab —「陸股情緒決策歷史系統」（2026-06-13 改造）
 *
 * 日期驅動：頂部 DatePicker 選交易日 → 整頁打 /api/cn-agents/day?date= 一次回整天。
 * 每天回答：①今天最熱題材+為什麼熱 ②選了哪幾檔+理由 ③候選+龍虎榜+板塊+漲停結構
 * ④推薦後 d1~d20 漲跌（成功=d5收盤>+3%）。所有股票可點 → 首頁走圖停在那天 K 棒。
 *
 * 慣例：紅漲綠跌（別改）；空資料顯示提示不 crash；只 import types 不 import server-only。
 * 每個模組附 <details> ⓘ 定義/資料來源（事實出自各 provider）。
 */

import { useEffect, useMemo, useState } from 'react';
import { DatePicker } from '@/components/ui/DatePicker';
import { useWatchlistStore } from '@/store/watchlistStore';
import { RedFlagChips } from '@/components/RedFlagChips';
import type { EmotionStage, SeatType, StockPosition } from '@/lib/cn-agents/types';
import type { RedFlag } from '@/lib/redflags/types';

// ── /day 回傳形狀 ───────────────────────────────────────────────────────────
interface Perf { d1: number | null; d2: number | null; d3: number | null; d4: number | null; d5: number | null; d10: number | null; d20: number | null; mfe: number | null; mae: number | null; success: boolean | null }
interface CandInfo { changePct: number | null; close: number | null; industry: string | null; consecBoards: number | null; turnoverCny: number | null; isOneWord: boolean }
interface Candidate { code: string; symbol: string; name: string; board: string; rank: number; totalScore: number; tier: 'A' | 'B' | 'C'; mode: string; themeId: string | null; position: StockPosition | null; reasons: string[]; perf: Perf | null; info: CandInfo | null; redFlags?: RedFlag[] }
interface Theme { id: string; name: string; stage: string; strength: number; policy_link: { event: string; level: string; direction: string } | null; leader_symbol: string | null; member_symbols: string[]; logic_summary: string }
interface Board { code: string; name: string; pct: number; mainNetCny: number | null; limitUpCount: number | null; leaderName: string | null }
interface LhbSeat { name: string; type: SeatType; netAmt: number | null }
interface LhbStock { code: string; symbol: string; name: string; board: string; changeRate: number | null; netAmt: number | null; reason: string; verdict: 'good' | 'neutral' | 'avoid'; warnings: string[]; buySeats: LhbSeat[]; sellSeats: LhbSeat[]; perf: Perf | null }
interface Ladder { code: string; symbol: string; name: string; consecBoards: number; industry: string | null; isOneWord: boolean }
interface DayResp {
  ok: boolean;
  date: string | null;
  availableDates: string[];
  analysisPresent: boolean;
  marketMood: { stage: EmotionStage; stageLabel: string; emotionScore: number; strategyLabel: string; positionPct: [number, number]; narrative: string | null } | null;
  breadth: { limitUpCount: number; limitDownCount: number; zhabanRate: number | null; maxBoardHeight: number; promotionRate1to2: number | null; yestLimitUpAvgReturn: number | null; totalTurnover: number | null } | null;
  stats: { sealRate: number | null } | null;
  series: Array<{ date: string; emotionScore: number; stage: EmotionStage }>;
  themes: Theme[];
  candidates: Candidate[];
  actionList: Array<{ symbol: string; name: string; tier: string; mode: string; note: string }>;
  avoidList: Array<{ symbol: string; name: string; reason: string }>;
  ladder: Ladder[];
  boards: { industries: Board[]; concepts: Board[] } | null;
  lhb: { date: string | null; detailFetched: boolean; stocks: LhbStock[] };
}

// ── 配色/常數 ────────────────────────────────────────────────────────────────
const STAGE_STYLE: Record<EmotionStage, string> = {
  frozen: 'bg-slate-800/60 text-slate-300 border-slate-600',
  repair: 'bg-blue-950/60 text-blue-300 border-blue-700',
  launch: 'bg-green-950/60 text-green-300 border-green-700',
  main_rise: 'bg-emerald-950/70 text-emerald-300 border-emerald-600',
  climax: 'bg-orange-950/60 text-orange-300 border-orange-700',
  divergence: 'bg-yellow-950/60 text-yellow-300 border-yellow-700',
  retreat: 'bg-purple-950/60 text-purple-300 border-purple-700',
  crash: 'bg-red-950/60 text-red-300 border-red-700',
};
const STAGE_HEX: Record<EmotionStage, string> = {
  frozen: '#94a3b8', repair: '#60a5fa', launch: '#4ade80', main_rise: '#059669',
  climax: '#fb923c', divergence: '#facc15', retreat: '#c084fc', crash: '#f87171',
};
const MODE_LABEL: Record<string, string> = { daban: '打板', banlu: '半路', dixi: '低吸', swing: '波段', watch: '觀察' };
const TIER_CLS: Record<string, string> = {
  A: 'text-emerald-300 border-emerald-600 bg-emerald-950/40',
  B: 'text-blue-300 border-blue-700 bg-blue-950/30',
  C: 'text-zinc-400 border-zinc-600 bg-zinc-900/40',
};
const THEME_STAGE_CN: Record<string, string> = { fermenting: '發酵', main_rise: '主升', divergence: '分歧', ebb: '退潮' };
const POSITION_CN: Record<string, string> = { leader: '龍頭', core: '中軍', follower: '跟風', misc: '雜毛' };
const BOARD_CN: Record<string, string> = { 'SH-main': '滬主板', 'SZ-main': '深主板', ChiNext: '創業板', STAR: '科創板', BJ: '北交所' };
const SEAT_TYPE_STYLE: Record<SeatType, { label: string; cls: string }> = {
  hot_money: { label: '游資', cls: 'text-red-300 border-red-700/50 bg-red-950/30' },
  institution: { label: '機構', cls: 'text-blue-300 border-blue-700/50 bg-blue-950/30' },
  northbound: { label: '北向', cls: 'text-cyan-300 border-cyan-700/50 bg-cyan-950/30' },
  retail_proxy: { label: '散戶', cls: 'text-zinc-400 border-zinc-600/50 bg-zinc-900/40' },
  quant: { label: '量化', cls: 'text-purple-300 border-purple-700/50 bg-purple-950/30' },
  unknown: { label: '一般', cls: 'text-muted-foreground border-border bg-card' },
};

// ── 格式化 ───────────────────────────────────────────────────────────────────
const fmtRate = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const fmtPct = (v: number | null | undefined, d = 1) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`);
const fmtYi = (v: number | null | undefined, d = 1) => (v == null ? '—' : `${(v / 1e8).toFixed(d)} 億`);
const pctColor = (v: number | null | undefined) => (v == null ? 'text-muted-foreground' : v > 0 ? 'text-red-400' : v < 0 ? 'text-green-400' : 'text-muted-foreground');
function chartHref(symbol: string, date: string | null): string {
  return `/?load=${encodeURIComponent(symbol)}${date ? `&date=${date}` : ''}`;
}

/** 模組說明（摺疊 ⓘ） */
function Info({ children }: { children: React.ReactNode }) {
  return (
    <details className="mt-1 text-[10px] text-muted-foreground">
      <summary className="cursor-pointer hover:text-foreground select-none">ⓘ 定義 / 資料來源</summary>
      <div className="mt-1 pl-3 leading-relaxed border-l border-border">{children}</div>
    </details>
  );
}

// 常駐報酬橫條：7 個交易日 + 最高 + 回撤（仿台股掃描卡 ForwardPerfRow）
type PerfCellKey = 'd1' | 'd2' | 'd3' | 'd4' | 'd5' | 'd10' | 'd20' | 'mfe' | 'mae';
const PERF_CELLS: Array<{ key: PerfCellKey; label: string }> = [
  { key: 'd1', label: '1日' }, { key: 'd2', label: '2日' }, { key: 'd3', label: '3日' },
  { key: 'd4', label: '4日' }, { key: 'd5', label: '5日' }, { key: 'd10', label: '10日' },
  { key: 'd20', label: '20日' }, { key: 'mfe', label: '最高' }, { key: 'mae', label: '最低' },
];

// ── 主元件 ───────────────────────────────────────────────────────────────────
export function CnAgentsTab() {
  const [date, setDate] = useState<string>('');
  const [data, setData] = useState<DayResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const url = date ? `/api/cn-agents/day?date=${date}` : '/api/cn-agents/day';
    fetch(url)
      .then((r) => r.json())
      .then((j: DayResp) => { if (!cancelled) { if (j.ok) { setData(j); if (!date && j.date) setDate(j.date); setError(null); } else setError('讀取失敗'); } })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [date]);

  if (loading && !data) return <div className="text-center py-12 text-muted-foreground">載入中…</div>;
  if (error && !data) return <div className="rounded border border-red-700 bg-red-950/40 p-6 text-sm text-red-300">讀取錯誤：{error}</div>;
  if (!data || !data.date) {
    return <div className="rounded-lg border border-border bg-card p-8 text-center text-muted-foreground">尚無資料，先跑 <code className="text-foreground">/api/cron/cn-agents-eod</code></div>;
  }

  const d = data;
  const mood = d.marketMood;

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* 日期切換 */}
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold">陸股情緒決策歷史</h2>
          <span className="text-[10px] text-muted-foreground">選交易日回溯當天的選股與事後績效{loading ? ' · 載入中…' : ''}</span>
        </div>
        <DatePicker value={d.date ?? ''} onChange={setDate} dates={[...d.availableDates].reverse()} size="md" />
      </div>

      {/* ① 今日大盤情緒 + 最熱題材 */}
      {mood && (
        <div className={`rounded-lg border p-4 ${STAGE_STYLE[mood.stage]}`}>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs opacity-70">{d.date} 盤後</span>
            <span className="text-2xl font-bold">{mood.stageLabel}</span>
            <span className="text-sm">情緒分 <span className="text-xl font-semibold tabular-nums">{mood.emotionScore}</span>/100</span>
            <span className="px-2 py-0.5 rounded border border-current/40 bg-black/20 text-sm">今日策略：{mood.strategyLabel}</span>
            <span className="px-2 py-0.5 rounded border border-current/40 bg-black/20 text-sm">倉位 {mood.positionPct[0]}–{mood.positionPct[1]}%</span>
          </div>
          {d.breadth && (
            <div className="text-xs mt-2 opacity-90">
              漲停 {d.breadth.limitUpCount} 家、跌停 {d.breadth.limitDownCount}、最高 {d.breadth.maxBoardHeight} 板、
              炸板率 {fmtRate(d.breadth.zhabanRate)}、封板率 {fmtRate(d.stats?.sealRate ?? (d.breadth.zhabanRate == null ? null : 1 - d.breadth.zhabanRate))}、
              昨日漲停今日 {fmtPct(d.breadth.yestLimitUpAvgReturn)}、兩市 {fmtYi(d.breadth.totalTurnover, 0)}
            </div>
          )}
          {mood.narrative && <div className="text-xs mt-1.5 opacity-90">{mood.narrative}</div>}
          <Info>
            情緒分 = 6 因子加權（漲停家數 0.25 / 封板品質 0.2 / 昨日漲停今日均 0.2 / 一進二晉級 0.15 / 最高連板 0.1 / 上漲佔比 0.1，缺值取中性 50）。
            漲停/跌停/炸板皆全 A 股（含創業、科創、北交），各板 10%/20%/30% 各自判、ST 另計不入主數。炸板率=炸板/(漲停+炸板)。八階段（冰點→修復→啟動→主升→高潮→分歧→退潮→殺跌）由 cycle.ts 純函式判，可回測。
          </Info>
        </div>
      )}

      {/* 最熱題材（為什麼熱） */}
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold mb-2">今日最熱題材（為什麼熱）</h2>
        {d.themes.length === 0 ? (
          <div className="text-xs text-muted-foreground">這天沒有題材語意（需 /cn-agents-analysis 跑過；歷史日多半空）。可看下方板塊漲幅看資金流向。</div>
        ) : (
          <div className="space-y-2">
            {d.themes.map((t) => (
              <div key={t.id} className="text-xs border-b border-border/40 pb-2 last:border-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm">{t.name}</span>
                  <span className="px-1.5 py-px rounded border border-border text-[10px]">{THEME_STAGE_CN[t.stage] ?? t.stage}</span>
                  <span className="text-muted-foreground">強度 {t.strength}</span>
                  {t.policy_link && <span className="px-1.5 py-px rounded border border-amber-700/50 bg-amber-950/30 text-amber-300 text-[10px]">政策：{t.policy_link.event.slice(0, 16)}</span>}
                  {t.leader_symbol && <span className="text-muted-foreground">龍頭 {t.leader_symbol}</span>}
                </div>
                {t.logic_summary && <div className="text-muted-foreground mt-0.5">{t.logic_summary}</div>}
              </div>
            ))}
          </div>
        )}
        <Info>題材聚類是 Claude 夜間讀「漲停原因+板塊漲幅+主力淨流入+新聞」歸納的（data/cn-agents/analysis）。階段：發酵=早期資金剛進可提前布局／主升=龍頭跟風都漲／分歧=高位炸板／退潮=斷板資金撤。</Info>
      </section>

      {/* ②③ 今日選股清單（掃描面板式：排序 pill + 模式篩選 + 每張卡附報酬橫條） */}
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold mb-1">今日選股（{d.candidates.length} 檔候選，A 類最值得看）</h2>
        <div className="text-[10px] text-muted-foreground mb-2">每張卡：當日漲幅（右上）＋ 模式/連板/題材徽章 ＋ 底部一排推薦後 1~20 日漲跌；🟢=第5日收盤&gt;+3%。綠框=A 類。點 ▼ 看理由。</div>
        <CandidateList candidates={d.candidates} date={d.date} themes={d.themes} />
        <Info>候選池=漲停∪炸板∪龍虎榜淨買∪主力流入top50∪人氣top50，去重後打分排序（硬分+Claude語意分+情緒階段校準）。績效=隔日開盤進場、d1=進場日收盤；成功=第5日收盤&gt;+3%；最近的日子（隔日K未封）顯示「—」。</Info>
      </section>

      {/* 避開名單（退市 veto + 紅旗避雷 shouldAvoid） */}
      {d.avoidList.length > 0 && (
        <section className="rounded-lg border border-red-900/50 bg-red-950/15 p-4">
          <h2 className="text-sm font-semibold mb-2 text-red-300">避開名單（{d.avoidList.length}）</h2>
          <ul className="space-y-1">
            {d.avoidList.map((a) => (
              <li key={a.symbol} className="flex items-baseline gap-2 text-[11px]">
                <a href={chartHref(a.symbol, d.date)} className="font-mono text-sky-400 hover:underline shrink-0">{a.symbol}</a>
                <span className="text-foreground/80 shrink-0 min-w-[64px]">{a.name}</span>
                <span className="text-red-300/90">{a.reason}</span>
              </li>
            ))}
          </ul>
          <Info>退市/ST 由系統名稱否決；其餘「紅旗｜…」來自買進前避雷檢查（業績爆雷/主力出貨/質押還債等≥1 紅或≥3 黃）。只警示，不影響候選分數。</Info>
        </section>
      )}

      {/* ④ 主線 / 板塊強弱 */}
      {d.boards && (
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-semibold mb-2">板塊強弱（資金往哪流）</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <BoardTable title="行業漲幅 Top10" entries={d.boards.industries} />
            <BoardTable title="概念漲幅 Top10" entries={d.boards.concepts} />
          </div>
          <Info>東方財富官方板塊接口（push2 clist）：漲幅/主力淨流入是 EM 原生數字，概念分類是東財歸的（非系統自分）。行業=公司本業（固定）、概念=熱門話題（可多個、會變）。</Info>
        </section>
      )}

      {/* ⑤ 今日龍虎榜（淨買超排序） */}
      <section className="rounded-lg border border-border bg-card p-4 overflow-x-auto">
        <h2 className="text-sm font-semibold mb-1">今日龍虎榜（淨買超排序）</h2>
        <div className="text-[10px] text-muted-foreground mb-2">淨買超大的在前、賣超落底。🔴=回測上會跌（拉薩在買/跌多上榜/淨賣超）。</div>
        {d.lhb.stocks.length === 0 ? (
          <div className="text-xs text-muted-foreground">這天無龍虎榜（或尚未抓）。</div>
        ) : (
          <table className="w-full text-xs min-w-[680px]">
            <thead className="text-muted-foreground">
              <tr className="border-b border-border">
                <th className="text-left py-1 font-normal w-4"></th>
                <th className="text-left font-normal">代號</th>
                <th className="text-left font-normal">名稱</th>
                <th className="text-right font-normal">當日</th>
                <th className="text-right font-normal">淨買超</th>
                <th className="text-left font-normal">買席</th>
                <th className="text-right font-normal">5日</th>
                <th className="text-left font-normal">原因/警示</th>
              </tr>
            </thead>
            <tbody>
              {d.lhb.stocks.slice(0, 15).map((s) => (
                <tr key={`${s.code}-${s.reason}`} className="border-b border-border/30 last:border-0 hover:bg-accent/20">
                  <td>{s.verdict === 'good' ? '🟢' : s.verdict === 'avoid' ? '🔴' : '⚪'}</td>
                  <td className="font-mono"><a href={chartHref(s.symbol, d.date)} className="text-blue-400 hover:underline">{s.code}</a></td>
                  <td className="truncate max-w-[6rem]"><a href={chartHref(s.symbol, d.date)} className="text-blue-400 hover:underline">{s.name}</a></td>
                  <td className={`text-right tabular-nums ${pctColor(s.changeRate)}`}>{fmtPct(s.changeRate)}</td>
                  <td className={`text-right tabular-nums ${pctColor(s.netAmt)}`}>{fmtYi(s.netAmt, 2)}</td>
                  <td className="flex gap-0.5 py-1">{s.buySeats.slice(0, 3).map((seat, i) => <span key={i} className={`text-[9px] px-1 rounded border ${SEAT_TYPE_STYLE[seat.type].cls}`} title={seat.name}>{SEAT_TYPE_STYLE[seat.type].label}</span>)}</td>
                  <td className={`text-right tabular-nums ${pctColor(s.perf?.d5)}`}>{fmtPct(s.perf?.d5)}</td>
                  <td className="text-[10px]">
                    {s.warnings.map((w) => <span key={w} className="mr-1 px-1 rounded border border-red-700/60 bg-red-950/30 text-red-300">{w}</span>)}
                    <span className="text-muted-foreground">{s.reason.slice(0, 12)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Info>來源：東方財富 datacenter 龍虎榜（收盤後 17-19 點公布）。淨買超=買席合計−賣席合計（BILLBOARD_NET_AMT）。席位標籤：機構=機構專用、游資=知名席位、北向=滬深股通、散戶=拉薩(東財App散戶入口)。回測：拉薩在買 5日 -5.4% 最慘。</Info>
      </section>

      {/* ⑥ 連板梯隊 */}
      {d.ladder.length > 0 && (
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-semibold mb-2">連板梯隊（高度 Top，全市場非 ST）</h2>
          <div className="flex flex-wrap gap-1.5">
            {d.ladder.map((l) => (
              <a key={l.code} href={chartHref(l.symbol, d.date)} className="text-[11px] px-2 py-0.5 rounded border border-border bg-background hover:bg-accent/30">
                <span className="text-blue-400">{l.name}</span> <span className="text-muted-foreground">{l.consecBoards}板{l.isOneWord ? '·一字' : ''}</span>
              </a>
            ))}
          </div>
          <Info>全市場（非 ST）漲停股按連續漲停天數排（首板=1板）。一字=開盤即封買不到。可點 → 走圖那天。</Info>
        </section>
      )}

      {/* ⑦ 近 30 日情緒分 */}
      {d.series.length > 1 && <EmotionSparkline series={d.series} />}

      {/* ⑧ 策略×情緒階段勝率表 */}
      <StageWinTable />
    </div>
  );
}

// ── 子元件 ───────────────────────────────────────────────────────────────────

// 選股清單排序鍵（對齊策略掃描面板的「排序」pill 列；三色專屬的短攻/中強/中控/超短跌
// 與漲跌·隔開不適用陸股，改用陸股有的：分數/漲幅/股價/成交量/連板 + 推薦後各日漲跌）
type SortKey = 'score' | 'change' | 'price' | 'turnover' | 'boards' | 'd1' | 'd5' | 'd20' | 'mfe' | 'mae';
const SORT_PILLS: Array<{ key: SortKey; label: string; tip: string }> = [
  { key: 'score', label: '分數', tip: '系統綜合分（硬分+語意分+情緒階段校準），高的排前面' },
  { key: 'change', label: '漲幅', tip: '當日漲跌幅 %（大的排前面）' },
  { key: 'price', label: '股價', tip: '當日收盤價' },
  { key: 'turnover', label: '成交量', tip: '當日成交額（大的排前面）' },
  { key: 'boards', label: '連板', tip: '連續漲停天數（首板=1）' },
  { key: 'd1', label: '漲跌·1日', tip: '推薦後第 1 個交易日漲跌幅' },
  { key: 'd5', label: '漲跌·5日', tip: '推薦後第 5 個交易日漲跌幅（成功門檻看這天）' },
  { key: 'd20', label: '漲跌·20日', tip: '推薦後第 20 個交易日漲跌幅' },
  { key: 'mfe', label: '漲跌·最高', tip: '推薦後區間最大累計漲幅' },
  { key: 'mae', label: '漲跌·最低', tip: '推薦後區間最大累計跌幅' },
];

function sortVal(c: Candidate, key: SortKey): number | null {
  switch (key) {
    case 'score': return c.totalScore;
    case 'change': return c.info?.changePct ?? null;
    case 'price': return c.info?.close ?? null;
    case 'turnover': return c.info?.turnoverCny ?? null;
    case 'boards': return c.info?.consecBoards ?? null;
    default: return c.perf ? c.perf[key] : null;
  }
}

/** 選股清單：排序 pill + 模式篩選 chip + 卡片（仿台股策略掃描卡） */
function CandidateList({ candidates, date, themes }: { candidates: Candidate[]; date: string | null; themes: Theme[] }) {
  const [sort, setSort] = useState<SortKey>('score');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [modeFilter, setModeFilter] = useState<string>('all');

  const modes = useMemo(() => [...new Set(candidates.map((c) => c.mode))], [candidates]);
  const themeName = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of themes) m.set(t.id, t.name);
    return m;
  }, [themes]);

  const shown = useMemo(() => {
    const sign = dir === 'desc' ? 1 : -1;
    return candidates
      .filter((c) => modeFilter === 'all' || c.mode === modeFilter)
      .slice()
      .sort((a, b) => {
        const va = sortVal(a, sort);
        const vb = sortVal(b, sort);
        if (va == null && vb == null) return 0;
        if (va == null) return 1; // 缺值永遠落底
        if (vb == null) return -1;
        return sign * (vb - va);
      })
      .slice(0, 30);
  }, [candidates, sort, dir, modeFilter]);

  return (
    <div className="space-y-1.5">
      {/* 排序 pill 列 */}
      <div className="flex flex-wrap gap-1 items-center">
        <span className="text-[9px] text-muted-foreground/70 mr-0.5">排序</span>
        {SORT_PILLS.map(({ key, label, tip }) => (
          <button key={key} title={tip}
            onClick={() => { if (sort === key) setDir((x) => (x === 'desc' ? 'asc' : 'desc')); else { setSort(key); setDir('desc'); } }}
            className={`text-[9px] px-1.5 py-0.5 rounded-full whitespace-nowrap ${sort === key ? 'bg-sky-700 text-foreground' : 'bg-secondary text-muted-foreground'}`}>
            {label}{sort === key && <span className="ml-0.5">{dir === 'desc' ? '▼' : '▲'}</span>}
          </button>
        ))}
      </div>
      {/* 模式篩選 chip */}
      {modes.length > 1 && (
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setModeFilter('all')}
            className={`text-[9px] px-1.5 py-0.5 rounded-full ${modeFilter === 'all' ? 'bg-sky-700 text-foreground' : 'bg-secondary text-muted-foreground'}`}>全部</button>
          {modes.map((m) => (
            <button key={m} onClick={() => setModeFilter(m)}
              className={`text-[9px] px-1.5 py-0.5 rounded-full ${modeFilter === m ? 'bg-sky-700 text-foreground' : 'bg-secondary text-muted-foreground'}`}>
              {MODE_LABEL[m] ?? m}
            </button>
          ))}
        </div>
      )}
      {/* 卡片清單（緊湊，一畫面多看幾檔） */}
      <div className="space-y-1">
        {shown.map((c) => (
          <CandidateCard key={c.code} c={c} date={date} themeName={c.themeId ? themeName.get(c.themeId) ?? null : null} />
        ))}
      </div>
    </div>
  );
}

/** 選股卡（緊湊版）：2 行表頭（名稱/徽章/漲幅 ＋ 股價/產業/分數/按鈕）+ 1 排報酬橫條 */
function CandidateCard({ c, date, themeName }: { c: Candidate; date: string | null; themeName: string | null }) {
  const [open, setOpen] = useState(false);
  const inWatch = useWatchlistStore((s) => s.has(c.symbol));
  const info = c.info;
  const aTier = c.tier === 'A';
  return (
    <div className={`rounded-md border px-2.5 py-1 ${aTier ? 'border-emerald-600/60 bg-emerald-950/15' : 'bg-card border-border/60'}`}>
      {/* 第一行：分層 + 名稱 + 代號 + 模式/連板/題材 ⋯ 當日漲幅 */}
      <div className="flex items-center gap-1.5">
        <span className={`text-[9px] px-1 rounded-sm font-bold border shrink-0 ${TIER_CLS[c.tier] ?? ''}`}>{c.tier}</span>
        <a href={chartHref(c.symbol, date)} className="flex items-baseline gap-1 min-w-0 hover:underline">
          <span className="text-[13px] font-semibold text-foreground/90 truncate">{c.name}</span>
          <span className="font-mono text-[10px] text-muted-foreground shrink-0">{c.code}</span>
        </a>
        <span className="text-[9px] px-1 rounded-sm bg-indigo-950/50 text-indigo-300 border border-indigo-800/40 shrink-0">{MODE_LABEL[c.mode] ?? c.mode}</span>
        {info?.consecBoards != null && info.consecBoards >= 1 && (
          <span className="text-[9px] px-1 rounded-sm bg-red-950/40 text-red-300 border border-red-800/40 shrink-0">{info.consecBoards}板{info.isOneWord ? '·一字' : ''}</span>
        )}
        {themeName && <span className="text-[9px] px-1 rounded-sm bg-purple-950/40 text-purple-300 border border-purple-800/40 shrink-0 truncate max-w-[72px]">{themeName}</span>}
        <span className={`ml-auto font-mono text-[13px] font-bold shrink-0 ${pctColor(info?.changePct)}`}>
          {info?.changePct != null ? fmtPct(info.changePct, 2) : '—'}
        </span>
      </div>
      {/* 第二行：股價 · 產業 · 板別 · 分數 · 成功旗標 ⋯ 走圖 / 加自選 / 展開 */}
      <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-muted-foreground">
        {info?.close != null && <span className="font-mono text-foreground/70">{info.close.toFixed(2)}</span>}
        {info?.industry && <span className="truncate max-w-[84px]">{info.industry}</span>}
        <span>{BOARD_CN[c.board] ?? c.board}</span>
        <span>· {c.totalScore}分</span>
        {c.perf?.success != null && <span>{c.perf.success ? '🟢' : '🔴'}</span>}
        <div className="ml-auto flex items-center gap-1">
          <a href={chartHref(c.symbol, date)} className="text-[9px] text-sky-400 hover:text-sky-300 px-1.5 py-0.5 rounded border border-sky-700/50 hover:bg-sky-900/30">走圖</a>
          <button onClick={() => useWatchlistStore.getState().add(c.symbol, c.name)}
            className="text-[9px] text-amber-400 hover:text-amber-300 px-1.5 py-0.5 rounded border border-amber-700/50 hover:bg-amber-900/30">{inWatch ? '✓' : '＋'}</button>
          {c.reasons.length > 0 && (
            <button onClick={() => setOpen((v) => !v)} className="text-[10px] text-muted-foreground hover:text-foreground px-0.5">{open ? '▲' : '▼'}</button>
          )}
        </div>
      </div>
      {/* 紅旗避雷（基本面/籌碼/治理；只標示不剔除） */}
      {c.redFlags && c.redFlags.length > 0 && (
        <div className="mt-1"><RedFlagChips flags={c.redFlags} /></div>
      )}
      {/* 第三行：常駐報酬橫條（slim） */}
      <div className="mt-1"><PerfStrip perf={c.perf} /></div>
      {/* 展開：完整理由 */}
      {open && c.reasons.length > 0 && (
        <ul className="mt-1.5 pt-1.5 border-t border-border/40 text-[10px] text-muted-foreground list-disc list-inside space-y-0.5">
          {c.reasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      )}
    </div>
  );
}

/** 常駐報酬橫條（slim：每欄上標籤下數字、紅漲綠跌；缺值「—」） */
function PerfStrip({ perf }: { perf: Perf | null }) {
  return (
    <div className="flex items-stretch rounded overflow-hidden bg-secondary/20">
      {PERF_CELLS.map(({ key, label }) => {
        const v = perf ? perf[key] : null;
        return (
          <div key={key} className="flex-1 text-center py-0.5 border-l border-border/20 first:border-l-0">
            <div className="text-[7px] text-muted-foreground/60 leading-tight">{label}</div>
            <div className={`text-[9px] font-mono leading-tight ${pctColor(v)}`}>{fmtPct(v)}</div>
          </div>
        );
      })}
    </div>
  );
}

function BoardTable({ title, entries }: { title: string; entries: Board[] }) {
  return (
    <div>
      <div className="text-xs font-medium mb-1">{title}</div>
      <table className="w-full text-xs">
        <thead className="text-muted-foreground"><tr className="border-b border-border"><th className="text-left py-1 font-normal">名稱</th><th className="text-right font-normal">漲幅</th><th className="text-right font-normal">主力淨流入</th><th className="text-right font-normal">漲停</th></tr></thead>
        <tbody>
          {entries.map((b) => (
            <tr key={b.code} className="border-b border-border/30 last:border-0">
              <td className="py-1 truncate max-w-[7rem]">{b.name}</td>
              <td className={`text-right tabular-nums ${pctColor(b.pct)}`}>{fmtPct(b.pct)}</td>
              <td className={`text-right tabular-nums ${pctColor(b.mainNetCny)}`}>{fmtYi(b.mainNetCny, 1)}</td>
              <td className="text-right tabular-nums text-muted-foreground">{b.limitUpCount ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmotionSparkline({ series }: { series: Array<{ date: string; emotionScore: number; stage: EmotionStage }> }) {
  const W = 600, H = 80, pad = 6;
  const xs = (i: number) => pad + (i / Math.max(1, series.length - 1)) * (W - 2 * pad);
  const ys = (v: number) => H - pad - (v / 100) * (H - 2 * pad);
  const path = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${xs(i).toFixed(1)},${ys(p.emotionScore).toFixed(1)}`).join(' ');
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-semibold mb-2">近 {series.length} 日情緒分</h2>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="近 30 日情緒分趨勢">
        {[25, 50, 75].map((y) => <line key={y} x1={pad} x2={W - pad} y1={ys(y)} y2={ys(y)} stroke="currentColor" className="text-border" strokeWidth={0.5} strokeDasharray="3 3" />)}
        <path d={path} fill="none" stroke="#38bdf8" strokeWidth={1.5} />
        {series.map((p, i) => <circle key={p.date} cx={xs(i)} cy={ys(p.emotionScore)} r={2.5} fill={STAGE_HEX[p.stage]}><title>{`${p.date} ${p.emotionScore}`}</title></circle>)}
      </svg>
      <Info>每點=當日情緒分（0-100），顏色=當日階段。線往上=情緒轉熱。截至所選日，不顯示之後。</Info>
    </section>
  );
}

// ── 策略×情緒階段勝率表（讀預算快照，即時） ───────────────────────────────────
interface StageRow { phase: EmotionStage; phaseLabel: string; n: number; filled: number; winRate: Record<string, number | null>; avg: Record<string, number | null>; successRate: number | null; lowSample: boolean }
function StageWinTable() {
  const [rows, setRows] = useState<StageRow[] | null>(null);
  const [meta, setMeta] = useState<{ totalEvents: number } | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    fetch('/api/cn-agents/leaderboard').then((r) => r.json())
      .then((j) => { if (j.ok) { setRows(j.stages ?? []); setMeta(j.meta ?? null); } })
      .catch(() => {}).finally(() => setLoaded(true));
  }, []);
  if (!loaded) return null;
  const shown = (rows ?? []).filter((r) => r.filled > 0);
  if (shown.length === 0) return null;
  return (
    <section className="rounded-lg border border-border bg-card p-4 overflow-x-auto">
      <h2 className="text-sm font-semibold mb-1">策略 × 情緒階段勝率（歷史回測）</h2>
      <div className="text-[10px] text-muted-foreground mb-2">過去在每個情緒階段推薦的股，事後各天「上漲比例」+ 平均漲幅 + 成功率（5日&gt;+3%）。{meta ? `共 ${meta.totalEvents} 筆事件` : ''}</div>
      <table className="w-full text-xs min-w-[640px]">
        <thead className="text-muted-foreground">
          <tr className="border-b border-border">
            <th className="text-left py-1 font-normal">階段</th>
            <th className="text-right font-normal">推薦次數</th>
            {['1日', '2日', '3日', '4日', '5日'].map((h) => <th key={h} className="text-right font-normal">{h}勝率</th>)}
            <th className="text-right font-normal">平均5日</th>
            <th className="text-right font-normal">成功率</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.phase} className={`border-b border-border/30 last:border-0 ${r.lowSample ? 'opacity-50' : ''}`}>
              <td className="py-1">{r.phaseLabel}</td>
              <td className="text-right tabular-nums">{r.filled}</td>
              {(['d1', 'd2', 'd3', 'd4', 'd5'] as const).map((h) => <td key={h} className="text-right tabular-nums">{fmtRate(r.winRate[h])}</td>)}
              <td className={`text-right tabular-nums ${pctColor(r.avg.d5)}`}>{fmtPct(r.avg.d5)}</td>
              <td className="text-right tabular-nums">{fmtRate(r.successRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Info>用 hard_score 歷史事件（隔日開盤進場）算。勝率=該日收盤&gt;進場價的比例；成功率=第5日收盤&gt;+3%的比例。樣本&lt;10 灰顯。回測結論：打板在熱階段(主升/高潮/分歧)系統性虧、低吸/早期波段才賺。</Info>
    </section>
  );
}
