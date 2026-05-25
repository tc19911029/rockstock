/**
 * summarizeFacetVerdicts — 4 verdict → 一句話人話結論
 *
 * 用於 DecisionPanel FallbackFacetVerdicts 上方顯示「整體建議」、user 不用自己算
 * 「3 過 1 不過 = ?」。
 *
 * 規則（朱書精神：多面向同意才進場、戒律觸發絕對不動）：
 *   - 4 pass               → 「✅ 4 面向同意、可考慮進場（盤中找 5 分 K 突破點）」
 *   - 3 pass + 1 watch     → 「👀 3 面向過 1 觀察、可等買點 / 配 5 分 K 確認」
 *   - 3 pass + 1 fail      → 「⚠ 訊號分歧（3 過 1 不過）、先觀察 / 不追高」
 *   - 2 pass + ...         → 「⏳ 僅 2 面向過、訊號不夠強、繼續觀察」
 *   - 1 pass + ...         → 「🚫 僅 1 面向過、不適合進場」
 *   - 0 pass               → 「⛔ 無面向過、絕對不進場」
 *   - 技術 fail + 戒律觸發 → 「⛔ 戒律觸發 + 技術不過、書本絕對禁止」（最高優先）
 */

import type { FacetVerdict, FacetVerdictsResult } from './computeFacetVerdicts';

export interface FacetSummary {
  /** 一句話結論 */
  conclusion: string;
  /** 分級 — green=可進場 / yellow=觀察 / red=不進場 */
  level: 'green' | 'yellow' | 'red';
  /** pass / watch / fail 計數 */
  counts: { pass: number; watch: number; fail: number };
}

export interface SummarizeInput extends FacetVerdictsResult {
  /** 技術面戒律觸發（最高優先級判斷）*/
  prohibitionHit?: boolean | null;
}

export function summarizeFacetVerdicts(input: SummarizeInput): FacetSummary {
  const verdicts: FacetVerdict[] = [input.technical, input.news, input.chip, input.fundamental];
  const pass = verdicts.filter(v => v === 'pass').length;
  const watch = verdicts.filter(v => v === 'watch').length;
  const fail = verdicts.filter(v => v === 'fail').length;
  const counts = { pass, watch, fail };

  // 最高優先：戒律觸發 + 技術不過 → 絕對不進場
  if (input.prohibitionHit && input.technical === 'fail') {
    return {
      conclusion: '⛔ 戒律觸發 + 技術不過、書本絕對禁止進場',
      level: 'red',
      counts,
    };
  }

  if (pass === 4) {
    return {
      conclusion: '✅ 4 面向都同意、可考慮進場（盤中找 5 分 K 突破點）',
      level: 'green',
      counts,
    };
  }
  if (pass === 3 && watch === 1) {
    return {
      conclusion: '👀 3 面向過、1 面向觀察、可等買點（盤中配 5 分 K 確認）',
      level: 'green',
      counts,
    };
  }
  if (pass === 3 && fail === 1) {
    return {
      conclusion: '⚠ 訊號分歧（3 面向過、1 面向不過）、先觀察、不要追高',
      level: 'yellow',
      counts,
    };
  }
  if (pass === 2) {
    return {
      conclusion: '⏳ 僅 2 面向過、訊號不夠強、繼續觀察其他面向是否轉強',
      level: 'yellow',
      counts,
    };
  }
  if (pass === 1) {
    return {
      conclusion: '🚫 僅 1 面向過、其餘觀察 / 不過、不適合進場',
      level: 'red',
      counts,
    };
  }
  // 0 pass
  return {
    conclusion: '⛔ 無面向過關、絕對不進場、繼續觀察大盤',
    level: 'red',
    counts,
  };
}
