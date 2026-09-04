/**
 * Single Source of Truth: 面板實際顯示的選股邏輯
 *
 * 一個純函式，三方共用：
 * - 前端 `store/backtestStore.ts` 的 MTF toggle 過濾
 * - 回測腳本 `scripts/backtest-*.ts` 的最終 pick 判定
 * - 合約測試 `__tests__/contracts/scan-parity.test.ts` 的 oracle
 *
 * ScanPipeline 已保證輸入的 results 都通過：
 *   - 前 500 成交額
 *   - 六條件 ≥ 5 分
 *   - 10 大戒律（checkLongProhibitions）
 *   - 淘汰法 R1-R11（evaluateElimination）
 *
 * 本函式只負責面板 UI 層追加的過濾 + 排序。改動前請先閱讀 `CLAUDE.md` 第 10 條。
 */
import type { StockScanResult } from '@/lib/scanner/types';
import { passesMtf } from '@/lib/scanner/mtfPass';

export interface PanelFilterOptions {
  /** 是否開啟 MTF 長線保護（等同 App 面板「長線保護短線」toggle） */
  useMultiTimeframe: boolean;
}

/**
 * 處置股硬排除（2026-06-12 B1）— 三方共用的唯一判定。
 *
 * 處置期間改人工管制分盤撮合（約 5 分鐘一次）+ 大額委託預收款券，
 * 屬交易制度層「不可交易性」（同漲停買不到），不是選股因子（不違鐵則 #5）。
 * 旗標由 saveScanSession 寫入 L4 時按官方名單蓋章（lib/market/attentionList.ts）；
 * 歷史 session 無此欄位（undefined）→ 不剔除。注意股（attentionNotice）只警示不排除。
 */
export function isDisposalVetoed(r: Pick<StockScanResult, 'disposalVeto'>): boolean {
  return r.disposalVeto === true;
}

/**
 * 對 scan session 的 results 套用面板顯示規則。
 * @param results ScanPipeline 產生、已通過六條件+戒律+淘汰法的候選
 * @param options 面板切換狀態
 */
export function applyPanelFilter(
  results: readonly StockScanResult[],
  options: PanelFilterOptions,
): StockScanResult[] {
  let filtered = [...results];

  // 處置股硬排除：不分 MTF on/off 一律剔除（見 isDisposalVetoed 註解）
  filtered = filtered.filter(r => !isDisposalVetoed(r));

  // MTF gate：優先使用已套用週／月 strict 設定的 mtfPass；舊 session 才退回 mtfWeeklyPass。
  //
  // 嚴格 `=== true`：null（未計算 MTF）在此一律排除。本函式假設輸入的 results
  // 都來自「scan 時已 ALWAYS 計算 mtfWeeklyPass」的新 session。
  // 注意 store/backtestStore.ts 的 client-side toggle 用的是寬容版
  // （`mtfWeeklyPass == null || === true`），那是為了相容「舊 B/C/D/E session
  // 未算 MTF」的歷史資料 → null 當保留。兩者語意差異是刻意的，不是不一致：
  //   - 本函式（oracle / 回測 pick）：嚴格，null 不該出現
  //   - backtestStore（UI 即時 toggle）：寬容，避免舊 session 被整批清空
  // 改動任一處前先讀 CLAUDE.md 第 10 條 + 對方註解。
  if (options.useMultiTimeframe) {
    filtered = filtered.filter(r => passesMtf(r));
  }

  filtered.sort(panelSortCompare);

  return filtered;
}

/**
 * 面板排序比較器 — 三方共用（applyPanelFilter / backtest-run / UI BacktestSection）
 *
 * 主鍵：漲幅 desc（2026-04-19 回測驗證：漲幅在 Top500 全期冠軍）
 * 次鍵：六條件總分 desc
 * 第三鍵：MA20 斜率 desc — 朱老師 CH3「均線三大力量」角度量化（2026-05-21 線上課程）
 *   只在雙方都是「多頭」時才生效，避免初轉多股票因 MA20 還沒翻揚被誤排
 *
 * 改這個比較器等於改 UI 顯示 top N + 回測 top N + UI 排序，三方同步動。
 */
export function panelSortCompare(a: StockScanResult, b: StockScanResult): number {
  const d1 = (b.changePercent ?? 0) - (a.changePercent ?? 0);
  if (d1 !== 0) return d1;
  const d2 = (b.sixConditionsScore ?? 0) - (a.sixConditionsScore ?? 0);
  if (d2 !== 0) return d2;
  // 第三鍵僅在雙方都多頭時觸發
  if (a.trendState === '多頭' && b.trendState === '多頭') {
    return (b.ma20Slope ?? 0) - (a.ma20Slope ?? 0);
  }
  return 0;
}

/**
 * 依面板的三層 lexicographic 規則排序，支援正反方向且保持原陣列不變。
 * 不可把三個欄位相加成單一浮點 key：主鍵只差 0.001 時，次鍵就可能反客為主。
 */
export function sortByPanelOrder(
  results: readonly StockScanResult[],
  direction: 'asc' | 'desc' = 'desc',
): StockScanResult[] {
  const mult = direction === 'desc' ? 1 : -1;
  return [...results].sort((a, b) => mult * panelSortCompare(a, b));
}

/**
 * @deprecated 只能供舊研究腳本做近似分數，正式 UI／選股請用 panelSortCompare 或
 * sortByPanelOrder。浮點加權無法保證與 lexicographic 排序等價。
 */
export function panelSortKey(
  r: Pick<StockScanResult, 'changePercent' | 'sixConditionsScore'> &
     Partial<Pick<StockScanResult, 'trendState' | 'ma20Slope'>>,
): number {
  const base = (r.changePercent ?? 0) + (r.sixConditionsScore ?? 0) / 1000;
  if (r.trendState === '多頭') {
    return base + (r.ma20Slope ?? 0) / 1_000_000;
  }
  return base;
}

/**
 * 取第一名 — B1 買入策略（all-in 排名第一）專用。
 * 回傳 null 代表當日沒有候選可買。
 */
export function panelTopPick(
  results: readonly StockScanResult[],
  options: PanelFilterOptions,
): StockScanResult | null {
  const filtered = applyPanelFilter(results, options);
  return filtered.length > 0 ? filtered[0] : null;
}
