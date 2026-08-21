/**
 * lib/analysis/maDeduction.ts — 移動扣抵預測（課程 CH3-2 · 顯示層純函式）
 *
 * 課程判準（CH3-2 投影片 p01）：抵（今收）> 扣（扣抵價）→ 上彎；抵 < 扣 → 下彎；相等走平。
 * 翻向天數用課程數法：均線在「未來第 s 根」翻向 = 「s 天後」（1 = 明天）。
 */

import {
  deductPrice,
  deductSeries,
  daysUntilBullishAlignment,
  daysUntilMaTurn,
  daysUntilMaRises,
  daysUntilGoldenCross,
  formatMaTurnLine,
  forecastAllMaRising,
  multiMaDeductionStates,
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

describe('deductSeries — 未來 k 天扣抵價序列（課程 CH3-2：全是已知歷史資料）', () => {
  const closes = [10, 11, 12, 13, 14, 15];

  it('5 日線預設看滿 maN 根：未來第 j 根扣 closes[asOf−5+j]', () => {
    const s = deductSeries(closes, 5);
    expect(s).toEqual([
      { daysAhead: 1, index: 1, price: 11 },
      { daysAhead: 2, index: 2, price: 12 },
      { daysAhead: 3, index: 3, price: 13 },
      { daysAhead: 4, index: 4, price: 14 },
      { daysAhead: 5, index: 5, price: 15 }, // 第 maN 根扣到今天自己 → 之後不再是已知資料
    ]);
  });

  it('k 限制序列長度；k > maN 自動截到 maN', () => {
    expect(deductSeries(closes, 5, 2)).toHaveLength(2);
    expect(deductSeries(closes, 5, 99)).toHaveLength(5);
  });

  it('窗口沒滿 / 非法參數 → 空陣列', () => {
    expect(deductSeries([1, 2, 3], 5)).toEqual([]);
    expect(deductSeries(closes, 0)).toEqual([]);
  });
});

describe('multiMaDeductionStates — 今日／下次扣抵與多週期方向', () => {
  it('明確分開今日扣抵與下一交易日扣抵，避免 off-by-one', () => {
    const closes = Array.from({ length: 70 }, (_, i) => i + 1);
    const state = multiMaDeductionStates(closes, [5], closes.length - 1, 20)[0];

    expect(state.currentDeductPrice).toBe(65); // asOf-period
    expect(state.nextDeductPrice).toBe(66);    // asOf-period+1
    expect(state.currentDirection).toBe('up');
    expect(state.nextDirection).toBe('up');
    expect(state.deductChange).toBe(1);
  });

  it('可辨識月線助漲、季線助跌的衝突狀態', () => {
    const closes = Array.from({ length: 80 }, () => 50);
    closes[19] = 80; // 今日 MA60 扣高 → 助跌
    closes[20] = 75; // 下一日 MA60 仍扣高 → 助跌
    closes[59] = 30; // 今日 MA20 扣低 → 助漲
    closes[60] = 35; // 下一日 MA20 仍扣低 → 助漲
    closes[79] = 50;

    const states = multiMaDeductionStates(closes, [20, 60]);
    expect(states.find(state => state.period === 20)?.nextDirection).toBe('up');
    expect(states.find(state => state.period === 60)?.nextDirection).toBe('down');
  });
});

describe('forecastAllMaRising — 四線同步助漲門檻與條件窗口', () => {
  it('完整已知近窗用四個扣抵價最高值作門檻', () => {
    const closes = Array.from({ length: 70 }, () => 50);
    const asOf = closes.length - 1;
    closes[asOf - 5 + 1] = 60;
    closes[asOf - 10 + 1] = 65;
    closes[asOf - 20 + 1] = 55;
    for (let step = 1; step <= 5; step++) closes[asOf - 60 + step] = 80;
    closes[asOf] = 70;

    const result = forecastAllMaRising(closes, [5, 10, 20, 60], asOf, 10);
    expect(result.nextDay?.knownThreshold).toBe(80);
    expect(result.nextDay?.limitingPeriods).toEqual([60]);
    expect(result.nextDay?.unknownPeriods).toEqual([]);
    expect(result.firstExactAtCurrentPrice).toBeNull();
    expect(result.exactDays).toHaveLength(5);
  });

  it('第6日起短線扣抵未知，只能標成條件窗口', () => {
    const closes = Array.from({ length: 80 }, () => 40);
    const asOf = closes.length - 1;
    closes[asOf] = 50;
    // 前5日的已知四線門檻都故意高於今收；第6日已知 MA10/20/60 都低於今收。
    for (let step = 1; step <= 5; step++) closes[asOf - 60 + step] = 70;
    closes[asOf - 60 + 6] = 45;
    closes[asOf - 20 + 6] = 44;
    closes[asOf - 10 + 6] = 43;

    const result = forecastAllMaRising(closes, [5, 10, 20, 60], asOf, 10);
    expect(result.firstConditionalNearCurrentPrice?.daysAhead).toBe(6);
    expect(result.firstConditionalNearCurrentPrice?.knownThreshold).toBe(45);
    expect(result.firstConditionalNearCurrentPrice?.unknownPeriods).toEqual([5]);
  });
});

describe('daysUntilMaTurn — 依扣抵估幾天後均線翻向（課程數法：第 s 根翻向 = s 天後）', () => {
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

  it('已知序列：3 天後翻上（驗證確切轉彎天數＋翻向扣抵棒）', () => {
    // 高位 30,29,28,27,26 後低位反彈 20,21,22（asOf=7，今收 22，5 日線）。
    // 逐根手算（凍結今收 22）：
    //   今天 MA = (27+26+20+21+22)/5 = 23.2
    //   +1 根扣 closes[3]=27 → MA 22.2（下彎）
    //   +2 根扣 closes[4]=26 → MA 21.4（下彎）
    //   +3 根扣 closes[5]=20 → MA 21.8（翻上！）→ 課程數法 = 3 天後翻上
    const closes = [30, 29, 28, 27, 26, 20, 21, 22];
    const r = daysUntilMaTurn(closes, 5);
    expect(r.direction).toBe('down');
    expect(r.days).toBe(3);
    expect(r.turnTo).toBe('up');
    // 造成翻向的是「改扣 20 那根」（低價被扣掉 → 上彎），可對回日期
    expect(r.turnDeductIdx).toBe(5);
    expect(r.turnDeductPrice).toBe(20);
  });

  it('已知序列：3 天後翻下（頭部對稱 — 要扣高價）', () => {
    // 低位 10..14 後高位 30,29,28（asOf=7，今收 28，5 日線）。
    //   +1 根扣 13 → 上彎；+2 根扣 14 → 上彎；+3 根扣 30（高價）→ 翻下
    const closes = [10, 11, 12, 13, 14, 30, 29, 28];
    const r = daysUntilMaTurn(closes, 5);
    expect(r.direction).toBe('up');
    expect(r.days).toBe(3);
    expect(r.turnTo).toBe('down');
    expect(r.turnDeductIdx).toBe(5);
    expect(r.turnDeductPrice).toBe(30);
  });

  it('課程加權指數情境：今天實際還下彎、明天就翻上（todayDirection ≠ direction）', () => {
    // CH3-2 應用一：2022/11/7 收 13223、明天扣抵 13106 → 今天月線還向下，明天翻上。
    // 縮小版：今天丟 closes[1]=30（高）→ 今天實際下彎；明天丟 closes[2]=20（低）→ 明天翻上
    const closes = [9, 30, 20, 21, 22, 23, 24];
    const r = daysUntilMaTurn(closes, 5);
    expect(r.todayDirection).toBe('down');
    expect(r.direction).toBe('up');
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

describe('formatMaTurnLine — 一行白話結論（課程 CH3-2）', () => {
  it('將下彎（警覺）：幾天後、扣哪天的高價，先結論短句', () => {
    const closes = [10, 11, 12, 13, 14, 30, 29, 28];
    const dates = [
      '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-06',
      '2026-06-09', '2026-06-12', '2026-06-13', '2026-06-16',
    ];
    const line = formatMaTurnLine({ label: '月線', closes, maN: 5, dates });
    expect(line).toEqual({
      tone: 'warn',
      text: '月線 3 天後要扣 6/12 的高價 30 → 股價不漲將下彎（警覺）',
    });
  });

  it('將上彎：改扣低價 →「上不去就等下來」', () => {
    const closes = [30, 29, 28, 27, 26, 20, 21, 22];
    const line = formatMaTurnLine({ label: '10日線', closes, maN: 5 });
    expect(line?.tone).toBe('good');
    expect(line?.text).toBe('10日線 3 天後改扣 低價 20 → 股價不跌將上彎');
  });

  it('課程 11/7 情境：明天就翻上 → 用明天的扣抵價講', () => {
    const closes = [9, 30, 20, 21, 22, 23, 24];
    const line = formatMaTurnLine({ label: '月線', closes, maN: 5 });
    expect(line?.tone).toBe('good');
    expect(line?.text).toBe('月線明天改扣 低價 20 → 股價不跌就上彎');
  });

  it('方向不變（近窗只剩凍結價走平）→ null，面板保持安靜', () => {
    const closes = [10, 11, 12, 13, 14, 15, 16, 17];
    expect(formatMaTurnLine({ label: '5日線', closes, maN: 5 })).toBeNull();
  });

  it('資料不足 → null', () => {
    expect(formatMaTurnLine({ label: '月線', closes: [1, 2, 3], maN: 20 })).toBeNull();
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

describe('daysUntilMaRises — 單一均線何時開始向上', () => {
  it('MA60 目前下彎，3 個交易日後扣到低價才開始向上', () => {
    const closes = Array.from({ length: 65 }, () => 30);
    closes[5] = 29;
    closes[6] = 28;
    closes[7] = 10;
    closes[64] = 20;

    const r = daysUntilMaRises(closes, 60);
    expect(r.currentDirection).toBe('down');
    expect(r.alreadyRising).toBe(false);
    expect(r.days).toBe(3);
    expect(r.deductIndex).toBe(7);
    expect(r.deductPrice).toBe(10);
  });

  it('目前已向上 → days=0', () => {
    const closes = Array.from({ length: 61 }, (_, i) => 10 + i);
    const r = daysUntilMaRises(closes, 60);
    expect(r.currentDirection).toBe('up');
    expect(r.alreadyRising).toBe(true);
    expect(r.days).toBe(0);
  });

  it('會略過走平，繼續找第一個真正向上的交易日', () => {
    const closes = [30, 29, 20, 10, 20, 20, 20];
    // MA5：今天扣 29 → 下；明天扣 20 → 平；後天扣 10 → 上。
    const r = daysUntilMaRises(closes, 5);
    expect(r.currentDirection).toBe('down');
    expect(r.days).toBe(2);
  });

  it('資料不足或情境窗內沒有向上 → null', () => {
    expect(daysUntilMaRises([1, 2, 3], 60).days).toBeNull();
    expect(daysUntilMaRises(Array.from({ length: 61 }, () => 20), 60).days).toBeNull();
  });
});

describe('daysUntilBullishAlignment — MA5/10/20 三線多排', () => {
  it('目前已是 MA5 > MA10 > MA20 → days=0', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 10 + i);
    const r = daysUntilBullishAlignment(closes, [5, 10, 20]);
    expect(r.alreadyAligned).toBe(true);
    expect(r.days).toBe(0);
    expect(r.values?.[0]).toBeGreaterThan(r.values?.[1] ?? Infinity);
    expect(r.values?.[1]).toBeGreaterThan(r.values?.[2] ?? Infinity);
  });

  it('依今收凍結情境找出第一個三線嚴格多排日', () => {
    const closes = [
      30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
      20, 20, 20, 20, 20, 20, 20, 20, 20, 20,
      20, 20, 20, 20, 40,
    ];
    const r = daysUntilBullishAlignment(closes, [5, 10, 20]);
    expect(r.alreadyAligned).toBe(false);
    expect(r.days).toBe(2);
    expect(r.values?.[0]).toBeGreaterThan(r.values?.[1] ?? Infinity);
    expect(r.values?.[1]).toBeGreaterThan(r.values?.[2] ?? Infinity);
  });

  it('20 日內未形成或參數／資料不足 → null', () => {
    const falling = Array.from({ length: 30 }, (_, i) => 100 - i);
    expect(daysUntilBullishAlignment(falling, [5, 10, 20]).days).toBeNull();
    expect(daysUntilBullishAlignment([1, 2, 3], [5, 10, 20]).days).toBeNull();
    expect(daysUntilBullishAlignment(Array.from({ length: 30 }, () => 10), [10, 5, 20]).days).toBeNull();
  });
});
