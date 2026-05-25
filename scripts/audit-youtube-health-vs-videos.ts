#!/usr/bin/env npx tsx
/**
 * audit-youtube-health-vs-videos.ts
 *
 * 核對 health snapshot 與實際 videos file 的一致性,避免「面板說有抓到、影片列表沒有」這類錯誤。
 *
 * 用戶 2026-05-25 報問題:
 *   - 上方節目卡顯示「✓ 已抓到」+ 最後抓到影片 timestamp
 *   - 但下方影片列表沒有對應影片
 *   - root cause:last_video_discovered_at 用 scanned_count > 0 算(已修)
 *
 * 此 audit 跑:
 *   1. 讀 data/youtube/health.json
 *   2. 讀 data/youtube/videos/{today}.json
 *   3. 對每個 source 比對:
 *      - health.today.analyzable === videos file 內 source_id+should_analyze=true 數量?
 *      - last_video_discovered_at 對應的日期 → videos/{date}.json 內該 source 真有可分析影片?
 *      - "✓ 今日已抓到" 狀態但 videos 內找不到 → 異常
 *      - "— 今日無新節目" 狀態但 videos 內有 analyzable → 異常
 *
 * 用法:
 *   npx tsx scripts/audit-youtube-health-vs-videos.ts [YYYY-MM-DD]
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { YouTubeHealthSnapshot, YouTubeVideo } from '../lib/youtube/types';

const HEALTH_FILE = path.join(process.cwd(), 'data', 'youtube', 'health.json');
const VIDEOS_DIR = path.join(process.cwd(), 'data', 'youtube', 'videos');

interface AuditIssue {
  severity: 'HIGH' | 'MED' | 'LOW';
  source_id: string;
  message: string;
}

function todayYmdTaipei(): string {
  const now = new Date();
  const tw = new Date(now.getTime() + 8 * 3600 * 1000);
  return tw.toISOString().slice(0, 10);
}

async function loadJson<T>(p: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(p, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function main() {
  const targetDate = process.argv[2] ?? todayYmdTaipei();
  console.log(`\n=== YouTube health vs videos audit · ${targetDate} ===\n`);

  const health = await loadJson<YouTubeHealthSnapshot>(HEALTH_FILE);
  if (!health) {
    console.error('❌ data/youtube/health.json 不存在 — health cron 從未跑過?');
    process.exit(1);
  }

  const videos = await loadJson<YouTubeVideo[]>(path.join(VIDEOS_DIR, `${targetDate}.json`));
  const videosBySource = new Map<string, YouTubeVideo[]>();
  if (videos) {
    for (const v of videos) {
      const list = videosBySource.get(v.source_id) ?? [];
      list.push(v);
      videosBySource.set(v.source_id, list);
    }
  }

  const issues: AuditIssue[] = [];
  let goodCount = 0;

  for (const s of health.sources) {
    if (s.active === false) continue;

    const sourceVideos = videosBySource.get(s.source_id) ?? [];
    const actualAnalyzable = sourceVideos.filter(v => v.should_analyze).length;
    const actualTotal = sourceVideos.length;

    // Check 1: health.today.analyzable 對應實際 videos file
    if (s.today.analyzable !== actualAnalyzable) {
      issues.push({
        severity: actualAnalyzable === 0 && s.today.analyzable > 0 ? 'HIGH' : 'MED',
        source_id: s.source_id,
        message: `[${s.display_name}] health 報 analyzable=${s.today.analyzable} 但 videos/${targetDate}.json 實際 should_analyze=true 有 ${actualAnalyzable} 支`,
      });
    }

    // Check 2: 若 health 報「最後抓到新節目 = targetDate」,videos file 必須有 analyzable
    if (s.last_video_discovered_at) {
      const lastDate = s.last_video_discovered_at.slice(0, 10);
      if (lastDate === targetDate && actualAnalyzable === 0) {
        issues.push({
          severity: 'HIGH',
          source_id: s.source_id,
          message: `[${s.display_name}] health.last_video_discovered_at=${targetDate} 但 videos file 該日無 analyzable=true 影片(可能 health snapshot stale)`,
        });
      }
    }

    // Check 3: videos file 內有 analyzable 但 health 報 analyzable=0
    if (actualAnalyzable > 0 && s.today.analyzable === 0) {
      issues.push({
        severity: 'HIGH',
        source_id: s.source_id,
        message: `[${s.display_name}] videos file 有 ${actualAnalyzable} 支 analyzable 但 health 報 analyzable=0(漏 update?)`,
      });
    }

    if (s.today.analyzable === actualAnalyzable) {
      goodCount += 1;
    }
  }

  // 統計
  const totalSources = health.sources.filter(s => s.active !== false).length;
  console.log(`Sources active:       ${totalSources}`);
  console.log(`Sources 一致:        ${goodCount}`);
  console.log(`Sources 不一致:      ${totalSources - goodCount}`);
  console.log(`Total videos today:   ${videos?.length ?? 0}`);
  console.log(`  其中 analyzable:    ${videos?.filter(v => v.should_analyze).length ?? 0}`);
  console.log('');

  if (issues.length === 0) {
    console.log('✅ 全部 source 的 health 狀態與 videos file 對得起來,無異常。\n');
    process.exit(0);
  }

  // 按 severity 排序
  const order = { HIGH: 0, MED: 1, LOW: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);

  console.log(`⚠️  發現 ${issues.length} 個 inconsistency:\n`);
  for (const issue of issues) {
    const icon = issue.severity === 'HIGH' ? '🔴' : issue.severity === 'MED' ? '🟡' : '🔵';
    console.log(`${icon} [${issue.severity}] ${issue.message}`);
  }

  console.log('\n💡 修法建議:');
  console.log('   - HIGH 不一致 → 跑 curl POST /api/cron/youtube-scan 強制 rebuild health snapshot');
  console.log('   - 仍不一致 → 看 last_video_discovered_at 邏輯(已改用 analyzable_count > 0,需重跑 scan)');
  console.log('');

  process.exit(issues.some(i => i.severity === 'HIGH') ? 1 : 0);
}

main().catch(err => {
  console.error('audit failed:', err);
  process.exit(2);
});
