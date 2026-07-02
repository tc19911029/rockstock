/**
 * 資金成長路徑反推（Phase 2.3）
 *
 * 為什麼存在：使用者目標「7,000 萬 → 3 億，2026/12/31」。沒有月度里程碑就沒辦法
 * 早期判斷是否落後、需不需要降槓桿。這支模組純函式 + 檔案層分離。
 *
 * 模型：
 *   r = (target/start)^(1/N) - 1   // monthly compounding rate
 *   target_at_month_i = start × (1+r)^i
 *
 * Status bands（用戶 2026-05-23 決議 -5% 黃 / -10% 紅，比 plan 初稿 -15% 紅更緊
 *  因為月化 23% 已逼近回測天花板，落後越多越難回補）：
 *   green:  gap ≥ warningYellow（預設 ≥ -5%）
 *   yellow: warningRed ≤ gap < warningYellow
 *   red:    gap < warningRed（預設 < -10%）
 *
 * 規則 #5 不變：紅燈時建議減槓桿 / 加速換股，**禁止**放寬選股條件。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';

export const GROWTH_PATH_SCHEMA_VERSION = 1 as const;

export interface GrowthMilestone {
  yearMonth: string;           // 'YYYY-MM'
  targetEnd: number;           // 期末目標總資金
}

export interface GrowthWarningBands {
  yellowPct: number;           // 負值，例 -0.05
  redPct: number;              // 負值，例 -0.10
}

export interface GrowthPathFile {
  schemaVersion: typeof GROWTH_PATH_SCHEMA_VERSION;
  startDate: string;
  startCapital: number;
  targetDate: string;
  targetCapital: number;
  monthlyRate: number;
  milestones: GrowthMilestone[];
  warningBands: GrowthWarningBands;
  notes?: string;
  generatedAt: string;
}

export type ProgressStatus = 'green' | 'yellow' | 'red' | 'unknown';

export interface ProgressSnapshot {
  asOfDate: string;
  currentCapital: number;
  currentMonth: string;
  currentMonthTarget: number | null;
  /** gap = (currentCapital - currentMonthTarget) / currentMonthTarget */
  gapPct: number | null;
  status: ProgressStatus;
  /** 距 targetDate 還剩幾月（含當月）*/
  monthsRemaining: number;
  /** 達標所需剩餘月化複利（從現在到 targetDate）*/
  requiredMonthlyRate: number | null;
  /** 簡述（給 UI / skill 用）*/
  message: string;
}

// ────────────────────────────────────────────────────────────────────────────
// 純函式
// ────────────────────────────────────────────────────────────────────────────

/** 月差（end - start），含端點。例：2026-05 → 2026-12 = 7 個月 */
export function monthsBetween(startDate: string, endDate: string): number {
  const s = new Date(startDate);
  const e = new Date(endDate);
  return (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());
}

/** 解月化複利 r 滿足 (1+r)^N = target/start */
export function solveMonthlyRate(startCapital: number, targetCapital: number, months: number): number {
  if (months <= 0) return 0;
  if (startCapital <= 0) throw new Error('startCapital must be positive');
  return Math.pow(targetCapital / startCapital, 1 / months) - 1;
}

/** 每月最後一天 'YYYY-MM-DD'（不含跨月） */
function endOfMonth(yearMonth: string): string {
  const [y, m] = yearMonth.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${yearMonth}-${String(last).padStart(2, '0')}`;
}

/** 產生月度 milestones（startDate 所在月起算到 targetDate 所在月）
 *
 * Convention：
 *   - 第一筆 = startMonth（i=0），targetEnd = startCapital（不壓縮，因為從 5/23 到 5/31
 *     只有 8 天，不適合算 1 個月複利）
 *   - 之後每筆 i++，targetEnd = startCapital × (1+r)^i
 *   - 最後一筆 = targetMonth，i = monthsBetween，targetEnd ≈ targetCapital
 */
export function generateMilestones(args: {
  startDate: string;
  startCapital: number;
  targetDate: string;
  monthlyRate: number;
}): GrowthMilestone[] {
  const startYM = args.startDate.slice(0, 7);     // 'YYYY-MM'
  const endYM = args.targetDate.slice(0, 7);
  const milestones: GrowthMilestone[] = [];
  const [startYear, startMonth] = startYM.split('-').map(Number);
  let year = startYear;
  let month = startMonth - 1; // 0-indexed
  let i = 0;
  while (true) {
    const ym = `${year}-${String(month + 1).padStart(2, '0')}`;
    milestones.push({
      yearMonth: ym,
      targetEnd: Math.round(args.startCapital * Math.pow(1 + args.monthlyRate, i)),
    });
    if (ym >= endYM) break;                       // 字串比對避免時區問題
    month++;
    if (month > 11) { month = 0; year++; }
    i++;
    if (i > 60) break; // safety: max 5 years
  }
  return milestones;
}

export function buildGrowthPath(args: {
  startDate: string;
  startCapital: number;
  targetDate: string;
  targetCapital: number;
  warningBands?: GrowthWarningBands;
  notes?: string;
}): GrowthPathFile {
  const months = monthsBetween(args.startDate, args.targetDate);
  const monthlyRate = solveMonthlyRate(args.startCapital, args.targetCapital, months);
  const milestones = generateMilestones({
    startDate: args.startDate,
    startCapital: args.startCapital,
    targetDate: args.targetDate,
    monthlyRate,
  });
  return {
    schemaVersion: GROWTH_PATH_SCHEMA_VERSION,
    startDate: args.startDate,
    startCapital: args.startCapital,
    targetDate: args.targetDate,
    targetCapital: args.targetCapital,
    monthlyRate,
    milestones,
    warningBands: args.warningBands ?? { yellowPct: -0.05, redPct: -0.10 },
    notes: args.notes,
    generatedAt: new Date().toISOString(),
  };
}

/** 給 path + asOfDate + currentCapital → 算當前進度 */
export function computeProgress(
  pathFile: GrowthPathFile,
  asOfDate: string,
  currentCapital: number,
): ProgressSnapshot {
  const currentMonth = asOfDate.slice(0, 7);
  const milestone = pathFile.milestones.find(m => m.yearMonth === currentMonth) ?? null;
  const currentMonthTarget = milestone?.targetEnd ?? null;
  const gapPct = currentMonthTarget && currentMonthTarget > 0
    ? +((currentCapital - currentMonthTarget) / currentMonthTarget).toFixed(4)
    : null;

  let status: ProgressStatus = 'unknown';
  if (gapPct != null) {
    if (gapPct >= pathFile.warningBands.yellowPct) status = 'green';
    else if (gapPct >= pathFile.warningBands.redPct) status = 'yellow';
    else status = 'red';
  }

  // 剩餘月份 + 達標所需 r
  const monthsRemaining = Math.max(0, monthsBetween(asOfDate, pathFile.targetDate));
  let requiredMonthlyRate: number | null = null;
  if (monthsRemaining > 0 && currentCapital > 0) {
    requiredMonthlyRate = +(Math.pow(pathFile.targetCapital / currentCapital, 1 / monthsRemaining) - 1).toFixed(4);
  } else if (monthsRemaining === 0) {
    requiredMonthlyRate = 0;
  }

  let message = '';
  if (status === 'green') {
    message = `綠燈：當前資金 ${currentCapital.toLocaleString()} 達 ${currentMonth} 期末目標 ${currentMonthTarget?.toLocaleString()} 之 ${((1 + (gapPct ?? 0)) * 100).toFixed(1)}%；剩餘月化需求 ${((requiredMonthlyRate ?? 0) * 100).toFixed(2)}%`;
  } else if (status === 'yellow') {
    message = `黃燈：當前資金落後 ${((gapPct ?? 0) * 100).toFixed(1)}%（介於 ${(pathFile.warningBands.redPct * 100).toFixed(0)}% 與 ${(pathFile.warningBands.yellowPct * 100).toFixed(0)}%）；剩餘月化需求 ${((requiredMonthlyRate ?? 0) * 100).toFixed(2)}%`;
  } else if (status === 'red') {
    message = `紅燈：當前資金落後 ${((gapPct ?? 0) * 100).toFixed(1)}%（超過 ${(pathFile.warningBands.redPct * 100).toFixed(0)}%）；觸發降槓桿建議。剩餘月化需求 ${((requiredMonthlyRate ?? 0) * 100).toFixed(2)}%`;
  } else {
    message = `無法判定：缺 ${currentMonth} 月度 milestone（asOfDate ${asOfDate} 超出路徑範圍？）`;
  }

  return {
    asOfDate,
    currentCapital,
    currentMonth,
    currentMonthTarget,
    gapPct,
    status,
    monthsRemaining,
    requiredMonthlyRate,
    message,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// FS 層
// ────────────────────────────────────────────────────────────────────────────

const GROWTH_DIR = path.join(process.cwd(), 'data', 'portfolio');
const GROWTH_FILE = path.join(GROWTH_DIR, 'growth-path.json');

export async function loadGrowthPath(): Promise<GrowthPathFile | null> {
  try {
    const raw = await fs.readFile(GROWTH_FILE, 'utf-8');
    return JSON.parse(raw) as GrowthPathFile;
  } catch { return null; }
}

export async function saveGrowthPath(file: GrowthPathFile): Promise<void> {
  await fs.mkdir(GROWTH_DIR, { recursive: true });
  await atomicFsPut(GROWTH_FILE, JSON.stringify(file, null, 2));
}

export async function regenGrowthPath(args: {
  startDate: string;
  startCapital: number;
  targetDate: string;
  targetCapital: number;
  warningBands?: GrowthWarningBands;
  notes?: string;
}): Promise<GrowthPathFile> {
  const file = buildGrowthPath(args);
  await saveGrowthPath(file);
  return file;
}
