/**
 * 陸股 AI 選股 Agent — 全 domain dual-storage 持久化層
 *
 * 鏡像 lib/cn-sanse/scanStorage.ts 的 dual-storage pattern（自創策略，
 * 刻意與 TW lib/storage/scanStorage 隔離）：
 *   本地 dev：data/cn-agents/{domain}/{date}.json
 *   Vercel ：Blob key cn-agents/{domain}/{date}.json
 *
 * domain 一覽：
 *   limitup-pool — 漲停池日檔（LimitUpPoolDay）
 *   boards       — 板塊快照（BoardsDay）
 *   hotness      — 人氣熱度（HotnessDay）
 *   breadth      — 市場寬度 + 情緒週期（BreadthDayFile）；另有 index.json 近 N 日序列
 *   lhb          — 龍虎榜日檔（LhbDailyFile；P2）
 *   seats        — 席位績效統計 stats.json（SeatStatsFile；registry.json 由
 *                  lib/cn-agents/seats.ts 管，FS-only 不走這裡）
 *   _health      — cron 步驟健康紀錄（CnAgentsHealthDay）
 *
 * 防呆（仿 cn-sanse saveSanSeScan DF8）：saveLimitUpPoolDay 拒存
 * 「全市場明顯活躍（upCount > 2000）卻一檔漲停都沒有」的退化資料 —
 * 這幾乎必是上游抓取壞掉（EM 接口回空 / 解析欄位偏移），存進去會污染
 * 隔日晉級率與情緒狀態機輸入，寧可 throw 讓 cron 記 _health 失敗。
 *
 * 陷阱：upsertBreadthIndex 是 read-merge-write，atomicFsPut 只保證單檔
 * 寫入原子性、不解決並行 lose update（見 atomicFsPut.ts 檔頭）—
 * caller 必須是單一序列化的盤後 cron，不可多路並行 upsert。
 */

import type {
  LimitUpPoolDay,
  BoardsDay,
  HotnessDay,
  BreadthDayFile,
  BreadthIndexFile,
  MarketBreadthDay,
  EmotionCycleDay,
  CnAgentsHealthDay,
  LhbDailyFile,
  SeatStatsFile,
} from './types';
import { BREADTH_INDEX_MAX_DAYS, CN_AGENTS_SCHEMA_VERSION } from './types';
import type { CnRecoEventsFile } from './backtest/recoTypes';
import type { NewsDigestDay, CnAnalysisFile, CnDailyFile } from './types';

const IS_VERCEL = !!process.env.VERCEL;
const ROOT = 'cn-agents';

type CnAgentsDomain = 'limitup-pool' | 'boards' | 'hotness' | 'breadth' | 'lhb' | 'seats' | 'events' | 'news' | 'analysis' | 'daily' | '_health';

// ── Vercel Blob ───────────────────────────────────────────────────────────────

async function blobPut(pathname: string, data: string): Promise<void> {
  const { blobPutWithRetry } = await import('@/lib/storage/blobRetry');
  await blobPutWithRetry(pathname, data, { access: 'private', addRandomSuffix: false, allowOverwrite: true });
}

async function blobGet(pathname: string): Promise<string | null> {
  const { get } = await import('@vercel/blob');
  const result = await get(pathname, { access: 'private' }).catch(() => null);
  if (!result || !result.stream) return null;
  const reader = result.stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// ── Filesystem ────────────────────────────────────────────────────────────────

async function fsPut(domain: CnAgentsDomain, filename: string, data: string): Promise<void> {
  const path = await import('path');
  const { promises: fs } = await import('fs');
  const { atomicFsPut } = await import('@/lib/storage/atomicFsPut');
  const dir = path.join(process.cwd(), 'data', ROOT, domain);
  await fs.mkdir(dir, { recursive: true });
  await atomicFsPut(path.join(dir, filename), data);
}

async function fsGet(domain: CnAgentsDomain, filename: string): Promise<string | null> {
  const path = await import('path');
  const { promises: fs } = await import('fs');
  return fs
    .readFile(path.join(process.cwd(), 'data', ROOT, domain, filename), 'utf-8')
    .catch(() => null);
}

// ── 泛型 domain 日檔讀寫 ──────────────────────────────────────────────────────

async function putJson(domain: CnAgentsDomain, filename: string, payload: unknown): Promise<void> {
  const data = JSON.stringify(payload);
  if (IS_VERCEL) await blobPut(`${ROOT}/${domain}/${filename}`, data);
  else await fsPut(domain, filename, data);
}

async function getJson<T>(domain: CnAgentsDomain, filename: string): Promise<T | null> {
  const raw = IS_VERCEL ? await blobGet(`${ROOT}/${domain}/${filename}`) : await fsGet(domain, filename);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null; // 壞檔（寫入中斷殘骸）視同不存在，由上游重抓
  }
}

/** ROOT 層單檔（不分 domain 子目錄）讀寫 — 給 leaderboard.json 這種全域聚合檔。 */
export async function putJsonRoot(filename: string, payload: unknown): Promise<void> {
  const data = JSON.stringify(payload);
  if (IS_VERCEL) { await blobPut(`${ROOT}/${filename}`, data); return; }
  const path = await import('path');
  const { promises: fs } = await import('fs');
  const { atomicFsPut } = await import('@/lib/storage/atomicFsPut');
  const dir = path.join(process.cwd(), 'data', ROOT);
  await fs.mkdir(dir, { recursive: true });
  await atomicFsPut(path.join(dir, filename), data);
}
export async function getJsonRoot<T>(filename: string): Promise<T | null> {
  let raw: string | null;
  if (IS_VERCEL) raw = await blobGet(`${ROOT}/${filename}`);
  else {
    const path = await import('path');
    const { promises: fs } = await import('fs');
    raw = await fs.readFile(path.join(process.cwd(), 'data', ROOT, filename), 'utf-8').catch(() => null);
  }
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

// ── 漲停池 ────────────────────────────────────────────────────────────────────

/** 固化一日漲停池（覆寫同日）。退化資料守門見檔頭說明。 */
export async function saveLimitUpPoolDay(day: LimitUpPoolDay): Promise<void> {
  if (day.stats.limitUpCount === 0 && day.breadth.upCount > 2000) {
    throw new Error(
      `[cn-agents] ${day.date} 漲停池退化：limitUpCount=0 但 upCount=${day.breadth.upCount}（>2000），` +
        '疑似上游抓取壞掉，拒絕存檔以免污染晉級率與情緒狀態機',
    );
  }
  await putJson('limitup-pool', `${day.date}.json`, day);
}

/** 讀某日漲停池；無則 null。 */
export async function readLimitUpPoolDay(date: string): Promise<LimitUpPoolDay | null> {
  return getJson<LimitUpPoolDay>('limitup-pool', `${date}.json`);
}

// ── 板塊快照 ──────────────────────────────────────────────────────────────────

export async function saveBoardsDay(day: BoardsDay): Promise<void> {
  await putJson('boards', `${day.date}.json`, day);
}

export async function readBoardsDay(date: string): Promise<BoardsDay | null> {
  return getJson<BoardsDay>('boards', `${date}.json`);
}

// ── 人氣熱度 ──────────────────────────────────────────────────────────────────

export async function saveHotnessDay(day: HotnessDay): Promise<void> {
  await putJson('hotness', `${day.date}.json`, day);
}

export async function readHotnessDay(date: string): Promise<HotnessDay | null> {
  return getJson<HotnessDay>('hotness', `${date}.json`);
}

// ── 市場寬度 + 情緒週期 ───────────────────────────────────────────────────────

export async function saveBreadthDay(file: BreadthDayFile): Promise<void> {
  await putJson('breadth', `${file.date}.json`, file);
}

export async function readBreadthDay(date: string): Promise<BreadthDayFile | null> {
  return getJson<BreadthDayFile>('breadth', `${date}.json`);
}

/** 讀近 N 日寬度序列 index（data/cn-agents/breadth/index.json）；無則 null。 */
/** 列出已落地的市場寬度日期（升冪）— 時光機回放枚舉可選日用。 */
export async function listBreadthDates(): Promise<string[]> {
  if (IS_VERCEL) {
    const { list: blobList } = await import('@vercel/blob');
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await blobList({ prefix: `${ROOT}/breadth/`, limit: 100, cursor });
      for (const b of result.blobs) {
        const m = b.pathname.match(/(\d{4}-\d{2}-\d{2})\.json$/);
        if (m) out.push(m[1]);
      }
      cursor = result.hasMore ? result.cursor : undefined;
    } while (cursor);
    return out.sort();
  }
  const path = await import('path');
  const { promises: fs } = await import('fs');
  const files = await fs
    .readdir(path.join(process.cwd(), 'data', ROOT, 'breadth'))
    .catch(() => [] as string[]);
  return files
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 10))
    .sort();
}

export async function readBreadthIndex(): Promise<BreadthIndexFile | null> {
  return getJson<BreadthIndexFile>('breadth', 'index.json');
}

/**
 * upsert 一日進寬度 index：同 date 覆蓋，否則插入 → 按 date 升冪排序 →
 * 只保留最後 BREADTH_INDEX_MAX_DAYS 筆。
 *
 * ⚠️ read-merge-write，無鎖 — 只能由單一序列化 cron 呼叫（見檔頭）。
 */
export async function upsertBreadthIndex(entry: {
  date: string;
  breadth: MarketBreadthDay;
  cycle: EmotionCycleDay;
}): Promise<void> {
  const existing = await readBreadthIndex();
  const days = existing?.days ? [...existing.days] : [];
  const idx = days.findIndex((d) => d.date === entry.date);
  if (idx >= 0) days[idx] = entry;
  else days.push(entry);
  days.sort((a, b) => a.date.localeCompare(b.date));
  const next: BreadthIndexFile = {
    schemaVersion: CN_AGENTS_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    days: days.slice(-BREADTH_INDEX_MAX_DAYS),
  };
  await putJson('breadth', 'index.json', next);
}

// ── 龍虎榜（P2） ──────────────────────────────────────────────────────────────

/**
 * 固化一日龍虎榜（覆寫同日）。守門：
 *   - date 非 YYYY-MM-DD → throw（檔名即主鍵，髒日期會產生永遠讀不到的孤兒檔）
 *   - stocks 含重複 (code, reason) → throw（複合鍵唯一性由組裝端保證，
 *     存檔層當最後防線 — 重複鍵會讓席位明細分發與 seatStats 重建雙重計數）
 */
export async function saveLhbDaily(file: LhbDailyFile): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(file.date)) {
    throw new Error(`[cn-agents] saveLhbDaily 非法日期 '${file.date}'（要 YYYY-MM-DD）`);
  }
  const seen = new Set<string>();
  for (const s of file.stocks) {
    const key = `${s.code} ${s.reason}`;
    if (seen.has(key)) {
      throw new Error(`[cn-agents] saveLhbDaily ${file.date} 含重複 (code, reason)：${s.code} ${s.reason}`);
    }
    seen.add(key);
  }
  await putJson('lhb', `${file.date}.json`, file);
}

export async function readLhbDaily(date: string): Promise<LhbDailyFile | null> {
  return getJson<LhbDailyFile>('lhb', `${date}.json`);
}

/** 列出已落地的龍虎榜日期（升冪）。本地掃 lhb/ 目錄；Vercel 走 blob list。 */
export async function listLhbDates(): Promise<string[]> {
  if (IS_VERCEL) {
    const { list: blobList } = await import('@vercel/blob');
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await blobList({ prefix: `${ROOT}/lhb/`, limit: 100, cursor });
      for (const b of result.blobs) {
        const m = b.pathname.match(/(\d{4}-\d{2}-\d{2})\.json$/);
        if (m) out.push(m[1]);
      }
      cursor = result.hasMore ? result.cursor : undefined;
    } while (cursor);
    return out.sort();
  }
  const path = await import('path');
  const { promises: fs } = await import('fs');
  const files = await fs
    .readdir(path.join(process.cwd(), 'data', ROOT, 'lhb'))
    .catch(() => [] as string[]);
  return files
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 10))
    .sort();
}

// ── 席位績效統計（P2；每晚全量重建，單檔 stats.json） ─────────────────────────

export async function saveSeatStats(file: SeatStatsFile): Promise<void> {
  await putJson('seats', 'stats.json', file);
}

export async function readSeatStats(): Promise<SeatStatsFile | null> {
  return getJson<SeatStatsFile>('seats', 'stats.json');
}

// ── 回測事件（P2；data/cn-agents/events/{date}.json） ─────────────────────────

export async function saveRecoEvents(file: CnRecoEventsFile): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(file.date)) {
    throw new Error(`[cn-agents] saveRecoEvents 非法日期 '${file.date}'`);
  }
  const seen = new Set<string>();
  for (const e of file.events) {
    if (seen.has(e.id)) {
      throw new Error(`[cn-agents] saveRecoEvents ${file.date} 含重複事件 id：${e.id}`);
    }
    seen.add(e.id);
  }
  await putJson('events', `${file.date}.json`, file);
}

export async function readRecoEvents(date: string): Promise<CnRecoEventsFile | null> {
  return getJson<CnRecoEventsFile>('events', `${date}.json`);
}

/** 列出已落地的事件日期（升冪）。 */
export async function listRecoEventDates(): Promise<string[]> {
  if (IS_VERCEL) {
    const { list: blobList } = await import('@vercel/blob');
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await blobList({ prefix: `${ROOT}/events/`, limit: 100, cursor });
      for (const b of result.blobs) {
        const m = b.pathname.match(/(\d{4}-\d{2}-\d{2})\.json$/);
        if (m) out.push(m[1]);
      }
      cursor = result.hasMore ? result.cursor : undefined;
    } while (cursor);
    return out.sort();
  }
  const path = await import('path');
  const { promises: fs } = await import('fs');
  const files = await fs
    .readdir(path.join(process.cwd(), 'data', ROOT, 'events'))
    .catch(() => [] as string[]);
  return files
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 10))
    .sort();
}

// ── 新聞 digest / 語意分析 / 每日決策（P3） ───────────────────────────────────

export async function saveNewsDigest(d: NewsDigestDay): Promise<void> {
  await putJson('news', `${d.date}.json`, d);
}
export async function readNewsDigest(date: string): Promise<NewsDigestDay | null> {
  return getJson<NewsDigestDay>('news', `${date}.json`);
}

export async function saveAnalysis(a: CnAnalysisFile): Promise<void> {
  await putJson('analysis', `${a.date}.json`, a);
}
export async function readAnalysis(date: string): Promise<CnAnalysisFile | null> {
  return getJson<CnAnalysisFile>('analysis', `${date}.json`);
}

export async function saveDaily(d: CnDailyFile): Promise<void> {
  await putJson('daily', `${d.date}.json`, d);
}
export async function readDaily(date: string): Promise<CnDailyFile | null> {
  return getJson<CnDailyFile>('daily', `${date}.json`);
}
export async function listDailyDates(): Promise<string[]> {
  if (IS_VERCEL) {
    const { list: blobList } = await import('@vercel/blob');
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await blobList({ prefix: `${ROOT}/daily/`, limit: 100, cursor });
      for (const b of result.blobs) {
        const m = b.pathname.match(/(\d{4}-\d{2}-\d{2})\.json$/);
        if (m) out.push(m[1]);
      }
      cursor = result.hasMore ? result.cursor : undefined;
    } while (cursor);
    return out.sort();
  }
  const path = await import('path');
  const { promises: fs } = await import('fs');
  const files = await fs.readdir(path.join(process.cwd(), 'data', ROOT, 'daily')).catch(() => [] as string[]);
  return files.filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort();
}

// ── cron 健康紀錄 ─────────────────────────────────────────────────────────────

export async function saveCnAgentsHealth(day: CnAgentsHealthDay): Promise<void> {
  await putJson('_health', `${day.date}.json`, day);
}

export async function readCnAgentsHealth(date: string): Promise<CnAgentsHealthDay | null> {
  return getJson<CnAgentsHealthDay>('_health', `${date}.json`);
}
