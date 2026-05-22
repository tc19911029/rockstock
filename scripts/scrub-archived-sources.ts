/**
 * 把 alan-says / ps1788 / asia-ff888 三個淘汰來源的所有歷史資料清掉。
 *
 * 範圍：
 *   1. data/youtube/videos/{date}.json — 移除這三個 source_id 的 video entry
 *   2. data/youtube/transcripts/{date}/{video_id}.json — 刪檔
 *   3. data/youtube/transcript-index.json — 移除這些 video_id
 *   4. data/youtube/video-index.json — 移除這些 video_id
 *   5. data/youtube/scan-logs/{date}.json — 移除 source_id 為 archived 的 log
 *   6. data/youtube/analysis/{date}.json — 移除 source_id 為 archived 的 mentions、重算 stats
 *   7. data/youtube/stock-mentions/{date}.json — 重算（衍生自 analysis，整檔重寫）
 *   8. data/youtube/extraction-index.json — 移除 archived source_id
 *
 * 不動：sources.json / health.json / sourceRegistry.ts（已手動清過）
 *
 * Usage: npx tsx scripts/scrub-archived-sources.ts [--dry-run]
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = path.join(process.cwd(), 'data', 'youtube');
const ARCHIVED = new Set(['alan-says', 'ps1788', 'asia-ff888']);
const DRY = process.argv.includes('--dry-run');

interface Video { video_id: string; source_id: string; [k: string]: unknown }
interface ScanLog { source_id: string; [k: string]: unknown }
interface Mention { source_id: string; video_id: string; [k: string]: unknown }
interface Analysis {
  date: string;
  high_consensus_stocks: Mention[];
  weak_signal_stocks: Mention[];
  stats: Record<string, number | Record<string, number>>;
  [k: string]: unknown;
}

async function readJson<T>(p: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(p, 'utf-8')) as T; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
async function writeJson(p: string, v: unknown): Promise<void> {
  if (DRY) { console.log(`  [dry] would write ${p}`); return; }
  await fs.writeFile(p, JSON.stringify(v, null, 2));
}

async function listDir(dir: string): Promise<string[]> {
  try { return await fs.readdir(dir); } catch { return []; }
}

async function main(): Promise<void> {
  console.log(`[scrub] dry_run=${DRY}, archived sources:`, [...ARCHIVED]);

  // === 1. videos/{date}.json + 收集要刪的 video_id ===
  const archivedVideoIds = new Set<string>();
  const videosDir = path.join(ROOT, 'videos');
  for (const f of await listDir(videosDir)) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(videosDir, f);
    const arr = await readJson<Video[]>(p);
    if (!arr) continue;
    const kept = arr.filter(v => {
      if (ARCHIVED.has(v.source_id)) { archivedVideoIds.add(v.video_id); return false; }
      return true;
    });
    if (kept.length !== arr.length) {
      console.log(`  videos/${f}: ${arr.length} → ${kept.length} (removed ${arr.length - kept.length})`);
      await writeJson(p, kept);
    }
  }
  console.log(`  collected ${archivedVideoIds.size} archived video_ids`);

  // === 2. transcripts/{date}/{video_id}.json ===
  const transcriptsRoot = path.join(ROOT, 'transcripts');
  let removedTranscripts = 0;
  for (const dateDir of await listDir(transcriptsRoot)) {
    const ddir = path.join(transcriptsRoot, dateDir);
    for (const f of await listDir(ddir)) {
      const vid = f.replace(/\.json$/, '');
      if (archivedVideoIds.has(vid)) {
        const target = path.join(ddir, f);
        if (DRY) console.log(`  [dry] would unlink ${target}`);
        else await fs.unlink(target);
        removedTranscripts++;
      }
    }
  }
  console.log(`  removed ${removedTranscripts} transcript files`);

  // === 3. transcript-index.json (schema: { byId: {vid: entry}, updated_at }) ===
  const tIdxPath = path.join(ROOT, 'transcript-index.json');
  const tIdx = await readJson<{ byId: Record<string, unknown>; updated_at: string }>(tIdxPath);
  if (tIdx?.byId) {
    const before = Object.keys(tIdx.byId).length;
    for (const vid of Object.keys(tIdx.byId)) if (archivedVideoIds.has(vid)) delete tIdx.byId[vid];
    const after = Object.keys(tIdx.byId).length;
    if (before !== after) {
      tIdx.updated_at = new Date().toISOString();
      console.log(`  transcript-index.json: ${before} → ${after}`);
      await writeJson(tIdxPath, tIdx);
    }
  }

  // === 4. video-index.json (schema: { byId: {vid: {date, source_id}}, updated_at }) ===
  const vIdxPath = path.join(ROOT, 'video-index.json');
  const vIdx = await readJson<{ byId: Record<string, unknown>; updated_at: string }>(vIdxPath);
  if (vIdx?.byId) {
    const before = Object.keys(vIdx.byId).length;
    for (const vid of Object.keys(vIdx.byId)) if (archivedVideoIds.has(vid)) delete vIdx.byId[vid];
    const after = Object.keys(vIdx.byId).length;
    if (before !== after) {
      vIdx.updated_at = new Date().toISOString();
      console.log(`  video-index.json: ${before} → ${after}`);
      await writeJson(vIdxPath, vIdx);
    }
  }

  // === 5. scan-logs/{date}.json ===
  const logsDir = path.join(ROOT, 'scan-logs');
  for (const f of await listDir(logsDir)) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(logsDir, f);
    const arr = await readJson<ScanLog[]>(p);
    if (!arr) continue;
    const kept = arr.filter(l => !ARCHIVED.has(l.source_id));
    if (kept.length !== arr.length) {
      console.log(`  scan-logs/${f}: ${arr.length} → ${kept.length}`);
      await writeJson(p, kept);
    }
  }

  // === 6. analysis/{date}.json — 過濾 mentions + 重算 stats ===
  const analysisDir = path.join(ROOT, 'analysis');
  for (const f of await listDir(analysisDir)) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(analysisDir, f);
    const a = await readJson<Analysis>(p);
    if (!a) continue;
    const filterMentions = (arr: Mention[]) => arr.filter(m => !ARCHIVED.has(m.source_id));
    const beforeHigh = a.high_consensus_stocks.length;
    const beforeWeak = a.weak_signal_stocks.length;
    a.high_consensus_stocks = filterMentions(a.high_consensus_stocks);
    a.weak_signal_stocks = filterMentions(a.weak_signal_stocks);

    // 重算 stats（保留 rating_distribution / videos_analyzed 等其他欄位）
    const allMentions = [...a.high_consensus_stocks, ...a.weak_signal_stocks];
    const uniqStocks = new Set<string>();
    for (const m of allMentions) {
      const matched = (m as Record<string, unknown>).matched as { code?: string } | null;
      if (matched?.code) uniqStocks.add(matched.code);
    }
    a.stats.unique_stocks_total = uniqStocks.size;
    a.stats.high_consensus_count = a.high_consensus_stocks.length;
    a.stats.weak_signal_count = a.weak_signal_stocks.length;

    console.log(`  analysis/${f}: high ${beforeHigh}→${a.high_consensus_stocks.length}, weak ${beforeWeak}→${a.weak_signal_stocks.length}, unique_stocks=${uniqStocks.size}`);
    await writeJson(p, a);
  }

  // === 7. stock-mentions/{date}.json — 衍生自 analysis，重新計算更安全；簡單做：刪檔讓 derive 重算 ===
  const smDir = path.join(ROOT, 'stock-mentions');
  for (const f of await listDir(smDir)) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(smDir, f);
    console.log(`  [info] stock-mentions/${f} is derived; deriveStockMentions() will rebuild on next API call`);
    if (!DRY) await fs.unlink(p);
  }

  // === 8. extraction-index.json — 移除 archived source_id entries ===
  const eIdxPath = path.join(ROOT, 'extraction-index.json');
  const eIdx = await readJson<Record<string, { source_id?: string }>>(eIdxPath);
  if (eIdx) {
    const before = Object.keys(eIdx).length;
    for (const k of Object.keys(eIdx)) {
      const ent = eIdx[k];
      if (ent && ARCHIVED.has(ent.source_id ?? '')) delete eIdx[k];
    }
    const after = Object.keys(eIdx).length;
    if (before !== after) {
      console.log(`  extraction-index.json: ${before} → ${after}`);
      await writeJson(eIdxPath, eIdx);
    }
  }

  console.log('[scrub] done.');
}

main().catch(e => { console.error(e); process.exit(1); });
