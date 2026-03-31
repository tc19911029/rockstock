import { TradingRule, RuleSignal } from '@/types';
import { crossedAbove, crossedBelow, isBullishMAAlignment, isBearishMAAlignment } from '@/lib/indicators';
import { isLongBlackCandle } from './ruleUtils';

/** 多頭三線排列確認 */
export const bullishMAAlignment: TradingRule = {
  id: 'bullish-ma-alignment',
  name: '三線多頭排列剛成形',
  description: 'MA5 > MA10 > MA20，三線多頭排列剛完成',
  evaluate(candles, index): RuleSignal | null {
    if (index < 1) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (!isBullishMAAlignment(c) || isBullishMAAlignment(prev)) return null;
    const aboveMA60 = c.ma60 == null || c.close > c.ma60;
    return {
      type: 'WATCH',
      label: '多頭排列確認',
      description: `MA5(${c.ma5}) > MA10(${c.ma10}) > MA20(${c.ma20}) 三線多頭排列剛成形`,
      reason: [
        '【書中進場條件】朱家泓《做對5個實戰步驟》的多頭選股條件第3項：「均線3線（MA5、MA10、MA20）多頭排列向上」——均線排列是進場的必要條件之一。',
        '【進場口訣】「就短線做多而言，日線多頭架構完成趨勢確認，加上均線3線多頭排列向上，這時順勢做多，成功賺錢的勝率大，賠錢停損的機率小。」',
        aboveMA60
          ? '【四線多頭】MA60季線也在股價下方，已形成四線多頭排列，代表短中長期全面偏多，可考慮較長波段持有。'
          : '【季線壓力】MA60季線仍在股價上方，為季線阻力。書中提醒：站上月線後先做短線，待站上季線後才轉為中長線操作。',
        '【操作建議】可等下一根回檔不破前低再上漲時進場（黃金買點③），勝率更高。',
        '【配合指標】搭配MACD OSC由綠轉紅（或KD黃金交叉）共振時進場，準確率更高。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 空頭三線排列確認 */
export const bearishMAAlignment: TradingRule = {
  id: 'bearish-ma-alignment',
  name: '三線空頭排列剛成形',
  description: 'MA5 < MA10 < MA20，三線空頭排列剛完成',
  evaluate(candles, index): RuleSignal | null {
    if (index < 1) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (!isBearishMAAlignment(c) || isBearishMAAlignment(prev)) return null;
    return {
      type: 'SELL',
      label: '空頭排列警示',
      description: `MA5(${c.ma5}) < MA10(${c.ma10}) < MA20(${c.ma20}) 三線空頭排列剛成形`,
      reason: [
        '【書中空頭排列邏輯】三線空頭排列代表短中期賣方力道全面主導，均線呈下壓態勢。「空頭走勢：見撐不是撐，見壓多有壓」——每次反彈到均線都是賣壓。',
        '【不宜做多】書中明確指出：「凡是均線同時往下，股價在均線下方時不做多。」均線空排期間，任何反彈都可能只是逢高出貨的機會。',
        '【操作建議】①持有多單者應考慮出場；②反彈到MA5或MA10附近、且均線方向向下時，是做空的機會；③等待趨勢轉為多頭排列再考慮做多。',
        '【空頭操作SOP】「空頭行進反彈壓力：反彈到壓力均線，不過前高再下跌」——這是做空的黃金進場位置。',
        '【停損設定】若做空，停損設在進場當日K線最高點，不超過7%。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 均線糾結突破 */
export const maClusterBreakout: TradingRule = {
  id: 'ma-cluster-breakout',
  name: '均線糾結後突破',
  description: 'MA5、MA10、MA20 三線靠近糾結，今日帶量紅K突破',
  evaluate(candles, index): RuleSignal | null {
    if (index < 1) return null;
    const c = candles[index];
    if (c.ma5 == null || c.ma10 == null || c.ma20 == null) return null;
    const spread = Math.abs(c.ma5 - c.ma20) / c.ma20;
    if (spread > 0.025) return null; // 均線差距>2.5%代表未糾結
    const isBreakingUp = c.close > c.open && c.close > Math.max(c.ma5, c.ma10, c.ma20);
    const avgVol = c.avgVol5;
    const hasVol = avgVol == null || c.volume >= avgVol * 1.2;
    if (!isBreakingUp || !hasVol) return null;
    return {
      type: 'BUY',
      label: '均線糾結突破',
      description: `三均線差距僅 ${(spread * 100).toFixed(1)}%（糾結），帶量紅K突破所有均線`,
      reason: [
        '【書中口訣】「均線糾結的向上紅棒是起漲的開始。」——這是朱家泓書中最重要的均線操作口訣之一，糾結突破往往是波段起漲的訊號。',
        '【糾結的意義】三條均線靠攏代表多空力量長時間均衡，能量積累。一旦帶量突破，方向確立，後續走勢往往延續，不容易立刻反轉。',
        '【飆股特徵之一】朱家泓飆股8條件第5項：「發動前，短中長期均線糾結」——糾結突破也是飆股發動的前兆，需特別留意。',
        '【操作建議】可以此紅K棒低點或MA20為停損基準進場。若成交量是近期最大量，後續上漲空間更大。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 突破月線（MA20）買點 */
export const breakAboveMA20: TradingRule = {
  id: 'break-above-ma20',
  name: '突破月線 MA20',
  description: '收盤由下往上穿越20日均線（月線）',
  evaluate(candles, index): RuleSignal | null {
    if (!crossedAbove(candles, index, 'ma20')) return null;
    const c = candles[index];
    const aboveMA60 = c.ma60 == null || c.close > c.ma60;
    return {
      type: 'WATCH',
      label: '突破月線觀察',
      description: `收盤 ${c.close} 突破月線 MA20 (${c.ma20})${aboveMA60 ? '，同時站上季線' : ''}`,
      reason: [
        '【書中月線規則】「股價在月線之上，而且月線呈現向上走勢，趨勢為多頭，只要股價沒有跌破月線之前，做多操作。」——月線是短線操作的多空分界線。',
        '【一條均線戰法進場】書中一條均線戰法：「底部打底完成，暴大量上漲紅K線，站上20日均線且均線走平或上揚，買進。」本訊號與此戰法相符。',
        aboveMA60
          ? '【雙線確認】同時站上季線（MA60），月線和季線雙重多頭確認。書中：「季線是中長期操作的多空分界均線」，雙線確認代表中短期同步偏多。'
          : '【季線壓力存在】目前季線仍在股價上方，按書中建議先以短線操作為主（參考三條均線戰法），待站上季線後再轉中線。',
        '【出場紀律】「一條均線戰法」出場條件：收盤跌破MA20出場，不要凹單。停損設在進場K線最低點。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 突破MA5短線買點 */
export const breakAboveMA5: TradingRule = {
  id: 'break-above-ma5',
  name: '突破 MA5 短線買點',
  description: '收盤由下往上穿越5日均線，短線多方動能再起',
  evaluate(candles, index): RuleSignal | null {
    if (!crossedAbove(candles, index, 'ma5')) return null;
    const c = candles[index];
    if (c.close < (c.ma20 ?? 0) * 0.93) return null;
    return {
      type: 'WATCH',
      label: '短線觀察',
      description: `收盤 ${c.close} 突破 MA5 (${c.ma5})`,
      reason: [
        '【書中順勢波浪戰法】「低檔打底底底高，大量上漲紅K線站上5日均線；或突破盤整上頸線帶量紅K線」——站上MA5是短線多方動能確認的最低門檻。',
        '【MA5 功能】5日均線代表近一週的平均成本，站上後MA5從阻力轉為支撐，短線買方開始主導。',
        '【二條均線戰法出場規則】一旦進場，書中二條均線戰法說：「股價收盤跌破MA10一定要先出場。」以此為短線停利基準。',
        '【注意事項】若月線（MA20）仍向下，此突破可能只是空頭反彈，不宜重倉，輕倉試多即可。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 多頭回踩均線加碼 */
export const bullishPullbackBuy: TradingRule = {
  id: 'bullish-pullback-buy',
  name: '多頭回踩支撐再上漲（黃金買點③）',
  description: '均線多頭排列中，前日低點觸及MA10，今日紅K棒反彈',
  evaluate(candles, index): RuleSignal | null {
    if (index < 3) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (!isBullishMAAlignment(c)) return null;
    const ma10 = prev.ma10 ?? prev.ma20;
    if (ma10 == null) return null;
    const touchedSupport = prev.low <= ma10 * 1.02 && prev.low >= ma10 * 0.97;
    const isRed = c.close > c.open;
    const notBreakLow = c.low >= prev.low; // 今日不破前日低點
    if (!touchedSupport || !isRed || !notBreakLow) return null;
    return {
      type: 'ADD',
      label: '回踩加碼點',
      description: `多頭排列中，前日低點 ${prev.low} 觸及 MA10(${ma10?.toFixed(2)})，今日紅K反彈確認支撐有效`,
      reason: [
        '【書中黃金買點③】「回檔時沒有跌破前面低點，且出現再向上漲的紅K線時」——這是朱家泓4個黃金買點中第③個，也是最理想的進場機會，因為風險最低。',
        '【最佳進場位置】「多頭走勢的進場好時機，是買在回檔止跌再上漲的位置，而不是突破前面高點的位置。因為過高必拉回是多頭的特性。」',
        '【回後買上漲邏輯】「回後買上漲是指上升走勢中，在股價回檔修正後再次上漲時買進，而不是在回檔中自認為是低價就去買。」',
        '【停損設定】以前日低點（剛剛觸及均線的那根K線最低點）為停損基準，若再次跌破，代表支撐失效，應出場。',
        '【回檔幅度判斷】回至0.382止跌最強，回至0.5止跌正常，回至0.618止跌較弱。若回深至0.618後的反彈，後續是否能突破前高仍需觀察。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 跌破月線停損 */
export const breakBelowMA20: TradingRule = {
  id: 'break-below-ma20',
  name: '跌破月線 MA20',
  description: '收盤跌破20日均線（月線）',
  evaluate(candles, index): RuleSignal | null {
    if (!crossedBelow(candles, index, 'ma20')) return null;
    const c = candles[index];
    const isLongBlack = isLongBlackCandle(c);
    return {
      type: 'SELL',
      label: '月線停損訊號',
      description: `收盤 ${c.close} 跌破月線 MA20 (${c.ma20})${isLongBlack ? '，且為實體長黑K' : ''}`,
      reason: [
        '【書中月線規則】「一旦股價跌破月線下方，而且月線下彎，就視為空頭趨勢，做空操作。」——跌破月線是趨勢轉空的重要訊號。',
        '【一條均線戰法出場】「收盤前確認股價跌破20日均線時，出場。」——此為明確的出場信號。',
        isLongBlack
          ? '【長黑加強警示】此根為實體長黑K，代表跌破力道強勁，非洗盤假跌破，建議立即執行停損。書中：「任何操作方法，一定要把停損放在最優先位置。」'
          : '【觀察是否假跌破】若為小實體K棒，可觀察3天內是否回到月線之上（假跌破），若3天內仍未收復，則確認停損。',
        '【停損的重要性】「要在股市生存，一定不能大賠。能夠做到小賠的唯一方法只有停損。停損是進入股市避開危險的煞車機制。」',
        '【多頭高檔 vs 初升段】若跌破時乖離月線已超過-10%，代表本次下跌已有一定幅度，停損後等待打底反彈訊號，不急著再進場。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 跌破季線 MA60 */
export const breakBelowMA60: TradingRule = {
  id: 'break-below-ma60',
  name: '跌破季線 MA60',
  description: '收盤跌破60日均線（季線），進入中期空頭格局',
  evaluate(candles, index): RuleSignal | null {
    if (!crossedBelow(candles, index, 'ma60')) return null;
    const c = candles[index];
    return {
      type: 'SELL',
      label: '強力停損訊號',
      description: `收盤 ${c.close} 跌破季線 MA60 (${c.ma60})，中期空頭格局確認`,
      reason: [
        '【書中季線規則】「股價跌破季線下方，而且季線下彎，就視為空頭趨勢，做空操作。季線是中長期操作的多空分界均線。」',
        '【實際案例印證】書中舉例：「台積電自2022年2月底跌破季線後，進入中期空頭格局，此後股價從600元跌至555元，中期空頭的投資人可以持續做空操作。」',
        '【月線+季線雙死叉危機】若月線也同時位於季線下方（即月線死叉季線），代表中長期雙重空頭確認，後續下跌往往幅度更大、時間更長。',
        '【立即停損，不猶豫】書中強調：「一旦趨勢不再是多頭，持有的多單要在第一時間出場，才能避開後面的大跌走勢。」',
        '【等待轉機訊號】跌破季線後，等待以下訊號才再進場：①低檔底底高型態 ②帶量突破下降切線 ③月線重新站上季線（黃金交叉）。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 跌破 MA5 警告 */
export const breakBelowMA5: TradingRule = {
  id: 'break-below-ma5',
  name: '跌破 MA5',
  description: '收盤跌破5日均線',
  evaluate(candles, index): RuleSignal | null {
    if (!crossedBelow(candles, index, 'ma5')) return null;
    const c = candles[index];
    const aboveMA20 = c.ma20 == null || c.close > c.ma20;
    return {
      type: aboveMA20 ? 'WATCH' : 'SELL',
      label: aboveMA20 ? '短線回檔警示' : '考慮停損',
      description: `收盤 ${c.close} 跌破 MA5 (${c.ma5})，${aboveMA20 ? '仍在月線上方' : '逼近月線支撐'}`,
      reason: [
        '【書中操作法③】「日線多頭MA5均線操作法：出場條件→黑K線收盤跌破MA5均線出場。」——若你使用MA5操作法，這是明確的出場訊號。',
        aboveMA20
          ? '【正常多頭回檔】股價仍在月線之上，按書中邏輯這可能只是多頭中的正常回檔。「多頭走勢總是上漲的多、回跌的少」，觀察是否在MA10或MA20獲得支撐後再上漲。'
          : '【趨勢轉弱警示】股價已跌近月線，若跌破月線則觸發更強的停損訊號。建議先減碼一半，其餘以月線為最後防線。',
        '【操作紀律】「會買股票是徒弟，會賣股票才是師傅。」跌破MA5若不出場，要有明確的理由（如確認為多頭洗盤），否則紀律停損優先。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};
