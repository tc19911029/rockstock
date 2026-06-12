/**
 * 三大法人衍生欄位 — 純衍生計算，零新資料源
 *
 *   - 外資 / 投信連續買超天數（從最新交易日往回數，淨買 > 0 算連續；0 或賣超中斷）
 *   - 最新日買賣超占當日成交量百分比（法人買賣超與 L1 成交量單位皆為「張」）
 *   - 外資 + 投信同日同步買超（最新日 + 連續天數）
 *
 * 純函式：吃升冪日期排序的法人日序列 + 最新日成交量（張），不打任何外部 API。
 * 純顯示/判讀用途 — 不可接進選股 gate（鐵則 #5）。
 */

export interface InstDerived {
  /** 外資連續買超天數（最新日賣超或持平 → 0） */
  foreignConsecBuyDays: number;
  /** 投信連續買超天數（同上） */
  trustConsecBuyDays: number;
  /** 最新日外資買賣超(張) ÷ 當日成交量(張) × 100（1 位小數；成交量缺或 0 → null） */
  foreignNetToVolumePct: number | null;
  /** 最新日投信買賣超(張) ÷ 當日成交量(張) × 100（同上） */
  trustNetToVolumePct: number | null;
  /** 外資 + 投信最新日同步買超（兩者淨買 > 0） */
  instSyncBuy: boolean;
  /** 外資 + 投信「同日同步買超」連續天數 */
  instSyncBuyDays: number;
}

export const EMPTY_INST_DERIVED: InstDerived = {
  foreignConsecBuyDays: 0,
  trustConsecBuyDays: 0,
  foreignNetToVolumePct: null,
  trustNetToVolumePct: null,
  instSyncBuy: false,
  instSyncBuyDays: 0,
};

interface InstNetRow {
  date: string;
  foreign: number;
  trust: number;
}

/** 從序列最後一筆往回數連續滿足 pred 的天數；最新一筆不滿足 → 0 */
function consecFromTail<T>(rows: T[], pred: (r: T) => boolean): number {
  let count = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (pred(rows[i])) count++;
    else break;
  }
  return count;
}

/** 買賣超占成交量百分比（保留 1 位小數）；成交量缺/非正數 → null */
function netToVolumePct(net: number, volumeLots: number | null | undefined): number | null {
  if (volumeLots == null || !Number.isFinite(volumeLots) || volumeLots <= 0) return null;
  return +((net / volumeLots) * 100).toFixed(1);
}

/**
 * 計算三大法人衍生欄位。
 *
 * @param rows            法人日序列（升冪 by date；每列 foreign/trust 單位「張」）
 * @param latestVolumeLots 最新一筆 row 對應日的當日總成交量（張）；缺資料傳 null
 */
export function computeInstDerived(
  rows: InstNetRow[],
  latestVolumeLots: number | null | undefined,
): InstDerived {
  if (rows.length === 0) return { ...EMPTY_INST_DERIVED };

  const latest = rows[rows.length - 1];

  return {
    foreignConsecBuyDays: consecFromTail(rows, r => r.foreign > 0),
    trustConsecBuyDays: consecFromTail(rows, r => r.trust > 0),
    foreignNetToVolumePct: netToVolumePct(latest.foreign, latestVolumeLots),
    trustNetToVolumePct: netToVolumePct(latest.trust, latestVolumeLots),
    instSyncBuy: latest.foreign > 0 && latest.trust > 0,
    instSyncBuyDays: consecFromTail(rows, r => r.foreign > 0 && r.trust > 0),
  };
}
