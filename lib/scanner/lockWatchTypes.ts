/**
 * 鎖股觀察名單（LockWatch）資料結構
 *
 * v12 Phase 0.3 / 議題 23 / 65 / 93
 *
 * 適用範圍：F V 反轉 / N 型態確認（觸發時 detectTrend 通常還沒翻多，需走觀察階段）
 *
 * **不適用**：
 * - D 一字底（觸發 = 即時翻多事件，直接進場）
 * - O 打底完成（要件已含「反轉多頭確認」，直接進場）
 * - K 橫盤突破（多頭軌，走 ScanRecord.provisional）
 * - 多頭軌訊號（B/P/C/E/J/L/M）— 直接進場
 * - Q 戰法（獨立 SOP）
 *
 * 書本依據：
 * - 寶典 Part 11-1 第 7 位置「等型態確認」p.697
 * - 5 步驟 步驟 1 第 7 章「鎖股觀察」p.106
 * - 寶典 p.689 #12「最佳的 3-5 檔再檢視一遍」
 */

import type { MarketId } from './types';
import type { PatternPivotSnapshot } from '../analysis/patternCatalog';

/**
 * 一筆觀察名單紀錄
 *
 * 跨日持續追蹤，每日 cron 更新狀態。
 */
export interface LockWatchRecord {
  symbol: string;
  market: MarketId;

  /** 觸發日 ISO yyyy-mm-dd */
  triggeredDate: string;

  /** 觸發訊號（v12 議題 93：只有 F / N 走 LockWatch）*/
  triggerSignal: 'F' | 'N';

  /**
   * N 訊號的具體型態類型（多頭進場：底部型態 + N 字底）
   *
   * 底部型態（向上突破做多）：
   * - 'head-shoulder' 頭肩底
   * - 'complex-head-shoulder' 複式頭肩底
   * - 'triple-bottom' 三重底
   * - 'falling-diamond' 跌菱形
   * - 'rounding-bottom' 圓弧底
   * - 'descending-wedge' 下降楔形
   * - 'double-bottom' 雙重底
   * - 'n-shape' N 字底（A 高→B 低→C 突破 A 高，2026-05-10 補實作）
   *
   * 頂部型態（向下跌破做空 / 出場警示，2026-05-10 補實作）：
   * - 'head-shoulder-top' 頭肩頂
   * - 'triple-top' 三重頂
   * - 'double-top' 雙重頂
   * - 'complex-head-shoulder-top' 複式頭肩頂
   * - 'inverted-n-top' 倒 N 字頂
   * - 'long-double-top' 長雙頭頂
   * - 'one-line-top' 一字頂
   */
  patternType?:
    | 'head-shoulder'
    | 'complex-head-shoulder'
    | 'triple-bottom'
    | 'falling-diamond'
    | 'rounding-bottom'
    | 'descending-wedge'
    | 'double-bottom'
    | 'n-shape'
    | 'head-shoulder-top'
    | 'triple-top'
    | 'double-top'
    | 'complex-head-shoulder-top'
    | 'inverted-n-top'
    | 'long-double-top'
    | 'one-line-top';

  /**
   * 觸發日鎖定的突破點價格（議題 24 / 75）
   * - F：V 底反彈起點 close（鎖定價，UI 顯示用；不是結構失效判定點）
   * - N：型態頸線價（撤銷判定基準）
   */
  triggerPrice: number;

  /**
   * F V 反轉專用：實際 V 底（變盤線 low）
   *
   * 結構失效判定用：`c.low < vBottom` → 跌破 V 底 → structure-broken
   * 不可用 triggerPrice（rebound close 高於 V 底，會 false positive）
   */
  vBottom?: number;

  /**
   * 型態目標價（N 訊號用，議題 Step 5 ②）
   *
   * 達目標價 → 觸發 Step 5 停利訊號
   *
   * 計算公式（依型態，2026-05-10 對齊書本《抓飆股》Part 7）：
   * - 頭肩底：頸線 + (頸線 - 頭部最低)
   * - 三重底：頸線 + (頸線 - 三底最低點)
   * - 圓弧底：頸線 + 弧底深度
   * - 雙重底：頸線 + (頸線 - 兩底最低)
   * - N 字底：右腳 B + (前高 A - 第一隻深腳)
   * - 頭肩頂：頸線 - (頭部最高 - 頸線)
   * - 三重頂：頸線 - (最高點 - 頸線)
   * - 雙重頂：頸線 - (最高點 - 頸線)
   */
  patternTargetPrice?: number;

  /**
   * N 型態真正的結構失效門檻（已包含 detector 的 3% 確認緩衝）。
   * 舊紀錄缺值時才回退到 triggerPrice × 0.97。
   */
  structureBrokenPrice?: number;

  /** 建立／最近一次重驗這筆 N 型態時使用的 detector 契約版本。 */
  detectorVersion?: number;

  /** 觸發日凍結的型態腳位；避免日後 pivot 重組後，圖上冒用另一組同名型態。 */
  patternPivots?: PatternPivotSnapshot[];

  /**
   * 舊書型態達成目標價比例（0–1）；不是 Rockstock 回測勝率。
   * 新 UI 會依 canonical 型態表顯示，忽略舊資料中的自行估值。
   */
  patternAchievementRate?: number;

  /**
   * 當前生命週期階段
   *
   * 0513 ABCDE E：對齊書本後簡化 — pending-breakout 跟 entry-signal 都 deprecated
   * 書本（寶典 Part 11-1 第 7 位置 p.697）：型態確認當下就是進場訊號，不分兩段觀察
   *
   * - observation：書本進場條件已觸發（N 真突破 / F V 反彈）
   * - purchased：用戶已買進
   * - revoked：訊號失效（close < triggerPrice / 翻空）
   * - manually-removed：用戶手動移除
   * - structure-broken：結構失效自動移除
   * - ⚠️ pending-breakout (deprecated)：舊資料相容，0513 後不再寫入
   * - ⚠️ entry-signal (deprecated)：舊資料相容，0513 後 updateLockWatch 不再升級
   */
  currentStage:
    | 'observation'
    | 'purchased'
    | 'revoked'
    | 'manually-removed'
    | 'structure-broken'
    | 'target-reached'
    /** @deprecated 0513 ABCDE 對齊書本後不再寫入，僅相容舊資料 */
    | 'pending-breakout'
    /** @deprecated 0513 ABCDE 對齊書本後不再寫入，僅相容舊資料 */
    | 'entry-signal';

  /**
   * 已觀察天數（資訊用，非過期判定）
   * 議題 17 鎖定純書本不限期，daysObserved 純供 UI 顯示
   */
  daysObserved: number;

  /**
   * 最近一次更新時的 close（每日 update-lockwatch cron 自動維護）
   * UI 顯示「現價」+ 重算「目標價距現價爬升空間」用
   * 2026-05-11 Phase D 新增
   */
  currentClose?: number;

  /** 完整事件歷史 */
  history: LockWatchEvent[];
}

export interface LockWatchEvent {
  date: string;
  event:
    | 'triggered'
    | 'provisional-pass'
    | 'provisional-revoke'
    | 'breakout-confirmed'   // close 過頸線×1.03 真突破 → pending-breakout 升級 observation
    | 'trend-confirmed'      // detectTrend 翻多 → entry-signal 升級
    | 'sop-passed'           // 進場 SOP 通過
    | 'purchased'            // 用戶買進
    | 'manual-remove'        // 用戶手動移除
    | 'structure-broken'     // 結構失效自動移除
    | 'target-reached';      // 已進入型態目標價緩衝區，不再提供新進場
  detail?: string;
}

/**
 * 一日的觀察名單（議題 61：單檔合併寫入避免 Blob 成本爆炸）
 *
 * 儲存路徑：data/lock-watch/{market}/{date}.json
 */
export interface LockWatchDailySnapshot {
  market: MarketId;
  /** 快照日期 ISO yyyy-mm-dd */
  date: string;
  /** 該日觀察名單股票（含所有 active 紀錄）*/
  records: LockWatchRecord[];
  /** 最後更新時間 ISO timestamp */
  lastUpdated: string;
}
