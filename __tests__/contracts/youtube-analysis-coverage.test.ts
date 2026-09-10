import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const helper = path.resolve('scripts/launchd/bin/rockstock-youtube-analysis-coverage.sh');
let repo: string;
const date = '2026-09-09';
const write = (file: string, value: unknown) => fs.writeFileSync(path.join(repo, 'data/youtube', file), JSON.stringify(value));
const analysis = (ids: string[], count = ids.length) => write(`analysis/${date}.json`, {
  date, stats: { videos_analyzed: count }, video_summaries: ids.map(video_id => ({ video_id })),
});
const check = (...extra: string[]) => spawnSync('zsh', [helper, date, repo, ...extra], { encoding: 'utf8' });
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-coverage-'));
  fs.mkdirSync(path.join(repo, 'data/youtube/analysis'), { recursive: true });
  write('transcript-index.json', { byId: { a: { date, status: 'available' }, b: { date, status: 'available' }, unavailable: { date, status: 'error' } } });
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));
it('rejects existing but incomplete analysis even with an inflated count', () => {
  analysis(['a'], 2);
  expect(check().status).toBe(1);
});
it('checks IDs rather than equal counts', () => {
  analysis(['a', 'wrong']);
  expect(check().stderr).toContain('missing 1/2 videos: b');
});
it('accepts full coverage without waiting for unavailable transcripts', () => {
  analysis(['a', 'b']);
  expect(check().status).toBe(0);
});
it('rejects duplicate summaries and malformed index', () => {
  analysis(['a', 'a']);
  expect(check().status).toBe(1);
  write('transcript-index.json', {});
  expect(check().status).toBe(1);
});
it('skips an actual no-transcript day without requiring a placeholder analysis', () => {
  write('transcript-index.json', { byId: {} });
  expect(check().status).toBe(0);
});
it('includes question IDs and rejects old output after an attempt', () => {
  analysis(['a', 'b']);
  const question = path.join(repo, 'question.json');
  fs.writeFileSync(question, JSON.stringify({ date, videos: [{ video_id: 'c' }] }));
  expect(check(question).status).toBe(1);
  fs.writeFileSync(question, JSON.stringify({ date, videos: [] }));
  expect(check(question, String(Math.floor(Date.now() / 1000) + 60)).status).toBe(1);
});
it('validates shell syntax of every changed entry point', () => {
  for (const name of ['rockstock-youtube-analysis-coverage', 'rockstock-analysis-morning-check', 'rockstock-youtube-incremental-analysis', 'rockstock-analysis-catchup', 'rockstock-youtube-nightly-analysis']) {
    expect(() => execFileSync('zsh', ['-n', `scripts/launchd/bin/${name}.sh`])).not.toThrow();
  }
});
