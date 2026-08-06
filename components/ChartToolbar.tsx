'use client';

import type { Candle } from '@/types';
import type { TrendState } from '@/lib/analysis/trendAnalysis';
import { MarketTrendBadge } from './MarketTrendBadge';

interface MaToggles { ma5: boolean; ma10: boolean; ma20: boolean; ma60: boolean; ma120: boolean; ma240: boolean }
interface Indicators {
  macd: boolean; kd: boolean; volume: boolean; rsi: boolean;
  /** 外資買賣超副圖 */
  foreign?: boolean;
  /** 投信買賣超副圖 */
  trust?: boolean;
  /** 自營商買賣超副圖 */
  dealer?: boolean;
  /** 散戶買賣超推算副圖 */
  retail?: boolean;
  /** 大戶持股 400張↑ 副圖 */
  h400?: boolean;
  /** 大戶持股 1000張↑ 副圖 */
  h1000?: boolean;
  /** CN 主力資金（超大單+大單） */
  cnMain?: boolean;
  /** CN 散戶資金（中單+小單） */
  cnRetail?: boolean;
  /** 三色資金「主力狀態F」副圖 — CN + TW（台股走 /api/tw-sanse） */
  mainForce?: boolean;
  /** 三色資金「捕撈季節」副圖 — CN + TW（台股無換手率，不畫 4 級彩柱） */
  season?: boolean;
}

/**
 * 指標套組（一鍵切換 tab）：
 * - technical 技術面：MA5/10/20/60 ＋ 量 ＋ KD ＋ MACD ＋ 頭底（朱書標準看盤）
 * - sanse 三色資金：雙B ＋ 主力狀態 ＋ 捕撈季節（自創資金指標；雙B 疊主圖、其餘副圖）
 * - chip 籌碼面：價＋均線主圖不變，副圖全換成法人四（TW 外資/投信/自營/散戶）或主力/散戶（CN）
 * 三者「副圖」互斥：切到任一套組就把另外兩組的副圖全關（量/KD/MACD ⇄ 主力狀態/捕撈季節 ⇄ 籌碼）。
 * 切線/形態 overlay、大戶持股趨勢線、訊號 markers 不受套組切換影響。
 */
export type ChartIndicatorPreset = 'technical' | 'sanse' | 'chip';

interface ChartToolbarProps {
  candle: Candle;
  prevCandle?: Candle | null;
  isHover: boolean;
  stockName?: string;
  trend?: TrendState | null;
  /** 當前 timeframe（'1m'|'5m'|'15m'|'30m'|'60m'|'1d'|'1wk'|'1mo'） */
  currentInterval?: string;
  /** 切換 timeframe（呼叫端通常 reload 走圖） */
  onIntervalChange?: (interval: string) => void;
  maToggles: MaToggles;
  onMaToggle: (key: keyof MaToggles) => void;
  showBollinger: boolean;
  onBollingerToggle: () => void;
  /** 楊雲翔特殊EMA濾網疊圖：EMA23 ＋ ±1%/±3% 帶 ＋ EMA60（純視覺疊主圖）*/
  showYangEma?: boolean;
  onYangEmaToggle?: () => void;
  /** 雙B戰法主圖疊加（陸股自創；像 BB 一樣疊在 K 線主圖上）*/
  showShuangB?: boolean;
  onShuangBToggle?: () => void;
  /** 大戶持股趨勢線（千張大戶%）疊主圖 — 僅 TW；純格局參考、不發訊號 */
  showHolderLine?: boolean;
  onHolderLineToggle?: () => void;
  indicators: Indicators;
  onIndicatorToggle: (key: keyof Indicators) => void;
  /** 「籌碼」合併鈕：一鍵開關法人四（TW 外資/投信/自營/散戶）或主力/散戶（CN）；next=目標開關狀態 */
  onChipGroupToggle?: (next: boolean) => void;
  /** 一鍵切換指標套組（技術面 / 三色資金）；不提供則不顯示套組 tab */
  onApplyPreset?: (preset: ChartIndicatorPreset) => void;
  showMarkers: boolean;
  onMarkersToggle: () => void;
  signalStrengthMin: number;
  onSignalStrengthChange: (v: number) => void;
  showPivots?: boolean;
  onPivotsToggle?: () => void;
  showSupportResistance?: boolean;
  onSupportResistanceToggle?: () => void;
  /** K 棒三層支撐/壓力標線（最近長紅/長黑：最高=最強、1/2=平均成本、最低=最弱）*/
  showCandleSR?: boolean;
  onCandleSRToggle?: () => void;
  showNeckline?: boolean;
  onNecklineToggle?: () => void;
  showPattern?: boolean;
  onPatternToggle?: () => void;
  // 上升線 = 上升切線 + 上升軌道整合；下降線 = 下降切線 + 下跌軌道整合
  showAscendingLine?: boolean;
  onAscendingLineToggle?: () => void;
  showDescendingLine?: boolean;
  onDescendingLineToggle?: () => void;
  showConsolidationLines?: boolean;
  onConsolidationLinesToggle?: () => void;
  avgCost?: number;
  shares?: number;
  onPrev?: () => void;
  onNext?: () => void;
  onReset?: () => void;
  canPrev?: boolean;
  canNext?: boolean;
  onPrevBuyPoint?: () => void;
  onNextBuyPoint?: () => void;
  canPrevBuyPoint?: boolean;
  canNextBuyPoint?: boolean;
  /** 股票代碼，用於判斷市場（.TW/.TWO=台股，量顯示為張） */
  ticker?: string;
  /** 大盤趨勢徽章 — 顯示在個股「趨勢」旁邊 */
  market?: 'TW' | 'CN';
  scanDate?: string | null;
}

const MA_CONFIGS: Array<{ key: keyof MaToggles; label: string; title: string; locked?: boolean }> = [
  { key: 'ma5',   label: 'MA5',   title: '顯示/隱藏 5 日線' },
  { key: 'ma10',  label: 'MA10',  title: '顯示/隱藏 10 日線' },
  // 月線（20MA）是做多核心過濾、回檔最後防線（書本 CH3-03）→ 預設打開，但使用者可手動關
  { key: 'ma20',  label: 'MA20',  title: '顯示/隱藏月線（20MA）— 做多核心過濾、回檔最後防線' },
  { key: 'ma60',  label: 'MA60',  title: '顯示/隱藏 60 日線（季線）' },
  { key: 'ma120', label: 'MA120', title: '顯示/隱藏 120 日線（半年線）' },
  { key: 'ma240', label: 'MA240', title: '顯示/隱藏 240 日線（年線）— 整年買盤平均成本' },
];

const INTERVAL_CONFIGS: Array<{ key: string; label: string; title: string }> = [
  { key: '1m',  label: '1分', title: '1 分 K（盤中即時，看主力動向）' },
  { key: '5m',  label: '5分', title: '5 分 K（看買賣點、爆量長黑/末升段拉高出貨）' },
  { key: '15m', label: '15分', title: '15 分 K' },
  { key: '30m', label: '30分', title: '30 分 K' },
  { key: '60m', label: '60分', title: '60 分 K（1 小時 K）' },
  { key: '1d',  label: '日', title: '日 K（朱書主戰場：選股、進出場、紀律）' },
  { key: '1wk', label: '週', title: '週 K（多周期共振 MTF 過濾）' },
  { key: '1mo', label: '月', title: '月 K（中長線多空趨勢）' },
];

/** 技術面核心副圖（量/KD/MACD）— 獨立開關，可與套組 tab 混搭 */
const INDICATOR_CONFIGS = [
  { key: 'volume' as const, label: '量', title: '成交量副圖' },
  { key: 'kd' as const, label: 'KD', title: 'KD 隨機指標副圖（9,3,3）' },
  { key: 'macd' as const, label: 'MACD', title: 'MACD 副圖（12,26,9）' },
];

/** 籌碼面「法人四」(TW) — 合併成單一「籌碼」鈕一次開關（外資/投信/自營/散戶） */
const CHIP_GROUP_KEYS_TW = ['foreign', 'trust', 'dealer', 'retail'] as const;
/** 籌碼面 (CN) — 主力/散戶資金，合併成「籌碼」鈕 */
const CHIP_GROUP_KEYS_CN = ['cnMain', 'cnRetail'] as const;

/** 大戶持股副圖（TW only）— 維持獨立鈕（不在「籌碼」合併鈕內） */
const CHIP_HOLDER_CONFIGS_TW = [
  { key: 'h400' as const, label: '大戶400張', title: '大戶持股 400 張↑ 比例（TDCC 集保戶股權分散，每週四公布）' },
  { key: 'h1000' as const, label: '大戶1000張', title: '大戶持股 1000 張↑ 比例（TDCC 集保戶股權分散，每週四公布）' },
];

/** 由當前 toggle 狀態反推目前套在哪個套組（兩者皆不符＝自訂混搭，回 null 不高亮） */
function activeChartPreset(
  ma: MaToggles, showBollinger: boolean, showShuangB: boolean,
  ind: Indicators, showPivots: boolean,
): ChartIndicatorPreset | null {
  const anyChipSub = !!(ind.foreign || ind.trust || ind.dealer || ind.retail || ind.cnMain || ind.cnRetail);
  const anyTechSub = !!(ind.volume || ind.kd || ind.rsi || ind.macd);
  const anySanseSub = !!(ind.mainForce || ind.season);
  // 籌碼套組：有籌碼副圖、且技術/三色副圖全關（主圖均線維持技術設定，不納入判定）
  if (anyChipSub && !anyTechSub && !anySanseSub) return 'chip';
  if (
    ma.ma5 && ma.ma10 && ma.ma20 && ma.ma60 && !ma.ma120 && !ma.ma240 &&
    !showBollinger && !showShuangB &&
    ind.volume && ind.kd && !ind.rsi && ind.macd &&
    !ind.mainForce && !ind.season && showPivots
  ) return 'technical';
  // 三色套組：均線全清空讓出主圖給雙B（與 applyChartPreset('sanse') 一致；20MA 也關）
  if (
    !ma.ma5 && !ma.ma10 && !ma.ma20 && !ma.ma60 && !ma.ma120 && !ma.ma240 &&
    !showBollinger && showShuangB &&
    !ind.volume && !ind.kd && !ind.rsi && !ind.macd &&
    ind.mainForce && ind.season && !showPivots
  ) return 'sanse';
  return null;
}

export default function ChartToolbar({
  candle, prevCandle, isHover, stockName, trend,
  currentInterval, onIntervalChange,
  maToggles, onMaToggle,
  showBollinger, onBollingerToggle,
  showYangEma = false, onYangEmaToggle,
  showShuangB = false,
  showHolderLine = false, onHolderLineToggle,
  indicators, onIndicatorToggle,
  onChipGroupToggle,
  onApplyPreset,
  showMarkers, onMarkersToggle,
  signalStrengthMin, onSignalStrengthChange,
  showPivots = false, onPivotsToggle,
  showSupportResistance = false, onSupportResistanceToggle,
  showCandleSR = false, onCandleSRToggle,
  showNeckline = false, onNecklineToggle,
  showPattern = false, onPatternToggle,
  showAscendingLine = false, onAscendingLineToggle,
  showDescendingLine = false, onDescendingLineToggle,
  showConsolidationLines = false, onConsolidationLinesToggle,
  avgCost, shares,
  onPrev, onNext, onReset,
  canPrev = true, canNext = true,
  onPrevBuyPoint, onNextBuyPoint,
  canPrevBuyPoint = true, canNextBuyPoint = true,
  ticker,
  market, scanDate,
}: ChartToolbarProps) {
  const chg = prevCandle ? candle.close - prevCandle.close : 0;
  const chgPct = prevCandle ? (chg / prevCandle.close) * 100 : 0;
  const isUp = chg >= 0;
  // TW 判定：有 .TW/.TWO 後綴，或純 4-6 位數字（裸代碼 2330/3661 等）
  // TW: .TW/.TWO 後綴或 4-5 位數字（裸代碼）；CN: .SS/.SZ 或 6 位數字
  const isTW = ticker ? (/\.(TW|TWO)$/i.test(ticker) || /^\d{4,5}$/.test(ticker)) : false;
  const isCN = ticker ? (/\.(SS|SZ)$/i.test(ticker) || /^\d{6}$/.test(ticker)) : false;
  // 台股指數（^TWII / ^TWOII）：三色套組 tab + 主力/捕撈獨立開關比照台股顯示；
  // 不併進 isTW，避免動到量(張)標籤、籌碼/大戶副圖判斷。CN 指數 000001.SS 已由 isCN(.SS) 涵蓋。
  const isTwIndex = ticker ? /^\^TW/i.test(ticker) : false;
  // 指標套組 tab 目前選中誰（從 toggle 反推；僅在三色可用市場 TW/CN 才顯示）
  const activePreset = activeChartPreset(maToggles, showBollinger, showShuangB, indicators, showPivots);
  // 「籌碼」合併鈕亮燈狀態：該市場的法人/主力散戶副圖任一開啟即亮
  const chipGroupKeys = isTW ? CHIP_GROUP_KEYS_TW : isCN ? CHIP_GROUP_KEYS_CN : [];
  const chipGroupOn = chipGroupKeys.some(k => !!indicators[k]);

  const unrealizedPct = shares && shares > 0 && avgCost && avgCost > 0
    ? ((candle.close - avgCost) / avgCost) * 100
    : null;

  return (
    <div className="shrink-0 border-b border-border">
      {/* Row 1: Stock info — name, date, price, change, OHLCV（不換行，開高低量永遠同一排）*/}
      <div className="flex flex-nowrap items-center gap-x-1.5 px-3 py-1.5 font-mono min-w-0 overflow-x-auto">
        {stockName && (
          <span className="text-sm text-foreground font-bold font-sans shrink-0">{stockName}</span>
        )}
        <span className={`text-xs shrink-0 ${isHover ? 'text-blue-400' : 'text-muted-foreground'}`}>{candle.date}</span>
        <span className={`text-lg font-bold tabular-nums shrink-0 ${isUp ? 'text-bull' : 'text-bear'}`}>
          {candle.close.toFixed(2)}
        </span>
        <span className={`text-xs font-bold px-1.5 py-0.5 rounded shrink-0 ${isUp ? 'bg-bull/20 text-bull' : 'bg-bear/20 text-bear'}`}>
          {isUp ? '▲' : '▼'}{Math.abs(chg).toFixed(2)} ({Math.abs(chgPct).toFixed(2)}%)
        </span>
        {trend && (
          <span
            title={`趨勢：${trend}（朱書定義，看均線排列與底底高/底底低，非當日漲跌）｜多頭＝可選股做多｜盤整＝謹慎、優先觀望｜空頭＝禁止做多`}
            className={`text-[11px] font-bold px-1.5 py-0.5 rounded shrink-0 cursor-help ${
              trend === '多頭' ? 'bg-emerald-900/50 text-emerald-300' :
              trend === '空頭' ? 'bg-red-900/50 text-red-300' :
              'bg-amber-900/30 text-amber-400'
            }`}>
            趨勢：{trend === '多頭' ? '▲' : trend === '空頭' ? '▼' : '↔'} {trend}
          </span>
        )}
        {market && <MarketTrendBadge market={market} scanDate={scanDate ?? null} />}
        <div className="flex items-center gap-x-2 text-[11px] shrink-0">
          <span className="text-muted-foreground/70">開<span className="text-foreground/90 ml-0.5 tabular-nums">{candle.open.toFixed(2)}</span></span>
          <span className="text-muted-foreground/70">高<span className="text-bull ml-0.5 tabular-nums">{candle.high.toFixed(2)}</span></span>
          <span className="text-muted-foreground/70">低<span className="text-bear ml-0.5 tabular-nums">{candle.low.toFixed(2)}</span></span>
          <span className="text-muted-foreground/70">量{isTW ? '(張)' : isCN ? '(手)' : ''}<span className="text-foreground/70 ml-0.5 tabular-nums">{(isCN ? Math.round(candle.volume / 100) : candle.volume).toLocaleString()}</span></span>
        </div>
        {unrealizedPct !== null && (
          <span className="ml-auto flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">
              均價<span className="text-yellow-400 font-bold ml-0.5 tabular-nums">{avgCost!.toFixed(2)}</span>
            </span>
            <span className={`font-bold ${unrealizedPct >= 0 ? 'text-bull' : 'text-bear'}`}>
              {unrealizedPct >= 0 ? '+' : ''}{unrealizedPct.toFixed(2)}%
            </span>
          </span>
        )}
      </div>

      {/* Row 2: Controls — timeframe pills, MA toggles, BB, indicators, signals, nav */}
      <div className="flex flex-wrap items-center gap-1 px-3 py-1 bg-secondary/30">
        {onApplyPreset && (isCN || isTW || isTwIndex) && (
          <>
            <div
              role="group"
              aria-label="指標套組一鍵切換"
              className="flex items-center rounded-md ring-1 ring-border/70 overflow-hidden shrink-0"
            >
              <button
                onClick={() => onApplyPreset('technical')}
                aria-pressed={activePreset === 'technical'}
                className={`px-2 py-0.5 text-[10px] font-bold transition ${
                  activePreset === 'technical'
                    ? 'bg-sky-600 text-white'
                    : 'bg-secondary text-muted-foreground/60 hover:text-muted-foreground'
                }`}
                title="技術面套組：MA5/10/20/60 ＋ 量 ＋ KD ＋ MACD ＋ 頭底（朱書標準看盤）"
              >技術</button>
              <button
                onClick={() => onApplyPreset('sanse')}
                aria-pressed={activePreset === 'sanse'}
                className={`px-2 py-0.5 text-[10px] font-bold border-l border-border/70 transition ${
                  activePreset === 'sanse'
                    ? 'bg-fuchsia-600 text-white'
                    : 'bg-secondary text-muted-foreground/60 hover:text-muted-foreground'
                }`}
                title="三色資金套組：雙B ＋ 主力狀態 ＋ 捕撈季節（自創資金指標）"
              >三色</button>
              <button
                onClick={() => onApplyPreset('chip')}
                aria-pressed={activePreset === 'chip'}
                className={`px-2 py-0.5 text-[10px] font-bold border-l border-border/70 transition ${
                  activePreset === 'chip'
                    ? 'bg-amber-600 text-white'
                    : 'bg-secondary text-muted-foreground/60 hover:text-muted-foreground'
                }`}
                title={isTW
                  ? '籌碼面套組：外資／投信／自營／散戶買賣超副圖（量/KD/MACD 與三色副圖全關）'
                  : '籌碼面套組：主力／散戶資金副圖（量/KD/MACD 與三色副圖全關）'}
              >籌碼</button>
            </div>
            <span className="w-px h-3.5 bg-border/60 mx-0.5" />
          </>
        )}
        {onIntervalChange && (
          <>
            {INTERVAL_CONFIGS.map(({ key, label, title }) => (
              <button
                key={key}
                onClick={() => onIntervalChange(key)}
                aria-pressed={currentInterval === key}
                aria-label={`切換到 ${title}`}
                className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
                  currentInterval === key
                    ? 'bg-violet-700/70 text-violet-100 ring-1 ring-violet-400/40'
                    : 'bg-secondary text-muted-foreground/50 hover:text-muted-foreground'
                }`}
                title={title}
              >{label}</button>
            ))}
            <span className="w-px h-3.5 bg-border/60 mx-0.5" />
          </>
        )}
        {MA_CONFIGS.map(({ key, label, title, locked }) => (
          <button key={key}
            onClick={locked ? undefined : () => onMaToggle(key)}
            disabled={locked}
            aria-pressed={maToggles[key]}
            aria-label={locked ? `${label}（固定顯示，不可關閉）` : `${maToggles[key] ? '隱藏' : '顯示'} ${label}`}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
              locked
                ? 'bg-sky-700/60 text-sky-200 ring-1 ring-sky-400/40 cursor-default'
                : maToggles[key] ? 'bg-sky-700/60 text-sky-200' : 'bg-secondary text-muted-foreground/50 hover:text-muted-foreground'
            }`}
            title={title}
          >{label}</button>
        ))}
        <span className="w-px h-3.5 bg-border/60 mx-0.5" />
        <button
          onClick={onBollingerToggle}
          aria-pressed={showBollinger}
          aria-label={`${showBollinger ? '隱藏' : '顯示'}布林通道`}
          className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
            showBollinger ? 'bg-emerald-700/60 text-emerald-200' : 'bg-secondary text-muted-foreground/50 hover:text-muted-foreground'
          }`}
          title="布林通道 (20, 2)"
        >BB</button>
        {onYangEmaToggle && (
          <button
            onClick={onYangEmaToggle}
            aria-pressed={showYangEma}
            aria-label={`${showYangEma ? '隱藏' : '顯示'}楊氏EMA濾網`}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
              showYangEma ? 'bg-amber-700/60 text-amber-200' : 'bg-secondary text-muted-foreground/50 hover:text-muted-foreground'
            }`}
            title="楊雲翔特殊EMA濾網：EMA23 ＋ ±1%/±3% 濾網帶 ＋ EMA60 大方向線（純視覺疊圖，不發訊號）"
          >楊EMA</button>
        )}
        {INDICATOR_CONFIGS.map(({ key, label, title }) => (
          <button key={key}
            onClick={() => onIndicatorToggle(key)}
            aria-pressed={!!indicators[key]}
            aria-label={`${indicators[key] ? '隱藏' : '顯示'} ${label} 副圖`}
            title={title}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
              indicators[key] ? 'bg-sky-700/60 text-sky-200' : 'bg-secondary text-muted-foreground/50 hover:text-muted-foreground'
            }`}
          >{label}</button>
        ))}
        {isTW && onHolderLineToggle && (
          <button
            onClick={onHolderLineToggle}
            aria-pressed={showHolderLine}
            aria-label={`${showHolderLine ? '隱藏' : '顯示'}千張大戶持股趨勢線`}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
              showHolderLine ? 'bg-pink-700/60 text-pink-200' : 'bg-secondary text-muted-foreground/50 hover:text-muted-foreground'
            }`}
            title="千張大戶持股趨勢線（集保）— 淡淡一條疊主圖看格局強弱；純參考、不發訊號（回測無預測力）"
          >大戶</button>
        )}
        {(isTW || isCN || isTwIndex) && (
          <>
            <span className="w-px h-3.5 bg-border/60 mx-0.5" />
            {/* 三色資金副圖：主力狀態 / 捕撈季節（獨立開關，可與套組/籌碼混搭）*/}
            {(['mainForce', 'season'] as const).map(key => (
              <button key={key}
                onClick={() => onIndicatorToggle(key)}
                aria-pressed={!!indicators[key]}
                aria-label={`${indicators[key] ? '隱藏' : '顯示'} ${key === 'mainForce' ? '主力狀態' : '捕撈季節'} 副圖`}
                title={key === 'mainForce'
                  ? '主力狀態F（三色資金）副圖：中線主力/控盤/短線游資/超跌五色柱'
                  : '捕撈季節（三色資金）副圖：XYS 動能柱 + 快慢線 + 金叉死叉'}
                className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
                  indicators[key] ? 'bg-fuchsia-700/60 text-fuchsia-200' : 'bg-secondary text-muted-foreground/50 hover:text-muted-foreground'
                }`}
              >{key === 'mainForce' ? '主力狀態' : '捕撈季節'}</button>
            ))}
            {/* 「籌碼」合併鈕：一鍵開該市場法人/主力散戶副圖（與套組籌碼鈕功能相同但不互斥清場，故套組存在時也顯示）*/}
            {onChipGroupToggle && (
              <button
                onClick={() => onChipGroupToggle(!chipGroupOn)}
                aria-pressed={chipGroupOn}
                aria-label={`${chipGroupOn ? '隱藏' : '顯示'}籌碼面副圖`}
                title={isTW
                  ? '籌碼面：一鍵開外資／投信／自營／散戶買賣超副圖'
                  : '籌碼面：一鍵開主力／散戶資金副圖'}
                className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
                  chipGroupOn ? 'bg-amber-700/60 text-amber-200' : 'bg-secondary text-muted-foreground/50 hover:text-muted-foreground'
                }`}
              >籌碼</button>
            )}
            {isTW && CHIP_HOLDER_CONFIGS_TW.map(({ key, label, title }) => (
              <button key={key}
                onClick={() => onIndicatorToggle(key)}
                aria-pressed={!!indicators[key]}
                aria-label={`${indicators[key] ? '隱藏' : '顯示'} ${label} 副圖`}
                title={title}
                className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
                  indicators[key] ? 'bg-amber-700/60 text-amber-200' : 'bg-secondary text-muted-foreground/50 hover:text-muted-foreground'
                }`}
              >{label}</button>
            ))}
          </>
        )}
        <span className="w-px h-3.5 bg-border/60 mx-0.5" />
        {onPivotsToggle && (
          <button
            onClick={onPivotsToggle}
            aria-pressed={showPivots}
            aria-label={`${showPivots ? '隱藏' : '顯示'}頭底標記`}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
              showPivots ? 'bg-pink-600/60 text-pink-100' : 'bg-secondary text-muted-foreground/50 hover:text-muted-foreground'
            }`}
            title="找買賣轉折點（高低點）— 朱書「波段轉折」就是這條"
          >頭底</button>
        )}
        {onSupportResistanceToggle && (
          <button
            onClick={onSupportResistanceToggle}
            aria-pressed={showSupportResistance}
            aria-label={`${showSupportResistance ? '隱藏' : '顯示'}壓力支撐線`}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
              showSupportResistance ? 'bg-amber-600/60 text-amber-100' : 'bg-secondary text-muted-foreground/50 hover:text-muted-foreground'
            }`}
            title="找壓力與支撐線（突破壓力買、跌破支撐賣）"
          >壓撐</button>
        )}
        {onCandleSRToggle && (
          <button
            onClick={onCandleSRToggle}
            aria-pressed={showCandleSR}
            aria-label={`${showCandleSR ? '隱藏' : '顯示'}K棒三層支撐壓力`}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
              showCandleSR ? 'bg-amber-600/60 text-amber-100' : 'bg-secondary text-muted-foreground/50 hover:text-muted-foreground'
            }`}
            title="K 棒三層支撐/壓力（最近長紅/長黑：最高=最強、½=平均成本、最低=最弱）｜書本 CH2-04 階梯式出場框架"
          >三層撐壓</button>
        )}
        {onNecklineToggle && (
          <button
            onClick={onNecklineToggle}
            aria-pressed={showNeckline}
            aria-label={`${showNeckline ? '隱藏' : '顯示'}形態頸線`}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
              showNeckline ? 'bg-cyan-600/60 text-cyan-100' : 'bg-secondary text-muted-foreground/50 hover:text-muted-foreground'
            }`}
            title="型態頸線 + 預估目標價 + 結構失效價（破了就無效）"
          >頸線</button>
        )}
        {onPatternToggle && (
          <button
            onClick={onPatternToggle}
            aria-pressed={showPattern}
            aria-label={`${showPattern ? '隱藏' : '顯示'}形態關鍵點`}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
              showPattern ? 'bg-fuchsia-600/60 text-fuchsia-100' : 'bg-secondary text-muted-foreground/50 hover:text-muted-foreground'
            }`}
            title="型態關鍵點（紫色圈圈是系統判斷型態的依據點）"
          >形態</button>
        )}
        {onAscendingLineToggle && (
          <button
            onClick={onAscendingLineToggle}
            aria-pressed={showAscendingLine}
            aria-label={`${showAscendingLine ? '隱藏' : '顯示'}上升線`}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
              showAscendingLine ? 'bg-red-600/60 text-red-100' : 'bg-secondary text-muted-foreground/50 hover:text-muted-foreground'
            }`}
            title="上升線（上升切線連最近兩底 + 平行上升軌道壓力位）｜書本《抓住飆股》p.205"
          >上升線</button>
        )}
        {onDescendingLineToggle && (
          <button
            onClick={onDescendingLineToggle}
            aria-pressed={showDescendingLine}
            aria-label={`${showDescendingLine ? '隱藏' : '顯示'}下降線`}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
              showDescendingLine ? 'bg-emerald-600/60 text-emerald-100' : 'bg-secondary text-muted-foreground/50 hover:text-muted-foreground'
            }`}
            title="下降線（下降切線連最近兩頭 + 平行下跌軌道支撐位）｜書本《抓住飆股》p.205"
          >下降線</button>
        )}
        {onConsolidationLinesToggle && (
          <button
            onClick={onConsolidationLinesToggle}
            aria-pressed={showConsolidationLines}
            aria-label={`${showConsolidationLines ? '隱藏' : '顯示'}盤整切線`}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
              showConsolidationLines ? 'bg-amber-600/60 text-amber-100' : 'bg-secondary text-muted-foreground/50 hover:text-muted-foreground'
            }`}
            title="盤整箱型上下緣（突破上緣買、跌破下緣賣）｜書本《活用技術分析寶典》p.352"
          >盤整切線</button>
        )}
        <button
          onClick={onMarkersToggle}
          aria-pressed={showMarkers}
          aria-label={`${showMarkers ? '隱藏' : '顯示'}買賣訊號標記`}
          className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
            showMarkers ? 'bg-blue-600/60 text-blue-200' : 'bg-secondary text-muted-foreground/50 hover:text-muted-foreground'
          }`}
          title="買賣訊號標記：綠色上箭頭＝買、紅色下箭頭＝賣，箭頭越大代表共振越強；訊號密集時自動隱藏重複文字，避免遮住 K 棒"
        >訊號</button>
        {showMarkers && (
          <select
            value={signalStrengthMin}
            onChange={e => onSignalStrengthChange(Number(e.target.value))}
            aria-label="信號共振強度過濾"
            className="px-1 py-0.5 rounded text-[10px] font-medium bg-secondary text-foreground/80 border border-border outline-none"
            title="信號共振強度過濾"
          >
            <option value={1}>全部</option>
            <option value={2}>共振≥2</option>
            <option value={3}>強≥3</option>
          </select>
        )}
        {onPrev && onNext && (
          <>
            <span className="w-px h-3.5 bg-border/60 mx-0.5" />
            {onPrevBuyPoint && (
              <button onClick={onPrevBuyPoint} disabled={!canPrevBuyPoint} title="上一個買點 (Shift+←)"
                className="px-1.5 py-0.5 rounded text-[10px] font-bold transition bg-emerald-700/60 hover:bg-emerald-600 text-emerald-100 disabled:opacity-30">⏮</button>
            )}
            <button onClick={onPrev} disabled={!canPrev} title="上一根 K 棒 (←)"
              className="px-1.5 py-0.5 rounded text-[10px] font-bold transition bg-muted hover:bg-muted/80 text-foreground/80 disabled:opacity-30">◀</button>
            <button onClick={onNext} disabled={!canNext} title="下一根 K 棒 (→)"
              className="px-1.5 py-0.5 rounded text-[10px] font-bold transition bg-muted hover:bg-muted/80 text-foreground/80 disabled:opacity-30">▶</button>
            {onNextBuyPoint && (
              <button onClick={onNextBuyPoint} disabled={!canNextBuyPoint} title="下一個買點 (Shift+→)"
                className="px-1.5 py-0.5 rounded text-[10px] font-bold transition bg-emerald-700/60 hover:bg-emerald-600 text-emerald-100 disabled:opacity-30">⏭</button>
            )}
            {onReset && (
              <button onClick={onReset} title="重置走圖（回到第一根）"
                className="px-1.5 py-0.5 rounded text-[10px] font-medium transition bg-muted hover:bg-red-900/60 text-muted-foreground hover:text-red-300">↺</button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
