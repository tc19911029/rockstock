/**
 * Centralized configuration constants
 *
 * All magic numbers and configurable thresholds should be defined here
 * instead of being scattered across the codebase.
 */

// ── 台股交易成本 ─────────────────────────────────────────────────────────────
export const TW_TRADING = {
  /** 手續費率 0.1425% */
  FEE_RATE: 0.001425,
  /** 手續費折扣（六折） */
  FEE_DISCOUNT: 0.6,
  /** 當沖證交稅 0.15%（優惠稅率） */
  DAY_TRADE_TAX: 0.0015,
  /** 一般證交稅 0.3% */
  NORMAL_TAX: 0.003,
  /** 最低手續費（元） */
  MIN_FEE: 20,
} as const;

// ── 當沖引擎 ─────────────────────────────────────────────────────────────────
export const INTRADAY = {
  /** 開盤區間計算分鐘數 */
  OPEN_RANGE_MINUTES: 30,
  /** 預設初始資金 */
  DEFAULT_CAPITAL: 1_000_000,
  /** 自動交易下單比例（佔總資金） */
  AUTO_TRADE_POSITION_RATIO: 0.1,
  /** 最小下單張數 */
  MIN_SHARES: 1000,
} as const;

// ── 掃描器 ───────────────────────────────────────────────────────────────────
export const SCANNER = {
  /** 歷史勝率低於此值直接過濾 */
  MIN_HIST_WIN_RATE: 35,
  /** AI 排名最大送出股數 */
  AI_RANK_MAX_STOCKS: 15,
  /** 飆股分最低門檻（用於 Top Picks 篩選） */
  SURGE_SCORE_THRESHOLD: 40,
  /** 掃描歷史最大保留筆數 */
  MAX_HISTORY: 10,
  /** localStorage 壓縮保留結果數 */
  COMPACT_TOP_N: 20,
} as const;

// ── 回測引擎 ─────────────────────────────────────────────────────────────────
export const BACKTEST = {
  /** 各等級預設持有天數 */
  HOLD_DAYS: { S: 8, A: 7, B: 5, C: 4, D: 4 } as Record<string, number>,
  /** 嚴格停損比例 */
  TIGHT_STOP_LOSS: -0.04,
  /** 最大停損比例 */
  MAX_STOP_LOSS: -0.07,
  /** 複合分數斷點 */
  COMPOSITE_BREAKPOINTS: { HIGH: 70, LOW: 40 },
} as const;

// ── 技術分析指標 ─────────────────────────────────────────────────────────────
export const INDICATORS = {
  /** RSI 超買門檻 */
  RSI_OVERBOUGHT: 70,
  /** RSI 超賣門檻 */
  RSI_OVERSOLD: 30,
  /** RSI 計算週期 */
  RSI_PERIOD: 14,
  /** 短期均線 */
  MA_SHORT: 5,
  /** 中期均線 */
  MA_MID: 10,
  /** 長期均線 */
  MA_LONG: 20,
  /** 季線 */
  MA_QUARTER: 60,
} as const;

// ── 快取 ─────────────────────────────────────────────────────────────────────
export const CACHE = {
  /** 即時報價快取 TTL（毫秒） */
  REALTIME_TTL: 5 * 60 * 1000,
  /** 歷史數據快取 TTL（毫秒） */
  HISTORICAL_TTL: 24 * 60 * 60 * 1000,
  /** 籌碼數據快取 TTL（毫秒） */
  CHIP_TTL: 10 * 60 * 1000,
  /** 顏色主題快取 TTL（毫秒） */
  THEME_TTL: 5000,
} as const;

// ── 輪詢 ───────────────────────────────────────────────────────────────────
export const POLLING = {
  /** 報價輪詢間隔（毫秒） */
  QUOTE_INTERVAL: 30_000,
  /** API 請求超時（毫秒） */
  API_TIMEOUT: 30_000,
} as const;

// ── 顯示限制 ─────────────────────────────────────────────────────────────────
export const DISPLAY = {
  /** 最大 K 線顯示數量（防止記憶體洩漏） */
  MAX_CANDLES: 2000,
} as const;

// ── 即時分鐘 K 警示 ───────────────────────────────────────────────────────
// 警告：書本「爆量長黑=出貨」「末升段三條件」原文皆為日 K。本模組把規則套到分鐘 K
// 是分時類推、未經回測。所有觸發訊號帶 caveat: 'minute-inference' 標記，UI / 推播
// 三處露出 caveat banner。詳見 lib/realtime/blowoffDetector.ts 註解。
export const REALTIME_RULES = {
  /** 爆量倍數：vol > MA20(分鐘 vol) × N */
  VOLUME_MULTIPLIER: 2.0,
  /** 長 K 實體占全長最小比例 */
  BODY_RATIO_MIN: 0.6,
  /** 末升段乖離率門檻 close vs MA20(close) */
  TERMINAL_RALLY_DEVIATION: 0.15,
  /** 末升段需要連幾根長紅 */
  TERMINAL_RALLY_STREAK: 3,
  /** 長紅突破檢視前 N 根 high */
  BULLISH_BREAKOUT_LOOKBACK: 5,
  /** 同 symbol+rule debounce（毫秒） */
  DEBOUNCE_MS: 30 * 60 * 1000,
  /** MA20 樣本不足跳過 detector */
  MIN_BARS_FOR_DETECT: 20,
  /** 監控池硬上限（防 scan 失控塞太多） */
  POOL_HARD_CAP: 80,
  /** 當日 scan 候選 TTL */
  SCAN_CANDIDATE_TTL_MS: 30 * 60 * 1000,
  /** ring buffer 容量（1m K 一日約 270 根） */
  RING_BUFFER_CAPACITY: 270,
  /** disk flush 間隔（毫秒） */
  FLUSH_INTERVAL_MS: 60 * 1000,
  /** scan 觸發週期（毫秒，launchd plist 對齊） */
  SCAN_INTERVAL_MS: 30 * 1000,
} as const;

// ── 持倉保命警報層（holdings guard）─────────────────────────────────────
// 掛在 realtime-scan 30s 迴圈內的「即時提醒」層；正式操作建議仍由
// portfolio-notify（120s）負責。純警報：不下單、不改持倉檔、不進選股鏈路。
// 緊急滅音：env HOLDINGS_GUARD_NTFY_DISABLED=true（不用 rebuild；jsonl 照記）。
export type GuardScope = 'off' | 'holding' | 'holding_manual' | 'all';
export const HOLDINGS_GUARD = {
  /** 總開關（關掉 = 三規則不偵測、形態訊號也不走持倉推播） */
  ENABLED: true,
  /** 各規則警報範圍 */
  SCOPE: {
    /** 規則1：跌破停損價（本質只對有停損價的持倉有效） */
    STOP_LOSS_BREACH: 'holding' as GuardScope,
    /** 規則2：拉高出貨保護（當日大漲後自高點回檔） */
    PUMP_REVERSAL: 'holding' as GuardScope,
    /** 規則3：急殺（N 分鐘視窗跌幅） */
    RAPID_DROP: 'holding' as GuardScope,
    /** 規則4：既有 5m 形態訊號（PATTERN_RULES）推手機的範圍 */
    PATTERN_NTFY: 'holding' as GuardScope,
    /** 規則5（2026-07-05 漏網-3）：昨日高檔轉折訊號＋今晨開低（課程 CH2-9 開盤定強弱） */
    REVERSAL_OPEN: 'holding' as GuardScope,
    /** 規則6（2026-07-05 直播 QA③）：大跌開低「禁開盤殺單」緩衝提示 */
    GAP_OPEN_BUFFER: 'holding' as GuardScope,
    /** 規則7（2026-07-05 批次E）：鎖股名單盤中越關鍵價提醒（lockroster 項本來就非持倉 → 'all'） */
    KEY_LEVEL_BREAKOUT: 'all' as GuardScope,
  },
  /** 規則2：當日曾漲幅門檻（dayHigh vs 昨收）— 4% 高於多數個股日常振幅 */
  PUMP_MIN_GAIN_PCT: 0.04,
  /** 規則2：自當日高點回檔門檻 — 回 3% 已抹掉大半漲幅（倒貨實質確認） */
  PUMP_DRAWDOWN_PCT: 0.03,
  /** 規則3：急殺視窗（分鐘） */
  RAPID_DROP_WINDOW_MIN: 5,
  /** 規則3：視窗內跌幅門檻 — 5 分鐘 3% ≈ 正常 1m 波動的 2-6 倍 */
  RAPID_DROP_PCT: 0.03,
  /** 規則3：基準 bar 距視窗邊界的容忍度（分鐘）— 太舊（CN 午休/斷線缺口）視同無基準 skip，
   *  否則午休跳空/40 分鐘緩跌會被誤報成「近 5 分鐘急殺」還吃掉當日 dedup */
  RAPID_DROP_REF_TOLERANCE_MIN: 3,
  /** 規則2/3 開盤暖機分鐘數（避開集合競價/開盤噪音；規則1 保命不暖機） */
  OPEN_WARMUP_MIN: 5,
  /** 規則5：開盤確認觀察窗（分鐘）— 課程「次日開盤方向定強弱」看開盤後半小時 */
  REVERSAL_OPEN_WINDOW_MIN: 30,
  /** 規則5：「開低」門檻（vs 昨收）— 0.5%（⚠️ 自創量化，課程只說開低） */
  REVERSAL_OPEN_LOW_PCT: 0.005,
  /** 規則6：「大跌開低」門檻（vs 昨收）— 3%（⚠️ 自創量化，直播 QA 只說大跌開低） */
  GAP_OPEN_LOW_PCT: 0.03,
  /** 規則6：開盤緩衝觀察窗（分鐘）— 課程紀律：開盤別市價殺單，13:20 再按規則處理 */
  GAP_OPEN_WINDOW_MIN: 30,
  /** 規則4：哪些既有形態規則走持倉推播（blowoff-bullish 是買訊、非保命，不含） */
  PATTERN_RULES: ['blowoff-bearish', 'terminal-rally', 'ma5-breakdown'],
} as const;
