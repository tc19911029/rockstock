/**
 * 朱家泓《抓住K線 獲利無限》第3篇 — 2根K線看轉折
 * 課程 CH2-06「左藏紅右藏黑」高檔 6 組 + CH2-07「左長黑右長紅」低檔 6 組 = 12 條規則
 * （標準/遭遇/覆蓋/母子/吞噬/貫穿，兩側各 6 組全覆蓋；2026-07-05 補齊兩側標準形態）
 */
import { TradingRule, RuleSignal } from '@/types';
import {
  bodyPct, isMedLongRed, isMedLongBlack, isRedCandle, isBlackCandle,
  isUptrendWave, isDowntrendWave,
} from './ruleUtils';
import { classifyVolume } from '@/lib/analysis/volumePatterns';

// ═══════════════════════════════════════════
// 高檔 2 根 K 線轉折向下（第3篇 Ch1-2）
// ═══════════════════════════════════════════

/** 烏雲蓋頂（高檔覆蓋）— 紅K後黑K開高收低，深入紅K實體但未吞噬 */
export const darkCloudCover: TradingRule = {
  id: 'zhu-dark-cloud-cover',
  name: '烏雲蓋頂（高檔覆蓋）',
  description: '上漲到高檔，紅K後出現開高走低的黑K，收盤深入紅K實體1/2以下',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const red = candles[index - 1];
    const black = candles[index];

    if (!isMedLongRed(red)) return null;
    if (!isBlackCandle(black)) return null;
    if (bodyPct(black) < 0.015) return null;
    // 黑K開高（2026-07-05 對齊課程 CH2-6 第3組口徑：「開高走低收低」＝開盤高於昨日紅K收盤；
    // 舊版要求開盤過昨日最高屬教科書經典定義偏嚴，開在昨收~昨高之間的深覆蓋會漏報）
    if (black.open <= red.close) return null;
    // 黑K收盤深入紅K實體，但未跌破紅K開盤（否則就是吞噬）
    const redHalf = (red.open + red.close) / 2;
    if (black.close > redHalf) return null;   // 沒深入1/2，訊號弱
    if (black.close <= red.open) return null;  // 跌破=吞噬，由其他規則處理
    // 需在高檔
    if (!isUptrendWave(candles, index - 1, 8)) return null;

    return {
      type: 'SELL',
      label: '烏雲蓋頂轉折',
      description: `紅K(${red.close.toFixed(2)})後黑K開高${black.open.toFixed(2)}收低${black.close.toFixed(2)}，深入紅K實體1/2`,
      reason: [
        '【朱家泓《抓住K線》第3篇 高檔覆蓋】烏雲蓋頂是高檔轉折向下的強烈訊號。',
        '黑K收盤越深入紅K實體，反轉的可能性越高。',
        '如果覆蓋當日或前1~2日出現大量，反轉訊號越強。',
        '出現覆蓋後，這2根K線的最高點H和最低點L是重要壓力及支撐觀察點。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 高檔長黑吞噬 — 黑K完全包覆前一日紅K */
export const bearishEngulfingHigh: TradingRule = {
  id: 'zhu-bearish-engulfing-high',
  name: '高檔長黑吞噬',
  description: '上漲到高檔，黑K開高收低完全包覆前一日紅K實體',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const red = candles[index - 1];
    const black = candles[index];

    if (!isRedCandle(red)) return null;
    if (!isMedLongBlack(black)) return null;
    // 黑K實體完全包覆紅K實體
    if (black.open < red.close || black.close > red.open) return null;
    // 需在高檔
    if (!isUptrendWave(candles, index - 1, 8)) return null;

    return {
      type: 'SELL',
      label: '高檔長黑吞噬',
      description: `黑K(${black.open.toFixed(2)}→${black.close.toFixed(2)})完全吞噬紅K(${red.open.toFixed(2)}→${red.close.toFixed(2)})`,
      reason: [
        '【朱家泓《抓住K線》第3篇 高檔吞噬】長黑吞噬是5組向下雙K線轉折訊號中最強的組合。',
        '被吞噬的紅K線越小，吞噬的黑K線越長，轉折力道越強。',
        '吞噬當日或前一日出現大量或窒息量，反轉訊號越強。',
        '一根黑K線一次吞噬前面2~3根紅K線高點（也稱3線反黑），反轉越強。',
        '多單要立刻出場。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 高檔母子懷抱 — 長紅K後出現被包住的小K線 */
export const bearishHaramiHigh: TradingRule = {
  id: 'zhu-bearish-harami-high',
  name: '高檔母子懷抱（變盤警示）',
  description: '上漲到高檔，長紅K後出現不過高也不破低的小K線',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const mother = candles[index - 1]; // 母線：長紅
    const child = candles[index];       // 子線：被包住的小K

    if (!isMedLongRed(mother)) return null;
    // 子線被母線完全包住
    if (child.high > mother.high || child.low < mother.low) return null;
    // 子線實體上限：紅K/十字子線=傳統小子線 ≤2%；黑K子線**不限實體大小**
    // （2026-07-04 修：課程 CH2-6 第4組「左長紅右長黑」母子懷抱，右邊明確是長黑 —
    //   兆易创新 603986 6/23 的 -5.7% 長黑整根被昨日紅K包住即此型，之前被 2% 上限擋掉
    //   而流到貫穿規則誤判硬出場）
    if (!isBlackCandle(child) && bodyPct(child) > 0.02) return null;
    // 需在高檔
    if (!isUptrendWave(candles, index - 1, 8)) return null;

    const isChildDoji = bodyPct(child) < 0.005;
    const isChildLongBlack = isBlackCandle(child) && bodyPct(child) > 0.02;

    return {
      type: 'WATCH',
      label: '高檔母子懷抱（變盤・次日確認）',
      description: `長紅(${mother.close.toFixed(2)})後${isChildDoji ? '十字線' : isChildLongBlack ? '長黑' : '小K'}整根被包住（課程 CH2-6 第4組「不懷好意」）— 止漲變盤，看明日開盤確認`,
      reason: [
        '【朱家泓 課程 CH2-6 高檔懷抱】母子懷抱代表多空開始不安定，走勢突然變得不確定＝止漲（黃燈休息），不是立即出場訊號。',
        `母線高點 ${mother.high.toFixed(2)}／低點 ${mother.low.toFixed(2)} 是攻防線：向上突破 ${mother.high.toFixed(2)} 多方重新掌控、向下跌破 ${mother.low.toFixed(2)} 空方主導下跌。`,
        isChildDoji ? '子線是十字線，反轉力道大於一般母子懷抱，是強力反轉訊號！容易形成高檔夜星轉折。' : '',
        `明日確認：開低＋收黑 → 變盤確認、執行出場；開高不破今日低點 ${child.low.toFixed(2)} → 續抱觀察。`,
      ].filter(Boolean).join('\n'),
      ruleId: this.id,
    };
  },
};

/** 高檔長黑貫穿 — 黑K開高收低，收盤突破前一日紅K實體高點 */
export const bearishPiercingHigh: TradingRule = {
  id: 'zhu-bearish-piercing-high',
  name: '高檔長黑貫穿（一路向下）',
  description: '上漲到高檔，黑K開盤即跌，收盤跌破前一日紅K實體高點',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const red = candles[index - 1];
    const black = candles[index];

    if (!isMedLongRed(red)) return null;
    if (!isMedLongBlack(black)) return null;
    // 黑K收盤至少跌破紅K的開盤價（實體低點）——否則屬覆蓋/遭遇族，由對應規則處理
    if (black.close > red.open) return null;
    // 需在高檔
    if (!isUptrendWave(candles, index - 1, 8)) return null;

    // ── 2026-07-04 修（兆易创新 603986 6/23 誤殺案例）— 對齊課程 CH2-6 六組判準 ──
    // 課程第 6 組「破底貫穿／一路向下」原文＝「開低走低收低**破紅K低點**」：
    // 分界線是「收盤有沒有破昨日最低點(red.low)」，不是破實體開盤價。
    // 沒破低點的（如兆易：收 640.99 > 昨低 635）課程歸第 4 組母子（止漲、次日確認）。

    // 實體吞噬幾何（開高於昨收 + 收破昨開）→ 課程第 5 組，讓給 bearishEngulfingHigh（避免同 bar 雙報）
    if (black.open >= red.close) return null;
    // 整根被昨日紅K包住 → 課程第 4 組母子，讓給 bearishHaramiHigh
    if (black.high <= red.high && black.low >= red.low) return null;

    // 課程第 6 組成立：收盤跌破昨日最低點 = 破底貫穿（一路向下）
    if (black.close < red.low) {
      return {
        type: 'SELL',
        label: '高檔長黑貫穿（破底）',
        description: `黑K收 ${black.close.toFixed(2)} 跌破前日紅K最低 ${red.low.toFixed(2)}，一路向下、多空易位`,
        reason: [
          '【朱家泓 課程 CH2-6 第6組 破底貫穿】開低走低收低破紅K低點＝一路向下，多空主控權易位。',
          '貫穿的黑K線越長，轉折力道越強。',
          '貫穿當日或前一日出現大量，反轉訊號越強；配合大量，容易一日反轉。',
        ].join('\n'),
        ruleId: this.id,
      };
    }

    // 破實體但未破昨日最低：課程歸「止漲變盤」族 — 次日確認，不可當一路向下立即出場
    return {
      type: 'WATCH',
      label: '高檔黑K變盤（破實體未破底，次日確認）',
      description: `黑K收 ${black.close.toFixed(2)} 破昨紅K實體低點 ${red.open.toFixed(2)} 但未破昨日最低 ${red.low.toFixed(2)} — 變盤未確認`,
      reason: [
        '【朱家泓 CH2 次日確認鐵律】未破昨日最低＝不是「破底貫穿」，屬高檔止漲變盤。',
        '次日開盤位置很重要：開高（不破今日低）容易向上反轉續攻，開低或跌破今日最低＝空方確認才出場。',
        '明日開低或收盤跌破今日低點 → 執行出場；明日開高走高 → 續抱。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/**
 * 長黑遭遇 / 一日封口（課程 CH2-06「左藏紅右藏黑」6 組之第 2 組）
 *
 * 黑K開高（跳空高於昨日紅K收盤）走低，收盤≈昨日紅K收盤、開盤缺口當天就回補 → 一日封口。
 * 預設＝止漲（WATCH，黃燈休息）；**一旦伴隨爆大量（classifyVolume blowoff）→ 升級成「主力出貨」加重警示（SELL）**。
 * （課程原句：「遭遇線一旦爆大量，就不是只有止漲，是有人在賣股票，高檔黑K爆大量＝主力出貨。」）
 *
 * 與同檔其他高檔規則互斥的幾何界線（避免重複觸發）：
 *   - 收盤停在紅K實體上半（> redHalf）＝「沒深入」→ 深入紅K實體一半以下由 darkCloudCover（烏雲蓋頂）接手
 *   - 收盤未跌破紅K開盤（>= red.open）＝「沒吞噬/沒貫穿」→ 跌破由 bearishEngulfingHigh / bearishPiercingHigh 接手
 */
export const bearishEncounterHigh: TradingRule = {
  id: 'zhu-bearish-encounter-high',
  name: '長黑遭遇（一日封口）',
  description: '上漲到高檔，紅K後黑K開高走低，收盤回到昨日紅K收盤附近、開盤缺口當天封住',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const red = candles[index - 1];
    const black = candles[index];

    if (!isMedLongRed(red)) return null;
    if (!isBlackCandle(black)) return null;
    if (bodyPct(black) < 0.015) return null;
    // 黑K開高：跳空高於昨日紅K收盤（一日封口的前提＝開盤先有向上缺口）
    if (black.open <= red.close) return null;
    const redHalf = (red.open + red.close) / 2;
    // 收盤≈昨日紅K收盤、缺口回補：停在紅K實體上半（> redHalf），且未創更高收盤（<= 紅K最高）
    if (black.close <= redHalf) return null;   // 深入實體一半以下＝烏雲蓋頂，交給 darkCloudCover
    if (black.close > red.high) return null;    // 收更高＝沒封口、續強，不算遭遇
    // 未跌破紅K開盤（否則就是吞噬/貫穿，交給對應規則）
    if (black.close < red.open) return null;
    // 需在高檔
    if (!isUptrendWave(candles, index - 1, 8)) return null;

    // ── 爆量升級：止漲 → 主力出貨（純出場警示，不進任何選股 gate）──────────────
    const isBlowoff = classifyVolume(candles, index).includes('blowoff');

    if (isBlowoff) {
      return {
        type: 'SELL',
        label: '長黑遭遇爆量（主力出貨）',
        description: `黑K開高${black.open.toFixed(2)}走低收${black.close.toFixed(2)}封住缺口＋爆大量(≥5日均量×2)，主力出貨警示`,
        reason: [
          '【朱家泓 課程 CH2-06 高檔變盤】長黑遭遇（一日封口）＝黑K開高走低、收盤回到昨日紅K收盤附近、開盤缺口當天就封住。',
          '遭遇線一旦「爆大量」就不只是止漲——是有人在不計價賣股票，高檔黑K爆大量＝主力出貨訊號。',
          '出場就是跟著主力一起出場；飆股飆完一定要會跑，別捨不得。',
          '這2根K線的最高點與最低點是重要壓力/支撐；變盤線低點被跌破，後面通常還有一波下跌。',
        ].join('\n'),
        ruleId: this.id,
        subtype: 'exit_strong',
      };
    }

    return {
      type: 'WATCH',
      label: '長黑遭遇（一日封口）',
      description: `黑K開高${black.open.toFixed(2)}走低收${black.close.toFixed(2)}，回到昨日紅K收盤附近、開盤缺口當天封住，止漲警示`,
      reason: [
        '【朱家泓 課程 CH2-06 高檔變盤】長黑遭遇（一日封口）＝黑K開高走低、收盤回到昨日紅K收盤附近、開盤缺口當天就封住，是高檔止漲（黃燈休息）訊號。',
        '次日不一定馬上跌，但要看次日「開低 + 收黑K」確認變盤，兩個都有就提高警覺。',
        '若同時爆大量（5日均量×2）就升級成主力出貨，要立刻出場。',
        '這2根K線的最高點與最低點是重要壓力/支撐；變盤線低點被跌破，後面通常還有一波下跌。',
      ].join('\n'),
      ruleId: this.id,
      subtype: 'warn',
    };
  },
};

// ═══════════════════════════════════════════
// 低檔 2 根 K 線轉折向上（第3篇 Ch3-4）
// ═══════════════════════════════════════════

/** 旭日東升（低檔覆蓋）— 黑K後紅K開低收高，深入黑K實體但未吞噬 */
export const risingSun: TradingRule = {
  id: 'zhu-rising-sun',
  name: '旭日東升（低檔覆蓋）',
  description: '下跌到低檔，黑K後出現開低走高的紅K，收盤深入黑K實體1/2以上',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const black = candles[index - 1];
    const red = candles[index];

    if (!isMedLongBlack(black)) return null;
    if (!isRedCandle(red)) return null;
    if (bodyPct(red) < 0.015) return null;
    // 紅K開盤低於黑K最低價
    if (red.open >= black.low) return null;
    // 紅K收盤深入黑K實體1/2以上
    const blackHalf = (black.open + black.close) / 2;
    if (red.close < blackHalf) return null;    // 沒過1/2，訊號弱
    if (red.close >= black.open) return null;  // 突破=吞噬
    // 需在低檔
    if (!isDowntrendWave(candles, index - 1, 8)) return null;

    return {
      type: 'BUY',
      label: '旭日東升轉折',
      description: `黑K(${black.close.toFixed(2)})後紅K開低${red.open.toFixed(2)}收高${red.close.toFixed(2)}，深入黑K實體1/2`,
      reason: [
        '【朱家泓《抓住K線》第3篇 低檔覆蓋】旭日東升是低檔止跌的K線訊號，要注意是否會轉折向上。',
        '紅K收盤越深入黑K實體，反轉向上的可能性越高。如果突破黑K實體高點，就形成長紅吞噬。',
        '覆蓋的2根K線如有爆大量情形，更容易反轉向上。',
        '出現覆蓋後，走勢出現在H與L之間的橫向盤整，通常多為打底訊號。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 低檔長紅吞噬 — 紅K完全包覆前一日黑K */
export const bullishEngulfingLow: TradingRule = {
  id: 'zhu-bullish-engulfing-low',
  name: '低檔長紅吞噬（主力吸貨）',
  description: '下跌到低檔，紅K開低收高完全包覆前一日黑K實體',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const black = candles[index - 1];
    const red = candles[index];

    if (!isBlackCandle(black)) return null;
    if (!isMedLongRed(red)) return null;
    // 紅K實體完全包覆黑K實體
    if (red.open > black.close || red.close < black.open) return null;
    // 需在低檔
    if (!isDowntrendWave(candles, index - 1, 8)) return null;

    // 檢查是否一次吞噬多根（3線反紅）
    let engulfedCount = 1;
    for (let i = index - 2; i >= Math.max(0, index - 4); i--) {
      if (red.close >= candles[i].high && red.open <= candles[i].low) {
        engulfedCount++;
      } else {
        break;
      }
    }

    return {
      type: 'BUY',
      label: '低檔長紅吞噬',
      description: `紅K(${red.open.toFixed(2)}→${red.close.toFixed(2)})吞噬${engulfedCount > 1 ? engulfedCount + '根' : ''}黑K`,
      reason: [
        '【朱家泓《抓住K線》第3篇 低檔吞噬】長紅吞噬是5組向上雙K線轉折訊號中最強的組合，空單要立刻回補。',
        '被吞噬的黑K越小，吞噬的紅K越長，轉折力道越強。',
        engulfedCount > 1 ? `一根紅K一次吞噬前面${engulfedCount}根K線（3線反紅），反轉越強。` : '',
        '低檔出現爆量長紅吞噬K線後上漲反彈一段，日後再下跌，長紅吞噬的K線會形成重大支撐，容易形成底底高的底部型態。',
      ].filter(Boolean).join('\n'),
      ruleId: this.id,
    };
  },
};

/** 低檔母子懷抱 — 長黑K後出現被包住的小K線 */
export const bullishHaramiLow: TradingRule = {
  id: 'zhu-bullish-harami-low',
  name: '低檔母子懷抱（止跌警示）',
  description: '下跌到低檔，長黑K後出現不過高也不破低的小K線',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const mother = candles[index - 1];
    const child = candles[index];

    if (!isMedLongBlack(mother)) return null;
    if (child.high > mother.high || child.low < mother.low) return null;
    // 子線實體上限：黑K/十字子線=傳統小子線 ≤2%；紅K子線**不限實體大小**
    //（2026-07-04 修：課程 CH2-7 第④組「母子懷抱・光明在望」＝左長黑右長紅，右邊是長紅）
    if (!isRedCandle(child) && bodyPct(child) > 0.02) return null;
    if (!isDowntrendWave(candles, index - 1, 8)) return null;

    const isChildDoji = bodyPct(child) < 0.005;

    return {
      type: 'WATCH',
      label: '低檔母子懷抱',
      description: `長黑(${mother.close.toFixed(2)})後出現${isChildDoji ? '十字線' : '小K'}被完全包住，止跌警示`,
      reason: [
        '【朱家泓《抓住K線》第3篇 低檔懷抱】母子懷抱代表下跌走勢突然變得不確定，空頭下跌力道減弱。',
        '母線長黑K線的最高點是重要觀察位置，向上突破最高點代表多方反轉掌控主動權。',
        isChildDoji ? '子線是十字線，反轉力道大於一般母子懷抱，是強力反轉訊號！容易形成低檔晨星轉折。' : '',
        '出現母子懷抱，次日開盤位置很重要，開高容易向上反轉，開低容易下跌。',
      ].filter(Boolean).join('\n'),
      ruleId: this.id,
    };
  },
};

/** 低檔長紅貫穿 — 紅K開低收高，收盤突破前一日黑K實體高點 */
export const bullishPiercingLow: TradingRule = {
  id: 'zhu-bullish-piercing-low',
  name: '低檔長紅貫穿（一路向上）',
  description: '下跌到低檔，紅K開盤即漲，收盤突破前一日黑K實體高點',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const black = candles[index - 1];
    const red = candles[index];

    if (!isMedLongBlack(black)) return null;
    if (!isMedLongRed(red)) return null;
    // 紅K收盤至少突破黑K的開盤價（實體高點）——否則屬覆蓋（旭日東升）族
    if (red.close < black.open) return null;
    // 需在低檔
    if (!isDowntrendWave(candles, index - 1, 8)) return null;

    // ── 2026-07-04 修 — 對齊課程 CH2-7 六組判準（高檔貫穿的鏡像）──
    // 課程第⑥組「破高貫穿／一路向上」原文＝「一開盤就開高、收盤再過**黑K高點**」：
    // 分界線是「收盤有沒有過昨日最高點(black.high)」，不是過實體開盤價。

    // 實體吞噬幾何（開低於昨收 + 收破昨開）→ 課程第⑤組，讓給 bullishEngulfingLow
    if (red.open <= black.close) return null;
    // 整根被昨日黑K包住 → 課程第④組母子（光明在望），讓給 bullishHaramiLow
    if (red.high <= black.high && red.low >= black.low) return null;

    // 課程第⑥組成立：收盤突破昨日最高點 = 破高貫穿（一路向上）
    if (red.close > black.high) {
      return {
        type: 'BUY',
        label: '低檔長紅貫穿（破高）',
        description: `紅K收 ${red.close.toFixed(2)} 突破前日黑K最高 ${black.high.toFixed(2)}，一路向上、多空易位`,
        reason: [
          '【朱家泓 課程 CH2-7 第⑥組 破高貫穿】一開盤就開高、收盤再過黑K高點＝一路向上、一日反轉。',
          '貫穿的紅K線越長，轉折力道越強。',
          '貫穿當日或前一日出現大量，反轉訊號越強，轉折向上機率越高。',
          '短線連續下跌或急跌獲利達15%以上，出現長紅貫穿，一日反轉的機率很高。',
          '低檔出現爆量長紅貫穿K線後反彈，日後再下跌，長紅貫穿的K線會形成重大支撐，容易形成底底高的底部型態。',
        ].join('\n'),
        ruleId: this.id,
      };
    }

    // 破實體但未破昨日最高：課程歸「止跌變盤」族 — 次日開高收紅才確認反轉
    return {
      type: 'WATCH',
      label: '低檔紅K變盤（破實體未破高，次日確認）',
      description: `紅K收 ${red.close.toFixed(2)} 破昨黑K實體高點 ${black.open.toFixed(2)} 但未破昨日最高 ${black.high.toFixed(2)} — 止跌未確認`,
      reason: [
        '【朱家泓 CH2-7 次日確認】未過昨日最高＝不是「破高貫穿」，屬低檔止跌變盤。',
        '看次日開高收紅才確認反轉；次日開低則止跌失敗、空方續跌。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/**
 * 長紅遭遇 / 一日封口（低檔版）— 課程 CH2-07「左長黑右長紅」6 組之第②組（漏網-1，2026-07-05）
 *
 * 紅K開低（跳空低於昨日黑K收盤）走高，收盤≈昨日黑K收盤、開盤向下缺口當天回補 → 止跌訊號。
 * 對稱高檔 bearishEncounterHigh；低檔遭遇＋大量 = 有人進貨，加強止跌語意（仍 WATCH，
 * 課程：低檔止跌要「次日開高收紅」確認反轉才做多）。
 */
export const bullishEncounterLow: TradingRule = {
  id: 'zhu-bullish-encounter-low',
  name: '長紅遭遇（低檔一日封口）',
  description: '下跌到低檔，黑K後紅K開低走高，收盤回到昨日黑K收盤附近、向下缺口當天封住',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const black = candles[index - 1];
    const red = candles[index];

    if (!isMedLongBlack(black)) return null;
    if (!isRedCandle(red)) return null;
    if (bodyPct(red) < 0.015) return null;
    // 紅K開低：跳空低於昨日黑K收盤（黑K收盤=實體低點）
    if (red.open >= black.close) return null;
    const blackHalf = (black.open + black.close) / 2;
    // 收盤≈昨日黑K收盤附近：站回實體下半（< blackHalf 之上不算，深入上半=旭日東升）
    if (red.close >= blackHalf) return null;   // 深入實體一半以上＝旭日東升，交給 risingSun
    if (red.close < black.low) return null;     // 收更低＝沒封口、續弱
    if (red.close < black.close) return null;   // 至少收回昨收（封住向下缺口）
    // 需在低檔
    if (!isDowntrendWave(candles, index - 1, 8)) return null;

    const isBlowoff = classifyVolume(candles, index).includes('blowoff');

    return {
      type: 'WATCH',
      label: isBlowoff ? '長紅遭遇爆量（低檔有人進貨）' : '長紅遭遇（低檔一日封口）',
      description: `紅K開低${red.open.toFixed(2)}走高收${red.close.toFixed(2)}，封住向下缺口${isBlowoff ? '＋爆大量（主力進貨跡象）' : ''}，止跌訊號`,
      reason: [
        '【朱家泓 課程 CH2-07 低檔變盤】長紅遭遇（一日封口）＝紅K開低走高、收盤回到昨日黑K收盤附近、向下缺口當天封住，是低檔止跌訊號。',
        isBlowoff ? '低檔遭遇爆大量＝有人在買股票（主力進貨），止跌可信度升高。' : '',
        '次日確認：開高＋收紅 → 止跌反轉確認；開低 → 止跌失敗、空方續跌。',
        '這2根K線的最低點是重要支撐；跌破則止跌作廢。',
      ].filter(Boolean).join('\n'),
      ruleId: this.id,
      subtype: 'warn',
    };
  },
};

/** 標準長紅長黑 — 課程 CH2-6 第1組「標準形態」：高低點都跟紅K差不多、彼此沒過＝止漲（6組最弱） */
export const standardRedBlackHigh: TradingRule = {
  id: 'zhu-standard-red-black-high',
  name: '標準長紅長黑（止漲）',
  description: '高檔長紅後接長黑，兩根高低點差不多、彼此沒過 — 6組裡最弱的止漲訊號，次日確認',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const red = candles[index - 1];
    const black = candles[index];

    if (!isMedLongRed(red)) return null;
    if (!isMedLongBlack(black)) return null;
    // 課程原文：「高低點都跟紅K差不多、彼此沒過」（±0.5% 容差 ⚠️ 自創 padding）
    if (black.high > red.high * 1.005 || black.low < red.low * 0.995) return null;
    // 互斥讓位（其他 5 組幾何優先，各自有專屬規則）：
    if (black.close < red.low) return null;                              // 第6組 貫穿
    if (black.open >= red.close && black.close <= red.open) return null; // 第5組 吞噬
    if (black.open > red.high) return null;                              // 第2/3組 遭遇/覆蓋（都開高於紅K高）
    if (black.high <= red.high && black.low >= red.low) return null;     // 第4組 母子（整根被包住）
    // 需在高檔
    if (!isUptrendWave(candles, index - 1, 8)) return null;

    return {
      type: 'WATCH',
      label: '標準長紅長黑（止漲・次日確認）',
      description: `長紅(${red.close.toFixed(2)})後接長黑(${black.close.toFixed(2)})，高低點差不多、彼此沒過（課程 CH2-6 第1組）`,
      reason: [
        '【朱家泓 課程 CH2-6 第1組 標準形態】左長紅右長黑＝止漲，是 6 組紅黑配裡最弱的一組。',
        '課程共同判斷原則：觀察次日，次日開低確認止漲、注意是否轉折下跌；開高則多方仍在。',
        `這兩根的低點 ${Math.min(red.low, black.low).toFixed(2)} 是關鍵防線：被跌破後面容易有一波下跌。`,
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 標準長黑長紅（低檔）— 課程 CH2-7「左長黑右長紅」6 組之第①組鏡像：高低點差不多、彼此沒過＝止跌（6組最弱） */
export const standardBlackRedLow: TradingRule = {
  id: 'zhu-standard-black-red-low',
  name: '標準長黑長紅（低檔止跌）',
  description: '低檔長黑後接長紅，兩根高低點差不多、彼此沒過 — 最弱的止跌訊號，次日確認',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const black = candles[index - 1];
    const red = candles[index];

    if (!isMedLongBlack(black)) return null;
    if (!isMedLongRed(red)) return null;
    // 課程原文（高檔第1組的鏡像）：「高低點都差不多、彼此沒過」（±0.5% 容差 ⚠️ 自創 padding）
    if (red.high > black.high * 1.005 || red.low < black.low * 0.995) return null;
    // 互斥讓位（其他 5 組幾何優先，各自有專屬規則）：
    if (red.close > black.high) return null;                              // 第⑥組 破高貫穿
    if (red.open <= black.close && red.close >= black.open) return null;  // 第⑤組 吞噬
    if (red.open < black.low) return null;                                // 第②/③組 遭遇/旭日東升（都開低於黑K低）
    if (red.high <= black.high && red.low >= black.low) return null;      // 第④組 母子（整根被包住）
    // 需在低檔
    if (!isDowntrendWave(candles, index - 1, 8)) return null;

    return {
      type: 'WATCH',
      label: '標準長黑長紅（止跌・次日確認）',
      description: `長黑(${black.close.toFixed(2)})後接長紅(${red.close.toFixed(2)})，高低點差不多、彼此沒過（課程 CH2-7 第①組鏡像）`,
      reason: [
        '【朱家泓 課程 CH2-7 第①組 標準形態】左長黑右長紅＝止跌，是 6 組黑紅配裡最弱的一組。',
        '課程共同判斷原則：觀察次日，次日開高收紅確認止跌反轉；開低＝止跌失敗、空方續跌。',
        `這兩根的高點 ${Math.max(red.high, black.high).toFixed(2)} 是反轉關卡：突破才算多方接手。`,
      ].join('\n'),
      ruleId: this.id,
      subtype: 'warn',
    };
  },
};

export const TWO_BAR_REVERSAL_RULES: TradingRule[] = [
  darkCloudCover,
  bearishEngulfingHigh,
  bearishHaramiHigh,
  bearishPiercingHigh,
  bearishEncounterHigh,
  standardRedBlackHigh,
  risingSun,
  bullishEngulfingLow,
  bullishHaramiLow,
  bullishPiercingLow,
  bullishEncounterLow,
  standardBlackRedLow,
];
