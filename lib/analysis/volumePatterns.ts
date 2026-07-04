/**
 * 量價 detector — 書本 Part 7 p.487-535
 *
 * 實作：
 *   - 量 9 種分類（p.487-488）：基本/攻擊/爆大/止跌/進貨/換手/出貨/調節/搶反彈
 *   - 量價背離 3 種（p.500-506）：價漲量縮/價平量增/價漲量平
 *   - 高檔爆量 3 種（p.493-499）：調節/換手/出貨
 *   - 窒息量 + 凹洞量（p.525）
 *
 * 用法：各函式回傳 boolean，供上層判斷當前 K 棒是否符合該量價型態。
 */
import type { CandleWithIndicators } from '@/types';
import { BOOK_VOL_RATIO_MIN, BASE_HIGH_VOL_RATIO } from './bookThresholds';
import { detectTopFormation } from './reversalStructure';

/** 量分類（書本 p.487-488） */
export type VolumeType =
  | 'base'          // 基本量 = 5 日均量
  | 'attack'        // 攻擊量 = 前日 × 1.3
  | 'blowoff'       // 爆大量 = 5 日均量 × 2
  | 'stopDrop'      // 止跌量 = 5 日均量 × 0.5
  | 'accumulate'    // 進貨量 = 大量 + 股價上漲
  | 'turnover'      // 換手量 = 高檔大量K 3 日內被突破
  | 'distribution'  // 出貨量 = 大量 + 股價下跌/反轉
  | 'wash'          // 調節量 = 高檔大量K 下跌後又上漲突破
  | 'rebound';      // 搶反彈量 = 空頭低檔大量 + 後紅K反彈

export function classifyVolume(
  candles: CandleWithIndicators[],
  index: number,
): VolumeType[] {
  const c = candles[index];
  const prev = candles[index - 1];
  if (!c || !prev) return ['base'];

  const types: VolumeType[] = [];
  const avg5 = c.avgVol5 ?? 0;

  // 攻擊量（寶典 p.54 ④ ×1.3 前日基準 OR 課程 CH4-2「基本量(5日均)×1.2~1.3」）
  // 2026-07-05 忠實度修：(1) 課程原文「這樣子**股價也上漲**的話，我就認定有攻擊量」—
  //   補上漲前提（之前爆量長黑也會被貼攻擊量）；(2) 補課程 avg5×1.2 的 OR 分支
  //  （之前只有前日×1.3 書本軌，1.2~1.3 倍的合格攻擊量會漏）。
  const attackVol = (prev.volume > 0 && c.volume >= prev.volume * BOOK_VOL_RATIO_MIN)
    || (avg5 > 0 && c.volume >= avg5 * 1.2);
  if (attackVol && c.close > c.open) types.push('attack');

  // 爆大量（5 日均量 × 2）— 抓住飆股 / 朱家泓 YouTube #17
  if (avg5 > 0 && c.volume >= avg5 * 2) types.push('blowoff');

  // 止跌量（5 日均量 × 0.5，且當日不破低）
  // ×0.5 對齊書本 CH4-2「止跌量 = 基本量 × 0.5」（基本量 = 5 日均量），非自創工程值。
  // 2026-07-05 忠實度修：課程原文「**當股價下跌的時候**量急縮到一半」— 補下跌段前提
  //（收盤在 MA5 之下），多頭行進間的量縮小紅不再誤標止跌量（位置錯）。
  const inDecline = c.ma5 != null && c.ma5 > 0 && c.close < c.ma5;
  if (avg5 > 0 && c.volume <= avg5 * 0.5 && c.low >= prev.low && inDecline) types.push('stopDrop');

  // 「大量」單一口徑（與 detectHighPeakVolume / 做頭判定共用 BASE_HIGH_VOL_RATIO=1.5）：
  //   avg5 × BASE_HIGH_VOL_RATIO 或 前日量 × BOOK_VOL_RATIO_MIN(1.3)。
  // 小修-7：把散落的 1.5 統一成具名常數，避免同名概念在不同函式漂移。
  const isBig = (avg5 > 0 && c.volume >= avg5 * BASE_HIGH_VOL_RATIO) || (prev.volume > 0 && c.volume >= prev.volume * BOOK_VOL_RATIO_MIN);
  if (isBig && c.close > c.open) types.push('accumulate');

  // 出貨量（大量 + 黑K + **高檔**）
  // 2026-07-05 忠實度修：課程 CH4-2「漲到**相對高檔**爆大量出黑K＝出貨」、CH4-8 反例
  //「大量黑K第一隻腳（空頭低檔）是主力**進貨**量，壓低在進貨」— 同一根大量黑K
  // 高檔=出貨、低檔=進貨，意義相反。補高檔 gate（ma5>ma20 多頭段）；
  // 低檔（ma5<ma20）的大量黑K不再誤標出貨。
  const highSide = c.ma5 != null && c.ma20 != null && c.ma5 > c.ma20;
  if (isBig && c.close < c.open && highSide) types.push('distribution');

  // 換手量（近 3 日內的大量**黑K** 高點被今日收盤突破 =「該跌不跌」籌碼換手成功）
  // 2026-07-05 忠實度修（本章最重的方向性 bug）：課程原文「三天之內股價突破**大量黑K**
  // 的高點……被突破的大量就叫換手量」— 舊版要求被突破的是**紅K**（方向寫反），
  // 且只看固定 3 根前那一根。改成滾動窗：近 1~3 根內任一大量黑K，今日收盤過其高。
  if (index >= 1) {
    for (let k = 1; k <= 3; k++) {
      if (index - k < 1) break;
      const past = candles[index - k];
      const pastAvg5 = past.avgVol5 ?? avg5;
      if (pastAvg5 > 0 && past.volume >= pastAvg5 * BASE_HIGH_VOL_RATIO
        && past.close < past.open           // 大量「黑K」（課程正字定義）
        && c.close > past.high) {
        types.push('turnover');
        break;
      }
    }
  }

  // 調節量（高檔大量黑K 下跌修正後又上漲突破）
  // 2026-07-05 忠實度修：舊版只看固定 5 根前那一根（修正 4 或 6 天的全漏）。
  // 改滾動窗：近 4~7 根內任一大量黑K高點被今日收盤突破（與換手量 1~3 根窗銜接）。
  if (index >= 5) {
    for (let k = 4; k <= 7; k++) {
      if (index - k < 1) break;
      const past = candles[index - k];
      const pastAvg5 = past.avgVol5 ?? avg5;
      if (pastAvg5 > 0 && past.volume >= pastAvg5 * BASE_HIGH_VOL_RATIO
        && past.close < past.open
        && c.close > past.high) {
        types.push('wash');
        break;
      }
    }
  }

  // 搶反彈量（**空頭**低檔大量 + 紅K + 突破前一日高點）
  // 2026-07-05 忠實度修：課程原文「空頭跌到低檔…紅K**突破前一日K線最高點**」—
  // (1) 補突破昨高確認 (2) 空頭前提從單一 close<MA20 加嚴為 ma5<ma20（跌破月線的
  //     多頭深回檔不再誤標搶反彈量）。
  const lowSide = c.ma5 != null && c.ma20 != null && c.ma5 < c.ma20;
  if (c.ma20 && c.ma20 > 0 && c.close < c.ma20 && lowSide && isBig && c.close > c.open && c.close > prev.high) {
    types.push('rebound');
  }

  if (types.length === 0) types.push('base');
  return types;
}

/**
 * 量價背離 3 種（書本 p.500-506）
 *
 * 小修-7 口徑說明（刻意分工，非 bug）：
 *   本函式是「相鄰兩根」短線量價背離（今日 vs 昨日），用於當日量價同步檢查。
 *   trendAnalysis 內的 hasVolumePriceDivergence 是「波段量峰」背離（今日新高 vs 前一個
 *   findPivots 高點當日量），用於趨勢頭部判定。兩者粒度不同、用途不同，不應互相覆寫。
 *
 * 賠少-9 語意分流（2026-07-04 體檢註記）：量價背離依「你在場外還是場內」意義相反 —
 *   場外（進場端）＝勿進場做多（entryProhibitions 戒律3 三合一硬禁入）；
 *   場內（持倉端）＝上漲一段後的「停利警訊」（該準備出，不是停損）。
 *   消費本函式時務必分清用途，不可把持倉停利警訊當進場禁入、反之亦然。
 */
export interface VolumePriceDivergence {
  priceUpVolDown: boolean;   // 價漲量縮（背離）
  pricePlatVolUp: boolean;   // 價平量增（停滯）
  priceUpVolPlat: boolean;   // 價漲量平（止漲）
}

export function detectVolumePriceDivergence(
  candles: CandleWithIndicators[],
  index: number,
): VolumePriceDivergence {
  const c = candles[index];
  const prev = candles[index - 1];
  if (!c || !prev || prev.volume <= 0) {
    return { priceUpVolDown: false, pricePlatVolUp: false, priceUpVolPlat: false };
  }

  const priceChg = (c.close - prev.close) / prev.close;
  const volRatio = c.volume / prev.volume;

  return {
    priceUpVolDown:  priceChg > 0.01 && volRatio < 0.9,       // 價漲 >1% 量縮 >10%
    pricePlatVolUp:  Math.abs(priceChg) < 0.005 && volRatio > 1.3,  // 價幾乎不動量增 >30%
    priceUpVolPlat:  priceChg > 0.01 && volRatio >= 0.9 && volRatio <= 1.1,  // 價漲但量平
  };
}

/** 位置語意標籤（小修-4：多頭高檔=漲一倍 / 做頭第一頭 vs 第二頭，純避雷顯示） */
export type HighPeakPositionLabel = 'doubled' | 'firstHead' | 'secondHead' | null;

/**
 * 高檔爆量 3 種判定（書本 p.493-499）+ 出貨分級 metadata（賠少-8 / 小修-4）
 *
 * 小修-7 口徑說明：本函式 wash/turnover/distribution 專指「高檔(MA20 乖離>5%)」情境的
 *   即時當日判定，與 classifyVolume 的同名 9 分類（全位置、含進貨/搶反彈）刻意不同——
 *   classifyVolume 是泛用分類、本函式是高檔避雷專用。「大量」門檻已統一到爆大量 avg5×2。
 */
export interface HighVolumeHighPeak {
  washVolume:         boolean;  // 調節量
  turnoverVolume:     boolean;  // 換手量
  distributionVolume: boolean;  // 出貨量
  // ── 以下為純避雷顯示 metadata（不進任何選股 gate）─────────────────────────
  /** 誘多出貨量（賠少-8 ①）：高檔黑K回檔後再爆一根紅K騙進場，量更大但收盤未過頭部高 */
  luringDistribution?: boolean;
  /** 連續高檔爆量黑K 根數（賠少-8 ②）：逐根累積，≥2 拉警示 */
  consecutiveHighBlackK?: number;
  /** 位置語意（賠少-8 ③ / 小修-4）：漲一倍 / 做頭第一頭 / 第二頭 */
  positionLabel?: HighPeakPositionLabel;
}

export function detectHighPeakVolume(
  candles: CandleWithIndicators[],
  index: number,
): HighVolumeHighPeak {
  const c = candles[index];
  const avg5 = c?.avgVol5 ?? 0;
  if (index < 5 || avg5 <= 0) {
    return { washVolume: false, turnoverVolume: false, distributionVolume: false };
  }
  const prev = candles[index - 1];
  // 爆大量 = 5 日均量 × 2（書本「爆大量」定義，與 classifyVolume 'blowoff' 同口徑）
  const isBlowoff = c.volume >= avg5 * 2;

  // 是否高檔（MA20 乖離 >5%）
  const inHighZone = c.ma20 && c.ma20 > 0 && (c.close - c.ma20) / c.ma20 > 0.05;

  let washVolume = false, turnoverVolume = false, distributionVolume = false;

  if (inHighZone && isBlowoff && prev) {
    // 調節量：當日大量黑 → 後續紅K 站回
    // （簡化版：當日大量黑 + 不破前低；「待突破確認」語意見 classifyVolume 滾動窗版）
    if (c.close < c.open && c.low > prev.low * 0.98) washVolume = true;

    // 換手量：近 1~3 根內有爆量黑K、今日收盤突破該黑K高點（籌碼換手成功）
    // 2026-07-05 忠實度修：課程 CH4-3「爆量下跌後…再突破前一日**黑K高點**＝換手成功」；
    // 舊版「今收 > 昨收」就標換手 — 高檔爆量長紅（課程警告十之八九是拉高出貨）被貼成
    // 續漲正面標籤，判準鬆到變質。
    if (c.close > c.open) {
      for (let i = index - 1; i >= Math.max(1, index - 3); i--) {
        const k = candles[i];
        const kAvg5 = k.avgVol5 ?? 0;
        const kBlackBig = kAvg5 > 0 && k.volume >= kAvg5 * 1.5 && k.close < k.open;
        if (kBlackBig && c.close > k.high) { turnoverVolume = true; break; }
      }
    }

    // 出貨量：高檔大量 + 黑K + 收盤跌破前日低
    if (c.close < c.open && c.close < prev.low) distributionVolume = true;
  }

  // ── 賠少-8 / 小修-4：高檔出貨分級語意（純避雷 metadata，不進 gate）──────────
  let luringDistribution = false;
  let consecutiveHighBlackK = 0;
  let positionLabel: HighPeakPositionLabel = null;

  if (inHighZone) {
    // ② 連續高檔爆量黑K 累積（逐根回看，含今日，遇非「爆量黑K」即停）
    for (let i = index; i >= Math.max(1, index - 5); i--) {
      const k = candles[i];
      const kAvg5 = k.avgVol5 ?? 0;
      const kInHigh = k.ma20 != null && k.ma20 > 0 && (k.close - k.ma20) / k.ma20 > 0.05;
      const kBlackBlowoff = kAvg5 > 0 && k.volume >= kAvg5 * 2 && k.close < k.open;
      if (kInHigh && kBlackBlowoff) consecutiveHighBlackK++;
      else break;
    }

    // ① 誘多出貨量：近 3 根曾出現高檔爆量黑K（主力出第一波），
    //    今日卻是更大量紅K反彈騙進場，但收盤未過該黑K高點（沒真突破）
    if (isBlowoff && c.close > c.open) {
      for (let i = index - 1; i >= Math.max(1, index - 3); i--) {
        const k = candles[i];
        const kAvg5 = k.avgVol5 ?? 0;
        const kBlackBlowoff = kAvg5 > 0 && k.volume >= kAvg5 * 2 && k.close < k.open;
        if (kBlackBlowoff && c.volume > k.volume && c.close < k.high) {
          luringDistribution = true;
          break;
        }
      }
    }

    // ③ 位置語意：漲一倍（近 60 根最低收盤的 2 倍以上）優先；否則用做頭第一/第二頭
    const lookbackLow = (() => {
      let lo = Infinity;
      for (let i = Math.max(0, index - 60); i <= index; i++) {
        if (candles[i].close < lo) lo = candles[i].close;
      }
      return lo;
    })();
    if (lookbackLow > 0 && lookbackLow !== Infinity && c.close >= lookbackLow * 2) {
      positionLabel = 'doubled';  // 漲一倍＝主力目標區（書本高檔判準）
    } else {
      const top = detectTopFormation(candles, index);
      if (top === 'firstHead') positionLabel = 'firstHead';
      else if (top === 'secondHead' || top === 'bearConfirmed') positionLabel = 'secondHead';
    }
  }

  return {
    washVolume, turnoverVolume, distributionVolume,
    luringDistribution, consecutiveHighBlackK, positionLabel,
  };
}

/**
 * 窒息量（書本 p.525 / CH4-08）— 下跌末端「次日量相對前一日」急縮
 *
 * 小修-11 口徑校正：書本是「次日相對前一日」量縮到 1/2 以下，
 *   不是「前 5 日任一大量日」（原版回看 5 天偏寬，會把離很遠的大量日也算）。
 *   改成只比前一日：前一日是大量(avg5×2)、今日量 ≤ 前一日 × 0.5、且今日續跌(黑K)。
 */
export function detectChokingVolume(
  candles: CandleWithIndicators[],
  index: number,
): boolean {
  if (index < 5) return false;
  const c = candles[index];
  const prev = candles[index - 1];
  if (!prev?.avgVol5) return false;
  // 2026-07-05 忠實度修：課程 CH4-8「**爆量長黑後**若次日續跌且量縮至一半」—
  // 前一日必須是爆量**長黑**（舊版沒驗黑K，高檔爆量長紅隔日縮量也被標窒息量，
  // 位置與方向都不對 — 窒息量是下跌末端訊號）。
  const prevIsBigBlack = prev.volume >= prev.avgVol5 * 2 && prev.close < prev.open;
  return prevIsBigBlack && c.volume <= prev.volume * 0.5 && c.close < c.open;
}

/**
 * 凹洞量（書本 p.525 / CH4-08）— 窒息量次日放量紅K 反彈，構成晨星型反轉
 *
 * 小修-11 口徑校正：原版只看「昨日窒息量 + 今日放量紅K」，未驗是否構成真正的
 *   晨星三 K 型態（黑K下跌 → 窒息小實體 → 放量紅K 收復過半）。補上型態驗證降誤判：
 *   - 第 1 根(窒息前)：黑 K（下跌段）
 *   - 第 2 根(窒息日)：小實體（窒息量縮，實體 < 第 1 根實體）
 *   - 第 3 根(今日)：放量紅K（量 > 昨日 × 1.5）且收盤收復第 1 根實體一半以上
 */
export function detectHollowVolume(
  candles: CandleWithIndicators[],
  index: number,
): boolean {
  if (index < 2) return false;
  const c = candles[index];          // 第 3 根：今日放量紅K
  const k2 = candles[index - 1];     // 第 2 根：窒息日
  const k1 = candles[index - 2];     // 第 1 根：下跌黑K
  if (!k1 || !k2) return false;
  if (c.close <= c.open) return false;                       // 今日須紅K
  if (!detectChokingVolume(candles, index - 1)) return false; // 昨日須窒息量
  if (c.volume <= k2.volume * 1.5) return false;             // 今日放量

  // 晨星型態驗證：第 1 根下跌黑K、第 2 根小實體、今日收復第 1 根實體中點以上
  const k1Black = k1.close < k1.open;
  const k1Body = Math.abs(k1.close - k1.open);
  const k2Body = Math.abs(k2.close - k2.open);
  const k1Mid = (k1.open + k1.close) / 2;
  const morningStar = k1Black && k2Body < k1Body && c.close > k1Mid;
  return morningStar;
}
