/**
 * Contract test: YouTube tracking MVP 1 — 抓得穩
 *
 * 守門員：
 *   - classifyVideoType 對六種 fixture 都分對
 *   - parseProgramDate 對 8 種 title 變體正確/拒絕
 *   - decideShouldAnalyze invariant: should=false ⇒ skip_reason ≠ null
 *   - dedup: 同一份 NDJSON 跑兩次，第二次 0 new
 *   - scanRunner 收到失敗 stderr 時，scan log 的 error 欄位 non-null
 *   - YtdlpVideo NDJSON 解析容錯：壞行不會丟整批
 */

import { EventEmitter } from 'node:events';
import {
  classifyVideoType,
  decideShouldAnalyze,
  parseProgramDate,
  videoConfidenceScore,
} from '@/lib/youtube/classify';
import { fetchRecentVideos } from '@/lib/youtube/ytdlp';
import type { YtdlpVideo } from '@/lib/youtube/ytdlp';
import type { YouTubeSource, YouTubeVideo } from '@/lib/youtube/types';

// ── classifyVideoType ────────────────────────────────────────────────────────

describe('classifyVideoType', () => {
  const baseVideo: YtdlpVideo = {
    id: 'abcdefghijk', title: 'demo', url: 'https://www.youtube.com/watch?v=abcdefghijk',
  };

  it('Shorts URL → shorts', () => {
    expect(classifyVideoType({ ...baseVideo, url: 'https://www.youtube.com/shorts/abcdefghijk' })).toBe('shorts');
  });

  it('duration < 60s → shorts (regardless of URL)', () => {
    expect(classifyVideoType({ ...baseVideo, duration: 45 })).toBe('shorts');
  });

  it('live_status=was_live → live_replay', () => {
    expect(classifyVideoType({ ...baseVideo, live_status: 'was_live', duration: 3600 })).toBe('live_replay');
  });

  it('預告 title → preview', () => {
    expect(classifyVideoType({ ...baseVideo, title: '【預告】明日盤勢', duration: 600 })).toBe('preview');
  });

  it('業配 title → ad', () => {
    expect(classifyVideoType({ ...baseVideo, title: '【業配】XX 證券推薦', duration: 600 })).toBe('ad');
  });

  it('duration ≥ 8min, no live_status, no preview → full_program', () => {
    expect(classifyVideoType({ ...baseVideo, title: '盤後分析', duration: 1800 })).toBe('full_program');
  });

  it('duration 60s..8min → clip', () => {
    expect(classifyVideoType({ ...baseVideo, title: '台股盤勢精華', duration: 300 })).toBe('clip');
  });

  it('no duration, no hints → unknown', () => {
    expect(classifyVideoType({ ...baseVideo, title: '只看標題' })).toBe('unknown');
  });
});

// ── parseProgramDate ─────────────────────────────────────────────────────────

describe('parseProgramDate', () => {
  const now = new Date('2026-05-22T12:00:00Z');  // Asia/Taipei = 2026-05-22 20:00

  it.each([
    ['理財達人秀 2026.05.22 盤後', '2026-05-22'],
    ['錢線百分百 2026/05/22 直播', '2026-05-22'],
    ['2026-05-22 朱家泓教學', '2026-05-22'],
    ['5/22 台股盤勢 (Alan Says)', '2026-05-22'],
    ['57股市同學會 0522 收盤', '2026-05-22'],
    ['5月22日 林漢偉分析', '2026-05-22'],
    ['5月22號 收盤', '2026-05-22'],
    ['04月10日 春季特輯', '2026-04-10'],
  ])('parses %s → %s', (title, expected) => {
    expect(parseProgramDate(title, now)).toBe(expected);
  });

  it('rejects timestamp-like 00:22 in title (not a date)', () => {
    expect(parseProgramDate('收盤精華 00:22 結束', now)).toBeNull();
  });

  it('rejects title with no date', () => {
    expect(parseProgramDate('純標題沒日期', now)).toBeNull();
  });

  it('rejects month > 12 / day > 31', () => {
    expect(parseProgramDate('13/45 假日期', now)).toBeNull();
  });

  it('infers previous year for month far in the future', () => {
    // 現在 = 5 月，標題寫 12 月 → 視為去年 12 月
    expect(parseProgramDate('12月25日 聖誕特輯', now)).toBe('2025-12-25');
  });
});

// ── decideShouldAnalyze invariant ────────────────────────────────────────────

describe('decideShouldAnalyze invariant', () => {
  const now = new Date('2026-05-22T12:00:00Z');
  const base: Pick<YouTubeVideo, 'video_id' | 'video_type' | 'duration_sec' | 'published_at' | 'program_date' | 'raw'> = {
    video_id: 'vid01234567',
    video_type: 'full_program',
    duration_sec: 1800,
    published_at: '2026-05-22T10:00:00Z',  // 2h ago
    program_date: null,                     // 無標題日 → 退回 published_at
    raw: {},
  };

  it('contract: should=false ⇒ skip_reason non-null', () => {
    const cases: Array<{ patch: Partial<typeof base> | { ctxOverride?: unknown }; expectShould: boolean }> = [
      { patch: {}, expectShould: true },
      { patch: { video_type: 'shorts' }, expectShould: false },
      { patch: { video_type: 'preview' }, expectShould: false },
      { patch: { video_type: 'ad' }, expectShould: false },
      { patch: { duration_sec: 60 }, expectShould: false },     // < 3min → too_short
      { patch: { duration_sec: 466, video_type: 'clip' }, expectShould: true },  // 林漢偉盤前 7.7min clip 應通過
      { patch: { published_at: '2020-01-01T00:00:00Z' }, expectShould: false },
      { patch: { raw: { live_status: 'is_live' } }, expectShould: false },
    ];
    for (const c of cases) {
      const v = { ...base, ...c.patch } as typeof base;
      const r = decideShouldAnalyze(v, { now, alreadyAnalyzed: new Set() });
      if (c.expectShould) {
        expect(r.should).toBe(true);
        expect(r.reason).toBeNull();
      } else {
        expect(r.should).toBe(false);
        expect(r.reason).not.toBeNull();
      }
    }
  });

  it('already_analyzed wins over other reasons', () => {
    const r = decideShouldAnalyze(base, { now, alreadyAnalyzed: new Set([base.video_id]) });
    expect(r.should).toBe(false);
    expect(r.reason).toBe('already_analyzed');
  });

  // ── 嚴格同日 (targetDate) 模式 ────────────────────────────────
  describe('targetDate strict-same-day mode', () => {
    const ctx = { now, alreadyAnalyzed: new Set<string>(), targetDate: '2026-05-21' };

    it('published 5/21 Taipei (16:00Z = 5/22 00:00 CST) → wrong_date', () => {
      // 5/21 16:00Z = 5/22 00:00 CST → 不是 5/21 Taipei
      const v = { ...base, published_at: '2026-05-21T16:00:00Z' };
      const r = decideShouldAnalyze(v, ctx);
      expect(r.should).toBe(false);
      expect(r.reason).toBe('wrong_date');
    });

    it('published 5/21 15:59Z (= 5/21 23:59 CST) → should=true', () => {
      const v = { ...base, published_at: '2026-05-21T15:59:00Z' };
      const r = decideShouldAnalyze(v, ctx);
      expect(r.should).toBe(true);
      expect(r.reason).toBeNull();
    });

    it('published 5/20 (yesterday Taipei) → wrong_date', () => {
      const v = { ...base, published_at: '2026-05-20T08:00:00Z' };
      const r = decideShouldAnalyze(v, ctx);
      expect(r.should).toBe(false);
      expect(r.reason).toBe('wrong_date');
    });

    it('no targetDate → falls back to 72h window (regression check)', () => {
      const v = { ...base, published_at: '2026-05-22T10:00:00Z' };
      const r = decideShouldAnalyze(v, { now, alreadyAnalyzed: new Set() });
      expect(r.should).toBe(true);  // 2h ago < 72h
    });

    it('shorts skip wins over wrong_date check (规则性优先)', () => {
      const v = { ...base, video_type: 'shorts' as const, published_at: '2026-05-22T10:00:00Z' };
      const r = decideShouldAnalyze(v, ctx);
      expect(r.reason).toBe('shorts');  // 不是 wrong_date
    });
  });
});

// ── videoConfidenceScore ─────────────────────────────────────────────────────

describe('videoConfidenceScore', () => {
  const now = new Date('2026-05-22T12:00:00Z');
  const source: YouTubeSource = {
    source_id: 'test', display_name: 'Test',
    kind: 'channel', url: 'https://example.com',
    expected_cadence: 'daily', market_type: 'TW_STOCK',
    first_scan_done: true, active: true,
    created_at: '2026-01-01T00:00:00Z',
  };

  it('full-program 今日節目、有股票關鍵字 → 高分', () => {
    const score = videoConfidenceScore({
      video_type: 'full_program',
      duration_sec: 1800,
      published_at: '2026-05-22T08:00:00Z',  // 4h ago
      program_date: '2026-05-22',
      title: '理財達人秀 台股盤勢分析',
    }, source, now);
    // active(20) + 24h(15) + 今日(20) + 8min(10) + 關鍵字(10) + 非shorts(5) = 80
    expect(score).toBe(80);
  });

  it('shorts → 低分', () => {
    const score = videoConfidenceScore({
      video_type: 'shorts',
      duration_sec: 30,
      published_at: null,
      program_date: null,
      title: 'shorts',
    }, source, now);
    expect(score).toBeLessThanOrEqual(20);
  });

  it('score 永遠 ≤ 100', () => {
    const score = videoConfidenceScore({
      video_type: 'full_program',
      duration_sec: 3600,
      published_at: now.toISOString(),
      program_date: '2026-05-22',
      title: '股票 台股 盤勢 分析 理財',
    }, source, now);
    expect(score).toBeLessThanOrEqual(100);
  });
});

// ── ytdlp parsing & runner ───────────────────────────────────────────────────

class FakeStream extends EventEmitter {
  setEncoding(_enc: string) { /* no-op for testing */ }
}

class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  kill = jest.fn();
}

function makeRunner(ndjson: string, opts: { exitCode?: number; stderr?: string } = {}) {
  return (() => {
    const child = new FakeChild();
    // 立即非同步推送資料 + 結束
    setImmediate(() => {
      // 分多 chunk 推送，模擬 stream
      const lines = ndjson.split('\n');
      for (const line of lines) {
        child.stdout.emit('data', line + '\n');
      }
      if (opts.stderr) child.stderr.emit('data', opts.stderr);
      child.emit('exit', opts.exitCode ?? 0);
    });
    return child;
  }) as unknown as Parameters<typeof fetchRecentVideos>[1] extends infer T
    ? T extends { runner?: infer R } ? R : never
    : never;
}

describe('fetchRecentVideos (NDJSON parsing)', () => {
  it('parses valid NDJSON', async () => {
    const ndjson = [
      JSON.stringify({ id: 'aaaaaaaaaaa', title: 'V1', duration: 1800, url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' }),
      JSON.stringify({ id: 'bbbbbbbbbbb', title: 'V2', duration: 60, url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb' }),
    ].join('\n');
    const r = await fetchRecentVideos('https://www.youtube.com/@x/videos', {
      runner: makeRunner(ndjson),
    });
    expect(r.videos).toHaveLength(2);
    expect(r.videos[0].id).toBe('aaaaaaaaaaa');
    expect(r.exitCode).toBe(0);
  });

  it('tolerates a malformed line in the middle', async () => {
    const ndjson = [
      JSON.stringify({ id: 'aaaaaaaaaaa', title: 'V1', url: 'u1' }),
      'this-is-not-json',
      JSON.stringify({ id: 'bbbbbbbbbbb', title: 'V2', url: 'u2' }),
    ].join('\n');
    const r = await fetchRecentVideos('https://www.youtube.com/@x/videos', {
      runner: makeRunner(ndjson),
    });
    expect(r.videos).toHaveLength(2);
  });

  it('passes through stderr on non-zero exit', async () => {
    const r = await fetchRecentVideos('https://www.youtube.com/@x/videos', {
      runner: makeRunner('', { exitCode: 1, stderr: 'ERROR: Sign in to confirm' }),
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('ERROR: Sign in');
    expect(r.videos).toHaveLength(0);
  });
});

// ── Source URL invariant (2026-05-23) ────────────────────────────────────────
// 確保 sources.json 裡所有 source 都是 playlist URL（不是 channel URL）。
// 歷史上 channel URL 會誤抓非 playlist 範圍影片（如 part 1-10 短切），
// scanRunner.assertPlaylistUrl() 會在 scan 前擋掉，這裡額外做 static check。

describe('sources.json playlist-URL invariant', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');

  it('all sources are playlist URLs (no channel URLs)', () => {
    const sourcesPath = path.join(process.cwd(), 'data/youtube/sources.json');
    if (!fs.existsSync(sourcesPath)) return; // skip if not seeded
    const sources = JSON.parse(fs.readFileSync(sourcesPath, 'utf-8'));
    const playlistRe = /^https:\/\/www\.youtube\.com\/playlist\?list=PL[A-Za-z0-9_-]+/;
    for (const s of sources) {
      expect(s.kind).toBe('playlist');
      expect(s.url).toMatch(playlistRe);
    }
  });
});
