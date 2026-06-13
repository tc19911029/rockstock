/**
 * 校驗 skill 寫回的 analysis（P3）— 寫入與合約測試共用同一份規則
 * （仿 youtube-analysis-codes：skill 有寫錯代號前科，雙保險）。
 *
 * 最關鍵守衛：stock_semantics.symbol 必須 ⊆ question.candidates 的 code，
 * 防 skill 自創/幻覺代號污染決策。其餘：schemaVersion/date 一致、enum 合法、
 * 分數 ∈ [0,100]、themes ≤ 上限。
 */

import type { CnAnalysisFile } from '../types';

const THEME_STAGES = new Set(['fermenting', 'main_rise', 'divergence', 'ebb']);
const POLICY_LEVELS = new Set(['national', 'ministry', 'local', 'industry', 'none']);
const POLICY_DIRS = new Set(['positive', 'negative']);
const POSITIONS = new Set(['leader', 'core', 'follower', 'misc']);
const MAX_THEMES = 12;

export interface ValidateResult {
  ok: boolean;
  errors: string[];
}

const inRangeOrNull = (v: number | null | undefined): boolean =>
  v === null || v === undefined || (typeof v === 'number' && v >= 0 && v <= 100);

/**
 * @param analysis skill 寫回的物件
 * @param candidateCodes question.candidates 的 code 集合（symbol 白名單）
 */
export function validateAnalysis(analysis: unknown, candidateCodes: Set<string>): ValidateResult {
  const errors: string[] = [];
  const a = analysis as Partial<CnAnalysisFile> | null;
  if (!a || typeof a !== 'object') return { ok: false, errors: ['analysis 非物件'] };

  if (a.schemaVersion !== 1) errors.push(`schemaVersion 應為 1（得 ${a.schemaVersion}）`);
  if (typeof a.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(a.date)) errors.push(`date 非法：${a.date}`);

  const themes = Array.isArray(a.themes) ? a.themes : null;
  if (!themes) errors.push('themes 缺或非陣列');
  else {
    if (themes.length > MAX_THEMES) errors.push(`themes ${themes.length} 超過上限 ${MAX_THEMES}`);
    const ids = new Set<string>();
    for (const t of themes) {
      if (!t.id || ids.has(t.id)) errors.push(`theme id 缺或重複：${t.id}`);
      ids.add(t.id);
      if (!THEME_STAGES.has(t.stage)) errors.push(`theme ${t.id} stage 非法：${t.stage}`);
      if (!inRangeOrNull(t.strength)) errors.push(`theme ${t.id} strength 越界：${t.strength}`);
      if (t.policy_link) {
        if (!POLICY_LEVELS.has(t.policy_link.level)) errors.push(`theme ${t.id} policy level 非法`);
        if (!POLICY_DIRS.has(t.policy_link.direction)) errors.push(`theme ${t.id} policy direction 非法`);
      }
    }
  }

  if (Array.isArray(a.policy_events)) {
    for (const p of a.policy_events) {
      if (!POLICY_LEVELS.has(p.level)) errors.push(`policy_event level 非法：${p.level}`);
      if (!POLICY_DIRS.has(p.direction)) errors.push(`policy_event direction 非法：${p.direction}`);
    }
  }

  const sem = Array.isArray(a.stock_semantics) ? a.stock_semantics : null;
  if (!sem) errors.push('stock_semantics 缺或非陣列');
  else {
    const themeIds = new Set((themes ?? []).map((t) => t.id));
    for (const s of sem) {
      if (!candidateCodes.has(s.symbol)) errors.push(`stock_semantics 自創代號（不在 candidates）：${s.symbol}`);
      if (!POSITIONS.has(s.position)) errors.push(`${s.symbol} position 非法：${s.position}`);
      if (!inRangeOrNull(s.policy_score)) errors.push(`${s.symbol} policy_score 越界：${s.policy_score}`);
      if (!inRangeOrNull(s.theme_score)) errors.push(`${s.symbol} theme_score 越界：${s.theme_score}`);
      if (s.theme_id !== null && s.theme_id !== undefined && !themeIds.has(s.theme_id)) {
        errors.push(`${s.symbol} theme_id 指向不存在題材：${s.theme_id}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
