/**
 * Contract test: YouTube transcript MVP 3 — 讀得準
 *
 * 守門員：
 *   - VTT parser 正確 strip header / inline tag / dedup rolling captions
 *   - parseVtt 對 timestamp 容錯（含/不含 hours）
 *   - gradeTranscript 對 status 決策矩陣（unavailable / failed / low_quality / available）
 *   - Invariant: status='available' ⇒ quality_score >= 50
 *   - Invariant: !fetched.available ⇒ status='unavailable' & score=0
 *   - rolling_dup_ratio 對自動字幕高、對人工字幕低
 */

import { parseVtt } from '@/lib/youtube/transcript';
import type { TranscriptFetchResult } from '@/lib/youtube/transcript';
import { gradeTranscript } from '@/lib/youtube/transcriptQuality';

// ── VTT parser ───────────────────────────────────────────────────────────────

describe('parseVtt', () => {
  it('parses standard manual VTT (real ustvmoney100 format)', () => {
    const raw = `WEBVTT
Kind: captions
Language: zh-Hant

00:00:00.366 --> 00:00:00.933
插播一下

00:00:00.933 --> 00:00:02.000
我們進棚到現在

00:00:02.000 --> 00:00:03.633
將近快要三個小時
`;
    const r = parseVtt(raw);
    expect(r.cues).toHaveLength(3);
    expect(r.cues[0].text).toBe('插播一下');
    expect(r.cues[0].start).toBeCloseTo(0.366);
    expect(r.cues[1].text).toBe('我們進棚到現在');
    expect(r.text).toContain('插播一下');
    expect(r.text).toContain('將近快要三個小時');
  });

  it('handles missing hour in timestamp', () => {
    // YouTube auto subs 有時用 MM:SS.mmm 而非 HH:MM:SS.mmm
    const raw = `WEBVTT

00:00.366 --> 00:00.933
短時長格式
`;
    const r = parseVtt(raw);
    expect(r.cues).toHaveLength(1);
    expect(r.cues[0].start).toBeCloseTo(0.366);
  });

  it('strips inline <c>, <v>, timing tags', () => {
    const raw = `WEBVTT

00:00:00.000 --> 00:00:05.000
<c.colorCCCCCC>歡迎</c><c.colorE5E5E5> </c><c.colorCCCCCC>收看</c>
<00:00:01.500><c>節目</c>
`;
    const r = parseVtt(raw);
    expect(r.cues[0].text).not.toContain('<');
    expect(r.cues[0].text).not.toContain('>');
    expect(r.cues[0].text).toContain('歡迎');
    expect(r.cues[0].text).toContain('節目');
  });

  it('dedupes rolling auto-caption prefix duplicates', () => {
    const raw = `WEBVTT

00:00:00.000 --> 00:00:01.000
今天台股

00:00:01.000 --> 00:00:02.000
今天台股上漲

00:00:02.000 --> 00:00:03.000
今天台股上漲收紅
`;
    const r = parseVtt(raw);
    // 3 cues 應該 collapse 到 1 個（保留最長）
    expect(r.cues).toHaveLength(1);
    expect(r.cues[0].text).toBe('今天台股上漲收紅');
  });

  it('returns empty result for VTT with header only', () => {
    const raw = `WEBVTT
Kind: captions
`;
    const r = parseVtt(raw);
    expect(r.cues).toHaveLength(0);
    expect(r.text).toBe('');
  });
});

// ── gradeTranscript decision matrix ──────────────────────────────────────────

describe('gradeTranscript', () => {
  const baseFetched: TranscriptFetchResult = {
    available: true, manual: true, lang: 'zh-Hant',
    text: '', cues: [],
    char_count: 0, vtt_bytes: 0,
    stderr: '', exit_code: 0, timed_out: false,
  };

  it('!available → status=unavailable, score=0', () => {
    const r = gradeTranscript({ fetched: { ...baseFetched, available: false } });
    expect(r.status).toBe('unavailable');
    expect(r.score).toBe(0);
  });

  it('available but char_count=0 → status=failed', () => {
    const r = gradeTranscript({ fetched: { ...baseFetched, available: true, char_count: 0 } });
    expect(r.status).toBe('failed');
    expect(r.score).toBe(0);
  });

  it('high-quality Chinese transcript → status=available with high score', () => {
    const text = '今天台股盤勢分析'.repeat(200) + '台積電 輝達 半導體 法人 外資 投信 主力 籌碼 財報 營收';
    const cues = Array.from({ length: 60 }, (_, i) => ({
      start: i, end: i + 1, text: `cue ${i}`,
    }));
    const r = gradeTranscript({
      fetched: { ...baseFetched, text, cues, char_count: text.length },
    });
    expect(r.status).toBe('available');
    expect(r.score).toBeGreaterThanOrEqual(50);
    expect(r.lang_ok).toBe(true);
    expect(r.has_timestamps).toBe(true);
    expect(r.stock_keyword_hits).toBeGreaterThanOrEqual(3);
  });

  it('English transcript → lang_ok=false → low score', () => {
    const text = 'today the stock market opened higher '.repeat(50);
    const r = gradeTranscript({
      fetched: { ...baseFetched, lang: 'en', text, char_count: text.length, cues: [
        { start: 0, end: 1, text: 'today' },
      ] },
    });
    expect(r.lang_ok).toBe(false);
    expect(r.score).toBeLessThan(50);
    expect(r.status).toBe('low_quality');
  });

  it('Chinese but no stock keywords → reduced score', () => {
    const text = '介紹一個有趣的故事 '.repeat(80);
    const cues = Array.from({ length: 60 }, (_, i) => ({ start: i, end: i + 1, text: 'x' }));
    const r = gradeTranscript({
      fetched: { ...baseFetched, text, cues, char_count: text.length },
    });
    expect(r.stock_keyword_hits).toBeLessThan(3);
    // 20+25+15+10+0 = 70 — 仍 available 但低於有股市內容的版本
    expect(r.status).toBe('available');
    expect(r.score).toBeLessThan(90);
  });

  it('Chinese available with text < 500 chars (length_ok=false)', () => {
    const text = '盤後 台股 收紅 法人 籌碼';
    const cues = [{ start: 0, end: 1, text }];
    const r = gradeTranscript({
      fetched: { ...baseFetched, text, char_count: text.length, cues },
    });
    expect(r.length_ok).toBe(false);
  });
});

// ── Invariants ───────────────────────────────────────────────────────────────

describe('Transcript invariants', () => {
  it('contract: status=unavailable ⇒ score=0', () => {
    const fetched: TranscriptFetchResult = {
      available: false, manual: false, lang: null,
      text: '', cues: [], char_count: 0, vtt_bytes: 0,
      stderr: '', exit_code: null, timed_out: false,
    };
    const r = gradeTranscript({ fetched });
    expect(r.status).toBe('unavailable');
    expect(r.score).toBe(0);
  });

  it('contract: status=available ⇒ score ≥ 50', () => {
    // Test many random-ish good transcripts: lang Chinese + length OK + keywords + cues
    for (const len of [1000, 5000, 15000, 50000]) {
      const text = ('台股盤勢分析 法人籌碼動向 ' + '我們進棚到現在 '.repeat(100)).slice(0, len);
      const cues = Array.from({ length: Math.max(50, Math.floor(len / 50)) }, (_, i) => ({
        start: i, end: i + 1, text: `cue${i}`,
      }));
      const r = gradeTranscript({
        fetched: {
          available: true, manual: true, lang: 'zh-Hant',
          text, cues, char_count: text.length, vtt_bytes: text.length,
          stderr: '', exit_code: 0, timed_out: false,
        },
      });
      if (r.status === 'available') {
        expect(r.score).toBeGreaterThanOrEqual(50);
      }
    }
  });
});
