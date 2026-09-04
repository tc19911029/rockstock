'use client';

/**
 * 買法條件面板（v12 Phase 1.12 UI 改造，2026-05-09）
 *
 * 根據當前選中買法（B-I 既有 + J-Q v12 新增）顯示對應的進場條件評分。
 * A 六條件走既有 SixConditionsPanel，本元件不處理 A。
 *
 * 字母對照：
 *   v11 既有：B=回後買上漲、C=盤整突破、D=一字底、E=缺口、F=V形反轉
 *             G=ABC 突破（寶典位置 6）、H=突破大量黑K（位置 8）、I=K線橫盤（位置 5）
 *   v12 新增：J=ABC 突破（=v11 G）、K=K線橫盤（=v11 I）、L=過大量黑K（=v11 H）
 *             M=突破軌道線（寶典 p.387）、N=型態確認（課程六型優先＋舊書補充）、O=打底完成（位置 1）
 *             P=高檔拉回（位置 3 等拉回）、Q=三條均線戰法（MA3+10+24，戰法軌）
 */

import { useReplayStore } from '@/store/replayStore';
import { detectStrategyE } from '@/lib/analysis/highWinRateEntry';
import { detectStrategyD } from '@/lib/analysis/gapEntry';
import { detectConsolidationBreakout } from '@/lib/analysis/breakoutEntry';
import { buildPullbackBuyConditions } from '@/lib/analysis/pullbackBuyConditions';
import { detectTrend, findPivots } from '@/lib/analysis/trendAnalysis';
import { detectVReversal, detectVReversalStructure } from '@/lib/analysis/vReversalDetector';
import { detectABCBreakout } from '@/lib/analysis/abcBreakoutEntry';
import { detectBlackKBreakout } from '@/lib/analysis/blackKBreakoutEntry';
import { detectKlineConsolidationBreakout } from '@/lib/analysis/klineConsolidationBreakout';
// v12 新訊號 detectors
import { detectLetterM } from '@/lib/analysis/v12LetterM';
import {
  BOTTOM_PATTERN_DISPLAY_MIN_QUALITY_SCORE,
  detectLetterN,
  detectLetterNStructure,
} from '@/lib/analysis/v12LetterN';
import { detectLetterO } from '@/lib/analysis/v12LetterO';
import { detectLetterP } from '@/lib/analysis/v12LetterP';
import { detectLetterQ } from '@/lib/analysis/v12LetterQ';
import {
  BOOK_BODY_PCT_MIN,
  BOOK_VOL_RATIO_MIN,
  VREVERSAL_VOL_MULT,
  VREVERSAL_MIN_DROP_PCT,
  BLACKK_MAX_DAYS_AFTER,
  FLATBOTTOM_MIN_CONSOL_DAYS,
} from '@/lib/analysis/bookThresholds';
import { LETTER_NAMES } from '@/lib/scanner/buyMethodTracks';
import { isLegacyBookObservationOnly } from '@/lib/analysis/patternCatalog';
import type { CandleWithIndicators } from '@/types';
import ProhibitionsBlock from './ProhibitionsBlock';
import { isMAUp } from '@/lib/analysis/maPivot';

// 2026-05-12：只留 v12 字母，v11 G/H/I 已被 normalizeLetter() 自動轉成 J/L/K
type BuyMethod =
  | 'B' | 'C' | 'D' | 'E' | 'F'
  | 'J' | 'K' | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q';

interface ConditionItem {
  icon: string;
  name: string;
  detail: string;
  pass: boolean;
  metric?: string;
}

// 字母→名稱讀 lib/scanner/buyMethodTracks.ts 單一事實來源
// 本 panel 對特定字母附加註解（淺回 / MA3+10+24 等）
const METHOD_TITLE: Record<BuyMethod, string> = {
  B: LETTER_NAMES.B,
  C: LETTER_NAMES.C,
  D: LETTER_NAMES.D,
  E: LETTER_NAMES.E,
  F: LETTER_NAMES.F,
  J: LETTER_NAMES.J,
  K: 'K 線橫盤突破', // 本 panel 用完整名（含「突破」）做標題
  L: '過大量黑 K 高', // 同上（含「高」做標題）
  M: LETTER_NAMES.M,
  N: LETTER_NAMES.N,
  O: LETTER_NAMES.O,
  P: '高檔拉回（淺回）',
  Q: '三條均線戰法（MA3+10+24）',
};

function evaluateMethod(
  method: BuyMethod,
  candles: CandleWithIndicators[],
  idx: number,
): { title: string; subTitle?: string; conditions: ConditionItem[]; allPass: boolean } {
  const title = METHOD_TITLE[method];
  if (idx < 1 || candles.length === 0) {
    return { title, conditions: [], allPass: false };
  }
  const c = candles[idx];
  const prev = candles[idx - 1];

  switch (method) {
    case 'B': {
      // 回後買上漲 — 顯示層零邏輯：逐關 ✓✗ 與文案全部來自 buildPullbackBuyConditions
      // （判定單一事實 = explainPullbackBuy；合約測試 pullback-panel-parity 守一致性）
      // 2026-07-06 修：舊版 ② 綁整個 detector 結果，量比不足時會誤顯示「無站回」
      const { conditions, allPass } = buildPullbackBuyConditions(candles, idx);
      return { title, conditions, allPass };
    }

    case 'C': {
      // C=盤整突破
      const r = detectConsolidationBreakout(candles, idx);
      const bodyPct = c.open > 0 && c.close > c.open ? (c.close - c.open) / c.open * 100 : 0;
      const volRatio = prev && prev.volume > 0 ? c.volume / prev.volume : 0;
      const conditions: ConditionItem[] = [
        {
          icon: '①', name: '前置盤整',
          detail: r ? `盤整 ${r.preEntryDays} 天（detectTrend=盤整）` : '無盤整前置',
          pass: !!r,
          metric: r ? `${r.preEntryDays}天` : undefined,
        },
        {
          icon: '②', name: '收盤突破上頸線',
          detail: r ? `突破 ${r.breakoutPrice.toFixed(2)}` : '未突破上頸線',
          pass: !!r,
          metric: r ? r.breakoutPrice.toFixed(2) : undefined,
        },
        {
          icon: '③', name: `紅 K 實體 ≥ ${BOOK_BODY_PCT_MIN}%`,
          detail: `實體 ${bodyPct.toFixed(2)}%`,
          pass: bodyPct >= BOOK_BODY_PCT_MIN,
          metric: `${bodyPct.toFixed(2)}%`,
        },
        {
          icon: '④', name: `量比 ≥ ${BOOK_VOL_RATIO_MIN}`,
          detail: `×${volRatio.toFixed(2)}`,
          pass: volRatio >= BOOK_VOL_RATIO_MIN,
          metric: `×${volRatio.toFixed(2)}`,
        },
      ];
      return { title, conditions, allPass: !!r?.isBreakout };
    }

    case 'D': {
      // D=一字底
      const r = detectStrategyE(candles, idx);
      const conditions: ConditionItem[] = [
        {
          icon: '①', name: `盤整 ${FLATBOTTOM_MIN_CONSOL_DAYS} 天以上`,
          detail: r ? `盤整 ${r.consolidationDays} 天` : '盤整天數不足',
          pass: !!r,
          metric: r ? `${r.consolidationDays}天` : undefined,
        },
        {
          icon: '②', name: '均線糾結',
          detail: r ? '盤整末段 MA5/10/20 糾結 ≥5 天' : 'MA 未糾結',
          pass: !!r,
        },
        {
          icon: '③', name: '量縮 → 突破量',
          detail: r ? '盤整期量 < 前期60%、當日量 ≥ 盤整均量 × 2' : '量能未達標',
          pass: !!r,
        },
        {
          icon: '④', name: '紅 K 突破頸線',
          detail: r ? r.detail : '未突破盤整上頸線',
          pass: !!r,
        },
      ];
      return { title, conditions, allPass: !!r };
    }

    case 'E': {
      // E=缺口進場
      const r = detectStrategyD(candles, idx);
      const gapPct = prev && prev.high > 0 ? (c.open - prev.high) / prev.high * 100 : 0;
      const bodyPct = c.open > 0 && c.close > c.open ? (c.close - c.open) / c.open * 100 : 0;
      const volRatio = prev && prev.volume > 0 ? c.volume / prev.volume : 0;
      const conditions: ConditionItem[] = [
        {
          icon: '①', name: '向上跳空',
          detail: gapPct > 0 ? `開盤 ${c.open.toFixed(2)} > 前日高 ${prev?.high.toFixed(2)}` : '未跳空',
          pass: gapPct > 0,
          metric: `+${gapPct.toFixed(2)}%`,
        },
        {
          icon: '②', name: `紅 K 實體 ≥ ${BOOK_BODY_PCT_MIN}%`,
          detail: bodyPct >= BOOK_BODY_PCT_MIN ? `實體 ${bodyPct.toFixed(2)}%` : `實體僅 ${bodyPct.toFixed(2)}%`,
          pass: bodyPct >= BOOK_BODY_PCT_MIN,
          metric: `${bodyPct.toFixed(2)}%`,
        },
        {
          icon: '③', name: `量比 ≥ ${BOOK_VOL_RATIO_MIN}`,
          detail: volRatio >= BOOK_VOL_RATIO_MIN ? `量比 ×${volRatio.toFixed(2)}` : `量比不足 ×${volRatio.toFixed(2)}`,
          pass: volRatio >= BOOK_VOL_RATIO_MIN,
          metric: `×${volRatio.toFixed(2)}`,
        },
      ];
      return { title, conditions, allPass: !!r?.isGapEntry };
    }

    case 'F': {
      // F=V形反轉 — 忠於朱老師第57集「八個字四個條件」：急跌→底部爆量→止跌(變盤線或紅K)→過高進場
      // 結構部分（①②③④）由 detectVReversalStructure 一起算（連跌+底部爆量+止跌線+守住）；
      // ⑤ 過高是進場確認，獨立顯示。
      const struct = detectVReversalStructure(candles, idx);
      const r = detectVReversal(candles, idx);
      const bodyPct = c.open > 0 && c.close > c.open ? (c.close - c.open) / c.open * 100 : 0;
      const breakPrevHigh = !!prev && c.close > prev.high;

      const conditions: ConditionItem[] = [
        {
          icon: '①', name: `連續下跌（急跌 ≥ ${VREVERSAL_MIN_DROP_PCT}%）`,
          detail: struct
            ? `前 ${struct.precedingDownDays} 天下跌，段跌幅 ${struct.precedingDrop.toFixed(1)}%`
            : '未偵測到夠深的下跌段',
          pass: !!struct,
          metric: struct ? `${struct.precedingDownDays}跌 · -${struct.precedingDrop.toFixed(1)}%` : '—',
        },
        {
          icon: '②', name: `底部爆量（低檔出量 × ${VREVERSAL_VOL_MULT}）`,
          detail: struct
            ? `低檔 ${struct.bottomVolOffset} 根前爆量 ×${struct.bottomVolRatio.toFixed(1)} 段前均量`
            : '前提未成立（需先有夠深下跌段）',
          pass: !!struct,
          metric: struct ? `×${struct.bottomVolRatio.toFixed(1)}` : '—',
        },
        {
          icon: '③', name: '止跌訊號（變盤線 或 紅K）',
          detail: struct
            ? `${struct.stopBarOffset} 根前出現 [${struct.stopBarShape}] 止跌`
            : '過去 15 根內未找到止跌訊號',
          pass: !!struct,
          metric: struct ? `${struct.stopBarShape}·${struct.stopBarOffset}根前` : '—',
        },
        {
          icon: '④', name: '止跌守住（不破止跌低）',
          detail: struct
            ? `止跌 low ${struct.stopBarLow.toFixed(2)} 之後 ${struct.stopBarOffset - 1} 天未跌破`
            : '前提未成立（需先有止跌訊號）',
          pass: !!struct,
        },
        {
          icon: '⑤', name: '過高進場（紅K 收盤 > 前 K 高）',
          detail: prev
            ? (c.close > c.open
                ? `收 ${c.close.toFixed(2)} vs 前高 ${prev.high.toFixed(2)}（紅K +${bodyPct.toFixed(1)}%）`
                : `今日為黑 K，收 ${c.close.toFixed(2)} vs 前高 ${prev.high.toFixed(2)}`)
            : '無前日資料',
          pass: c.close > c.open && breakPrevHigh,
        },
      ];
      return { title, conditions, allPass: !!r?.isVReversal };
    }

    // ── v12 多頭軌字母 J/K/L（沿用 v11 detector，刪除 v11 G/H/I 重複 case）─
    case 'J': {
      // ABC 突破（寶典 Part 11-1 位置 6 + Part 12-4 祕笈圖 #16）
      const r = detectABCBreakout(candles, idx);
      const bodyPct = c.open > 0 && c.close > c.open ? (c.close - c.open) / c.open * 100 : 0;
      const volRatio = prev && prev.volume > 0 ? c.volume / prev.volume : 0;
      const aboveMa20 = c.ma20 != null && c.close > c.ma20;
      const conditions: ConditionItem[] = [
        {
          icon: '①', name: 'ABC 修正結構（頭頭低+底底低）',
          detail: r
            ? `A峰 ${r.legAHigh.toFixed(1)}→A底 ${r.legALow.toFixed(1)}→B峰 ${r.legBHigh.toFixed(1)}→C底 ${r.legCLow.toFixed(1)}（修正 ${r.preEntryDays} 天）`
            : '未偵測到 ABC 修正結構',
          pass: !!r,
          metric: r ? `${r.preEntryDays}天` : '—',
        },
        {
          icon: '②', name: '收盤突破下降切線',
          detail: r ? `切線延伸值 ${r.trendlineValue.toFixed(2)}` : '未突破下降切線',
          pass: !!r,
          metric: r ? r.trendlineValue.toFixed(2) : '—',
        },
        {
          icon: '③', name: `紅 K 實體 ≥ ${BOOK_BODY_PCT_MIN}%`,
          detail: `實體 ${bodyPct.toFixed(2)}%`,
          pass: bodyPct >= BOOK_BODY_PCT_MIN,
          metric: `${bodyPct.toFixed(2)}%`,
        },
        {
          icon: '④', name: `量比 ≥ ${BOOK_VOL_RATIO_MIN}`,
          detail: `×${volRatio.toFixed(2)}`,
          pass: volRatio >= BOOK_VOL_RATIO_MIN,
          metric: `×${volRatio.toFixed(2)}`,
        },
        {
          icon: '⑤', name: '收盤站上 MA20',
          detail: c.ma20 != null
            ? `${c.close.toFixed(2)} vs MA20 ${c.ma20.toFixed(2)}`
            : '無 MA20 資料',
          pass: aboveMa20,
        },
      ];
      return { title, conditions, allPass: !!r?.isABCBreakout };
    }
    case 'K': {
      // K 線橫盤突破（寶典 Part 11-1 位置 3）
      const r = detectKlineConsolidationBreakout(candles, idx);
      const bodyPct = c.open > 0 && c.close > c.open ? (c.close - c.open) / c.open * 100 : 0;
      const volRatio = prev && prev.volume > 0 ? c.volume / prev.volume : 0;
      const isUptrend = detectTrend(candles, idx) === '多頭';
      const conditions: ConditionItem[] = [
        {
          icon: '①', name: '多頭趨勢',
          detail: isUptrend ? '多頭（頭頭高底底高）' : '非多頭趨勢',
          pass: isUptrend,
        },
        {
          // 2026-07-20 第七輪：面板原寫「實體 ≥ 3%」「5-15 天」，但 643926b（07-12）已把
          // 錨點實體濾網移除（課程 6-3：「第一根紅黑不管實體」），最小橫盤天數也是 3 不是 5。
          // 面板說一套、引擎做一套 → 改成引擎實際判準。
          icon: '②', name: '紅/黑 K 錨點（課程：第一根不限實體）',
          detail: r
            ? `${r.anchorDate} 錨點 K（高 ${r.anchorHigh.toFixed(2)}，實體 ${r.anchorBodyPct.toFixed(2)}%）`
            : '未找到符合的錨點 K',
          pass: !!r,
          metric: r ? `${r.anchorBodyPct.toFixed(2)}%` : '—',
        },
        {
          icon: '③', name: '錨點上方狹幅橫盤（≥ 3 天 / 幅度 ≤ 5%）',
          detail: r
            ? `橫盤 ${r.consolidationDays} 天，幅度 ${r.rangeWidthPct.toFixed(2)}%`
            : '橫盤條件未成立',
          pass: !!r,
          metric: r ? `${r.consolidationDays}天` : '—',
        },
        {
          icon: '④', name: `今日紅 K 實體 ≥ ${BOOK_BODY_PCT_MIN}%`,
          detail: `實體 ${bodyPct.toFixed(2)}%`,
          pass: bodyPct >= BOOK_BODY_PCT_MIN,
          metric: `${bodyPct.toFixed(2)}%`,
        },
        {
          icon: '⑤', name: `量比 ≥ ${BOOK_VOL_RATIO_MIN}`,
          detail: `×${volRatio.toFixed(2)}`,
          pass: volRatio >= BOOK_VOL_RATIO_MIN,
          metric: `×${volRatio.toFixed(2)}`,
        },
        {
          icon: '⑥', name: '收盤突破橫盤最高點',
          detail: r
            ? `${c.close.toFixed(2)} > 橫盤高 ${r.rangeHigh.toFixed(2)}`
            : '前提未成立',
          pass: !!r?.isBreakout,
        },
      ];
      return { title, conditions, allPass: !!r?.isBreakout };
    }
    case 'L': {
      // 過大量黑 K 高（寶典 Part 11-1 位置 8）
      const r = detectBlackKBreakout(candles, idx);
      const bodyPct = c.open > 0 && c.close > c.open ? (c.close - c.open) / c.open * 100 : 0;
      const volRatio = prev && prev.volume > 0 ? c.volume / prev.volume : 0;
      const isUptrend = detectTrend(candles, idx) === '多頭';
      const conditions: ConditionItem[] = [
        {
          icon: '①', name: '多頭趨勢',
          detail: isUptrend ? '多頭（頭頭高底底高）' : '非多頭趨勢',
          pass: isUptrend,
        },
        {
          icon: '②', name: `近 ${BLACKK_MAX_DAYS_AFTER} 日內出現大量黑 K（跌破前日低 / MA5）`,
          detail: r
            ? `${r.blackKDate} 大量黑 K（高 ${r.blackKHigh.toFixed(2)}，量×${r.blackKVolumeRatio.toFixed(2)}）`
            : '未發現符合條件的大量黑 K',
          pass: !!r,
          metric: r ? `${r.daysSinceBlackK}日前` : '—',
        },
        {
          icon: '③', name: `今日紅 K 實體 ≥ ${BOOK_BODY_PCT_MIN}%`,
          detail: `實體 ${bodyPct.toFixed(2)}%`,
          pass: bodyPct >= BOOK_BODY_PCT_MIN,
          metric: `${bodyPct.toFixed(2)}%`,
        },
        {
          icon: '④', name: `今日量比 ≥ ${BOOK_VOL_RATIO_MIN}`,
          detail: `×${volRatio.toFixed(2)}`,
          pass: volRatio >= BOOK_VOL_RATIO_MIN,
          metric: `×${volRatio.toFixed(2)}`,
        },
        {
          icon: '⑤', name: '收盤突破大量黑 K 最高點',
          detail: r
            ? `${c.close.toFixed(2)} > 黑K高 ${r.blackKHigh.toFixed(2)}`
            : '前提未成立',
          pass: !!r?.isBlackKBreakout,
        },
      ];
      return { title, conditions, allPass: !!r?.isBlackKBreakout };
    }
    case 'M': {
      // M=突破軌道線（v12 新訊號，寶典 p.387）
      const r = detectLetterM(candles, idx);
      const trendPass = detectTrend(candles, idx) === '多頭';
      const ma20Pass = c.ma20 != null && c.close > c.ma20
        && (prev.ma20 == null || c.ma20 >= prev.ma20);
      const pivots = findPivots(candles, idx, 10, false);
      const lows = pivots.filter((p) => p.type === 'low').slice(0, 2);
      const channelStructure = lows.length === 2
        && lows[0].index - lows[1].index >= 5
        && lows[0].price > lows[1].price;
      const bodyPct = c.open > 0 ? (c.close - c.open) / c.open * 100 : 0;
      const volRatio = prev.volume > 0 ? c.volume / prev.volume : 0;
      const conditions: ConditionItem[] = [
        {
          icon: '①', name: '多頭趨勢',
          detail: trendPass ? '多頭' : '非多頭',
          pass: trendPass,
        },
        {
          icon: '②', name: '站上 MA20 + MA20 不下彎',
          detail: c.ma20 != null ? `close ${c.close.toFixed(2)} / MA20 ${c.ma20.toFixed(2)}` : '無 MA20',
          pass: ma20Pass,
        },
        {
          icon: '③', name: '2 個上升 pivot low + 中間最高',
          detail: channelStructure ? '上升軌道結構成立' : '軌道線結構未成立',
          pass: channelStructure,
        },
        {
          icon: '④', name: 'close ≥ 軌道線 ×3% 真突破',
          detail: r.triggered
            ? `close ${c.close.toFixed(2)} ≥ ${r.breakoutThreshold?.toFixed(2)}`
            : channelStructure ? '未完成真突破或其他進場閘門' : '無有效軌道線',
          pass: r.breakoutThreshold != null && c.close >= r.breakoutThreshold,
        },
        {
          icon: '⑤', name: `紅 K 實體 ≥ ${BOOK_BODY_PCT_MIN}%` ,
          detail: `實體 ${bodyPct.toFixed(2)}%`,
          pass: bodyPct >= BOOK_BODY_PCT_MIN,
        },
        {
          icon: '⑥', name: `量比 ≥ ${BOOK_VOL_RATIO_MIN}`,
          detail: `量 ×${volRatio.toFixed(2)}`,
          pass: volRatio >= BOOK_VOL_RATIO_MIN,
        },
      ];
      return { title, subTitle: '寶典 p.387 上升軌道線', conditions, allPass: r.triggered };
    }
    case 'N': {
      // N=型態確認（8 種底部型態；最新課程 6 型優先、書本補充在後）
      // 雙層 detector：
      //   - detectLetterN：完整觸發（含 ×3% 真突破）— 全部條件過才算 ✓
      //   - detectLetterNStructure：只看「結構成立」（pivots + 達成率）— 給 pending-breakout 顯示
      // 跟 lockwatch 寫入邏輯（MarketScanner.ts:1483）對齊，避免「鎖股顯示圓弧底 85% 但條件面板說未識別」的矛盾
      const r = detectLetterN(candles, idx);
      const struct = detectLetterNStructure(candles, idx, BOTTOM_PATTERN_DISPLAY_MIN_QUALITY_SCORE);
      // 結構成立但未過真突破：條件面板顯示「結構成立（待突破）」而不是「未識別」
      const hasStructure: boolean = !r.triggered && !!struct.patternType && Array.isArray(struct.pivots) && struct.pivots.length > 0;
      const patternName = (r.patternType ?? struct.patternType)
        ? ({
            'head-shoulder': '頭肩底',
            'triple-bottom': '三重底',
            'rounding-bottom': '圓弧底',
            'double-bottom': '雙重底',
            'complex-head-shoulder': '複式頭肩底',
            'falling-diamond': '跌菱形',
            'descending-wedge': '下降楔形',
            'n-shape': 'N 字底',
          } as const)[(r.patternType ?? struct.patternType)!]
        : '尚未識別';
      const achievement = r.achievementRate ?? struct.achievementRate;
      const neckline = r.necklinePrice ?? struct.necklinePrice;
      const target = r.patternTargetPrice ?? struct.patternTargetPrice;
      const observationOnly = (r.patternType ?? struct.patternType)
        ? isLegacyBookObservationOnly((r.patternType ?? struct.patternType)!)
        : false;
      const confirmationThreshold = neckline != null ? neckline * 1.03 : null;
      const conditions: ConditionItem[] = [
        {
          icon: '①', name: '型態結構',
          detail: r.triggered
            ? `${patternName}${achievement != null ? `（舊書達標統計 ${achievement}%）` : ''}`
            : hasStructure
              ? observationOnly
                ? `${patternName}（舊書達標統計 ${achievement}% · 低達標統計，僅供圖表觀察，不列入 N 進場）`
                : `${patternName}（${achievement != null ? `舊書達標統計 ${achievement}% · ` : ''}結構成立，等待真突破）`
              : '未識別',
          pass: r.triggered || hasStructure,
        },
        {
          icon: '②', name: '收盤通過真突破門檻（頸線 +3%）',
          detail: neckline
            ? r.triggered
              ? `頸線 ${neckline.toFixed(2)}／真突破 ${confirmationThreshold?.toFixed(2)} → close ${c.close.toFixed(2)}（訊號成立）`
              : `頸線 ${neckline.toFixed(2)}／真突破 ${confirmationThreshold?.toFixed(2)} → close ${c.close.toFixed(2)}（${observationOnly ? '此型態只供觀察' : c.close >= neckline ? '已過頸線但未滿 3%' : '尚未突破'}）`
            : '無頸線',
          pass: r.triggered,
        },
        {
          icon: '③', name: '突破後測量目標（非保證價）',
          detail: target
            ? r.triggered
              ? `訊號已成立，測量目標 ${target.toFixed(2)}`
              : `尚未完成真突破，${target.toFixed(2)} 目前只是條件式估算`
            : '—',
          pass: r.triggered && !!target,
        },
        {
          icon: '④', name: `紅 K + 量 ≥ ${BOOK_VOL_RATIO_MIN}`,
          detail: r.triggered ? `紅 K ${r.bodyPct?.toFixed(2)}% / 量 ×${r.volumeRatio?.toFixed(2)}` : '—',
          pass: r.triggered,
        },
      ];
      return {
        title,
        subTitle: r.triggered
          ? `${patternName}${achievement != null ? `（舊書達標統計 ${achievement}%）` : ''}`
          : hasStructure
            ? observationOnly
              ? `${patternName} · 低達標統計，僅供圖表觀察，不列入 N 進場`
              : `${patternName}${achievement != null ? `（舊書達標統計 ${achievement}%）` : ''} · 結構成立，等待真突破`
            : '課程六型優先＋舊書型態補充',
        conditions,
        allPass: r.triggered,
      };
    }
    case 'O': {
      // O=打底完成（v12 新訊號，寶典 Part 11-1 位置 1）
      const r = detectLetterO(candles, idx);
      const trendTurn = detectTrend(candles, idx) === '多頭' && detectTrend(candles, idx - 1) !== '多頭';
      const ma20Series = candles.slice(Math.max(0, idx - 30), idx + 1).map((k) => k.ma20).filter((v): v is number => v != null);
      const ma20Pass = c.ma20 != null && c.close >= c.ma20 && isMAUp(ma20Series, 3);
      const bodyPct = c.open > 0 ? (c.close - c.open) / c.open * 100 : 0;
      const volRatio = prev.volume > 0 ? c.volume / prev.volume : 0;
      const conditions: ConditionItem[] = [
        {
          icon: '①', name: '完整空→盤整＋大量打底結構',
          detail: r.hadHighVolume ? '✅ 已偵測到打底大量' : '尚未偵測',
          pass: !!r.hadHighVolume,
        },
        {
          icon: '②', name: '反轉多頭確認',
          detail: trendTurn ? '✅ 今日首次翻多' : '尚未形成首次翻多',
          pass: trendTurn,
        },
        {
          icon: '③', name: '站上 MA20 + MA20 上揚',
          detail: c.ma20 ? `close ${c.close.toFixed(2)} vs MA20 ${c.ma20.toFixed(2)}` : '無 MA20',
          pass: ma20Pass,
        },
        {
          icon: '④', name: `紅 K 實體 ≥ ${BOOK_BODY_PCT_MIN}% + 量 ≥ ${BOOK_VOL_RATIO_MIN}`,
          detail: `實體 ${bodyPct.toFixed(2)}% / 量 ×${volRatio.toFixed(2)}`,
          pass: bodyPct >= BOOK_BODY_PCT_MIN && volRatio >= BOOK_VOL_RATIO_MIN,
        },
        {
          icon: '⑤', name: '收盤突破打底盤整高 ×3%',
          detail: r.triggered
            ? `突破 ${r.triggerPrice?.toFixed(2)}（×3% = ${r.breakoutThreshold?.toFixed(2)}）`
            : '未突破',
          pass: r.breakoutThreshold != null && c.close >= r.breakoutThreshold,
        },
        {
          icon: '⑥', name: '加分項：站上 MA60（可長多）',
          detail: r.aboveMA60 ? '✅ 站上季線' : '— 未站上',
          pass: !!r.aboveMA60,
        },
      ];
      return { title, subTitle: '寶典 Part 11-1 位置 1', conditions, allPass: r.triggered };
    }
    case 'P': {
      // P=高檔拉回（v12 新訊號，寶典 Part 11-1 位置 3 等拉回）
      const r = detectLetterP(candles, idx);
      const bodyPct = c.open > 0 ? (c.close - c.open) / c.open * 100 : 0;
      const volRatio = prev.volume > 0 ? c.volume / prev.volume : 0;
      const abovePrevHigh = c.close > prev.high;
      const holdsMa20 = c.ma20 != null && Math.min(c.low, prev.low) >= c.ma20;
      const conditions: ConditionItem[] = [
        {
          icon: '①', name: '多頭趨勢',
          detail: detectTrend(candles, idx) === '多頭' ? '多頭' : '非多頭',
          pass: detectTrend(candles, idx) === '多頭',
        },
        {
          icon: '②', name: '近期高 + 1-2 天淺回',
          detail: r.triggered
            ? `${r.pullbackDays} 天淺回（前高 ${r.prevSwingHigh?.toFixed(2)}）`
            : '淺回結構未成立',
          pass: r.triggered,
        },
        {
          icon: '③', name: '不破 MA20（月線）／不破前低',
          detail: c.ma20 != null ? `近兩日低 ${Math.min(c.low, prev.low).toFixed(2)} / MA20 ${c.ma20.toFixed(2)}` : '無 MA20',
          pass: holdsMa20,
        },
        {
          icon: '④', name: `紅 K 實體 ≥ ${BOOK_BODY_PCT_MIN}% + 量 ≥ ${BOOK_VOL_RATIO_MIN}`,
          detail: `實體 ${bodyPct.toFixed(2)}% / 量 ×${volRatio.toFixed(2)}`,
          pass: bodyPct >= BOOK_BODY_PCT_MIN && volRatio >= BOOK_VOL_RATIO_MIN,
        },
        {
          icon: '⑤', name: '收盤突破前 K 高',
          detail: `${c.close.toFixed(2)} vs 前高 ${prev.high.toFixed(2)}`,
          pass: abovePrevHigh,
        },
      ];
      return { title, subTitle: '寶典位置 3 等拉回（B 的淺回版）', conditions, allPass: r.triggered };
    }
    case 'Q': {
      // Q=三條均線戰法（v12 新訊號，戰法軌獨立 SOP）
      const r = detectLetterQ(candles, idx);
      const ma24Series = candles.slice(Math.max(0, idx - 30), idx + 1).map((k) => k.ma24).filter((v): v is number => v != null);
      const ma24Up = isMAUp(ma24Series, 3);
      const goldenCross = c.ma3 != null && c.ma10 != null && prev.ma3 != null && prev.ma10 != null
        && c.ma3 > c.ma10 && prev.ma3 <= prev.ma10;
      const aboveMA3 = c.ma3 != null && c.close >= c.ma3;
      const bodyPct = c.open > 0 ? (c.close - c.open) / c.open * 100 : 0;
      const conditions: ConditionItem[] = [
        {
          icon: '①', name: '股價 ≥ MA24',
          detail: c.ma24 ? `close ${c.close.toFixed(2)} vs MA24 ${c.ma24.toFixed(2)}` : '無 MA24',
          pass: c.ma24 != null && c.close >= c.ma24,
        },
        {
          icon: '②', name: 'MA24 上揚（趨勢方向）',
          detail: ma24Up ? '✅ 上揚' : '未上揚',
          pass: ma24Up,
        },
        {
          icon: '③', name: 'MA3 黃金交叉 MA10',
          detail: goldenCross ? '✅ 今日金叉' : '未金叉',
          pass: goldenCross,
        },
        {
          icon: '④', name: '股價站上 MA3',
          detail: aboveMA3 ? '✅ 站上 MA3' : '未站上',
          pass: aboveMA3,
        },
        {
          icon: '⑤', name: `紅 K 實體 ≥ ${BOOK_BODY_PCT_MIN}%`,
          detail: `${bodyPct.toFixed(2)}%`,
          pass: bodyPct >= BOOK_BODY_PCT_MIN,
        },
      ];
      return {
        title,
        subTitle: '抓住線圖 第 4 篇 第 8 章 — 朱老師「年獲利 1 倍」首選戰法',
        conditions,
        allPass: r.triggered,
      };
    }
  }
}

export default function BuyMethodConditionsPanel({ method }: { method: BuyMethod }) {
  const allCandles = useReplayStore(s => s.allCandles);
  const currentIndex = useReplayStore(s => s.currentIndex);

  if (!allCandles || allCandles.length === 0 || currentIndex < 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
        <p className="text-2xl mb-2">📊</p>
        <p className="text-sm font-medium text-muted-foreground">尚未載入股票</p>
        <p className="text-xs text-muted-foreground mt-1">請先在上方選擇一檔股票</p>
      </div>
    );
  }

  const { title, subTitle, conditions, allPass } = evaluateMethod(method, allCandles, currentIndex);
  const passCount = conditions.filter(c => c.pass).length;
  const total = conditions.length;

  return (
    <div className="p-3">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-sm font-semibold text-foreground">{title}</div>
          {subTitle && <div className="text-[10px] text-muted-foreground mt-0.5">{subTitle}</div>}
        </div>
        <div className={`text-sm font-bold ${allPass ? 'text-green-400' : passCount >= total - 1 ? 'text-yellow-400' : 'text-red-400'}`}>
          {passCount}/{total}
        </div>
      </div>
      <ul className="space-y-2">
        {conditions.map((c) => (
          <li key={c.icon} className={`flex items-start gap-2 p-2 rounded border ${c.pass ? 'border-green-800/40 bg-green-900/10' : 'border-border bg-secondary/30'}`}>
            <span className="text-base leading-tight">{c.icon}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-medium text-foreground">{c.name}</span>
                {c.metric && (
                  <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${c.pass ? 'bg-green-900/40 text-green-300' : 'bg-muted text-muted-foreground'}`}>
                    {c.metric}
                  </span>
                )}
              </div>
              <div className="text-[10px] text-muted-foreground mt-0.5">{c.detail}</div>
            </div>
            <span className={`text-base leading-tight ${c.pass ? 'text-green-400' : 'text-muted-foreground/50'}`}>
              {c.pass ? '✓' : '·'}
            </span>
          </li>
        ))}
      </ul>
      {allPass ? (
        <div className="mt-3 px-2 py-1.5 bg-green-900/20 border border-green-800/40 rounded text-[11px] text-green-300 text-center">
          ✅ {title} 全部符合 — 書本明文進場位置
        </div>
      ) : (
        <div className="mt-3 px-2 py-1.5 bg-muted/30 border border-border rounded text-[11px] text-muted-foreground text-center">
          未完全符合 — 此 K 棒不滿足 {title} 條件
        </div>
      )}

      {/* 進場 10 大戒律狀態（書本：硬性禁忌，任一觸發即不應進場） */}
      <ProhibitionsBlock mode={['D', 'F', 'J', 'N', 'O', 'Q'].includes(method) ? 'warning' : 'veto'} />
    </div>
  );
}
