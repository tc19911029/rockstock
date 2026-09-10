#!/bin/zsh
# Read-only gate: compare actual video IDs, never infer completeness from file size/count alone.
# Usage: <date> [repo] [question.json] [attempt-start-epoch]
export PATH="/Users/tc/.local/node-22/bin:/Users/tc/.local/bin:/usr/local/bin:/usr/bin:/bin"
node - "$@" <<'JS'
const fs = require('node:fs');
const [date, repo = '/Users/tc/Desktop/rockstock', question, started] = process.argv.slice(2);
const read = path => JSON.parse(fs.readFileSync(path, 'utf8'));
try {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Error('invalid date');
  const root = `${repo}/data/youtube`;
  const index = read(`${root}/transcript-index.json`);
  if (!index.byId || typeof index.byId !== 'object' || Array.isArray(index.byId)) throw Error('invalid transcript index');
  const expected = new Set(Object.entries(index.byId)
    .filter(([, v]) => v.date === date && v.status === 'available').map(([id]) => id));
  if (question) {
    const q = read(question);
    if (q.date !== date || !Array.isArray(q.videos)) throw Error('invalid question');
    for (const v of q.videos) {
      if (!v.video_id) throw Error('question video ID missing');
      expected.add(v.video_id);
    }
  }
  if (!expected.size && !started) {
    console.log(`${date}: no available transcripts`);
    process.exit(0);
  }
  const file = `${root}/analysis/${date}.json`;
  const a = read(file);
  if (a.date !== date || !a.stats || !Array.isArray(a.video_summaries)) throw Error('invalid analysis');
  if (started && Math.floor(fs.statSync(file).mtimeMs / 1000) < Number(started)) throw Error('analysis not refreshed');
  const ids = a.video_summaries.map(v => v.video_id);
  const actual = new Set(ids);
  if (ids.some(id => typeof id !== 'string' || !id) || actual.size !== ids.length || a.stats.videos_analyzed !== actual.size) throw Error('inconsistent analysis video count');
  const missing = [...expected].filter(id => !actual.has(id));
  if (missing.length) throw Error(`missing ${missing.length}/${expected.size} videos: ${missing.join(',')}`);
  console.log(`${date}: coverage OK (${expected.size} available, ${actual.size} analyzed)`);
} catch (error) {
  console.error(`${date}: ${error.message}`);
  process.exit(1);
}
JS
