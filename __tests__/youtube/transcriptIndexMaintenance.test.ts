import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconcileTranscriptIndex } from '@/lib/youtube/transcriptIndexMaintenance';

function transcript(videoId: string, date: string, charCount: number) {
  return {
    video_id: videoId,
    source_id: 'source',
    date,
    fetched_at: `${date}T12:00:00.000Z`,
    status: 'available',
    quality_score: 90,
    lang: 'zh',
    char_count: charCount,
    cue_count: 1,
    vtt_bytes: 10,
    text: 'content',
    cues: [],
    error: null,
    quality: { lang_ok: true, length_ok: true, has_timestamps: true, stock_keyword_hits: 0, rolling_dup_ratio: 0 },
  };
}

describe('transcript index maintenance', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'rockstock-transcript-index-'));
    await fs.mkdir(path.join(root, 'transcripts', '2026-09-03'), { recursive: true });
    await fs.mkdir(path.join(root, 'transcripts', 'manual'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'transcripts', '2026-09-03', 'kept.json'),
      JSON.stringify(transcript('kept', '2026-09-03', 100)),
    );
    await fs.writeFile(
      path.join(root, 'transcripts', '2026-09-03', 'added.json'),
      JSON.stringify(transcript('added', '2026-09-03', 200)),
    );
    await fs.writeFile(path.join(root, 'transcripts', 'manual', 'ignored.json'), '{}');
    await fs.writeFile(path.join(root, 'transcript-index.json'), JSON.stringify({
      byId: {
        kept: { status: 'available', quality_score: 90, lang: 'zh', char_count: 50, fetched_at: 'old', date: '2026-09-03' },
        stale: { status: 'available', quality_score: 90, lang: 'zh', char_count: 300, fetched_at: 'old', date: '2026-08-01' },
      },
      updated_at: '2026-01-01T00:00:00.000Z',
    }));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test('dry-run reports drift without changing the index', async () => {
    const before = await fs.readFile(path.join(root, 'transcript-index.json'), 'utf-8');
    await expect(reconcileTranscriptIndex(root, { write: false })).resolves.toMatchObject({
      scanned: 2, before: 2, after: 2, added: 1, updated: 1, removed: 1, wrote: false,
    });
    expect(await fs.readFile(path.join(root, 'transcript-index.json'), 'utf-8')).toBe(before);
  });

  test('rebuild mirrors retained date folders and removes stale entries', async () => {
    const now = new Date('2026-09-04T00:00:00.000Z');
    await expect(reconcileTranscriptIndex(root, { now })).resolves.toMatchObject({
      scanned: 2, before: 2, after: 2, added: 1, updated: 1, removed: 1, wrote: true,
    });
    const rebuilt = JSON.parse(await fs.readFile(path.join(root, 'transcript-index.json'), 'utf-8'));
    expect(Object.keys(rebuilt.byId).sort()).toEqual(['added', 'kept']);
    expect(rebuilt.byId.kept.char_count).toBe(100);
    expect(rebuilt.updated_at).toBe(now.toISOString());
  });
});
