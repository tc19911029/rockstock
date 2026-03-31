import { TradingRule, RuleSignal, CandleWithIndicators } from '@/types';
import { recentHigh } from '@/lib/indicators';

/**
 * 大師共識突破選股法
 *
 * 綜合朱家泓、權證小哥、蔡森三位台股名師核心方法：
 *   1. 均線多頭排列（close > MA5 > MA20 > MA60）— 朱家泓核心
 *   2. 創20日新高突破 — 三位大師共識
 *   3. 帶量突破（量增1.5倍）— 三位大師共識
 *   4. KD黃金交叉且K值上升 — 朱家泓+權證小哥
 *   5. 流動性門檻（20日均量>500張、股價>10元）— 權證小哥標準
 *
 * 五個條件全部同時滿足才觸發買進訊號。
 */
export const masterConsensusBreakout: TradingRule = {
  id: 'master-consensus-breakout',
  name: '大師共識突破',
  description: '均線多頭 + 20日新高 + 量增1.5倍 + KD黃金交叉 — 三大師共識因子全數到齊',

  evaluate(candles: CandleWithIndicators[], index: number): RuleSignal | null {
    if (index < 1) return null;

    const c = candles[index];
    const prev = candles[index - 1];

    // ── 前置：所有指標必須有值 ──
    if (
      c.ma5 == null || c.ma20 == null || c.ma60 == null ||
      c.avgVol5 == null || c.avgVol20 == null ||
      c.kdK == null || c.kdD == null ||
      prev.kdK == null
    ) {
      return null;
    }

    // ── 條件 1：均線多頭排列（含MA60）──
    // 朱家泓核心戰法：close > MA5 > MA20 > MA60
    const maAligned = c.close > c.ma5 && c.ma5 > c.ma20 && c.ma20 > c.ma60;
    if (!maAligned) return null;

    // ── 條件 2：創20日新高突破 ──
    // 三位大師共識：突破整理平台，上檔無壓力
    const high20 = recentHigh(candles, index, 20);
    const isBreakout = c.close >= high20;
    if (!isBreakout) return null;

    // ── 條件 3：帶量突破（量增1.5倍）──
    // 三位大師共識：帶量突破才有效
    if (c.avgVol5 <= 0) return null;
    const volRatio = c.volume / c.avgVol5;
    if (volRatio < 1.5) return null;

    // ── 條件 4：KD黃金交叉且K值上升 ──
    // 朱家泓+權證小哥：KD是最先反應的指標
    const kdGolden = c.kdK > c.kdD && c.kdK > prev.kdK;
    if (!kdGolden) return null;

    // ── 條件 5：流動性門檻 ──
    // 權證小哥標準：20日均量>500張（500,000股）、股價>10元
    if (c.avgVol20 < 500_000 || c.close < 10) return null;

    // ── 全數通過 → 觸發買進訊號 ──
    const reasons = [
      '【大師共識突破】朱家泓 × 權證小哥 × 蔡森 三位名師核心共識因子全數到齊，這是最高勝率的進場組合。',
      `【均線四線多頭】收盤 ${c.close} > MA5(${c.ma5?.toFixed(1)}) > MA20(${c.ma20?.toFixed(1)}) > MA60(${c.ma60?.toFixed(1)})，短中長期全面偏多。`,
      `【20日新高突破】收盤價創近20日新高（前高 ${high20.toFixed(1)}），突破整理平台，上檔壓力已被消化。`,
      `【帶量突破】今日量 / 5日均量 = ${volRatio.toFixed(1)}倍，量能明顯放大，突破有效性高。`,
      `【KD黃金交叉】K(${c.kdK.toFixed(1)}) > D(${c.kdD.toFixed(1)})，K值較前日上升，動能持續增強。`,
      '【操作建議】隔日開盤可考慮進場。停利設15%，停損設-7%或跌破MA20出場，時間停損20個交易日。',
    ];

    return {
      type: 'BUY',
      label: '大師共識突破',
      description: `五大共識到齊：四線多頭 + 20日新高 + 量增${volRatio.toFixed(1)}倍 + KD黃金交叉(K=${c.kdK.toFixed(0)})`,
      reason: reasons.join('\n'),
      ruleId: this.id,
    };
  },
};
