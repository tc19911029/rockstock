/**
 * Contract test: analysis 檔的 keyframe 新欄位（2026-06-12）
 *
 * 守門員（向下相容是核心斷言）：
 *   - 舊 analysis 檔沒有新欄位 → trivially pass
 *   - 新欄位若存在則必須合法：
 *     source_type ∈ {speech, slide, speech+slide}
 *     recommendation_type ∈ 7 值 enum
 *     mention_time 是有限數 ≥ 0
 *     screenshot_ref 以 data/youtube/keyframes/ 開頭
 *     mentioned_price / target_price / stop_loss 是正的有限數
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AnalyzedStockMention, DailyAnalysis } from '@/lib/youtube/analysisStorage';

const ANALYSIS_DIR = path.join(process.cwd(), 'data', 'youtube', 'analysis');

const VALID_SOURCE_TYPES = new Set(['speech', 'slide', 'speech+slide']);
const VALID_RECO_TYPES = new Set(['明確買進', '看多', '觀察', '等回檔', '小心追高', '偏空', '只介紹']);

async function loadAllAnalyses(): Promise<Array<{ file: string; analysis: DailyAnalysis }>> {
  let files: string[] = [];
  try {
    files = (await fs.readdir(ANALYSIS_DIR)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  } catch {
    return [];
  }
  const out: Array<{ file: string; analysis: DailyAnalysis }> = [];
  for (const f of files) {
    try {
      out.push({ file: f, analysis: JSON.parse(await fs.readFile(path.join(ANALYSIS_DIR, f), 'utf-8')) });
    } catch { /* 壞檔由其他測試把關 */ }
  }
  return out;
}

function mentionsOf(a: DailyAnalysis): AnalyzedStockMention[] {
  return [...(a.high_consensus_stocks ?? []), ...(a.weak_signal_stocks ?? [])];
}

describe('analysis keyframe 欄位（存在才驗，舊檔無欄位即通過）', () => {
  it('source_type / recommendation_type / mention_time / screenshot_ref / 價位欄位合法', async () => {
    const all = await loadAllAnalyses();
    const errors: string[] = [];

    for (const { file, analysis } of all) {
      for (const m of mentionsOf(analysis)) {
        const tag = `${file} ${m.raw_query}`;
        if (m.source_type !== undefined && !VALID_SOURCE_TYPES.has(m.source_type)) {
          errors.push(`${tag}: 非法 source_type=${m.source_type}`);
        }
        if (m.recommendation_type !== undefined && !VALID_RECO_TYPES.has(m.recommendation_type)) {
          errors.push(`${tag}: 非法 recommendation_type=${m.recommendation_type}`);
        }
        if (m.mention_time !== undefined && !(Number.isFinite(m.mention_time) && m.mention_time >= 0)) {
          errors.push(`${tag}: 非法 mention_time=${m.mention_time}`);
        }
        if (m.screenshot_ref !== undefined && !/^data\/youtube\/keyframes\//.test(m.screenshot_ref)) {
          errors.push(`${tag}: screenshot_ref 路徑不合慣例=${m.screenshot_ref}`);
        }
        for (const key of ['mentioned_price', 'target_price', 'stop_loss'] as const) {
          const v = m[key];
          if (v !== undefined && !(Number.isFinite(v) && v > 0)) {
            errors.push(`${tag}: 非法 ${key}=${v}`);
          }
        }
        // slide 證據卻沒給截圖 → 警告級（不擋）；speech 不應有 screenshot_ref 以外不檢查
        if (m.source_type === 'slide' && m.screenshot_ref === undefined) {
          // 允許：OCR 命中但該幀只留文字沒存圖的情況
        }
      }
    }

    expect(errors).toEqual([]);
  });
});
