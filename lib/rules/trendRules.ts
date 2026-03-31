import { TradingRule, RuleSignal } from '@/types';
import { recentHigh, recentLow, isBullishMAAlignment } from '@/lib/indicators';
import { isLongRedCandle, isLongBlackCandle } from './ruleUtils';

/** 多頭趨勢確認：帶量長紅K線突破前高 */
export const bullishTrendConfirm: TradingRule = {
  id: 'bullish-trend-confirm',
  name: '多頭趨勢確認（帶量紅K過前高）',
  description: '帶量實體長紅K棒，收盤突破近5日最高點，多頭趨勢確認',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c = candles[index];
    const prevHigh = recentHigh(candles, index, 5);
    const avgVol = c.avgVol5;
    if (!isLongRedCandle(c)) return null;
    if (c.close <= prevHigh) return null;
    const hasVol = avgVol == null || c.volume >= avgVol * 1.2;
    if (!hasVol) return null;
    const isMaBullish = isBullishMAAlignment(c);
    return {
      type: 'BUY',
      label: '多頭突破買點',
      description: `帶量（${c.volume >= (avgVol ?? 0) * 1.2 ? '量增' : ''}）長紅K棒收盤 ${c.close} 突破前5日高點 ${prevHigh.toFixed(2)}`,
      reason: [
        '【書中黃金買點②】「底部盤整完成，出現突破前面高點的帶量長紅K線時」——這是朱家泓書中4個黃金買點的第②個，是最基本的多頭進場訊號。',
        '【四大金剛確認】波浪型態（收盤過前高）＋K線（實體長紅）＋成交量（量增）三項同時確認，是最高品質的進場機會。',
        isMaBullish
          ? '【均線加分】目前MA5>MA10>MA20三線多頭排列，均線從阻力轉支撐，持股風險相對低。'
          : '【均線提示】均線尚未完成多頭排列，建議輕倉進場，等待均線排列整齊後再加碼。',
        '【進場SOP】進場後停損設在本根K線最低點（不超過7%）。若乖離MA20超過+15%，改為跌破MA5才出場。',
        '【操作口訣】「K線看轉折，均線看方向。進場做波段，操作做短線。」',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 空頭趨勢確認：帶量長黑K線跌破前低 */
export const bearishTrendConfirm: TradingRule = {
  id: 'bearish-trend-confirm',
  name: '空頭趨勢確認（帶量黑K破前低）',
  description: '帶量實體長黑K棒，收盤跌破近5日最低點，空頭趨勢確認',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c = candles[index];
    const prevLow = recentLow(candles, index, 5);
    const avgVol  = c.avgVol5;
    if (!isLongBlackCandle(c)) return null;
    if (c.close >= prevLow) return null;
    const hasVol = avgVol == null || c.volume >= avgVol * 1.2;
    if (!hasVol) return null;
    return {
      type: 'SELL',
      label: '空頭跌破賣點',
      description: `帶量長黑K棒收盤 ${c.close} 跌破前5日低點 ${prevLow.toFixed(2)}`,
      reason: [
        '【書中黃金賣點②】「頭部盤整完成，跌破前面低點的長黑K線時」——這是朱家泓4個黃金空點的第②個，是最基本的空頭進場訊號。',
        '【空頭趨勢特性】「空頭走勢：見撐不是撐，見壓多有壓」——空頭中所有支撐都容易被跌破，所有反彈都遇到壓力。',
        '【多單持有者】此刻若手中有多單，應執行停損出場。書中：「要在股市生存，能做到小賠的唯一方法只有停損。股市中再大的風險，只要執行停損都能避開。」',
        '【空單機會】若確認空頭排列，可在反彈至均線時做空，停損設在反彈最高點。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};
