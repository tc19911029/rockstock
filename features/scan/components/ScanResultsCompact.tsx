'use client';

import { useState, useEffect, useMemo, Fragment } from 'react';
import { useBacktestStore } from '@/store/backtestStore';
import { useWatchlistStore } from '@/store/watchlistStore';
import type { SelectedStock } from './ScanChartPanel';
import type { StockForwardPerformance, StockScanResult } from '@/lib/scanner/types';
import type { TrendState } from '@/lib/analysis/trendAnalysis';
import type { LockWatchRecord } from '@/lib/scanner/lockWatchTypes';
import { LETTER_NAMES } from '@/lib/scanner/buyMethodTracks';
import { buildAllStrategyReasons, type StrategyReasonRow } from './strategyReasons';
import { useLockwatchSnapshot } from '@/lib/hooks/useLockwatchSnapshot';
import { panelSortKey } from '@/lib/selection/applyPanelFilter';
import { ForwardPerfRow } from './ForwardPerfRow';
import { useYouTubeMentionMap } from '@/lib/hooks/useYouTubeMentionMap';
import { useThemeHeatMap } from '@/lib/hooks/useThemeHeatMap';
import { bestHeatRank } from '@/lib/theme-sanse/heatRef';
import { ThemeTag } from '@/components/ThemeTag';
import { YouTubeMentionBadge, resonanceTags } from '@/components/youtube/YouTubeMentionBadge';
import { CnBoardBadge } from '@/components/shared/CnBoardBadge';
import { SortControl } from '@/components/shared';
import { applySort, type SortValue } from '@/lib/sorting/sortEngine';
import { UNIVERSAL_SORT_OPTIONS, type SortDir } from '@/lib/sorting/registry';
import { isMarketOpen, isPostCloseWindow } from '@/lib/datasource/marketHours';
import { RefreshCw } from 'lucide-react';
import { getLegacyBookAchievementRate } from '@/lib/analysis/patternCatalog';
import { getPatternDisplayName } from '@/lib/chart/patternDisplay';

// 此面板提供的排序選項（id 走 lib/sorting/registry 中央清單）：
// 該頁專屬（六條件/今日熱點/YouTube 提及）+ '|' 分隔線 + 共用區（全 UNIVERSAL_SORT_OPTIONS）。
const SCAN_SORT_OPTIONS = ['score.sixCond', 'heat.theme', 'heat.youtube', '|', ...UNIVERSAL_SORT_OPTIONS];
const SCAN_FWD_FIELD: Record<string, keyof StockForwardPerformance> = {
  'fwd.open': 'openReturn', 'fwd.d1': 'd1Return', 'fwd.d5': 'd5Return',
  'fwd.d10': 'd10Return', 'fwd.d20': 'd20Return', 'fwd.maxGain': 'maxGain', 'fwd.maxLoss': 'maxLoss',
};

// 去市場後綴拿裸代號（YouTube 提及 map 以裸代號為 key）
const bareCode = (s: string) => s.replace(/\.(TW|TWO|SS|SZ)$/i, '');

// ── Helpers ──────────────────────────────────────────────────────────────────

// v11 字母（G/H/I）跟 v12（J/K/L）是 alias，cross-strategy 顯示時去重
const V11_ALIAS_OF_V12: Record<string, string> = { G: 'J', H: 'L', I: 'K' };

// 2026-05-13 對齊書本：F/N 在書本（寶典 Part 11-1 #7、抓住K線 V 反轉戰法）
// 觸發即進場訊號，不再用 dashed outline 區分，跟 B/C/E 同等實心填色顯示。

/**
 * Cross-strategy badges 去重：
 *   - 排除 main 自己
 *   - v11 alias（G/H/I）統一映射到 v12 字母（J/L/K）去重
 *   - 全部命中策略都列出（不折疊、不過濾同軌道兄弟訊號）
 */
function dedupeCrossBadges(matched: string[], main: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matched) {
    if (m === main) continue;
    const canonical = V11_ALIAS_OF_V12[m] ?? m;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

/**
 * 主徽章名稱清理：
 *   - 去掉「J 」「M 」「F 」等單字母前綴（detector detail 慣例帶字母）
 *   - 去掉尾端 `（...）` 詳細參數
 */
function cleanMainBadgeName(ruleName: string): string {
  return ruleName
    .replace(/^[A-Z]\s+/, '')
    .replace(/（.*）$/, '')
    .replace(/[:：].*$/, '')
    .trim();
}

interface ScanResultsCompactProps {
  onSelectStock?: (stock: SelectedStock) => void;
}

export function ScanResultsCompact({ onSelectStock }: ScanResultsCompactProps) {
  const {
    scanResults, scanDate, market, marketTrend: storeTrend, scanOnly,
    performance, isFetchingForward, isLoadingCronSession,
    activeBuyMethod, activeSessionScanTime, loadCronSession, isLoadingBuyMethod,
  } = useBacktestStore();

  // A30（六條件30分K）盤中狀態列：盤中/盤後 + 最後更新時間 + 刷新 + 盤中每分鐘自動輪詢
  const isA30 = activeBuyMethod === 'A30';
  const a30Live = isA30 && market === 'TW' && (isMarketOpen('TW') || isPostCloseWindow('TW'));
  const a30UpdatedAt = activeSessionScanTime
    ? new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(activeSessionScanTime))
    : null;
  const refreshA30 = () => { if (scanDate) loadCronSession(market, scanDate, { scanOnly: true, direction: 'long' }); };
  useEffect(() => {
    if (!a30Live || !scanDate) return;
    const id = setInterval(() => {
      loadCronSession(market, scanDate, { scanOnly: true, direction: 'long' });
    }, 60_000); // 盤中每分鐘自動重載（30分K每半點更新，1分鐘輪詢即可跟上）
    return () => clearInterval(id);
  }, [a30Live, market, scanDate, loadCronSession]);

  const [expandedStock, setExpandedStock] = useState<string | null>(null);
  const [conceptFilter, setConceptFilter] = useState<string>('all');
  // 只看「近 7 天有被 YouTube 節目提及」的股票（display-layer 篩選，不改掃描資料流）
  const [ytRecentOnly, setYtRecentOnly] = useState(false);
  // 排序選項：成交額排名為預設（依 0512 v12 全期間綜合回測，A 級組合多靠此排序勝出）
  // 漲幅排序對齊 panelSortKey（漲幅主鍵 + 六條件次鍵 tie-breaker）
  const [scanSort, setScanSort] = useState<string>('mkt.turnover');
  const [scanSortDir, setScanSortDir] = useState<SortDir>('desc');

  // YouTube 提及 map（截至掃描當日）— 純展示 join，不進掃描/選股邏輯
  // 只台股有對應；陸股代號不重疊，傳 undefined 不發請求（與三色掃描一致）
  const { map: ytMap } = useYouTubeMentionMap(market === 'TW' ? (scanDate ?? undefined) : undefined);

  // 今日題材熱度 map（裸碼 → 所屬最熱題材；refs[0]=今日最熱）— 「🔥今日題材熱度」排序 + 卡片標籤用
  // TW=38 題材按今日漲幅；CN=概念板塊按今日 pct（即時抓成分股）。純展示/排序，不進選股 gate。
  const themeHeatMap = useThemeHeatMap(market, scanDate ?? undefined);

  // 即時 raw trend（跟 banner 同源）— saved session 的 marketTrend 是舊邏輯（含降級）
  // 不可用，會跟 banner 顯示不一致（「banner 多頭、結果欄盤整」這種）
  const [liveTrend, setLiveTrend] = useState<TrendState | null>(storeTrend ?? null);
  useEffect(() => {
    let cancelled = false;
    if (!market || !scanDate) return;
    fetch(`/api/scanner/market-trend?market=${market}&date=${scanDate}`)
      .then((r) => r.json())
      .then((j: { ok?: boolean; trend?: TrendState }) => {
        if (!cancelled && j.ok && j.trend) setLiveTrend(j.trend);
      })
      .catch(() => { /* keep storeTrend fallback */ });
    return () => { cancelled = true; };
  }, [market, scanDate]);
  const marketTrend = liveTrend ?? storeTrend;

  // ── LockWatch records cross-ref（已失效 N / F 訊號標 ✗）──────────────────
  // 共用 useLockwatchSnapshot；LockWatchPanel 也用同一個 hook
  const { snapshot: lockwatchSnapshot } = useLockwatchSnapshot(market);
  const lockWatchRecords: LockWatchRecord[] = useMemo(
    () => lockwatchSnapshot?.records ?? [],
    [lockwatchSnapshot],
  );
  // (symbol, triggerSignal, triggeredDate) → record；用 row.scanDate 對齊 record.triggeredDate
  // 解兩個 bug：(a) 同支股多筆 N 不會互蓋；(b) 看歷史 scan 拿到對應日期的 record 而非最新 state
  const lockWatchByKey = useMemo(() => {
    const map = new Map<string, LockWatchRecord>();
    for (const r of lockWatchRecords) {
      if (r.triggerSignal !== 'N' && r.triggerSignal !== 'F') continue;
      map.set(`${r.symbol}|${r.triggerSignal}|${r.triggeredDate}`, r);
    }
    return map;
  }, [lockWatchRecords]);
  const findLockWatch = (symbol: string, signal: 'N' | 'F'): LockWatchRecord | undefined => {
    if (!scanDate) return undefined;
    return lockWatchByKey.get(`${symbol}|${signal}|${scanDate}`);
  };

  const perfMap = useMemo(() => {
    const map = new Map<string, StockForwardPerformance>();
    for (const p of performance) map.set(p.symbol, p);
    return map;
  }, [performance]);


  const availableConcepts = [...new Set(scanResults.map(r => r.industry).filter(Boolean))] as string[];

  const filtered = scanResults
    .filter(r => conceptFilter === 'all' || r.industry === conceptFilter)
    .filter(r => !ytRecentOnly || (ytMap.get(bareCode(r.symbol))?.count7d ?? 0) > 0);

  // 排序值取法（id 走中央清單；缺值/升降序由 sortEngine 統一處理）
  const scanSortValue = (r: StockScanResult, id: string): SortValue => {
    const fk = SCAN_FWD_FIELD[id];
    if (fk) return (perfMap.get(r.symbol)?.[fk] as number | null | undefined) ?? null;
    switch (id) {
      case 'mkt.price':   return r.price ?? null;
      case 'mkt.change':  // 漲幅/六條件/ma20Slope 三層 — 單一事實 panelSortKey（rule 10）
        return panelSortKey(r);
      case 'score.sixCond': return (r.sixConditionsScore ?? 0) * 100 + (r.changePercent ?? 0) / 100;
      case 'mkt.turnover':  return -(r.turnoverRank ?? 999_999); // rank 1 = 最大 → 取負，desc 時排最前
      case 'heat.youtube':  return ytMap.get(bareCode(r.symbol))?.count30d ?? null; // 未提及排最後
      case 'heat.theme': {  // 所屬「今日最熱題材」名次（1=最熱）→ 同題材內再按漲幅；無題材排最後
        const rank = bestHeatRank(themeHeatMap, r.symbol);
        return rank === Infinity ? null : -(rank * 1000) + (r.changePercent ?? 0);
      }
      default: return null;
    }
  };
  const sorted = applySort(filtered, scanSort, scanSortDir, scanSortValue);

  if (!scanOnly) return null;
  if (scanResults.length === 0 && isLoadingCronSession) return null;

  if (scanResults.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <p className="text-2xl mb-2">🔍</p>
        <p className="text-xs text-muted-foreground">尚無掃描結果</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5 px-2">
      {/* Header */}
      <div className="flex items-center gap-1.5 text-xs flex-wrap">
        <span className="font-bold text-foreground">{scanResults.length} 檔</span>
        <span className="text-[10px] text-muted-foreground/60">{scanDate}</span>
        {marketTrend && (
          <span className={`px-1 py-0.5 rounded text-[9px] font-bold ${
            marketTrend === '多頭' ? 'bg-red-900/50 text-red-300' :
            marketTrend === '空頭' ? 'bg-green-900/50 text-green-300' :
            'bg-yellow-900/50 text-yellow-300'
          }`}>{String(marketTrend)}</span>
        )}
        {isFetchingForward && (
          <span className="text-[9px] text-sky-400 animate-pulse">載入中…</span>
        )}
      </div>

      {/* A30 六條件(30分K) 盤中狀態列（仿三色資金：盤中/盤後 + 最後更新 + 刷新）*/}
      {isA30 && (
        <div className="flex items-center justify-between gap-1 px-1.5 py-1 rounded bg-amber-950/30 border border-amber-800/40">
          <div className="flex items-center gap-1.5 text-[10px] flex-wrap min-w-0">
            <span className="font-semibold text-amber-300 shrink-0">🕐 六條件30分</span>
            {a30Live ? (
              <span className="text-rose-400 flex items-center gap-1 shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse inline-block" />盤中跳動
              </span>
            ) : (
              <span className="text-sky-400 shrink-0">盤後</span>
            )}
            {a30UpdatedAt && <span className="text-muted-foreground/80">· 最後更新 {a30UpdatedAt}</span>}
            <span className="text-muted-foreground/80">· 累積 {scanResults.length} 檔</span>
          </div>
          <button
            onClick={refreshA30}
            disabled={isLoadingBuyMethod}
            title="立即重新載入盤中名單（盤中每 30 分自動掃、名單累加）"
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground shrink-0 disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${isLoadingBuyMethod ? 'animate-spin' : ''}`} />
          </button>
        </div>
      )}


      {/* Sort selector pills — 共用 SortControl + 中央排序清單 */}
      <SortControl
        options={SCAN_SORT_OPTIONS}
        value={scanSort}
        dir={scanSortDir}
        onChange={(id, d) => { setScanSort(id); setScanSortDir(d); }}
      />
      {scanSort === 'heat.theme' && (
        <p className="text-[9px] leading-snug text-amber-400/90">
          {market === 'TW'
            ? '🔥 按今日漲幅最強的題材排（面板/網通/生技/被動元件…）。回測：最熱題材那段報酬約是後段 2 倍（台股有效）。'
            : '⚠ 按今日漲幅最強的概念排（中芯/HBM/存儲/CRO…）。陸股回測這樣排「反而把較差的排前面」— 只供觀察哪個概念在燒，別照此追高。'}
        </p>
      )}

      {/* YouTube 提及篩選 */}
      <div className="flex flex-wrap gap-1 items-center">
        <button
          onClick={() => setYtRecentOnly(v => !v)}
          title="只顯示近 7 天有被 YouTube 理財節目提及的股票"
          className={`text-[9px] px-1.5 py-0.5 rounded-full whitespace-nowrap ${ytRecentOnly ? 'bg-purple-700 text-foreground' : 'bg-secondary text-muted-foreground'}`}
        >
          近7天提及{ytRecentOnly ? ' ✓' : ''}
        </button>
      </div>

      {/* Concept filter pills */}
      {availableConcepts.length > 1 && (
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setConceptFilter('all')}
            className={`text-[9px] px-1.5 py-0.5 rounded-full ${conceptFilter === 'all' ? 'bg-sky-700 text-foreground' : 'bg-secondary text-muted-foreground'}`}>
            全部
          </button>
          {availableConcepts.sort().slice(0, 10).map(c => (
            <button key={c} onClick={() => setConceptFilter(c)}
              className={`text-[9px] px-1.5 py-0.5 rounded-full ${conceptFilter === c ? 'bg-sky-700 text-foreground' : 'bg-secondary text-muted-foreground'}`}>
              {c}
            </button>
          ))}
        </div>
      )}

      {/* Card list */}
      {sorted.slice(0, 50).map(r => {
        const perf = perfMap.get(r.symbol);
        const isExpanded = expandedStock === r.symbol;
        const ticker = r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
        // YouTube 提及（純展示，不影響掃描/排序資料）
        const ytSummary = ytMap.get(ticker);
        const ytResonance = resonanceTags(ytSummary);
        // 戒律觸發 row 灰化（書本：detector 訊號可看，但戒律是硬性禁忌不該追）
        const prohibitionsCount = r.longProhibitionsReasons?.length ?? 0;
        const hasProhibition = prohibitionsCount > 0;

        return (
          <Fragment key={r.symbol}>
            <div
              className={`rounded-lg border px-2.5 py-2 cursor-pointer transition-colors ${
                isExpanded
                  ? 'bg-secondary/60 border-sky-700/50'
                  : hasProhibition
                    ? 'bg-zinc-900/60 border-rose-900/40 hover:bg-zinc-900/80'
                    : 'bg-card border-border/60 hover:bg-secondary/40'
              }`}
              style={hasProhibition && !isExpanded ? { filter: 'grayscale(0.6) brightness(0.65)' } : undefined}
              onClick={() => setExpandedStock(isExpanded ? null : r.symbol)}
              title={hasProhibition ? `⚠ 戒律觸發 ${prohibitionsCount} 條 — ${r.longProhibitionsReasons!.slice(0, 2).join('；')}（書本：硬性禁忌不該追）` : undefined}
            >
              {/* Row 1: Symbol + Name + Change% + Actions */}
              <div className="flex items-center gap-1.5 mb-1">
                <span className="font-mono text-[11px] text-foreground/90 shrink-0">{ticker}</span>
                <span className="text-[11px] text-foreground/80 truncate">{r.name}</span>
                <CnBoardBadge symbol={r.symbol} />
                <div className="flex-1" />
                {hasProhibition && (
                  <span
                    className="text-[8px] px-1 h-3.5 flex items-center rounded-sm bg-rose-900/40 text-rose-300 font-bold shrink-0"
                    title={r.longProhibitionsReasons!.join('；')}
                  >
                    ⚠ 戒律 {prohibitionsCount}
                  </span>
                )}
                <span className={`font-mono text-[11px] font-bold shrink-0 ${r.changePercent >= 0 ? 'text-bull' : 'text-bear'}`}>
                  {r.changePercent >= 0 ? '+' : ''}{r.changePercent.toFixed(1)}%
                </span>
              </div>

              {/* Row 2: Price + Industry + Trend + Position + Turnover Rank */}
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-1">
                <span className="font-mono">{r.price.toFixed(2)}</span>
                {r.industry && <span className="truncate max-w-[56px]">{r.industry}</span>}
                <ThemeTag market={market} code={bareCode(r.symbol)} hotMap={themeHeatMap} className="max-w-[120px]" />
                <span>{r.trendState}</span>
                <span className="truncate">{r.trendPosition}</span>
                {(ytSummary || r.turnoverRank !== undefined) && (
                  <div className="ml-auto flex items-center gap-1 shrink-0">
                    {ytResonance[0] && (
                      <span
                        title={ytResonance[0].title}
                        className={`text-[8px] px-1 h-3.5 flex items-center rounded-sm border ${ytResonance[0].cls}`}
                      >
                        {ytResonance[0].label}
                      </span>
                    )}
                    {ytSummary && <YouTubeMentionBadge summary={ytSummary} bareCode={ticker} size="xs" />}
                    {r.turnoverRank !== undefined && (
                      <span
                        className="text-[9px] font-mono text-amber-400/80 bg-amber-900/20 px-1 py-px rounded"
                        title="20日均成交額排名（全市場前500內）"
                      >
                        成交量第{r.turnoverRank}名
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Row 3: 條件 badges */}
              <div className="flex items-center gap-1 mb-1">
                {activeBuyMethod && activeBuyMethod !== 'A' ? (
                  // B/C/D/E/F/G/H/I：顯示策略觸發條件 + 跨策略命中徽章
                  (() => {
                    const rule = r.triggeredRules?.[0];
                    const methodColors: Record<string, string> = {
                      A: 'bg-amber-800/80 text-amber-200',
                      B: 'bg-sky-800/80 text-sky-300',
                      C: 'bg-emerald-800/80 text-emerald-300',
                      D: 'bg-purple-800/80 text-purple-300',
                      E: 'bg-orange-800/80 text-orange-300',
                      F: 'bg-rose-800/80 text-rose-300',
                      G: 'bg-cyan-800/80 text-cyan-300',
                      H: 'bg-fuchsia-800/80 text-fuchsia-300',
                      I: 'bg-lime-800/80 text-lime-300',
                      J: 'bg-cyan-800/80 text-cyan-300',
                      K: 'bg-lime-800/80 text-lime-300',
                      L: 'bg-fuchsia-800/80 text-fuchsia-300',
                      M: 'bg-teal-800/80 text-teal-300',
                      N: 'bg-indigo-800/80 text-indigo-300',
                      O: 'bg-blue-800/80 text-blue-300',
                      P: 'bg-pink-800/80 text-pink-300',
                      Q: 'bg-violet-800/80 text-violet-300',
                      R: 'bg-cyan-800/80 text-cyan-200',
                      W: 'bg-emerald-800/80 text-emerald-200',
                      X: 'bg-teal-800/80 text-teal-200',
                      Y: 'bg-amber-800/80 text-amber-200',
                    };
                    // 字母→名稱讀 lib/scanner/buyMethodTracks.ts 單一事實來源
                    const methodNames = LETTER_NAMES;
                    const color = methodColors[activeBuyMethod] ?? 'bg-sky-800/80 text-sky-300';
                    const others = dedupeCrossBadges(r.matchedMethods ?? [], activeBuyMethod);
                    // R 機械軌：用乖離率取代條件 badge（沒有 triggeredRule）
                    if (activeBuyMethod === 'R') {
                      const dev = r.ma20Deviation;
                      const devPct = dev != null ? (dev * 100).toFixed(2) : '—';
                      const devColor = dev == null
                        ? 'text-muted-foreground'
                        : dev >= 0 ? 'text-bear' : 'text-bull';
                      return (
                        <>
                          <span className={`text-[8px] px-1.5 h-3.5 flex items-center rounded-sm ${color}`}
                            title="機械軌（成交額前500 + MA20 乖離率）">
                            {methodNames.R}
                          </span>
                          <span className={`text-[10px] font-mono font-bold ml-1 ${devColor}`}
                            title="MA20 乖離率 = (close - MA20) / MA20">
                            乖離 {dev != null && dev >= 0 ? '+' : ''}{devPct}%
                          </span>
                        </>
                      );
                    }
                    // W 大戶偷買軌（refined）：主力分點 20 日集中度由負轉正 + 5 日濾隔日沖
                    if (activeBuyMethod === 'W') {
                      const conc20 = r.smartMoneyConc;
                      const conc5 = r.smartMoneyConc5;
                      return (
                        <>
                          <span className={`text-[8px] px-1.5 h-3.5 flex items-center rounded-sm ${color}`}
                            title="大戶偷買（主力分點20日集中度由負轉正 + 5日<8濾隔日沖 + 不爆量）">
                            {methodNames.W}
                          </span>
                          {conc20 != null && (
                            <span className="text-[10px] font-mono font-bold ml-1 text-emerald-400"
                              title="主力分點 20 日集中度（剛由負轉正，落在 1~5%）">
                              20日+{conc20.toFixed(1)}%
                            </span>
                          )}
                          {conc5 != null && (
                            <span className="text-[10px] font-mono font-bold ml-1 text-muted-foreground"
                              title="主力分點 5 日集中度（< 8 才非隔日沖假象）">
                              5日{conc5.toFixed(1)}%
                            </span>
                          )}
                        </>
                      );
                    }
                    // X 法人接刀軌：在跌/長黑 + 法人逆勢買（顯示法人買超 + 跌幅）
                    if (activeBuyMethod === 'X') {
                      const instK = r.instDipInstK;
                      const drop = r.instDipDrop;
                      return (
                        <>
                          <span className={`text-[8px] px-1.5 h-3.5 flex items-center rounded-sm ${color}`}
                            title="法人接刀（成交額前500 + 在跌/長黑 + 法人逆勢買，剔除大戶持股超高）">
                            {methodNames.X}
                          </span>
                          {drop != null && (() => {
                            const tc = r.instDipTodayChg;
                            const black = tc != null && tc < -3 && drop >= -3;   // 靠今日長黑入選（非在跌）
                            const val = black ? (tc as number) : drop;
                            return (
                              <span className={`text-[10px] font-mono font-bold ml-1 ${val >= 0 ? 'text-bull' : 'text-bear'}`}
                                title="進場理由：近5日在跌(負%) 或 今日長黑(收/開<-3%)入選">
                                {black ? '長黑' : '近5日'}{val >= 0 ? '+' : ''}{val.toFixed(1)}%
                              </span>
                            );
                          })()}
                          {instK != null && (
                            <span className="text-[10px] font-mono font-bold ml-1 text-emerald-400" title="法人 5 日淨買超(張)，逆勢承接">
                              法人+{instK.toLocaleString()}張
                            </span>
                          )}
                        </>
                      );
                    }
                    // Y 法人偷買(原)軌：跌 + 5日集中度在增加 + 法人連買（顯示集中度爬升 + 連買天數）
                    if (activeBuyMethod === 'Y') {
                      const conc5 = r.instStealConc5;
                      const conc5prev = r.instStealConc5Prev;
                      const consec = r.instStealConsec;
                      const drop = r.instStealDrop;
                      return (
                        <>
                          <span className={`text-[8px] px-1.5 h-3.5 flex items-center rounded-sm ${color}`}
                            title="大戶法人偷買：股價在跌 + 5日籌碼集中度在增加 + 法人連買（觀察用，回測無穩定超額）">
                            {methodNames.Y}
                          </span>
                          {r.disposalVeto && (
                            <span className="text-[9px] font-bold ml-1 px-1 rounded-sm bg-red-500/25 text-red-400"
                              title="處置股：分盤交易、跟漲停一樣常常買不到。只是觀察大戶在偷買誰，不是叫你買">
                              ⚠️處置
                            </span>
                          )}
                          {drop != null && (
                            <span className={`text-[10px] font-mono font-bold ml-1 ${drop >= 0 ? 'text-bull' : 'text-bear'}`} title="近5日漲跌%（負=在跌）">
                              近5日{drop >= 0 ? '+' : ''}{drop.toFixed(1)}%
                            </span>
                          )}
                          {conc5 != null && (
                            <span className="text-[10px] font-mono font-bold ml-1 text-emerald-400"
                              title="主力分點5日集中度（在爬：負→正/變大）">
                              集中{conc5prev != null ? `${conc5prev.toFixed(1)}→` : ''}{conc5.toFixed(1)}%
                            </span>
                          )}
                          {consec != null && consec > 0 && (
                            <span className="text-[10px] font-mono font-bold ml-1 text-muted-foreground" title="三大法人合計連續買超天數">
                              法人連買{consec}天
                            </span>
                          )}
                          {r.instStealVolumeWarn && (
                            <span className="text-[9px] font-bold ml-1 px-1 rounded-sm bg-amber-500/20 text-amber-400"
                              title="爆量：今日量≥2倍20日均量。可能是隔日沖/追高，不是慢慢吸籌，留意">
                              ⚠️爆量
                            </span>
                          )}
                          {r.instStealConcHighWarn && (
                            <span className="text-[9px] font-bold ml-1 px-1 rounded-sm bg-amber-500/20 text-amber-400"
                              title="集中度過高(>12%)：疑隔日沖鎖股，同漲停買不到、易被洗，留意">
                              ⚠️集中度高
                            </span>
                          )}
                        </>
                      );
                    }
                    return (
                      <>
                        <span className={`text-[8px] px-1.5 h-3.5 flex items-center rounded-sm max-w-[160px] truncate ${color}`}
                          title={rule?.ruleName ?? ''}>
                          {rule ? cleanMainBadgeName(rule.ruleName) : (methodNames[activeBuyMethod] ?? activeBuyMethod)}
                        </span>
                        {others.map(m => (
                          <span key={m}
                            className={`text-[8px] px-1 h-3.5 flex items-center rounded-sm font-bold ${methodColors[m] ?? 'bg-secondary/60 text-foreground/70'}`}
                            title={`同時命中：${methodNames[m] ?? m}`}>
                            {methodNames[m] ?? m}
                          </span>
                        ))}
                      </>
                    );
                  })()
                ) : (
                  // A（六條件）：六個條件格子 + 分數 + 跨策略命中徽章
                  (() => {
                    const methodColors: Record<string, string> = {
                      B: 'bg-sky-800/80 text-sky-300',
                      C: 'bg-emerald-800/80 text-emerald-300',
                      D: 'bg-purple-800/80 text-purple-300',
                      E: 'bg-orange-800/80 text-orange-300',
                      F: 'bg-rose-800/80 text-rose-300',
                      G: 'bg-cyan-800/80 text-cyan-300',
                      H: 'bg-fuchsia-800/80 text-fuchsia-300',
                      I: 'bg-lime-800/80 text-lime-300',
                      J: 'bg-cyan-800/80 text-cyan-300',
                      K: 'bg-lime-800/80 text-lime-300',
                      L: 'bg-fuchsia-800/80 text-fuchsia-300',
                      M: 'bg-teal-800/80 text-teal-300',
                      N: 'bg-indigo-800/80 text-indigo-300',
                      O: 'bg-blue-800/80 text-blue-300',
                      P: 'bg-pink-800/80 text-pink-300',
                      Q: 'bg-violet-800/80 text-violet-300',
                      R: 'bg-cyan-800/80 text-cyan-200',
                      W: 'bg-emerald-800/80 text-emerald-200',
                      X: 'bg-teal-800/80 text-teal-200',
                      Y: 'bg-amber-800/80 text-amber-200',
                    };
                    // 字母→名稱讀 lib/scanner/buyMethodTracks.ts 單一事實來源
                    const methodNames = LETTER_NAMES;
                    // A tab：所有命中策略都有資訊量（六條件 + 其他進場訊號），只去重 v11 alias
                    const seen = new Set<string>();
                    const others = (r.matchedMethods ?? [])
                      .filter(m => m !== 'A')
                      .filter(m => {
                        const canonical = V11_ALIAS_OF_V12[m] ?? m;
                        if (seen.has(canonical)) return false;
                        seen.add(canonical);
                        return true;
                      });
                    return (
                      <>
                        {[
                          { pass: r.sixConditionsBreakdown?.trend, label: '趨' },
                          { pass: r.sixConditionsBreakdown?.position, label: '位' },
                          { pass: r.sixConditionsBreakdown?.kbar, label: 'K' },
                          { pass: r.sixConditionsBreakdown?.ma, label: '均' },
                          { pass: r.sixConditionsBreakdown?.volume, label: '量' },
                          { pass: r.sixConditionsBreakdown?.indicator, label: '指' },
                        ].map(({ pass, label }) => (
                          <span key={label} className={`text-[8px] w-3.5 h-3.5 flex items-center justify-center rounded-sm ${pass ? 'bg-sky-800/80 text-sky-300' : 'bg-secondary/50 text-muted-foreground/60'}`}>{label}</span>
                        ))}
                        <span className="text-[9px] text-sky-400 ml-0.5">{r.sixConditionsScore}/6</span>
                        {/* 六條件 badge — 放在 cross-strategy badges 之間，與其他 tab 命中徽章一致 */}
                        <span className="text-[8px] px-1 h-3.5 flex items-center rounded-sm font-bold bg-amber-800/80 text-amber-200"
                          title={`六條件 ${r.sixConditionsScore}/6`}>
                          六條件
                        </span>
                        {others.map(m => (
                          <span key={m}
                            className={`text-[8px] px-1 h-3.5 flex items-center rounded-sm font-bold ${methodColors[m] ?? 'bg-secondary/60 text-foreground/70'}`}
                            title={`同時命中：${methodNames[m] ?? m}`}>
                            {methodNames[m] ?? m}
                          </span>
                        ))}
                      </>
                    );
                  })()
                )}

                {/* v12 警示徽章（議題 13/27/88）— 末升段/季線壓力/量分等級/KD 向下 */}
                {r.endPhaseFlag && (
                  <span
                    className="text-[8px] px-1 h-3.5 flex items-center rounded-sm bg-red-900/60 text-red-300 font-bold"
                    title="末升段警示：自最近翻多事件低點起漲漲幅 ≥ 100%（議題 13）">
                    末升段
                  </span>
                )}
                {r.seasonLineResistance != null && r.seasonLineResistance > 0 && (
                  <span
                    className="text-[8px] px-1 h-3.5 flex items-center rounded-sm bg-amber-900/50 text-amber-300"
                    title={`季線壓力 ${r.seasonLineResistance.toFixed(2)}：MA60 下彎且在股價上方（議題 27）`}>
                    季壓 {r.seasonLineResistance.toFixed(0)}
                  </span>
                )}
                {r.volumeLevel === 'climax' && (
                  <span
                    className="text-[8px] px-1 h-3.5 flex items-center rounded-sm bg-orange-900/60 text-orange-300 font-bold"
                    title="爆量警示：今日量 ≥ 5 日均量 × 2（議題 88）">
                    爆量
                  </span>
                )}
                {r.kdDecliningWarning && (
                  <span
                    className="text-[8px] px-1 h-3.5 flex items-center rounded-sm bg-rose-900/40 text-rose-300"
                    title="短線 20 守則 #9：KD 向下不買（議題 27）">
                    KD↓
                  </span>
                )}

                {/* v12 N 型態確認專用：型態名 + 達成率 + 目標價（議題 65）*/}
                {r.lockWatchPayload?.patternType && (() => {
                  const name = getPatternDisplayName(r.lockWatchPayload.patternType);
                  const rate = getLegacyBookAchievementRate(r.lockWatchPayload.patternType);
                  const target = r.lockWatchPayload.patternTargetPrice;
                  // 目標相對現價的距離 — 正 = 仍有上漲空間；負 = 已達/超過目標
                  const upsideNum = target ? ((target - r.price) / r.price * 100) : null;
                  const reached = upsideNum != null && upsideNum <= 0;
                  // 結構失效 / 已撤銷 → 整個 N 徽章降灰 + 加 ✗ 後綴
                  const stage = findLockWatch(r.symbol, 'N')?.currentStage;
                  const failed = stage === 'structure-broken' || stage === 'revoked';
                  const failReason = stage === 'structure-broken'
                    ? `已跌破頸線 ${r.lockWatchPayload.triggerPrice.toFixed(2)} ×0.97 = ${(r.lockWatchPayload.triggerPrice * 0.97).toFixed(2)}，型態結構失效`
                    : stage === 'revoked' ? '訊號已撤銷' : '';
                  const rateText = rate != null ? ` · 舊書達標率 ${rate}%` : '';
                  const baseTitle = reached
                    ? `N 型態：${name}${rateText} · 頸線 ${r.lockWatchPayload.triggerPrice.toFixed(2)} · 目標 ${target?.toFixed(2) ?? '?'}（已達標：現價超過目標 ${Math.abs(upsideNum!).toFixed(1)}%）`
                    : `N 型態：${name}${rateText} · 頸線 ${r.lockWatchPayload.triggerPrice.toFixed(2)} · 目標 ${target?.toFixed(2) ?? '?'}（距目標還有 ${upsideNum?.toFixed(1) ?? '?'}% 空間）`;
                  return (
                    <span
                      className={`text-[8px] px-1 h-3.5 flex items-center gap-0.5 rounded-sm font-bold ${
                        failed
                          ? 'bg-zinc-800/60 text-zinc-500 line-through'
                          : 'bg-indigo-900/60 text-indigo-200'
                      }`}
                      title={failed ? `${baseTitle}\n— ${failReason}` : baseTitle}>
                      {name}{rate != null && <span className="opacity-75 ml-0.5">舊書 {rate}%</span>}
                      {target != null && upsideNum != null && !failed && (
                        reached ? (
                          // 已達 / 超過目標 → 提示停利
                          <span className="ml-0.5 text-amber-300" title="目標已達，可考慮停利">
                            目標達標
                          </span>
                        ) : (
                          // 仍有空間 → 顯示目標價 + 距現價百分比
                          <span className="ml-0.5 text-emerald-300">
                            目標 {target.toFixed(0)} (+{upsideNum.toFixed(1)}%)
                          </span>
                        )
                      )}
                      {failed && (
                        <span className="ml-0.5 text-rose-400/80 no-underline" title={failReason}>
                          ✗ {stage === 'structure-broken' ? '結構失效' : '已撤銷'}
                        </span>
                      )}
                    </span>
                  );
                })()}

                {/* v12 F V 反轉觸發鎖定價（含結構失效 cross-ref ✗）*/}
                {r.lockWatchPayload?.triggerPrice && !r.lockWatchPayload.patternType && (() => {
                  const fStage = findLockWatch(r.symbol, 'F')?.currentStage;
                  const fFailed = fStage === 'structure-broken' || fStage === 'revoked';
                  const fReason = fStage === 'structure-broken'
                    ? `已跌破 V 底（變盤線 low），結構失效`
                    : fStage === 'revoked' ? '訊號已撤銷' : '';
                  return (
                    <span
                      className={`text-[8px] px-1 h-3.5 flex items-center gap-0.5 rounded-sm font-bold ${
                        fFailed
                          ? 'bg-zinc-800/60 text-zinc-500 line-through'
                          : 'bg-rose-900/60 text-rose-200'
                      }`}
                      title={fFailed
                        ? `F V 反轉鎖定價：${r.lockWatchPayload.triggerPrice.toFixed(2)}\n— ${fReason}`
                        : `F V 反轉鎖定價（觸發即進場參考）：${r.lockWatchPayload.triggerPrice.toFixed(2)}`
                      }>
                      🔒{r.lockWatchPayload.triggerPrice.toFixed(2)}
                      {fFailed && (
                        <span className="ml-0.5 text-rose-400/80 no-underline" title={fReason}>
                          ✗ {fStage === 'structure-broken' ? '結構失效' : '已撤銷'}
                        </span>
                      )}
                    </span>
                  );
                })()}

                {/* v12 Provisional 三天驗證（K/D 型態訊號用，議題 75）*/}
                {r.provisional && (() => {
                  // 動態計算「實際剩餘交易日」（議題 86 真正用交易日）
                  // 用 history 長度 + scan date 比 today：history 含 entry 那天就已經有 1 筆，
                  // 之後每個交易日 cron 會 push 1 筆 → length 直接代表已過交易日數
                  const history = r.provisional.history ?? [];
                  let actualRemaining = r.provisional.daysRemaining;
                  if (history.length > 0 && r.provisional.status === 'provisional') {
                    // history[0] 是 entry 日，所以已過交易日 = length - 1
                    const tradingDaysPassed = Math.max(0, history.length - 1);
                    actualRemaining = Math.max(0, 3 - tradingDaysPassed) as 0 | 1 | 2 | 3;
                  }
                  const effectiveStatus = actualRemaining === 0 && r.provisional.status === 'provisional' ? 'confirmed' : r.provisional.status;
                  return (
                    <span
                      className={`text-[8px] px-1 h-3.5 flex items-center rounded-sm font-bold ${
                        effectiveStatus === 'confirmed' ? 'bg-emerald-900/60 text-emerald-200' :
                        effectiveStatus === 'revoked' ? 'bg-rose-900/60 text-rose-200 line-through' :
                        'bg-amber-900/60 text-amber-200'
                      }`}
                      title={
                        effectiveStatus === 'confirmed' ? `已確認（停留 ≥3 天）` :
                        effectiveStatus === 'revoked' ? `已撤銷（close 跌破 ${r.provisional.triggerPrice.toFixed(2)}）` :
                        `三天驗證中（剩 ${actualRemaining} 天，鎖定價 ${r.provisional.triggerPrice.toFixed(2)}）`
                      }>
                      {effectiveStatus === 'confirmed' ? '✓ 確認' :
                       effectiveStatus === 'revoked' ? '✗ 撤銷' :
                       `⏳ ${actualRemaining}天`}
                      {r.provisional.revocationCount >= 2 && (
                        <span className="ml-0.5 text-orange-400">!</span>
                      )}
                    </span>
                  );
                })()}

                {/* Action buttons */}
                <div className="ml-auto flex items-center gap-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectStock?.({ symbol: r.symbol, name: r.name, market: market as 'TW' | 'CN' });
                    }}
                    className="text-[9px] text-sky-400 hover:text-sky-300 px-1 py-0.5 rounded border border-sky-700/50 hover:bg-sky-900/30">
                    走圖
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      useWatchlistStore.getState().add(r.symbol, r.name, r.price);
                    }}
                    className="text-[9px] text-amber-400 hover:text-amber-300 px-1 py-0.5 rounded border border-amber-700/50 hover:bg-amber-900/30">
                    {useWatchlistStore.getState().has(r.symbol) ? '✓' : '+'}
                  </button>
                </div>
              </div>

              {/* Row 4: Compact forward performance */}
              <ForwardPerfRow performance={perf} isFetching={isFetchingForward} />
            </div>

            {/* Expanded details */}
            {isExpanded && (
              <div className="rounded-lg border border-sky-700/30 bg-card/80 px-2.5 py-2 space-y-2 text-[10px]">
                {/* 符合策略原因 — 按 matchedMethods 順序列出每個命中策略的命中原因 */}
                {(() => {
                  const blocks = buildAllStrategyReasons(r, activeBuyMethod);
                  if (blocks.length === 0) return null;
                  const toneClass = (tone?: StrategyReasonRow['tone']) =>
                    tone === 'good' ? 'text-emerald-300' :
                    tone === 'bad'  ? 'text-rose-300' :
                    tone === 'warn' ? 'text-amber-300' :
                                      'text-foreground/80';
                  return (
                    <div>
                      <div className="text-muted-foreground font-medium mb-1">符合策略原因</div>
                      <div className="space-y-1.5">
                        {blocks.map((block) => (
                          <div key={block.method} className="rounded border border-border/40 bg-secondary/30 px-2 py-1.5">
                            <div className="flex items-center gap-1.5 mb-0.5">
                              <span className="text-[9px] font-mono px-1 rounded bg-sky-900/60 text-sky-200">{block.method}</span>
                              <span className="text-[10px] text-foreground/90 font-medium">{block.title}</span>
                              {block.summary && (
                                <span className="text-[9px] text-sky-400">{block.summary}</span>
                              )}
                            </div>
                            <div className="space-y-0.5 text-[9px]">
                              {block.rows.map((row, i) => (
                                <div key={i} className="flex items-start gap-1.5">
                                  {row.pass !== undefined ? (
                                    <span className={row.pass ? 'text-green-400' : 'text-red-400'}>
                                      {row.pass ? '✅' : '❌'}
                                    </span>
                                  ) : (
                                    <span className="text-muted-foreground/50">·</span>
                                  )}
                                  {row.label && (
                                    <span className="text-muted-foreground font-medium shrink-0">{row.label}</span>
                                  )}
                                  <span className={toneClass(row.tone)}>{row.text}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
                {/* 33 種贏家圖像（寶典 Part 12） */}
                {((r.winnerBullishPatterns ?? []).length > 0 || (r.winnerBearishPatterns ?? []).length > 0) && (
                  <div>
                    {(r.winnerBullishPatterns ?? []).length > 0 && (
                      <div className="mb-0.5">
                        <span className="text-blue-400 font-medium">🎯 贏家圖像（空轉多）：</span>
                        <span className="text-blue-300/80 text-[9px]">{r.winnerBullishPatterns!.join('、')}</span>
                      </div>
                    )}
                    {(r.winnerBearishPatterns ?? []).length > 0 && (
                      <div>
                        <span className="text-purple-400 font-medium">⛔ 贏家圖像（多轉空）：</span>
                        <span className="text-purple-300/80 text-[9px]">{r.winnerBearishPatterns!.join('、')}</span>
                      </div>
                    )}
                  </div>
                )}
                {/* Elimination reasons */}
                {r.eliminationReasons && r.eliminationReasons.length > 0 && (
                  <div>
                    <div className="text-amber-400 font-medium mb-0.5">淘汰法警告</div>
                    {r.eliminationReasons.map((reason, i) => (
                      <div key={i} className="text-[9px] text-amber-300/80">⚠ {reason}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
