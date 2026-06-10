// ============================================================
// 策略排行榜 — harness 與前端共用的型別契約（單一事實來源）
//
// 「策略 × 排序」當成一個選股器，量它選到的股票在隔日開盤買進後
// d1 / d3 / d5 收盤的報酬，做成排行榜。
//
//   harness（scripts/backtest-unified-leaderboard.ts）寫出 LeaderboardDoc
//   → lib/backtest/leaderboardStorage.ts 落地（fs + Blob）
//   → app/api/backtest/leaderboard 讀出
//   → app/backtest/leaderboard 頁面渲染
//
// 純型別、無 IO，client / script / route 任意 import。
// ============================================================

export type Market = 'TW' | 'CN';

/** 選股引擎：買法字母 vs 三色資金。 */
export type Engine = 'buymethod' | 'sanse';

/** 排行榜對外只看 d1/d3/d5 三個 horizon（買入基準=隔日開盤，收盤計價）。 */
export type Horizon = 'd1' | 'd3' | 'd5';
export const HORIZONS: Horizon[] = ['d1', 'd3', 'd5'];

/** 買法軌道（讀 lib/scanner/buyMethodTracks.ts 的 trackOf）。 */
export type Track = 'bullish' | 'reversal' | 'system' | 'mechanical' | 'pool';

/** 單一 pick（某掃描日某策略×排序的某名次股票）的實際 forward 報酬。 */
export interface SamplePick {
  date: string;          // 掃描日 YYYY-MM-DD（隔日開盤才進場）
  symbol: string;
  name: string;
  rank: number;          // 該日該排序的名次（1 = 排序第一）
  entryOpen: number;     // 隔日開盤進場價
  d1: number | null;     // 進場後 d1/d3/d5 收盤報酬 %（漲停買不到 → null，該樣本剔除）
  d3: number | null;
  d5: number | null;
}

/** 一組選股單位（top1 / top3 / top5 / cohort）在某 horizon 的統計。 */
export interface SelStats {
  n: number;             // 有效樣本數（該 horizon 非 null 的天數/檔數）
  avgPct: number;        // 平均報酬 %
  medianPct: number;     // 中位報酬 %
  winRatePct: number;    // 勝率 %（報酬 > 0 比例）
}

/** 每個 horizon 下的 4 種選股單位統計 + 排序 alpha。 */
export interface HorizonBlock {
  top1: SelStats;        // 每日排序第 1 名
  top3: SelStats;        // 每日排序前 3 名平均
  top5: SelStats;        // 每日排序前 5 名平均
  cohort: SelStats;      // 當日全體（與排序無關的基準）
  /** 排序本身帶來的 alpha = top1.avgPct − cohort.avgPct（>0 代表排序有效把贏家排前面）。 */
  sortAlphaPct: number;
}

/** 排行榜一列 = 一個 (市場 × 引擎 × 策略 × 排序)。 */
export interface LeaderboardRow {
  id: string;                          // 穩定 key：`${market}:${engine}:${strategyId}:${sortKey}`
  market: Market;
  engine: Engine;
  strategyId: string;                  // 買法字母 'B'..'R' / 三色桶 key / 三色嚴格度 'strict'|'medium'|'loose'
  strategyLabel: string;               // 已在地化繁中：'回後買上漲（B）' / '三色滿分⭐ +雙B' …
  track?: Track;                       // 僅買法
  sortKey: string;                     // 排序機器碼：'漲幅' / 'expectedGain' …
  sortLabel: string;                   // 排序繁中：'漲幅' / '期望漲幅(樣本內)' …
  /** 涵蓋天數（該策略×排序有出 pick 的掃描日數）。 */
  days: number;
  byHorizon: Record<Horizon, HorizonBlock>;
  samplePicks: SamplePick[];           // 最近 N 筆 top1 pick（newest first，附實際漲幅）
}

export interface LeaderboardDoc {
  generatedAt: string;                 // ISO（前端顯示請 +8h 轉 CST）
  entryBaseline: 'next-open';          // 買入基準恆為隔日開盤
  window: {
    start: string;                     // 第一個掃描日
    end: string;                       // 最後一個掃描日（已扣除 forwardTd）
    tradingDays: number;
    label: string;                     // 例 '2y'
    forwardTd: number;                 // 為確保 forward 全在本地 K 而排除的尾端交易日數
  };
  horizons: Horizon[];
  rows: LeaderboardRow[];              // 扁平；前端 client-side 過濾/排序
  meta: {
    survivorshipNote: string;
    minPicks: number;                  // 進排行榜的最低樣本門檻（低於此仍寫入但前端可隱藏）
    turnoverTopN: Record<Market, number>;
    notes?: string[];
  };
}
