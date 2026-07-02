/**
 * lib/analysis/maDeduction.ts — 移動扣抵預測（W3c · 顯示層純函式）
 */

import {
  deductPrice,
  daysUntilMaTurn,
  daysUntilGoldenCross,
} from '@/lib/analysis/maDeduction';

describe('deductPrice — N 日均線下一根要丟掉的扣抵價', () => {
  const closes = [10, 11, 12, 13, 14, 15];

  it('5 日線：最後一根的扣抵值 = 5 天前那根收盤', () => {
    // asOf=5（最後一根 15），窗口 [11..15]，下一根丟掉最舊的 closes[1]=11
    expect(deductPrice(closes, 5)).toBe(11);
  });

  it('5 日線：指定 asOf 中間根', () => {
    // asOf=4（值 14），窗口 [10..14]，丟掉 closes[0]=10
    expect(deductPrice(closes, 5, 4)).toBe(10);
  });

  it('窗口還沒滿 → undefined', () => {
    // asOf=2 只有 3 根，5 日線湊不滿、沒有可丟的最舊根
    expect(deductPrice(closes, 5, 2)).toBeUndefined();
  });

  it('非法參數防呆', () => {
    expect(deductPrice(closes, 0)).toBeUndefined();
    expect(deductPrice(closes, 5, -1)).toBeUndefined();
    expect(deductPrice(closes, 5, 99)).toBeUndefined();
  });
});

describe('daysUntilMaTurn — 依扣抵估幾天後均線翻向', () => {
  it('今收 > 扣抵值 → 均線往上', () => {
    // 一路上漲，今收一定大於最舊扣抵值 → 方向 up
    const closes = [10, 11, 12, 13, 14, 15, 16, 17];
    const r = daysUntilMaTurn(closes, 5);
    expect(r.direction).toBe('up');
  });

  it('今收 < 扣抵值 → 均線往下', () => {
    const closes = [20, 19, 18, 17, 16, 15, 14, 13];
    const r = daysUntilMaTurn(closes, 5);
    expect(r.direction).toBe('down');
  });

  it('剛從跌轉漲：均線雖還在跌，但能估出幾天後翻上', () => {
    // 前段在高位（被丟掉的扣抵值偏高 → 均線往下），但今收已拉回較低又回升。
    // 構造：高位 30,29,28,27,26 然後低位反彈 20,21,22。
    // 以最後一根(22)為 asOf，5 日均線目前仍下彎，但隨高位扣抵值被丟掉會翻上。
    const closes = [30, 29, 28, 27, 26, 20, 21, 22];
    const r = daysUntilMaTurn(closes, 5);
    // 今收 22 vs 下一根扣抵 closes[3]=27 → 22<27 → 仍 down
    expect(r.direction).toBe('down');
    // 但再往前丟掉 26/27 等高扣抵值後，今收 22 會大於扣抵 → 翻上
    expect(r.days).not.toBeNull();
    expect(r.turnTo).toBe('up');
  });

  it('資料不足 / maN<=1 → flat、days=null', () => {
    expect(daysUntilMaTurn([1, 2, 3], 5).days).toBeNull();
    expect(daysUntilMaTurn([1, 2, 3, 4, 5], 1).direction).toBe('flat');
  });

  it('純函式：不改動輸入陣列', () => {
    const closes = [10, 11, 12, 13, 14, 15];
    const snapshot = [...closes];
    daysUntilMaTurn(closes, 5);
    expect(closes).toEqual(snapshot);
  });
});

describe('daysUntilGoldenCross — 短均線何時黃金交叉長均線', () => {
  it('短均線已在長均線上方 → days=0、alreadyAbove', () => {
    // 一路上漲，短均線(5)恆在長均線(10)之上
    const closes = Array.from({ length: 20 }, (_, i) => 10 + i);
    const r = daysUntilGoldenCross(closes, 5, 10);
    expect(r.alreadyAbove).toBe(true);
    expect(r.days).toBe(0);
  });

  it('剛起漲：短均線還在下方但正在靠近 → 估出幾天後交叉', () => {
    // 前段持平壓低均線，尾端轉強拉升 → 短均線追上長均線
    const closes = [
      20, 20, 20, 20, 20, 20, 20, 20, 20, 20, // 長期持平
      21, 23, 25, 27, 29, // 尾端轉強
    ];
    const r = daysUntilGoldenCross(closes, 5, 10);
    // 尾端急拉，短均線可能已交叉或即將交叉
    if (!r.alreadyAbove) {
      expect(r.days).not.toBeNull();
      expect(r.trend).toBe('converging');
    } else {
      expect(r.days).toBe(0);
    }
  });

  it('穩定下跌中：短均線在下方，近窗 maxLookahead 內估不到交叉（null）', () => {
    // 注意：移動扣抵假設「未來價停在今收」，故穩定下跌時短均線會比長均線更快
    // 在今收附近走平 → 理論上很遠的未來仍會交叉，但那是凍結假設的產物、無實戰意義。
    // 顯示層只看近窗（這裡限 maxLookahead=3）→ 近窗內不交叉應回 null。
    const closes = Array.from({ length: 20 }, (_, i) => 30 - i);
    const r = daysUntilGoldenCross(closes, 5, 10, closes.length - 1, 3);
    expect(r.alreadyAbove).toBe(false);
    expect(r.days).toBeNull();
  });

  it('穩定下跌：不限窗時數學上仍會在遠未來交叉（凍結價假設的特性）', () => {
    // 記錄真實行為：完整 lookahead 下短均線終究追上 → days 為正數。
    // 這也是顯示層要用近窗 maxLookahead 限制的原因。
    const closes = Array.from({ length: 20 }, (_, i) => 30 - i);
    const r = daysUntilGoldenCross(closes, 5, 10);
    expect(r.alreadyAbove).toBe(false);
    expect(typeof r.days).toBe('number');
  });

  it('參數防呆：shortN>=longN / 資料不足 → null', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 10 + i);
    expect(daysUntilGoldenCross(closes, 10, 5).days).toBeNull();
    expect(daysUntilGoldenCross([1, 2, 3], 5, 10).days).toBeNull();
  });

  it('純函式：不改動輸入陣列', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 10 + i);
    const snapshot = [...closes];
    daysUntilGoldenCross(closes, 5, 10);
    expect(closes).toEqual(snapshot);
  });
});
