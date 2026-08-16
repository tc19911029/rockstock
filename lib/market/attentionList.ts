/**
 * 處置股/注意股名單 — 儲存與查詢單一事實（2026-06-12 B1）
 *
 * 為什麼處置股是「硬排除」而非選股因子：處置期間改人工管制分盤撮合（約 5 分鐘一次）
 * 且大額委託需預收款券 — 是交易制度層的不可交易性（同「漲停買不到」性質），
 * 不需要 alpha 證明、不違鐵則 #5。注意股只警示不排除。
 *
 * 資料流：
 *   /api/cron/fetch-attention-list（每日 17:35 CST）
 *     → data/market/TW/attention/{fetchDate}.json + latest.json（FS atomicFsPut）
 *   saveScanSession（L4 寫入咽喉）→ stampAttentionFlags() 蓋 disposalVeto / attentionNotice
 *   applyPanelFilter.isDisposalVetoed → 顯示/回測層硬排除
 *   riskAgent → groundTruth.attentionFlags（處置=red、注意=yellow 證據）
 */
import fs from 'fs/promises';
import { readFileSync } from 'fs';
import path from 'path';
import type { AttentionEntry } from '@/lib/datasource/AttentionListProvider';

const ATTENTION_DIR = path.join(process.cwd(), 'data', 'market', 'TW', 'attention');
const LATEST_PATH = path.join(ATTENTION_DIR, 'latest.json');

export interface AttentionListFile {
  fetchedAt: string;   // ISO（UTC，讀取時 +8h 才是台灣時間）
  fetchDate: string;   // 抓取當日 YYYY-MM-DD（CST）
  entries: AttentionEntry[];
  sourceCounts: { twsePunish: number; twseNotice: number; tpexDisposal: number; tpexNotice: number };
  /** 抓取失敗的來源（partial 成功仍寫檔，但記錄缺哪條） */
  sourceErrors?: string[];
}

export async function saveAttentionList(file: AttentionListFile): Promise<void> {
  const { atomicFsPut } = await import('@/lib/storage/atomicFsPut');
  await fs.mkdir(ATTENTION_DIR, { recursive: true });
  const data = JSON.stringify(file, null, 2);
  await atomicFsPut(path.join(ATTENTION_DIR, `${file.fetchDate}.json`), data);
  await atomicFsPut(LATEST_PATH, data);
  invalidateAttentionCache();
}

// ── 讀取（in-memory cache，掃描每 session 寫入都會查，必須便宜）──────────────
let cachedFile: AttentionListFile | null = null;
let cachedAt = 0;
const CACHE_TTL = 10 * 60_000;

export function invalidateAttentionCache(): void {
  cachedFile = null;
  cachedAt = 0;
}

export async function readLatestAttentionList(): Promise<AttentionListFile | null> {
  if (cachedFile && Date.now() - cachedAt < CACHE_TTL) return cachedFile;
  try {
    const raw = await fs.readFile(LATEST_PATH, 'utf-8');
    cachedFile = JSON.parse(raw) as AttentionListFile;
    cachedAt = Date.now();
    return cachedFile;
  } catch {
    // 名單未抓過（檔案不存在）→ 全部 no-op，不可擋掃描
    cachedAt = Date.now();
    cachedFile = null;
    return null;
  }
}

/** date 落在處置期間內的裸代號集合 */
export async function getActiveDisposalSet(date: string): Promise<Set<string>> {
  const file = await readLatestAttentionList();
  const out = new Set<string>();
  if (!file) return out;
  for (const e of file.entries) {
    if (e.kind !== 'disposal' || !e.periodStart || !e.periodEnd) continue;
    if (e.periodStart <= date && date <= e.periodEnd) out.add(e.code);
  }
  return out;
}

/** date 往前 lookbackDays 個日曆日內曾公布注意的裸代號集合（警示用，不排除） */
export async function getRecentNoticeSet(date: string, lookbackDays = 5): Promise<Set<string>> {
  const file = await readLatestAttentionList();
  const out = new Set<string>();
  if (!file) return out;
  const floor = new Date(`${date}T00:00:00Z`);
  floor.setUTCDate(floor.getUTCDate() - lookbackDays);
  const floorIso = floor.toISOString().slice(0, 10);
  for (const e of file.entries) {
    if (e.kind !== 'notice') continue;
    if (e.announceDate >= floorIso && e.announceDate <= date) out.add(e.code);
  }
  return out;
}

/** "5483.TWO" / "2330.TW" → 裸代號 */
export function bareCode(symbol: string): string {
  return symbol.split('.')[0];
}

// ── 同步版（scripts/backtest-*.ts 的逐 K 評估函式是同步的，鐵則 #10 同步點）──────
let syncCache: AttentionListFile | null | undefined;

/**
 * symbol 在 date 當天是否處於處置期間。整個 process 只讀一次 latest.json；
 * 名單自 2026-06-12 起收集，更早的歷史日期查無紀錄 = no-op（回 false）。
 */
export function isDisposedOnSync(symbol: string, date: string): boolean {
  if (syncCache === undefined) {
    try {
      syncCache = JSON.parse(readFileSync(LATEST_PATH, 'utf-8')) as AttentionListFile;
    } catch {
      syncCache = null;
    }
  }
  if (!syncCache) return false;
  const code = bareCode(symbol);
  return syncCache.entries.some(e =>
    e.kind === 'disposal' && e.code === code &&
    !!e.periodStart && !!e.periodEnd &&
    e.periodStart <= date && date <= e.periodEnd,
  );
}

/**
 * 對掃描結果蓋處置/注意旗標（mutate in place，冪等）。
 * 由 saveScanSession（L4 唯一寫入點）呼叫 — 所有掃描路徑（六條件/買法軌/盤中）
 * 都經過那裡，蓋章只需一處。名單缺漏時為 no-op，絕不可擋掃描寫入。
 */
export async function stampAttentionFlags(
  results: Array<{ symbol: string; disposalVeto?: boolean; attentionNotice?: boolean }>,
  date: string,
): Promise<void> {
  if (!results.length) return;
  const [disposal, notice] = await Promise.all([
    getActiveDisposalSet(date),
    getRecentNoticeSet(date),
  ]);
  if (disposal.size === 0 && notice.size === 0) return;
  for (const r of results) {
    const code = bareCode(r.symbol);
    if (disposal.has(code)) r.disposalVeto = true;
    if (notice.has(code)) r.attentionNotice = true;
  }
}
