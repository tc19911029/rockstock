import { CandleWithIndicators } from '@/types';

export type SellSignalType =
  | 'DEATH_CROSS'         // MA5 crosses below MA20
  | 'HIGH_VOL_UPPER_SHADOW' // High volume + long upper shadow in uptrend
  | 'KD_DEATH_CROSS'      // KD high-level death cross (K crosses below D when both > 70)
  | 'BREAK_MA5'           // Close breaks below MA5 after being above
  | 'BREAK_MA20'          // Close breaks below MA20 (serious)
  | 'TREND_BEARISH'       // Trend has turned bearish
  // 朱老師獲利方程式（《活用技術分析寶典》p.54）
  | 'LOWER_LOW'           // 收盤出現「頭頭低」
  | 'PROFIT_BREAK_MA5'    // 獲利>10% + 跌破MA5
  | 'PROFIT_CLIMAX_EXIT'; // 獲利>20% 或連續急漲+長黑覆蓋

export interface SellSignal {
  type: SellSignalType;
  label: string;
  detail: string;
  severity: 'high' | 'medium' | 'low';
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

  // 2. KD 高位死叉：K 從高位（>70）向下交叉 D
  if (kd_k != null && kd_d != null && prevKdK != null && prevKdD != null) {
    if (prevKdK > 70 && prevKdK >= prevKdD && kd_k < kd_d) {
      signals.push({
        type: 'KD_DEATH_CROSS',
        label: 'KD高位死叉',
        detail: `KD K(${kd_k.toFixed(1)}) 在高位死叉 D(${kd_d.toFixed(1)})，短線過熱回落`,
        severity: 'medium',
      });
    }
  }

  // 3. 跌破 MA20（嚴重警訊）
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
  if (ma5 != null && prev?.ma5 != null) {
    if (prev.close >= prev.ma5 && c.close < ma5 && c.close >= (ma20 ?? 0)) {
      signals.push({
        type: 'BREAK_MA5',
        label: '跌破週線MA5',
        detail: `收盤(${c.close}) 跌破 MA5(${ma5.toFixed(2)})，短線動能轉弱`,
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
      if (newerHigh.price < olderHigh.price && c.close < newerHigh.price) {
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
    // 前3日連續上漲
    const prev3Up = [candles[index-1], candles[index-2], candles[index-3]]
      .every(x => x.close > x.open);
    // 今日是長黑K
    const isLongBlack = c.close < c.open && body > 0 && (c.open - c.close) / c.open >= 0.02;
    // 帶量
    const bigVolume = (volRatio5 ?? 0) > 1.5;

    if (prev3Up && isLongBlack && bigVolume) {
      signals.push({
        type: 'PROFIT_CLIMAX_EXIT',
        label: '急漲後長黑出場',
        detail: `連續3日急漲後出現大量長黑K覆蓋，主力出貨訊號`,
        severity: 'high',
      });
    }
  }

  return signals;
}
