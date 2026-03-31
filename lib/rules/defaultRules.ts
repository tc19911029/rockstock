import { TradingRule } from '@/types';
import { bullishTrendConfirm, bearishTrendConfirm } from './trendRules';
import { bullishMAAlignment, bearishMAAlignment, maClusterBreakout, breakAboveMA20, breakAboveMA5, bullishPullbackBuy, breakBelowMA5, breakBelowMA20, breakBelowMA60 } from './maRules';
import { volumeBreakoutHigh, highVolumeLongBlack, highVolumeLongRed, highDeviationWarning, piercingRedCandle, piercingBlackCandle, threeBlackCandles } from './volumeRules';
import { macdGoldenCross, macdDeathCross, macdBullishDivergence, kdOversoldBounce, kdOverboughtWarning, stopLossBreakMA5 } from './oscillatorRules';
import { masterConsensusBreakout } from './consensusRules';
import { bollingerSqueezeUp, bollingerSqueezeDown } from './bollingerRules';
import { rsiBullishFailureSwing, rsiBearishFailureSwing, rsiBullishDivergence, rsiBearishDivergence } from './rsiRules';
import { bullishResonance, bearishResonance } from './resonanceRules';
import { granvilleBuy1, granvilleBuy2, granvilleBuy3, granvilleBuy4, granvilleSell5, granvilleSell6, granvilleSell7, granvilleSell8 } from './granvilleRules';
import { ZHU_RULES } from './zhuRules';
import { sopBullConfirmEntry, sopBullPullbackBuy, sopConsolidationBreakout, sopBearConfirmEntry, sopBearBounceSell, sopConsolidationBreakdown } from './chartWalkingSopRules';
import { sopHighReversalWarning, sopLowReversalSignal } from './reversalPatternRules';
import { KLINE_COMBO_RULES } from './klineComboRules';
import { GAP_TRADING_RULES } from './gapTradingRules';
import { KLINE_TRADING_RULES } from './klineTradingRules';
// 朱家泓《抓住線圖 股民變股神》全書戰法
import { smartKLineBuy, smartKLineSell, candleMergeSignal, lowLongRedAttack, lowHammerAttack, lowCrossAttack, lowEngulfAttack, lowThreeRedAttack, highShootingStar, highCrossSell, highEngulfSell, highEveningStar } from './smartKLineRules';
import { singleMa20Buy, singleMa20Sell, tripleMaBuy, tripleMaSell, dualMaBuy, dualMaSell } from './maStrategyRules';
import { surgeStockBreakout, surgeStockExit, momentumContinuationBuy, fibRetracementGrade } from './momentumRules';
import { weeklyMa20Buy, weeklyMa20Sell, weeklyMa20Add } from './weeklyMaRules';
import { flatBottomBreakout, higherBottomBreakout, falseBreakdownBreakout, flatTopBreakdown, lowerTopBreakdown, falseBreakoutBreakdown, consolidationBreakoutDirection } from './zhuReversalRules';

export const DEFAULT_RULES: TradingRule[] = [
  // 趨勢確認
  bullishTrendConfirm,
  bearishTrendConfirm,
  // 均線
  bullishMAAlignment,
  bearishMAAlignment,
  maClusterBreakout,
  breakAboveMA20,
  breakAboveMA5,
  bullishPullbackBuy,
  breakBelowMA5,
  breakBelowMA20,
  breakBelowMA60,
  // 量價
  volumeBreakoutHigh,
  highVolumeLongBlack,
  highVolumeLongRed,
  highDeviationWarning,
  // K線型態
  piercingRedCandle,
  piercingBlackCandle,
  threeBlackCandles,
  // MACD
  macdGoldenCross,
  macdDeathCross,
  macdBullishDivergence,
  // KD
  kdOversoldBounce,
  kdOverboughtWarning,
  // 停損
  stopLossBreakMA5,
  // 大師共識
  masterConsensusBreakout,
  // 布林通道
  bollingerSqueezeUp,
  bollingerSqueezeDown,
  // RSI 進階
  rsiBullishFailureSwing,
  rsiBearishFailureSwing,
  rsiBullishDivergence,
  rsiBearishDivergence,
  // 多指標共振
  bullishResonance,
  bearishResonance,
  // 葛蘭碧八大法則
  granvilleBuy1,
  granvilleBuy2,
  granvilleBuy3,
  granvilleBuy4,
  granvilleSell5,
  granvilleSell6,
  granvilleSell7,
  granvilleSell8,
  // 朱家泓五步驟完整規則
  ...ZHU_RULES,
  // 走圖SOP（林穎）— 多單3種進場 + 空單3種進場 + 高低檔變盤偵測
  sopBullConfirmEntry,
  sopBullPullbackBuy,
  sopConsolidationBreakout,
  sopBearConfirmEntry,
  sopBearBounceSell,
  sopConsolidationBreakdown,
  sopHighReversalWarning,
  sopLowReversalSignal,
  // 朱家泓《抓住K線》行進中K線組合（15種）
  ...KLINE_COMBO_RULES,
  // 朱家泓《抓住K線》缺口操作規則（5條）
  ...GAP_TRADING_RULES,
  // 朱家泓《抓住K線》K線交易法（4條）
  ...KLINE_TRADING_RULES,
  // ── 朱家泓《抓住線圖 股民變股神》全書戰法 ──────────────────────────────────
  // 智慧K線戰法
  smartKLineBuy,
  smartKLineSell,
  candleMergeSignal,
  // K線攻擊/下殺訊號
  lowLongRedAttack,
  lowHammerAttack,
  lowCrossAttack,
  lowEngulfAttack,
  lowThreeRedAttack,
  highShootingStar,
  highCrossSell,
  highEngulfSell,
  highEveningStar,
  // 一條均線戰法（MA20）
  singleMa20Buy,
  singleMa20Sell,
  // 三條均線戰法（MA3/MA10/MA24）
  tripleMaBuy,
  tripleMaSell,
  // 二條均線戰法（MA10/MA24）
  dualMaBuy,
  dualMaSell,
  // 飆股戰法 & 續勢戰法
  surgeStockBreakout,
  surgeStockExit,
  momentumContinuationBuy,
  fibRetracementGrade,
  // 20週均線戰法
  weeklyMa20Buy,
  weeklyMa20Sell,
  weeklyMa20Add,
  // 底部/頭部反轉型態
  flatBottomBreakout,
  higherBottomBreakout,
  falseBreakdownBreakout,
  flatTopBreakdown,
  lowerTopBreakdown,
  falseBreakoutBreakdown,
  consolidationBreakoutDirection,
];
