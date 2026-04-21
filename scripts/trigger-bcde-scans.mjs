// 一次性種 4-21 盤中 B/C/D/E × TW/CN session（無需 cron tick）
// 用法：npx tsx scripts/trigger-bcde-scans.mjs
import fs from 'node:fs';
const envRaw = fs.readFileSync('.env.local', 'utf-8');
const cronSecret = envRaw.match(/^CRON_SECRET\s*=\s*"?([^"\n]+)"?/m)?.[1] ?? '';
const base = 'http://localhost:3000/api/cron/update-intraday-bm';
const headers = cronSecret ? { authorization: `Bearer ${cronSecret}` } : {};
for (const market of ['TW', 'CN']) {
  for (const method of ['B', 'C', 'D', 'E']) {
    const url = `${base}?market=${market}&method=${method}`;
    const start = Date.now();
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(180_000) });
      const j = await res.json();
      const ms = Date.now() - start;
      console.log(`${market} ${method} [${ms}ms HTTP ${res.status}]:`, JSON.stringify(j));
    } catch (e) {
      console.log(`${market} ${method}: ERROR ${String(e)}`);
    }
  }
}
