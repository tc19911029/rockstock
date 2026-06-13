/**
 * /api/daily-pick/dates — 可瀏覽的歷史日期清單（有三色掃描檔的日子，最多近 ~30 天）。
 */
import fs from 'fs';
import path from 'path';
import { apiOk } from '@/lib/api/response';

export const runtime = 'nodejs';

export async function GET() {
  const dir = path.join(process.cwd(), 'data', 'tw-sanse-scan');
  let dates: string[] = [];
  try {
    dates = fs.readdirSync(dir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.replace(/\.json$/, ''))
      .sort()
      .reverse();
  } catch { /* 目錄不存在 → 空清單 */ }
  return apiOk({ dates });
}
