/**
 * Contract test: 法人報告（data/broker/reports/*.json）資料完整性 + 推導一致性。
 *
 * 守則：
 *   - 純函式 normalizeRating / sentimentFromRating 的對照表固定（單一事實來源）
 *   - sentiment === sentimentFromRating(normalizeRating(rating_raw))
 *   - rating === normalizeRating(rating_raw)
 *   - target_price / prev_target_price 為 null 或 > 0；covered ⇒ rating !== 'other'
 *   - matched 存在 ⇔ market='TW'；matched.code 對映 stock-master 真實 entry（名稱 norm 後相符）或 matched=null
 *   - report_id 全域唯一；report_date = 檔名日期且 YYYY-MM-DD；stats 與 reports[] 一致
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { normalizeRating, sentimentFromRating } from '../../lib/broker/types';

const REPO = path.join(__dirname, '..', '..');
const REPORTS_DIR = path.join(REPO, 'data/broker/reports');
const MASTER_PATH = path.join(REPO, 'data/youtube/stock-master.json');

function norm(s: string): string {
  return s.replace(/[*\-\s]/g, '');
}

// ── 純函式對照（永遠跑，不依賴資料檔）────────────────────────────────────────
describe('broker rating pure functions', () => {
  it('normalizeRating maps broker wording to canonical values', () => {
    expect(normalizeRating('Buy')).toBe('buy');
    expect(normalizeRating('Conviction List Buy')).toBe('buy');
    expect(normalizeRating('Outperform')).toBe('buy');
    expect(normalizeRating('Overweight')).toBe('overweight');
    expect(normalizeRating('OW')).toBe('overweight');
    expect(normalizeRating('Equal-weight')).toBe('neutral');
    expect(normalizeRating('Neutral')).toBe('neutral');
    expect(normalizeRating('Hold')).toBe('hold');
    expect(normalizeRating('Underweight')).toBe('underweight');
    expect(normalizeRating('UW')).toBe('underweight');
    expect(normalizeRating('Sell')).toBe('sell');
    expect(normalizeRating('Underperform')).toBe('sell');
    expect(normalizeRating('')).toBe('other');
    expect(normalizeRating('Not Rated')).toBe('other');
  });

  it('sentimentFromRating: buy/ow→bullish, sell/uw→bearish, neutral/hold→neutral, other→mentioned_only', () => {
    expect(sentimentFromRating('buy')).toBe('bullish');
    expect(sentimentFromRating('overweight')).toBe('bullish');
    expect(sentimentFromRating('sell')).toBe('bearish');
    expect(sentimentFromRating('underweight')).toBe('bearish');
    expect(sentimentFromRating('neutral')).toBe('neutral');
    expect(sentimentFromRating('hold')).toBe('neutral');
    expect(sentimentFromRating('other')).toBe('mentioned_only');
  });
});

// ── 資料契約（有資料才跑）────────────────────────────────────────────────────
interface Matched { code: string; name: string; market: string; }
interface Mention {
  raw_query: string; matched: Matched | null; market: string;
  rating_raw: string; rating: string; sentiment: string;
  target_price: number | null; prev_target_price: number | null; covered: boolean;
}
interface Report { report_id: string; broker: string; report_date: string; stocks: Mention[]; }
interface Daily { date: string; reports: Report[]; stats: { report_count: number; covered_count: number }; }
interface MasterEntry { code: string; name: string; aliases?: string[]; }

describe('broker reports data contract', () => {
  if (!existsSync(REPORTS_DIR) || !existsSync(MASTER_PATH)) {
    it.skip('skipped — data files not present', () => undefined);
    return;
  }

  const master = JSON.parse(readFileSync(MASTER_PATH, 'utf-8')) as { entries: MasterEntry[] };
  const byCode = new Map(master.entries.map(e => [e.code, { name: e.name, aliases: e.aliases ?? [] }]));
  const KNOWN_NAME_VARIANTS: Record<string, string[]> = {
    '5347': ['世界先進'],   // master: '世界'
  };

  const files = readdirSync(REPORTS_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  const allReportIds = new Set<string>();

  it('has at least one report file', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s — schema, sentiment derivation, target price, code mapping', (fname) => {
    const day = JSON.parse(readFileSync(path.join(REPORTS_DIR, fname), 'utf-8')) as Daily;
    const fileDate = fname.replace(/\.json$/, '');
    expect(day.date).toBe(fileDate);

    let covered = 0;
    for (const r of day.reports) {
      expect(r.report_id).toBeTruthy();
      expect(allReportIds.has(r.report_id)).toBe(false); // 全域唯一
      allReportIds.add(r.report_id);
      expect(r.report_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.report_date).toBe(fileDate);
      expect(r.broker).toBeTruthy();

      for (const m of r.stocks) {
        if (m.covered) covered += 1;
        // 推導一致性
        expect(m.rating).toBe(normalizeRating(m.rating_raw));
        expect(m.sentiment).toBe(sentimentFromRating(normalizeRating(m.rating_raw)));
        // 目標價
        if (m.target_price != null) expect(m.target_price).toBeGreaterThan(0);
        if (m.prev_target_price != null) expect(m.prev_target_price).toBeGreaterThan(0);
        // covered ⇒ 有評等
        if (m.covered) expect(m.rating).not.toBe('other');
        // matched ↔ market
        if (m.matched) {
          expect(m.market).toBe('TW');
          const entry = byCode.get(m.matched.code);
          expect(entry).toBeDefined();
          if (entry) {
            const candidates = [entry.name, ...entry.aliases, ...(KNOWN_NAME_VARIANTS[m.matched.code] ?? [])].map(norm);
            expect(candidates).toContain(norm(m.matched.name));
          }
        } else {
          expect(m.market).toBe('OTHER');
        }
      }
    }
    // stats 一致
    expect(day.stats.report_count).toBe(day.reports.length);
    expect(day.stats.covered_count).toBe(covered);
  });
});
