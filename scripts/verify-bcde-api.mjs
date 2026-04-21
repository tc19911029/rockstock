// 驗證 /api/scanner/results 拿 4-21 B/C/D/E session 數量
import fs from 'node:fs';
const envRaw = fs.readFileSync('.env.local', 'utf-8');
const cronSecret = envRaw.match(/^CRON_SECRET\s*=\s*"?([^"\n]+)"?/m)?.[1] ?? '';
const headers = cronSecret ? { authorization: `Bearer ${cronSecret}` } : {};
const date = '2026-04-21';
console.log('date:', date);
for (const market of ['TW', 'CN']) {
  for (const mtf of ['daily', 'B', 'C', 'D', 'E']) {
    const url = `http://localhost:3000/api/scanner/results?market=${market}&direction=long&date=${date}&mtf=${mtf}`;
    try {
      const res = await fetch(url, { headers });
      const j = await res.json();
      const sessions = j?.sessions ?? [];
      const rc = sessions[0]?.resultCount ?? 0;
      console.log(`${market} ${mtf}: sessions=${sessions.length} resultCount=${rc}`);
    } catch (e) {
      console.log(`${market} ${mtf}: ERROR`, String(e));
    }
  }
}
