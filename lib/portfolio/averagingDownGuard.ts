/**
 * 向下攤平紅旗（課程 CH10-2 散戶錯誤行為 #02，2026-07-04）
 *
 * 課程原文：「往下攤平是在加碼一檔往下跌的股票，股票既然往下跌，當然不是買進的標的，
 * 這樣的操作完全錯誤。唯有在價值型投資（歷史底部＋資金充裕分批投入）才能使用。」
 *
 * 偵測點 = /api/agents/portfolio POST upsert 咽喉（portfolioStore.add/update 的 server sync、
 * /api/portfolio/import、直接打 API 全部經過這裡）。純函式、無 IO。
 *
 * 偵測規則（保守，避免「改錯字修價格」誤觸）：
 *   同 symbol 已有 open 持倉，且 shares 增加 且 新均價 < 舊均價
 *   —— 股數變多且均價被攤低，算術上只可能是「往下加碼」。
 *   lastClose 可選：有現價時再加「現價 < 舊均價（虧損中）」檢查；缺值跳過該檢查。
 *
 * 紅旗常駐到平倉（寫進 holding.ui.disciplineFlags，daily-action 每日透出）。
 */

export interface AveragedDownFlag {
  date: string;       // 偵測日 YYYY-MM-DD
  fromPrice: number;  // 攤平前均價
  toPrice: number;    // 攤平後均價
}

export interface DetectAveragingDownArgs {
  existing: { entryPrice: number; shares: number };
  incoming: { entryPrice: number; shares: number };
  /** 現價（判「虧損中」）；缺值只用均價/股數算術判定 */
  lastClose?: number | null;
}

export function detectAveragingDown(args: DetectAveragingDownArgs): { flagged: boolean; detail: string } {
  const { existing, incoming, lastClose } = args;
  if (!(incoming.shares > existing.shares)) {
    return { flagged: false, detail: '股數未增加（非加碼）' };
  }
  if (!(incoming.entryPrice < existing.entryPrice)) {
    return { flagged: false, detail: '均價未下降（非向下攤平）' };
  }
  if (lastClose != null && lastClose >= existing.entryPrice) {
    return { flagged: false, detail: '現價未低於原均價（非虧損中加碼）' };
  }
  return {
    flagged: true,
    detail: `均價 ${existing.entryPrice} → ${incoming.entryPrice}、股數 ${existing.shares} → ${incoming.shares}：虧損中向下攤平。課程 CH10-2：攤平=加碼下跌中的股票，完全錯誤（唯價值型+歷史底部+資金充裕例外）`,
  };
}

/**
 * 把攤平紅旗 merge 進 upsert 要寫入的 ui blob。
 * - 新偵測到 → 寫入 averagedDown
 * - 既有紅旗（disciplineFlags.averagedDown）→ 無條件 carry over（紅旗常駐到平倉；
 *   client 全量覆寫 ui blob 時不得洗掉）
 */
export function mergeAveragedDownFlag(
  incomingUi: Record<string, unknown> | undefined,
  existingUi: Record<string, unknown> | undefined,
  newFlag: AveragedDownFlag | null,
): Record<string, unknown> | undefined {
  const existingFlags = (existingUi?.disciplineFlags ?? {}) as Record<string, unknown>;
  const incomingFlags = (incomingUi?.disciplineFlags ?? {}) as Record<string, unknown>;
  const carried = existingFlags.averagedDown ?? incomingFlags.averagedDown;
  const averagedDown = newFlag ?? carried;
  if (averagedDown == null) return incomingUi;
  return {
    ...(incomingUi ?? {}),
    disciplineFlags: { ...incomingFlags, averagedDown },
  };
}

/** daily-action 端：從 holding.ui 讀紅旗（型別鬆散的 passthrough blob，防呆解析） */
export function readAveragedDownFlag(ui: Record<string, unknown> | undefined): AveragedDownFlag | null {
  const flags = ui?.disciplineFlags as Record<string, unknown> | undefined;
  const f = flags?.averagedDown as Partial<AveragedDownFlag> | undefined;
  if (f && typeof f.fromPrice === 'number' && typeof f.toPrice === 'number') {
    return { date: typeof f.date === 'string' ? f.date : '', fromPrice: f.fromPrice, toPrice: f.toPrice };
  }
  return null;
}
