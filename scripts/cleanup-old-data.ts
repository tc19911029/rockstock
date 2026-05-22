/**
 * Retention cleanup — 保留最近 30 天的 youtube 資料，其餘刪掉。
 * （30 天是因為跨日趨勢頁支援到 range=30d）
 *
 * 範圍：
 *   data/youtube/videos/{date}.json
 *   data/youtube/transcripts/{date}/
 *   data/youtube/scan-logs/{date}.json
 *   data/youtube/analysis/{date}.json
 *   data/youtube/stock-mentions/{date}.json
 *
 * 不動：sources.json / health.json / video-index.json / transcript-index.json
 *       （這些是 rolling 狀態檔，腳本同步清掉裡面對應 entries）
 *
 * Usage:
 *   npx tsx scripts/cleanup-old-data.ts           保留 30 天
 *   npx tsx scripts/cleanup-old-data.ts --days 60 改 retention 天數
 *   npx tsx scripts/cleanup-old-data.ts --dry-run
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = path.join(process.cwd(), 'data', 'youtube');
const DRY = process.argv.includes('--dry-run');
const daysArg = process.argv.indexOf('--days');
const RETAIN_DAYS = daysArg > 0 ? Number(process.argv[daysArg + 1]) : 30;

function ymdTaipei(d: Date): string {
  const t = new Date(d.getTime() + 8 * 3600_000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

async function listDir(p: string): Promise<string[]> {
  try { return await fs.readdir(p); } catch { return []; }
}

async function main() {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETAIN_DAYS);
  const cutoffYmd = ymdTaipei(cutoffDate);
  console.log(`[cleanup] dry_run=${DRY}  retain ${RETAIN_DAYS} days  cutoff=${cutoffYmd} (刪除 < 此日期)`);

  const removedDates: string[] = [];
  const removedVideoIds = new Set<string>();

  // ── 1. videos/{date}.json + 收集刪除的 video_id ──
  for (const f of await listDir(path.join(ROOT, 'videos'))) {
    if (!f.endsWith('.json')) continue;
    const date = f.replace('.json', '');
    if (date >= cutoffYmd) continue;
    removedDates.push(date);
    const arr = JSON.parse(await fs.readFile(path.join(ROOT, 'videos', f), 'utf-8')) as Array<{ video_id: string }>;
    for (const v of arr) removedVideoIds.add(v.video_id);
    if (!DRY) await fs.unlink(path.join(ROOT, 'videos', f));
    console.log(`  rm videos/${f} (${arr.length} videos)`);
  }

  // ── 2. transcripts/{date}/ 整個目錄 ──
  for (const dir of await listDir(path.join(ROOT, 'transcripts'))) {
    if (dir >= cutoffYmd) continue;
    const dirPath = path.join(ROOT, 'transcripts', dir);
    const files = await listDir(dirPath);
    for (const f of files) {
      if (!DRY) await fs.unlink(path.join(dirPath, f));
    }
    if (!DRY) await fs.rmdir(dirPath).catch(() => {});
    console.log(`  rm transcripts/${dir}/ (${files.length} files)`);
  }

  // ── 3. scan-logs/{date}.json ──
  for (const f of await listDir(path.join(ROOT, 'scan-logs'))) {
    if (!f.endsWith('.json')) continue;
    const date = f.replace('.json', '');
    if (date >= cutoffYmd) continue;
    if (!DRY) await fs.unlink(path.join(ROOT, 'scan-logs', f));
    console.log(`  rm scan-logs/${f}`);
  }

  // ── 4. analysis/{date}.json ──
  for (const f of await listDir(path.join(ROOT, 'analysis'))) {
    if (!f.endsWith('.json')) continue;
    const date = f.replace('.json', '');
    if (date >= cutoffYmd) continue;
    if (!DRY) await fs.unlink(path.join(ROOT, 'analysis', f));
    console.log(`  rm analysis/${f}`);
  }

  // ── 5. stock-mentions/{date}.json（衍生檔） ──
  for (const f of await listDir(path.join(ROOT, 'stock-mentions'))) {
    if (!f.endsWith('.json')) continue;
    const date = f.replace('.json', '');
    if (date >= cutoffYmd) continue;
    if (!DRY) await fs.unlink(path.join(ROOT, 'stock-mentions', f));
    console.log(`  rm stock-mentions/${f}`);
  }

  // ── 6. 同步 video-index / transcript-index ──
  const vIdxPath = path.join(ROOT, 'video-index.json');
  const vIdx = JSON.parse(await fs.readFile(vIdxPath, 'utf-8')) as { byId: Record<string, unknown>; updated_at: string };
  const vIdxBefore = Object.keys(vIdx.byId).length;
  for (const vid of removedVideoIds) delete vIdx.byId[vid];
  vIdx.updated_at = new Date().toISOString();
  if (!DRY) await fs.writeFile(vIdxPath, JSON.stringify(vIdx, null, 2));
  console.log(`  video-index: ${vIdxBefore} → ${Object.keys(vIdx.byId).length}`);

  const tIdxPath = path.join(ROOT, 'transcript-index.json');
  const tIdx = JSON.parse(await fs.readFile(tIdxPath, 'utf-8')) as { byId: Record<string, unknown>; updated_at: string };
  const tIdxBefore = Object.keys(tIdx.byId).length;
  for (const vid of removedVideoIds) delete tIdx.byId[vid];
  tIdx.updated_at = new Date().toISOString();
  if (!DRY) await fs.writeFile(tIdxPath, JSON.stringify(tIdx, null, 2));
  console.log(`  transcript-index: ${tIdxBefore} → ${Object.keys(tIdx.byId).length}`);

  console.log(`[cleanup] done. removed ${removedDates.length} date(s).`);
}

main().catch(e => { console.error(e); process.exit(1); });
