/**
 * 停損下修紅旗（課程 CH7-1 停損原則 #2，2026-07-06）
 *
 * 課程原文（7-1 逐字稿）：「停損設了就不可以改，否則你就等於沒設停損，
 * 到了你又不賣就是沒有，停損白設了。」
 *
 * 與 [[averagingDownGuard]] 同屬「凹單行為」偵測 —— 賠錢時把停損往「放鬆」方向挪，
 * 就是變相不停損，正對北極星「錢坑在執行不在訊號」。偵測點同樣掛 upsert 咽喉單點，純函式無 IO。
 *
 * 「放鬆」方向依部位方向而反：
 *   - 做多（long）：停損在價格下方 → 往「下」改（incoming < existing）＝放大風險＝凹單
 *   - 做空（short）：停損在價格上方 → 往「上」改（incoming > existing）＝放大風險＝凹單
 * 反方向（做多往上、做空往下）＝收緊停損 / 移動停利，是課程允許的正常操作，不標旗。
 *
 * 保守設計（避免誤觸）：
 *   - 只在 existing 與 incoming 都有 stopLoss 數值時比較；缺任一值跳過（client 沒重送 stopLoss
 *     不等於「移除停損」，不臆測）。
 *   - 只標旗不擋寫入；紅旗常駐到平倉（寫進 holding.ui.disciplineFlags，daily-action 每日透出）。
 */

export type PositionSide = 'long' | 'short';

export interface StopLossLoweredFlag {
  date: string;      // 偵測日 YYYY-MM-DD
  fromStop: number;  // 下修前停損價
  toStop: number;    // 下修後停損價
  side: PositionSide;
}

export interface DetectStopLossLoweredArgs {
  existing: { stopLoss?: number | null };
  incoming: { stopLoss?: number | null };
  /** 部位方向；缺值視為做多（多數持倉為多單） */
  positionSide?: PositionSide | null;
}

export function detectStopLossLowered(args: DetectStopLossLoweredArgs): { flagged: boolean; detail: string } {
  const { existing, incoming } = args;
  const side: PositionSide = args.positionSide ?? 'long';
  const from = existing.stopLoss;
  const to = incoming.stopLoss;
  if (from == null || to == null) {
    return { flagged: false, detail: '缺停損值（未重送或未設，不臆測）' };
  }
  // 放鬆方向：做多往下、做空往上
  const loosened = side === 'long' ? to < from : to > from;
  if (!loosened) {
    return { flagged: false, detail: side === 'long' ? '停損未下修（收緊或不變）' : '停損未上修（收緊或不變）' };
  }
  const dir = side === 'long' ? '往下' : '往上';
  return {
    flagged: true,
    detail: `停損 ${from} → ${to}（${side === 'long' ? '做多' : '做空'}${dir}放鬆）。課程 CH7-1：停損設了就不可以改，往鬆改＝等於沒設停損`,
  };
}

/**
 * 把停損下修紅旗 merge 進 upsert 要寫入的 ui blob（同 mergeAveragedDownFlag 邏輯）。
 * - 新偵測到 → 寫入 stopLossLowered
 * - 既有紅旗 → carry over（常駐到平倉；client 全量覆寫 ui blob 時不得洗掉）
 */
export function mergeStopLossLoweredFlag(
  incomingUi: Record<string, unknown> | undefined,
  existingUi: Record<string, unknown> | undefined,
  newFlag: StopLossLoweredFlag | null,
): Record<string, unknown> | undefined {
  const existingFlags = (existingUi?.disciplineFlags ?? {}) as Record<string, unknown>;
  const incomingFlags = (incomingUi?.disciplineFlags ?? {}) as Record<string, unknown>;
  const carried = existingFlags.stopLossLowered ?? incomingFlags.stopLossLowered;
  const stopLossLowered = newFlag ?? carried;
  if (stopLossLowered == null) return incomingUi;
  return {
    ...(incomingUi ?? {}),
    disciplineFlags: { ...incomingFlags, stopLossLowered },
  };
}

/** daily-action 端：從 holding.ui 讀紅旗（型別鬆散 passthrough blob，防呆解析） */
export function readStopLossLoweredFlag(ui: Record<string, unknown> | undefined): StopLossLoweredFlag | null {
  const flags = ui?.disciplineFlags as Record<string, unknown> | undefined;
  const f = flags?.stopLossLowered as Partial<StopLossLoweredFlag> | undefined;
  if (f && typeof f.fromStop === 'number' && typeof f.toStop === 'number') {
    return {
      date: typeof f.date === 'string' ? f.date : '',
      fromStop: f.fromStop,
      toStop: f.toStop,
      side: f.side === 'short' ? 'short' : 'long',
    };
  }
  return null;
}
