/**
 * Data integrity audit for YouTube system.
 *
 * 端點化今天 deep-dive 找到的所有檢查項目，定期或前端 trigger 就能跑。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ymdTaipei } from './classify';
import type { YouTubeVideo, YouTubeSource } from './types';
import type { DailyAnalysis } from './analysisStorage';

const ROOT = path.join(process.cwd(), 'data', 'youtube');

export type IssueSeverity = 'HIGH' | 'MED' | 'LOW' | 'INFO';

export interface AuditIssue {
  severity: IssueSeverity;
  area: string;
  message: string;
  affected_count?: number;
  sample?: string[];
}

export interface AuditReport {
  generated_at: string;
  issues: AuditIssue[];
  summary: {
    high: number;
    med: number;
    low: number;
    info: number;
  };
  stats: {
    video_files: number;
    total_videos: number;
    analyzable_videos: number;
    transcript_files: number;
    analyzed_dates: string[];
    active_sources: number;
    placeholder_analyses: string[];
  };
}

async function listDir(dir: string): Promise<string[]> {
  try { return await fs.readdir(dir); } catch { return []; }
}
async function readJson<T>(p: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(p, 'utf-8')) as T; }
  catch { return null; }
}

export async function runAudit(): Promise<AuditReport> {
  const issues: AuditIssue[] = [];

  // ── 載入 sources ──
  const sources = (await readJson<YouTubeSource[]>(path.join(ROOT, 'sources.json'))) ?? [];
  const activeSourceIds = new Set(sources.filter(s => s.active).map(s => s.source_id));

  // ── 1. videos 規則違反 ──
  const videoFiles = await listDir(path.join(ROOT, 'videos'));
  let totalVideos = 0;
  let analyzableTotal = 0;
  const ruleViolations: string[] = [];
  const crossDateLeaks: string[] = [];

  for (const fname of videoFiles) {
    const fileDate = fname.replace('.json', '');
    const arr = (await readJson<YouTubeVideo[]>(path.join(ROOT, 'videos', fname))) ?? [];
    totalVideos += arr.length;
    for (const v of arr) {
      if (v.should_analyze) analyzableTotal++;
      // Rule: should_analyze=false 必有 skip_reason
      if (!v.should_analyze && !v.skip_reason) {
        ruleViolations.push(`${fileDate}/${v.video_id} missing skip_reason`);
      }
      if (v.should_analyze && v.skip_reason) {
        ruleViolations.push(`${fileDate}/${v.video_id} both should=true and skip_reason set`);
      }
      // Cross-date pollution check — 只有當 file_date 既不等於 program_date 也不等於 ymdTaipei(published_at) 時才算真正污染。
      // 合法情況：晚間節目 21:00 上傳但隔天 00:30 才 publish → file by program_date（標題日）不等於 publish_at 是正確的。
      if (v.published_at) {
        const pubYmd = ymdTaipei(new Date(v.published_at));
        const programDate = v.program_date ?? null;
        const matchesProgramDate = programDate === fileDate;
        const matchesPubDate = pubYmd === fileDate;
        if (!matchesProgramDate && !matchesPubDate) {
          crossDateLeaks.push(`${v.video_id}: in ${fileDate}.json but program_date=${programDate ?? 'null'} pub=${pubYmd}`);
        }
      }
    }
  }
  if (ruleViolations.length > 0) {
    issues.push({
      severity: 'HIGH',
      area: 'rule',
      message: 'should_analyze=false 必須有 skip_reason；should_analyze=true 不可有 skip_reason',
      affected_count: ruleViolations.length,
      sample: ruleViolations.slice(0, 3),
    });
  }
  if (crossDateLeaks.length > 0) {
    issues.push({
      severity: 'MED',
      area: 'storage',
      message: 'videos/{date}.json 內含 published_at 不屬於該日的影片（跨日污染）',
      affected_count: crossDateLeaks.length,
      sample: crossDateLeaks.slice(0, 3),
    });
  }

  // ── 2. index 一致性 ──
  const vIdx = (await readJson<{ byId: Record<string, { date: string; source_id: string }> }>(path.join(ROOT, 'video-index.json')))?.byId ?? {};
  const allKnownVids = new Set<string>();
  for (const fname of videoFiles) {
    const arr = (await readJson<YouTubeVideo[]>(path.join(ROOT, 'videos', fname))) ?? [];
    for (const v of arr) allKnownVids.add(v.video_id);
  }
  const vIdxStale = Object.keys(vIdx).filter(vid => !allKnownVids.has(vid));
  const vIdxMissing = [...allKnownVids].filter(vid => !(vid in vIdx));
  if (vIdxStale.length > 0) {
    issues.push({
      severity: 'MED',
      area: 'video-index',
      message: 'video-index 有 stale entries（指向不存在的 video）',
      affected_count: vIdxStale.length,
      sample: vIdxStale.slice(0, 3),
    });
  }
  if (vIdxMissing.length > 0) {
    issues.push({
      severity: 'MED',
      area: 'video-index',
      message: 'video-index 漏記某些影片',
      affected_count: vIdxMissing.length,
      sample: vIdxMissing.slice(0, 3),
    });
  }

  // ── 3. transcript-index 對應 transcripts/ ──
  const tIdx = (await readJson<{ byId: Record<string, unknown> }>(path.join(ROOT, 'transcript-index.json')))?.byId ?? {};
  const transcriptFiles = new Set<string>();
  const transcriptDirs = await listDir(path.join(ROOT, 'transcripts'));
  for (const d of transcriptDirs) {
    for (const f of await listDir(path.join(ROOT, 'transcripts', d))) {
      transcriptFiles.add(f.replace('.json', ''));
    }
  }
  const tIdxStale = Object.keys(tIdx).filter(vid => !transcriptFiles.has(vid));
  const tIdxMissing = [...transcriptFiles].filter(vid => !(vid in tIdx));
  if (tIdxStale.length > 0) {
    issues.push({
      severity: 'MED',
      area: 'transcript-index',
      message: 'transcript-index 指到不存在的 transcript file',
      affected_count: tIdxStale.length,
      sample: tIdxStale.slice(0, 3),
    });
  }
  if (tIdxMissing.length > 0) {
    issues.push({
      severity: 'MED',
      area: 'transcript-index',
      message: 'transcript 檔案存在但 index 沒記錄',
      affected_count: tIdxMissing.length,
      sample: tIdxMissing.slice(0, 3),
    });
  }

  // ── 4. analyzable videos 是否有 transcript ──
  const missingTranscripts: string[] = [];
  for (const fname of videoFiles) {
    const arr = (await readJson<YouTubeVideo[]>(path.join(ROOT, 'videos', fname))) ?? [];
    for (const v of arr) {
      if (v.should_analyze && !transcriptFiles.has(v.video_id)) {
        missingTranscripts.push(`${v.video_id} (${v.source_id})`);
      }
    }
  }
  if (missingTranscripts.length > 0) {
    issues.push({
      severity: 'LOW',
      area: 'transcript',
      message: '可分析影片還沒對應 transcript（cron 還沒跑或 Whisper 漏）',
      affected_count: missingTranscripts.length,
      sample: missingTranscripts.slice(0, 5),
    });
  }

  // ── 5. analysis mentions source_id 必須在 active ──
  const analyses = await listDir(path.join(ROOT, 'analysis'));
  const placeholderDates: string[] = [];
  const analyzedDates: string[] = [];
  const inactiveMentions: string[] = [];
  for (const fname of analyses) {
    const date = fname.replace('.json', '');
    analyzedDates.push(date);
    const a = await readJson<DailyAnalysis>(path.join(ROOT, 'analysis', fname));
    if (!a) continue;
    if (a.is_placeholder) placeholderDates.push(date);
    const allMentions = [...a.high_consensus_stocks, ...a.weak_signal_stocks];
    for (const m of allMentions) {
      if (m.source_id && !activeSourceIds.has(m.source_id)) {
        inactiveMentions.push(`${date}: ${m.source_id} (vid=${m.video_id})`);
      }
    }
  }
  if (inactiveMentions.length > 0) {
    issues.push({
      severity: 'MED',
      area: 'analysis',
      message: 'analysis 引用已 archived 的 source_id',
      affected_count: inactiveMentions.length,
      sample: inactiveMentions.slice(0, 3),
    });
  }
  if (placeholderDates.length > 0) {
    issues.push({
      severity: 'INFO',
      area: 'analysis',
      message: '部分 analysis 是 placeholder（手動填的範例資料，非真實 LLM 分析）',
      affected_count: placeholderDates.length,
      sample: placeholderDates,
    });
  }

  // ── 6. health.json 跟 scan-logs 一致性 ──
  const health = await readJson<{ scan_date: string; sources: Array<{ source_id: string; today: { analyzable: number } }> }>(path.join(ROOT, 'health.json'));
  if (health) {
    const logsPath = path.join(ROOT, 'scan-logs', `${health.scan_date}.json`);
    const logs = (await readJson<Array<{ source_id: string; analyzable_count: number }>>(logsPath)) ?? [];
    const logMap = new Map(logs.map(l => [l.source_id, l.analyzable_count]));
    const mismatches: string[] = [];
    for (const s of health.sources) {
      const logCount = logMap.get(s.source_id);
      if (logCount != null && logCount !== s.today.analyzable) {
        mismatches.push(`${s.source_id}: health=${s.today.analyzable} log=${logCount}`);
      }
    }
    if (mismatches.length > 0) {
      issues.push({
        severity: 'HIGH',
        area: 'health',
        message: 'health.json 跟 scan-logs 的 analyzable 數字不一致',
        affected_count: mismatches.length,
        sample: mismatches,
      });
    }
  }

  // ── Summary ──
  const summary = {
    high: issues.filter(i => i.severity === 'HIGH').length,
    med: issues.filter(i => i.severity === 'MED').length,
    low: issues.filter(i => i.severity === 'LOW').length,
    info: issues.filter(i => i.severity === 'INFO').length,
  };

  return {
    generated_at: new Date().toISOString(),
    issues,
    summary,
    stats: {
      video_files: videoFiles.length,
      total_videos: totalVideos,
      analyzable_videos: analyzableTotal,
      transcript_files: transcriptFiles.size,
      analyzed_dates: analyzedDates.sort(),
      active_sources: activeSourceIds.size,
      placeholder_analyses: placeholderDates,
    },
  };
}
