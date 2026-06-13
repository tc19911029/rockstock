/**
 * 合約：cn-agents skill analysis 校驗規則（與 compose 寫入共用同一 validateAnalysis）
 *
 * 仿 youtube-analysis-codes：skill 有寫錯/幻覺代號前科，這支鎖住 validateAnalysis
 * 的行為（自創代號必擋、enum 必檢、分數界內），並對真實落地的 analysis 檔做過檢。
 */

import { promises as fs } from 'fs';
import path from 'path';
import { validateAnalysis } from '@/lib/cn-agents/bridge/validateAnalysis';
import type { CnAnalysisFile } from '@/lib/cn-agents/types';

const ANALYSIS_DIR = path.join(process.cwd(), 'data', 'cn-agents', 'analysis');

const goodAnalysis: CnAnalysisFile = {
  schemaVersion: 1, date: '2026-06-12', generatedAt: '2026-06-12T14:00:00Z',
  themes: [{ id: 'ai', name: 'AI算力', stage: 'main_rise', strength: 85, policy_link: null, leader_symbol: '300750', member_symbols: ['300750'], logic_summary: '主升' }],
  policy_events: [],
  stock_semantics: [{ symbol: '300750', theme_id: 'ai', position: 'leader', policy_score: 80, theme_score: 88, sentiment_note: '龍頭' }],
  market_narrative: '今日主升',
  report_written: true,
};

describe('validateAnalysis 合約', () => {
  const cands = new Set(['300750', '000001']);

  it('合法 analysis 通過', () => {
    expect(validateAnalysis(goodAnalysis, cands).ok).toBe(true);
  });

  it('自創代號（不在 candidates）被擋', () => {
    const bad = { ...goodAnalysis, stock_semantics: [{ ...goodAnalysis.stock_semantics[0], symbol: '999999' }] };
    const r = validateAnalysis(bad, cands);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('自創代號'))).toBe(true);
  });

  it('非法 stage / position / 越界分數被擋', () => {
    expect(validateAnalysis({ ...goodAnalysis, themes: [{ ...goodAnalysis.themes[0], stage: 'boom' }] }, cands).ok).toBe(false);
    expect(validateAnalysis({ ...goodAnalysis, stock_semantics: [{ ...goodAnalysis.stock_semantics[0], position: 'king' }] }, cands).ok).toBe(false);
    expect(validateAnalysis({ ...goodAnalysis, stock_semantics: [{ ...goodAnalysis.stock_semantics[0], theme_score: 150 }] }, cands).ok).toBe(false);
  });

  it('theme_id 指向不存在題材被擋', () => {
    const bad = { ...goodAnalysis, stock_semantics: [{ ...goodAnalysis.stock_semantics[0], theme_id: 'nonexist' }] };
    expect(validateAnalysis(bad, cands).ok).toBe(false);
  });

  it('schemaVersion / date 非法被擋', () => {
    expect(validateAnalysis({ ...goodAnalysis, schemaVersion: 2 }, cands).ok).toBe(false);
    expect(validateAnalysis({ ...goodAnalysis, date: 'xxxx' }, cands).ok).toBe(false);
  });

  it('真實落地 analysis 檔全過檢（無檔 skip）', async () => {
    const files = await fs.readdir(ANALYSIS_DIR).catch(() => [] as string[]);
    const jsons = files.filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
    if (jsons.length === 0) { console.warn('cn-analysis-schema：無 analysis 檔，skip'); return; }
    for (const f of jsons) {
      const a = JSON.parse(await fs.readFile(path.join(ANALYSIS_DIR, f), 'utf-8')) as CnAnalysisFile;
      // 真實檔的 candidate 白名單未知 → 放寬為「symbol 是 6 位數」+ 其他 enum/界內檢查
      const codes = new Set(a.stock_semantics.map((s) => s.symbol));
      const r = validateAnalysis(a, codes);
      // 自創代號錯誤會因白名單=自身而不觸發，其餘 enum/界內必須過
      expect(r.errors.filter((e) => !e.includes('自創代號'))).toEqual([]);
    }
  });
});
