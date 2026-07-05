import { CandleWithIndicators } from '@/types';
import { findPivots, detectTrend } from '@/lib/analysis/trendAnalysis';
import { halfPrice, isLongRedCandle } from '@/lib/rules/ruleUtils';
import { recentHigh } from '@/lib/indicators';
import { MAX_CANDLE_BODY_PCT, MEDIUM_CANDLE_BODY_MIN } from '@/lib/analysis/bookThresholds';

/**
 * 賠少-5（2026-07-04 體檢補，純顯示標註）：黑 K 三級制（課程 CH2-4/2-5）。
 * 觸發邏輯不變（仍用各 detector 既有門檻），只在 detail 文字標出級別 —
 * 「最大黑 ≥6.5%」比「小黑」警訊重得多，讓使用者一眼分辨。
 */
function blackTierSuffix(c: CandleWithIndicators): string {
  if (!(c.close < c.open) || c.open <= 0) return '';
  const body = (c.open - c.close) / c.open;
  if (body >= MAX_CANDLE_BODY_PCT) return '【最大黑 ≥6.5%】';
  if (body >= MEDIUM_CANDLE_BODY_MIN) return '【中黑】';
  return '【小黑】';
}

/**
 * 賠少-7（2026-07-04 體檢補，純顯示標註）：爆量分級（書本 CH4-07「2~5 倍」區間）。
 * ≥5×=爆天量（最強警訊）、≥2×=爆大量、其餘=大量。不改任何觸發門檻。
 */
function volGradeLabel(volRatio: number | null | undefined): string {
  if (volRatio == null) return '大量';
  if (volRatio >= 5) return '爆天量';
  if (volRatio >= 2) return '爆大量';
  return '大量';
}

export type SellSignalType =
  | 'DEATH_CROSS'         // MA5 crosses below MA20
  | 'HIGH_VOL_UPPER_SHADOW' // High volume + long upper shadow in uptrend
  | 'KD_DEATH_CROSS'      // KD high-level death cross (K crosses below D when both > 70)
  | 'BREAK_MA5'           // Close breaks below MA5 after being above
  | 'BREAK_MA10'          // Close breaks below MA10（朱家泓長短線綜合操作法核心出場線）
  | 'BREAK_MA20'          // Close breaks below MA20 (serious)
  | 'TREND_BEARISH'       // Trend has turned bearish
  // 朱老師獲利方程式（《活用技術分析寶典》p.54）
  | 'LOWER_LOW'           // 收盤出現「頭頭低」
  | 'PROFIT_CLIMAX_EXIT'  // 獲利>20% 或連續急漲+長黑覆蓋
  // 朱老師短線20條守則補充（p.711-712）
  | 'STRONG_COVER'        // 強覆蓋：黑K跌破前日紅K 1/2 + K值下彎（第11條）
  | 'HIGH_VOL_2DAY_3BLACK' // 高檔連2日爆量+回檔連3黑（第14條）
  | 'WEEKLY_RESIST_BREAK_MA5' // 週線遇壓+黑K跌破MA5（第19條）
  | 'SEASON_LINE_DOWN_BREAK' // 季線向下回檔跌破5均（第20條）
  // 寶典 Part 11-1 停損 5 法第 5 條「支阻停損」（p.703）
  | 'SUPPORT_BREAK_STOPLOSS' // 跌破關鍵支撐（前波低點 / 季線 MA60）→ 多單停損
  // 朱家泓 CH4-09 / CH2-04「逃命波」（破月線＋破前低後的反彈＝最後出場機會）
  | 'ESCAPE_WAVE'         // 破月線+破前低後的反彈紅K，未過破壞前高/月線 → 最後逃命
  // 寶典 Part 11-1 停利 / 短線 K 線出場法
  | 'RED_K_LOW_BREAK'     // 收盤跌破最後一根紅 K 低點（寶典短線 K 線出場法）
  // 寶典「自高檔下殺 8 個 K 線訊號」（抓住線圖第 3 篇 p.150-154）
  | 'TRENDLINE_BREAK_BLACK' // 第 1 條：跌破上升切線長黑 K
  | 'HIGH_LEVEL_DOJI'     // 第 3 條：高檔十字 K（次日跌破前一日最低）
  | 'HIGH_LEVEL_HANGING_MAN' // 第 4 條：高檔吊人 K（長下影）
  | 'HIGH_LEVEL_BEARISH_ENGULF' // 第 6 條：高檔陰包陽吞噬
  | 'HIGH_LEVEL_OPEN_FLAT_BLACK' // 第 7 條：高檔開平低（開=昨低）轉長黑
  // 朱家泓 CH2-05/CH2-07/CH4-09：反轉訊號「次日確認」（兩根 K 棒事件窗，降假訊號）
  | 'BLOWOFF_BLACK_CONFIRMED'    // 爆量長黑反轉 + 次日收盤跌破該長黑低點才確認
  // 朱家泓 CH2-01：長上影線紅 K「次日看開盤」— 次日跌破長上影紅 K 低點確認轉弱
  | 'UPPER_SHADOW_NEXTDAY_BREAK' // 高檔長上影紅K 次日收盤跌破其低點確認
  // 課程 CH9-3(一)（2026-07-04）：跌破高檔連續兩日大量 K 線的低點（一日反轉）→ 多單停利
  | 'HIGH_VOL_2DAY_LOW_BREAK'
  // 課程 CH2-6/2-9（2026-07-05 漏網-2）：高檔「該漲不漲就是跌」— 連 3 根動能停滯
  | 'PRICE_STALL_HIGH'
  // 課程 CH2-9（2026-07-05 漏網-4）：「預壓有壓」— 盤中觸及具體壓力位未過、收回留上影
  | 'PRESSURE_REJECT_SHADOW'
  // Wave2 進場-11（回測過關）：帶量突破紅K 後 T+1/T+2 黑K收盤跌破其 1/2 價 = 假突破
  | 'FALSE_BREAKOUT_FAIL'; // 假突破跌破1/2價（持倉端避雷出場，不接進場 gate）

export interface SellSignal {
  type: SellSignalType;
  label: string;
  detail: string;
  severity: 'high' | 'medium' | 'low';
}

// ════════════════════════════════════════════════════════════════
// 書本嚴重度排序（賠少-13，對齊朱家泓 CH1-07 / 寶典停損 5 法）
//   書本明示：「跌破前波低點」破壞多頭結構，比「跌破月線」更嚴重。
//   兩者 detector 都標 severity:'high'，但消費端（holdingVerdict 取 sellHigh[0]、
//   SixConditionsPanel 依陣列序顯示）只看「同 high 內誰排前」。
//   這裡在 detectSellSignals 末端做穩定排序：把「破前低/支撐」類擺在「破月線」之前，
//   讓 verdict 報的第一個 high 與 UI 第一條警示都對齊書本。純顯示/優先序層，不改任何 gate。
// ════════════════════════════════════════════════════════════════
//
// rank 越小＝越重（越靠前）。未列出的訊號用 DEFAULT_SELL_RANK，保留原相對序（穩定排序）。
const SELL_SEVERITY_RANK: Partial<Record<SellSignalType, number>> = {
  // 趨勢結構破壞（最重）— 空頭確認 / 頭頭低
  TREND_BEARISH: 0,
  LOWER_LOW: 1,
  // 關鍵支撐跌破：前波低點 / 季線（書本「跌破前低」比「跌破月線」重）
  SUPPORT_BREAK_STOPLOSS: 2,
  ESCAPE_WAVE: 3,
  // 月線保護線失守（比前低輕）
  BREAK_MA20: 4,
};
const DEFAULT_SELL_RANK = 3.5; // 介於支撐破壞與月線之間，未分級者維持既有相對序

function sellSeverityRank(t: SellSignalType): number {
  return SELL_SEVERITY_RANK[t] ?? DEFAULT_SELL_RANK;
}

/**
 * 偵測出場/賣出訊號（朱老師出場原則）
 * 嚴重程度：high = 立即出場考慮，medium = 警戒，low = 觀察
 */
export function detectSellSignals(
  candles: CandleWithIndicators[],
  index: number,
): SellSignal[] {
  if (index < 5) return [];
  const signals: SellSignal[] = [];

  const c     = candles[index];
  const prev  = candles[index - 1];
  const _prev2 = candles[index - 2];

  const ma5  = c.ma5;
  const ma20 = c.ma20;
  const kd_k = c.kdK;
  const kd_d = c.kdD;
  const prevMa5  = prev?.ma5;
  const prevMa20 = prev?.ma20;
  const prevKdK  = prev?.kdK;
  const prevKdD  = prev?.kdD;

  // 1. 死亡交叉：MA5 剛剛跌破 MA20
  if (ma5 != null && ma20 != null && prevMa5 != null && prevMa20 != null) {
    if (prevMa5 >= prevMa20 && ma5 < ma20) {
      signals.push({
        type: 'DEATH_CROSS',
        label: '死亡交叉',
        detail: `MA5(${ma5.toFixed(2)}) 跌破 MA20(${ma20.toFixed(2)})，趨勢轉弱訊號`,
        severity: 'high',
      });
    }
  }

  // 2. KD 高位死叉：K 從高位（>80，書本超買標準）向下交叉 D
  if (kd_k != null && kd_d != null && prevKdK != null && prevKdD != null) {
    if (prevKdK > 80 && prevKdK >= prevKdD && kd_k < kd_d) {
      signals.push({
        type: 'KD_DEATH_CROSS',
        label: 'KD高位死叉',
        detail: `KD K(${kd_k.toFixed(1)}) 在高位死叉 D(${kd_d.toFixed(1)})，短線過熱回落`,
        severity: 'medium',
      });
    }
  }

  // 3. 跌破 MA20（嚴重警訊）
  // ⚠️ 自創 padding（書本沒明寫 1% 緩衝）— 0513 ABCDE D 標自創
  // 防止 MA20 接近時的 noise（如 prev.close=100、prev.ma20=100.5，c.close=100.4，c.ma20=100.6 算跌破？）
  // 0.99 給 1% 緩衝；未來考慮改 ATR-based 或統一搬 bookThresholds
  if (ma20 != null && prev?.ma20 != null) {
    if (prev.close >= prev.ma20 * 0.99 && c.close < ma20 * 0.99) {
      signals.push({
        type: 'BREAK_MA20',
        label: '跌破月線',
        detail: `收盤(${c.close}) 跌破 MA20(${ma20.toFixed(2)})，多頭保護線失守`,
        severity: 'high',
      });
    }
  }

  // 4. 跌破 MA5（輕度警示）
  // 漏網-5（2026-07-05）：課程 CH1-5「紅K收盤跌破5均比黑K跌破更要警覺」— 連紅K都收不住＝更弱，文字加註
  if (ma5 != null && prev?.ma5 != null) {
    if (prev.close >= prev.ma5 && c.close < ma5 && c.close >= (ma20 ?? 0)) {
      const redButBroke = c.close > c.open ? '（⚠️ 紅K仍收破5均 — 課程：比黑K跌破更弱）' : '';
      signals.push({
        type: 'BREAK_MA5',
        label: '跌破週線MA5',
        detail: `收盤(${c.close}) 跌破 MA5(${ma5.toFixed(2)})，短線動能轉弱${redButBroke}`,
        severity: 'low',
      });
    }
  }

  // 5. 高檔爆量長上影線：量比 > 1.5x，上影線 > 實體的 2倍，且在多頭中
  const body = Math.abs(c.close - c.open);
  const upperShadow = c.high - Math.max(c.close, c.open);
  const volRatio5 = (() => {
    const vols = candles.slice(Math.max(0, index - 5), index).map(x => x.volume).filter(v => v > 0);
    if (vols.length === 0) return null;
    return c.volume / (vols.reduce((a, b) => a + b, 0) / vols.length);
  })();
  if (body > 0 && upperShadow > body * 2 && (volRatio5 ?? 0) > 1.5 && ma5 != null && ma20 != null && ma5 > ma20) {
    signals.push({
      type: 'HIGH_VOL_UPPER_SHADOW',
      label: '高檔爆量上影線',
      detail: `量比 ${(volRatio5 ?? 0).toFixed(1)}x，上影線為實體 ${(upperShadow / body).toFixed(1)} 倍，主力出貨警訊`,
      severity: 'high',
    });
  }

  // 6. 趨勢轉空
  // (imported separately via detectTrend, so we check MA cross as proxy)

  // ════════════════════════════════════════════════════════════════
  // 朱老師獲利方程式（《活用技術分析寶典》p.54）
  // ════════════════════════════════════════════════════════════════

  // 獲利方程式 第3條：收盤出現「頭頭低」→ 出場
  // 偵測：近期兩個波段高點，後面的高點比前面低
  if (index >= 10) {
    const recentHighs: { idx: number; price: number }[] = [];
    for (let i = index - 1; i >= Math.max(1, index - 20) && recentHighs.length < 3; i--) {
      const ci = candles[i];
      const pi = candles[i - 1];
      const ni = candles[i + 1];
      if (ci.high > pi.high && ci.high > ni.high) {
        recentHighs.push({ idx: i, price: ci.high });
      }
    }
    if (recentHighs.length >= 2) {
      const [newerHigh, olderHigh] = recentHighs;
      // 事件型觸發：頭頭低成立 + 今日為「自 newerHigh 形成以來首次 close < newerHigh」。
      // 之後每天即使 close < newerHigh 也不重複報（避免持續狀態 noise）。
      let firstBreakIdx = -1;
      if (newerHigh.price < olderHigh.price) {
        for (let i = newerHigh.idx + 1; i <= index; i++) {
          if (candles[i].close < newerHigh.price) { firstBreakIdx = i; break; }
        }
      }
      if (firstBreakIdx === index) {
        signals.push({
          type: 'LOWER_LOW',
          label: '頭頭低出場',
          detail: `近期高點${olderHigh.price.toFixed(1)}→${newerHigh.price.toFixed(1)}頭頭低，多頭力竭`,
          severity: 'high',
        });
      }
    }
  }

  // 獲利方程式 第7條：連續急漲3天+大量長黑K覆蓋或吞噬 → 當天出場
  if (index >= 3) {
    const prev3Up = [candles[index-1], candles[index-2], candles[index-3]]
      .every(x => x.close > x.open);
    const isLongBlack = c.close < c.open && body > 0 && (c.open - c.close) / c.open >= 0.02;
    const bigVolume = (volRatio5 ?? 0) > 1.5;

    if (prev3Up && isLongBlack && bigVolume) {
      signals.push({
        type: 'PROFIT_CLIMAX_EXIT',
        label: '急漲後長黑出場',
        detail: `連續3日急漲後出現${volGradeLabel(volRatio5)}長黑K覆蓋（量比 ${(volRatio5 ?? 0).toFixed(1)}x）${blackTierSuffix(c)}，主力出貨訊號`,
        severity: 'high',
      });
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 反轉訊號「次日確認」（朱家泓 CH2-05/CH2-07/CH4-09）
  //   書本：反轉訊號要「次日收盤跌破該訊號 K 棒低點」才確認，降假訊號。
  //   引入 2 根 K 棒事件窗 — 昨日是反轉 K、今日收盤跌破其低點才報。
  //   量比口徑沿用上方 volRatio5（5 日均量），不新增魔術數。
  // ════════════════════════════════════════════════════════════════
  if (prev) {
    // 昨日相對「前 5 日均量」的量比（與當日 volRatio5 同口徑，視窗位移一根）
    const prevVolRatio5 = (() => {
      const vols = candles.slice(Math.max(0, index - 6), index - 1).map(x => x.volume).filter(v => v > 0);
      if (vols.length === 0) return null;
      return prev.volume / (vols.reduce((a, b) => a + b, 0) / vols.length);
    })();
    const prevBody = Math.abs(prev.close - prev.open);
    const prevBodyPct = prev.open > 0 ? prevBody / prev.open : 0;
    const prevUpperShadow = prev.high - Math.max(prev.close, prev.open);
    const prevInHigh = prev.ma5 != null && prev.ma20 != null && prev.ma5 > prev.ma20;

    // 賠少-6：爆量長黑反轉 + 次日確認 — 昨日爆量長黑(實體≥2%)，今日收盤跌破昨低
    const prevBlowoffBlack = prev.close < prev.open
      && prevBodyPct >= 0.02
      && (prevVolRatio5 ?? 0) > 1.5;
    if (prevBlowoffBlack && c.close < prev.low) {
      signals.push({
        type: 'BLOWOFF_BLACK_CONFIRMED',
        label: '爆量長黑反轉(次日確認)',
        detail: `昨日${volGradeLabel(prevVolRatio5)}長黑(量比 ${(prevVolRatio5 ?? 0).toFixed(1)}x)${blackTierSuffix(prev)}，今日收盤 ${c.close.toFixed(2)} 跌破昨日低 ${prev.low.toFixed(2)}，反轉確認`,
        severity: 'high',
      });
    }

    // 賠少-19：高檔長上影紅K「次日看開盤」— 昨日高檔爆量長上影紅K，今日收盤跌破昨低確認轉弱
    const prevHighVolUpperShadow = prevInHigh
      && prev.close > prev.open                  // 紅 K（當天即使收漲也是警訊）
      && prevBody > 0
      && prevUpperShadow > prevBody * 2
      && (prevVolRatio5 ?? 0) > 1.5;
    if (prevHighVolUpperShadow && c.close < prev.low) {
      signals.push({
        type: 'UPPER_SHADOW_NEXTDAY_BREAK',
        label: '長上影紅K次日破低',
        detail: `昨日高檔爆量長上影紅K(警訊)，今日收盤 ${c.close.toFixed(2)} 跌破昨日低 ${prev.low.toFixed(2)}，次日看開盤已轉弱確認`,
        severity: 'high',
      });
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 朱老師短線20條守則補充（《活用技術分析寶典》p.711-712）
  // ════════════════════════════════════════════════════════════════

  // 第11條：強覆蓋 — 遇壓黑K下跌，跌破前一日紅K的二分之一，K值下彎 → 減碼警示
  if (prev && prev.close > prev.open && c.close < c.open) {
    const prevMidPrice = (prev.open + prev.close) / 2;
    const kdDownTurn = kd_k != null && prevKdK != null && kd_k < prevKdK;
    if (c.close < prevMidPrice && kdDownTurn) {
      signals.push({
        type: 'STRONG_COVER',
        label: '強覆蓋減碼',
        detail: `黑K跌破前日紅K 1/2(${prevMidPrice.toFixed(1)})，KD下彎，可減碼一半`,
        severity: 'medium',
      });
    }
  }

  // 第14條：高檔連2日爆量，回檔連3黑 → 不宜進場
  if (index >= 5) {
    // 找近5日是否有連2日爆量
    let has2DayBigVol = false;
    for (let i = index - 4; i < index - 1; i++) {
      const v1 = candles[i];
      const v2 = candles[i + 1];
      const avg = c.avgVol5;
      if (avg && v1.volume >= avg * 1.5 && v2.volume >= avg * 1.5) {
        has2DayBigVol = true;
        break;
      }
    }
    // 近3日連續收黑
    const last3Black = [candles[index], candles[index-1], candles[index-2]]
      .every(x => x.close < x.open);
    if (has2DayBigVol && last3Black) {
      signals.push({
        type: 'HIGH_VOL_2DAY_3BLACK',
        label: '爆量後連3黑',
        detail: `高檔連2日爆量後回檔連3黑，不宜進場做多`,
        severity: 'high',
      });
    }
  }

  // 第19條：週線接近壓力 + 日線出現黑K跌破MA5 → 多單要先出場
  // 用MA60作為週線壓力的近似（60日≈12週）
  if (c.ma60 != null && ma5 != null && c.close < c.open) {
    const nearMa60 = c.ma60 > c.close && (c.ma60 - c.close) / c.close < 0.05;
    const breakMa5 = prev && prev.ma5 != null && prev.close >= prev.ma5 && c.close < ma5;
    if (nearMa60 && breakMa5) {
      signals.push({
        type: 'WEEKLY_RESIST_BREAK_MA5',
        label: '遇壓破MA5',
        detail: `接近MA60(${c.ma60.toFixed(1)})壓力位，黑K跌破MA5(${ma5.toFixed(1)})，多單先出場`,
        severity: 'high',
      });
    }
  }

  // 第20條：季線(MA60)向下 + 回檔跌破5均 → 即使漲幅未達10%也要先出場
  if (c.ma60 != null && ma5 != null && index >= 5) {
    const prevMa60_5 = candles[index - 5]?.ma60;
    const ma60Declining = prevMa60_5 != null && c.ma60 < prevMa60_5;
    const breakMa5Now = prev && prev.ma5 != null && prev.close >= prev.ma5 && c.close < ma5;
    // 股價在MA60之上（已突破季線但季線仍向下）
    const aboveMa60 = c.close > c.ma60;
    if (ma60Declining && breakMa5Now && aboveMa60) {
      signals.push({
        type: 'SEASON_LINE_DOWN_BREAK',
        label: '季線下彎破5均',
        detail: `MA60(${c.ma60.toFixed(1)})仍下彎，回檔跌破MA5(${ma5.toFixed(1)})，多單先出場`,
        severity: 'medium',
      });
    }
  }

  // 註：寶典 p.711 第 18 條「獲利>10%+跌破MA5 停利」已由 zhuRules.ts 的 zhuTakeProfit10Pct 處理
  // 該規則用 ctx.avgCost（持倉成本）作為錨點，符合書本本意
  // 此處不再用「近 20 日最低收盤」當錨點（會誤觸，使用者不一定買在起漲點）

  // ════════════════════════════════════════════════════════════════
  // 朱家泓「長短線綜合操作法」核心出場線：跌破 MA10
  //   寶典 Part 11-1 停損 5 法第 3 條 + 5 步驟步驟 4 第 6 章策略 3
  //   多頭跌破 MA10 → 停利出場（MA10 是中短線分界）
  // ════════════════════════════════════════════════════════════════
  if (c.ma10 != null && prev?.ma10 != null) {
    if (prev.close >= prev.ma10 && c.close < c.ma10) {
      signals.push({
        type: 'BREAK_MA10',
        label: '跌破MA10',
        detail: `收盤(${c.close}) 跌破 MA10(${c.ma10.toFixed(2)})，朱家泓綜合操作法停利線`,
        severity: 'high',
      });
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 寶典 Part 11-1 短線 K 線出場法：收盤跌破最後一根「中長紅 K」低點
  //   找近 5 根中最後一根中長紅 K（實體 ≥ 2%），收盤跌破該紅 K low → 短線出場
  //   事件型：今日為「自該紅 K 形成以來首次 close < lastRedK.low」才報
  // ════════════════════════════════════════════════════════════════
  if (index >= 5) {
    let lastRedKIdx = -1;
    for (let i = index - 1; i >= Math.max(0, index - 5); i--) {
      const k = candles[i];
      const kBodyPct = k.open > 0 ? (k.close - k.open) / k.open : 0;
      if (k.close > k.open && kBodyPct >= 0.02) { lastRedKIdx = i; break; }
    }
    if (lastRedKIdx >= 0) {
      const lastRedK = candles[lastRedKIdx];
      // 自 lastRedK 形成後首次 close < lastRedK.low 才觸發
      let firstBreakIdx = -1;
      for (let i = lastRedKIdx + 1; i <= index; i++) {
        if (candles[i].close < lastRedK.low) { firstBreakIdx = i; break; }
      }
      if (firstBreakIdx === index) {
        signals.push({
          type: 'RED_K_LOW_BREAK',
          label: '跌破紅K低點',
          detail: `收盤(${c.close}) 跌破近期中長紅 K(${lastRedK.date}) 低點 ${lastRedK.low.toFixed(2)}，短線 K 線出場法`,
          severity: 'high',
        });
      }
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 寶典「自高檔下殺 8 個 K 線訊號」（抓住線圖第 3 篇 p.150-154）
  //   高檔判定：MA5 > MA20（多頭中），且非低檔
  // ════════════════════════════════════════════════════════════════
  const isHighLevel = ma5 != null && ma20 != null && ma5 > ma20;

  // 第 1 條：跌破上升切線長黑 K（用 MA20 上升 + 黑K跌破前 2 日最低當近似切線）
  // 事件型 dedup：若昨日 close 已 < 昨日的 prev2Low（前天昨天兩根低點較小者），
  // 表示切線昨日已破，今日是續跌而非新破，不重複觸發。
  if (isHighLevel && index >= 22) {
    const ma20Up = c.ma20 != null && candles[index - 5]?.ma20 != null && c.ma20 > candles[index - 5].ma20!;
    const isLongBlack = c.close < c.open && c.open > 0 && (c.open - c.close) / c.open >= 0.02;
    const prev2Low = Math.min(candles[index - 1]?.low ?? Infinity, candles[index - 2]?.low ?? Infinity);
    const prevPrev2Low = Math.min(candles[index - 2]?.low ?? Infinity, candles[index - 3]?.low ?? Infinity);
    const trendAlreadyBroken = prev != null && prev.close < prevPrev2Low;
    if (ma20Up && isLongBlack && c.close < prev2Low && !trendAlreadyBroken) {
      signals.push({
        type: 'TRENDLINE_BREAK_BLACK',
        label: '跌破切線長黑',
        detail: `上升趨勢中長黑K${blackTierSuffix(c)}收 ${c.close.toFixed(2)} 跌破前 2 日最低 ${prev2Low.toFixed(2)}（寶典 8 下殺第 1 條）`,
        severity: 'high',
      });
    }
  }

  // 第 3 條：高檔十字 K → 次日跌破前一日最低 確認
  //   今日 K 是「昨日是十字」+ 今日跌破昨日最低
  if (isHighLevel && prev) {
    const prevBody = Math.abs(prev.close - prev.open);
    const prevRange = prev.high - prev.low;
    const isPrevDoji = prevRange > 0 && prevBody / prevRange < 0.1; // 實體 < range 10% 視為十字
    if (isPrevDoji && c.close < prev.low) {
      signals.push({
        type: 'HIGH_LEVEL_DOJI',
        label: '高檔十字後破低',
        detail: `昨日高檔十字 K，今日收盤 ${c.close.toFixed(2)} 跌破昨日最低 ${prev.low.toFixed(2)}（寶典 8 下殺第 3 條）`,
        severity: 'high',
      });
    }
  }

  // 第 4 條：高檔吊人 K（長下影 + 短實體 + 短上影） → 跌破前一日最低
  //   昨日是吊人，今日跌破昨日最低
  if (isHighLevel && prev) {
    const prevBody = Math.abs(prev.close - prev.open);
    const prevUpper = prev.high - Math.max(prev.close, prev.open);
    const prevLower = Math.min(prev.close, prev.open) - prev.low;
    const isHangingMan = prevBody > 0
      && prevLower >= prevBody * 2
      && prevUpper <= prevBody * 0.5;
    if (isHangingMan && c.close < prev.low) {
      signals.push({
        type: 'HIGH_LEVEL_HANGING_MAN',
        label: '高檔吊人破低',
        detail: `昨日高檔吊人 K（長下影），今日跌破昨日最低 ${prev.low.toFixed(2)}（寶典 8 下殺第 4 條）`,
        severity: 'high',
      });
    }
  }

  // 第 6 條：高檔陰包陽（吞噬）
  //   書本原文：「當日創新高、收盤跌破前最低」
  //   = 今日吞噬昨日紅 K + 創新高 + 收盤跌破昨日最低
  if (isHighLevel && prev) {
    const isPrevRed = prev.close > prev.open;
    const isCurBlack = c.close < c.open;
    const newHighToday = c.high > prev.high;
    const engulf = c.open >= prev.close && c.close <= prev.open; // 今日黑K包覆昨日紅K
    const breakPrevLow = c.close < prev.low; // 書本明列「收盤跌破前最低」
    if (isPrevRed && isCurBlack && newHighToday && engulf && breakPrevLow) {
      signals.push({
        type: 'HIGH_LEVEL_BEARISH_ENGULF',
        label: '高檔陰包陽',
        detail: `今日創新高 ${c.high.toFixed(2)} 後收長黑吞噬昨日紅K，收盤跌破昨日低 ${prev.low.toFixed(2)}（寶典 8 下殺第 6 條）`,
        severity: 'high',
      });
    }
  }

  // 第 7 條：高檔開平低轉長黑 — 開盤=昨日最低（開低）一路拉長黑
  if (isHighLevel && prev && c.open > 0) {
    const openEqualsPrevLow = Math.abs(c.open - prev.low) / prev.low < 0.005; // 開盤近昨低 0.5% 內
    const isLongBlack = c.close < c.open && (c.open - c.close) / c.open >= 0.02;
    if (openEqualsPrevLow && isLongBlack) {
      signals.push({
        type: 'HIGH_LEVEL_OPEN_FLAT_BLACK',
        label: '高檔開平低長黑',
        detail: `開盤 ${c.open.toFixed(2)} ≈ 昨日最低 ${prev.low.toFixed(2)}，一路拉長黑收 ${c.close.toFixed(2)}（寶典 8 下殺第 7 條）`,
        severity: 'high',
      });
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 課程 CH9-3(一)（2026-07-04）：跌破高檔連續兩日大量 K 線的低點 → 多單停利
  //   高檔出現「爆大量 + 爆次大量」連續兩日，其低點是多空攻防線；
  //   收盤首次跌破兩根大量 K 線低點（課程圖標「一日反轉」）→ 停利。
  //   爆量口徑沿用本檔 avgVol5 × 1.5（同第 14 條）；事件型 dedup 沿用 firstBreak 模式。
  // ════════════════════════════════════════════════════════════════
  if (isHighLevel && index >= 12) {
    // 回看 10 根內找最近的「連續兩日皆爆量」K 線對（不含今日）
    let pairIdx = -1; // 兩日對的第二根 index
    for (let i = index - 1; i >= Math.max(1, index - 10); i--) {
      const a = candles[i - 1];
      const b = candles[i];
      if (a.avgVol5 != null && a.avgVol5 > 0 && b.avgVol5 != null && b.avgVol5 > 0
        && a.volume >= a.avgVol5 * 1.5 && b.volume >= b.avgVol5 * 1.5) {
        pairIdx = i;
        break;
      }
    }
    if (pairIdx > 0) {
      const clusterLow = Math.min(candles[pairIdx - 1].low, candles[pairIdx].low);
      // 事件型：自兩日大量形成後「首次」收盤跌破其低點才報，續跌不重複
      let firstBreakIdx = -1;
      for (let i = pairIdx + 1; i <= index; i++) {
        if (candles[i].close < clusterLow) { firstBreakIdx = i; break; }
      }
      if (firstBreakIdx === index) {
        signals.push({
          type: 'HIGH_VOL_2DAY_LOW_BREAK',
          label: '跌破兩日大量低點(9-3停利)',
          detail: `高檔連兩日大量（${candles[pairIdx - 1].date}/${candles[pairIdx].date}），今日收盤 ${c.close.toFixed(2)} 首次跌破兩日大量低點 ${clusterLow.toFixed(2)}，課程 CH9-3(一) 多單停利`,
          severity: 'high',
        });
      }
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 課程 CH2-9（2026-07-05 漏網-4）：「預壓有壓」— 盤中觸及**具體壓力位**（前波高/季線）
  //   沒過、收回留長上影 → 該壓力有效，次日不可跌破今日低點。
  //   與 HIGH_VOL_UPPER_SHADOW 差異：這條驗「觸及哪個 SR」（課程核心），不看量。
  // ════════════════════════════════════════════════════════════════
  if (isHighLevel && index >= 21) {
    const upperShadowLen2 = c.high - Math.max(c.open, c.close);
    const bodyLen2 = Math.abs(c.close - c.open);
    if (bodyLen2 > 0 && upperShadowLen2 > bodyLen2) {
      // 觸到哪個壓力？(a) 前波 pivot high (b) 上方季線 MA60
      const pvs = findPivots(candles, index - 1, 8);
      const ph = pvs.find(p => p.type === 'high' && p.price > c.close);
      let pressureName = '';
      let pressureVal = 0;
      if (ph && c.high >= ph.price * 0.995 && c.close < ph.price) {
        pressureName = `前波高 ${ph.price.toFixed(2)}`;
        pressureVal = ph.price;
      } else if (c.ma60 != null && c.ma60 > c.close && c.high >= c.ma60 * 0.995) {
        pressureName = `季線 MA60 ${c.ma60.toFixed(2)}`;
        pressureVal = c.ma60;
      }
      if (pressureVal > 0) {
        signals.push({
          type: 'PRESSURE_REJECT_SHADOW',
          label: '預壓有壓（觸壓收回）',
          detail: `盤中觸及 ${pressureName} 未過、收回留上影 — 課程 CH2-9：該壓力有效，明日不可跌破今日低點 ${c.low.toFixed(2)}，跌破則回檔展開`,
          severity: 'medium',
        });
      }
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 課程 CH2-6/2-9（2026-07-05 漏網-2）：高檔「該漲不漲就是跌」
  //   純價格動能停滯：連 3 根收盤都「沒過前一根最高、也沒破前一根最低」＝多方推不動。
  //   高檔（isHighLevel）才報；帶量版另有 淘汰9/hasConsecBlowoffNoRise。
  //   事件型：恰好湊滿 3 根當天報一次（第 4 根起不重複）。
  // ════════════════════════════════════════════════════════════════
  if (isHighLevel && index >= 4) {
    const isStallBar = (i: number) =>
      candles[i].close <= candles[i - 1].high && candles[i].close >= candles[i - 1].low;
    const stall3 = isStallBar(index) && isStallBar(index - 1) && isStallBar(index - 2);
    const wasStallYesterday = isStallBar(index - 1) && isStallBar(index - 2) && isStallBar(index - 3);
    if (stall3 && !wasStallYesterday) {
      signals.push({
        type: 'PRICE_STALL_HIGH',
        label: '高檔該漲不漲（動能停滯）',
        detail: `連 3 根收盤未過前根最高也未破前根最低 — 課程 CH2：「該漲不漲就是跌」，高檔推不動要警覺，跌破 3 根中最低點 ${Math.min(candles[index].low, candles[index - 1].low, candles[index - 2].low).toFixed(2)} 先出`,
        severity: 'medium',
      });
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 5 步驟絕對停損 6 情況之第 1 條：走勢轉空頭確認 → TREND_BEARISH
  //   detectTrend 已可判斷，這裡作為 sell signal 透出
  // ════════════════════════════════════════════════════════════════
  if (index >= 21) {
    const trendNow = detectTrend(candles, index);
    const trendPrev = detectTrend(candles, index - 1);
    if (trendPrev !== '空頭' && trendNow === '空頭') {
      signals.push({
        type: 'TREND_BEARISH',
        label: '空頭趨勢確認',
        detail: `走勢由 ${trendPrev} 轉「空頭」確認（頭頭低底底低），絕對停損出場`,
        severity: 'high',
      });
    }
  }

  // 寶典 Part 11-1 停損 5 法第 5 條「支阻停損」（p.703）
  // 做多時關鍵支撐跌破停損。支撐來源（寶典 Part 6）：月線/季線、上升切線、前低、下方大量跳空缺口
  // 月線跌破已由 BREAK_MA20 涵蓋，這裡補：(1) 跌破前波低點 (2) 跌破季線 MA60
  if (index >= 21) {
    const reasons: string[] = [];

    // (1) 跌破前波低點（findPivots 最近的 low pivot）— 破壞多頭結構
    // 限制：之前股價有站上該低點之上（避免本來就在低點下方的個股誤觸）
    const pivots = findPivots(candles, index - 1, 8);
    const lastLow = pivots.find(p => p.type === 'low');
    if (lastLow && prev && prev.close >= lastLow.price && c.close < lastLow.price) {
      reasons.push(`跌破前波低點 ${lastLow.price.toFixed(2)}`);
    }

    // (2) 跌破季線 MA60（中長期支撐）
    if (c.ma60 != null && prev?.ma60 != null && prev.close >= prev.ma60 && c.close < c.ma60) {
      reasons.push(`跌破季線 MA60(${c.ma60.toFixed(2)})`);
    }

    if (reasons.length > 0) {
      signals.push({
        type: 'SUPPORT_BREAK_STOPLOSS',
        label: '關鍵支撐跌破',
        detail: `${reasons.join('、')}，依寶典停損 5 法第 5 條「支阻停損」多單應出場`,
        severity: 'high',
      });
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 朱家泓 CH4-09 / CH2-04「逃命波」（破月線＋破前低後的反彈）
  //   書本：股價先跌破月線(MA20)、再跌破最近前波低點（雙線/雙重支撐破壞），
  //   隨後出現「反彈紅 K」但收盤未過「破壞前的前波高」也未站回月線
  //   → 這是最後一波逃命機會，禁止做多、多單該出場。
  //   容差沿用：MA20 緩衝 0.99（同 BREAK_MA20）、findPivots window 8（同 SUPPORT_BREAK_STOPLOSS）。
  //   嚴重度 high → holdingVerdict 自動判「該出場」，不必改決策樹。
  // ════════════════════════════════════════════════════════════════
  if (index >= 21 && ma20 != null) {
    const isReboundRedK = c.close > c.open;            // 當前為反彈紅 K
    if (isReboundRedK) {
      // (1) 近期曾跌破月線（回看窗內任一日 close < 其 MA20*0.99）
      let brokeMa20Recently = false;
      for (let i = index - 1; i >= Math.max(1, index - 10); i--) {
        const k = candles[i];
        if (k.ma20 != null && k.close < k.ma20 * 0.99) { brokeMa20Recently = true; break; }
      }

      // (2) 已跌破最近前波低點（findPivots low pivot，邏輯同 SUPPORT_BREAK_STOPLOSS）
      //     在「當前反彈日之前」窗內曾出現 close < 該前低
      const pivots = findPivots(candles, index - 1, 8);
      const lastLow = pivots.find(p => p.type === 'low');
      let brokePivotLow = false;
      if (lastLow) {
        for (let i = lastLow.index + 1; i <= index - 1; i++) {
          if (candles[i].close < lastLow.price) { brokePivotLow = true; break; }
        }
      }

      // 破壞前的前波高：findPivots 最近一個 high pivot（前低之前 / 結構頭部）
      const lastHigh = pivots.find(p => p.type === 'high');
      const priorHighPrice = lastHigh?.price;

      // (3) 反彈紅 K 收盤未過「破壞前的前波高」且未站回月線（MA20*0.99）
      const notPastPriorHigh = priorHighPrice == null || c.close < priorHighPrice;
      const notReclaimedMa20 = c.close < ma20 * 0.99;

      if (brokeMa20Recently && brokePivotLow && notPastPriorHigh && notReclaimedMa20) {
        const refHigh = priorHighPrice != null ? priorHighPrice.toFixed(2) : '前波高';
        signals.push({
          type: 'ESCAPE_WAVE',
          label: '逃命波(破月線+破前低後反彈，最後出場機會)',
          detail: `已破月線(MA20 ${ma20.toFixed(2)})又破前低${lastLow ? ` ${lastLow.price.toFixed(2)}` : ''}，今反彈紅K收 ${c.close.toFixed(2)} 未過前波高 ${refHigh}／未站回月線，是最後逃命波（CH4-09）`,
          severity: 'high',
        });
      }
    }
  }

  // ════════════════════════════════════════════════════════════════
  // Wave2 進場-11「假突破跌破 1/2 價」— 持倉端避雷出場（回測已過關）
  //   回測（92-wave2回測結果.md C18）：帶量突破紅K 後 T+1/T+2 出現黑 K 收盤跌破
  //   該突破長紅 K 的「1/2 價」(halfPrice=(high+low)/2) → 判假突破。
  //   假突破組後續 d5 淨超額 −4.70%、過濾後 +1.26%、勝率 37%→48%、train/test 一致。
  //   這裡把它做成持倉端「出場避雷」訊號（非選股 gate）：
  //     近 1~3 根曾有「帶量突破紅K」(實體大 ≥2% via isLongRedCandle、收盤過區間高、量比>1.5)，
  //     而當前為其 T+1/T+2 黑K、收盤跌破該突破紅K 的 halfPrice → push severity high。
  //   沿用既有 halfPrice / isLongRedCandle / recentHigh / volRatio>1.5 量比口徑，不新增魔術數。
  //   ⚠️ 純出場避雷，不接任何進場/選股 gate。
  // ════════════════════════════════════════════════════════════════
  const isBlackNow = c.close < c.open;
  if (isBlackNow && index >= 20) {
    // 突破日只看 T-1 / T-2（對應假突破 lookahead 1~2，當前為 T+1/T+2 黑 K）
    for (let bi = index - 1; bi >= index - 2; bi--) {
      const bk = candles[bi];
      if (!bk) continue;
      // (1) 帶量突破紅 K：實體大長紅（≥2%）、量比 > 1.5（沿用本檔「帶量/爆量」口徑）
      const bkVolRatio5 = (() => {
        const vols = candles.slice(Math.max(0, bi - 5), bi).map((x) => x.volume).filter((v) => v > 0);
        if (vols.length === 0) return null;
        return bk.volume / (vols.reduce((a, b) => a + b, 0) / vols.length);
      })();
      const isBreakoutRedK = isLongRedCandle(bk)
        && (bkVolRatio5 ?? 0) > 1.5
        && bk.close > recentHigh(candles, bi, 20); // 收盤過前 20 根區間高 = 突破
      if (!isBreakoutRedK) continue;

      // (2) 當前黑 K 收盤跌破該突破紅 K 的 1/2 價（halfPrice）
      const bkHalf = halfPrice(bk);
      if (c.close < bkHalf) {
        const tPlus = index - bi; // 1 = T+1、2 = T+2
        signals.push({
          type: 'FALSE_BREAKOUT_FAIL',
          label: '假突破跌破1/2價(該出場)',
          detail: `${tPlus}日前帶量突破長紅K(${bk.date})收 ${bk.close.toFixed(2)}，今日黑K收 ${c.close.toFixed(2)} 跌破其1/2價 ${bkHalf.toFixed(2)}，假突破確認（Wave2 進場-11），該出場`,
          severity: 'high',
        });
        break; // 命中最近一根突破即可，不重複報
      }
    }
  }

  // 賠少-13：書本嚴重度排序 — 同 severity 內「破前低/支撐」排在「破月線」之前。
  // 用 (severity 三級 → rank) 做主鍵、SELL_SEVERITY_RANK 做次鍵，index 做 tiebreaker 保穩定。
  const severityWeight = (s: SellSignal['severity']) => (s === 'high' ? 0 : s === 'medium' ? 1 : 2);
  return signals
    .map((sig, i) => ({ sig, i }))
    .sort((a, b) => {
      const sw = severityWeight(a.sig.severity) - severityWeight(b.sig.severity);
      if (sw !== 0) return sw;
      const rk = sellSeverityRank(a.sig.type) - sellSeverityRank(b.sig.type);
      if (rk !== 0) return rk;
      return a.i - b.i; // 同權重維持原插入序（穩定）
    })
    .map((x) => x.sig);
}
