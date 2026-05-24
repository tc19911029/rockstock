/**
 * Multi-agent reasoning / conflicts 用語的中英對照
 *
 * Phase 4 decisionBuilder + Bull/Bear thesis 的 reasoning 字串是 skill 寫成
 * 中英混用（Technical=fail、Risk yellow、hardBlocker p-02、Fundamental 優…）。
 * UI 顯示時用 replaceAgentTerms 做純文字替換，不動 data。
 *
 * 後續徹底中文化要改 skill prompt、這只是 UI surface 補強。
 */

// agent 名 + verdict 組合（最常見的「Technical=fail」「Risk=red」這類）
const TERM_PAIRS: Array<[RegExp, string]> = [
  // Agent 名 + verdict
  [/\bTechnical\s*=\s*pass\b/gi, '技術通過'],
  [/\bTechnical\s*=\s*watch\b/gi, '技術觀察'],
  [/\bTechnical\s*=\s*fail\b/gi, '技術不過'],
  [/\bNews\s*=\s*pass\b/gi, '消息通過'],
  [/\bNews\s*=\s*watch\b/gi, '消息觀察'],
  [/\bNews\s*=\s*fail\b/gi, '消息不過'],
  [/\bChip\s*=\s*pass\b/gi, '籌碼通過'],
  [/\bChip\s*=\s*watch\b/gi, '籌碼觀察'],
  [/\bChip\s*=\s*fail\b/gi, '籌碼不過'],
  [/\bFundamental\s*=\s*pass\b/gi, '基本通過'],
  [/\bFundamental\s*=\s*watch\b/gi, '基本觀察'],
  [/\bFundamental\s*=\s*fail\b/gi, '基本不過'],
  [/\bRisk\s*=\s*green\b/gi, '風控綠燈'],
  [/\bRisk\s*=\s*yellow\b/gi, '風控黃燈'],
  [/\bRisk\s*=\s*red\b/gi, '風控紅燈'],

  // 多空辯論強度
  [/\bBull\b/g, '多方'],
  [/\bBear\b/g, '空方'],

  // verdict 單字（落在獨立位置）
  [/\bpass\b/g, '通過'],
  [/\bwatch\b/g, '觀察'],
  [/\bfail\b/g, '不過'],

  // Risk 顏色（不接 =）
  [/\bgreen\b/g, '綠燈'],
  [/\byellow\b/g, '黃燈'],
  [/\bred\b/g, '紅燈'],

  // 風控規則代碼
  [/\bhardBlocker\b/g, '硬擋'],
  [/\bsoftBlocker\b/g, '軟擋'],
  [/\bp-(\d{2})\b/g, '戒律 P-$1'],

  // Agent 區塊名稱
  [/\bTechnical\b/g, '技術'],
  [/\bFundamental\b/g, '基本面'],
  [/\bChip\b/g, '籌碼'],
  [/\bNews\b/g, '消息面'],
  // Risk 後不接 = 時翻「風控」
  [/\bRisk\b/g, '風控'],
];

/**
 * 把英文 agent 術語翻成中文（純字串替換、不改原意）
 *
 * 範例：
 *   Technical=fail：六條件 4/6 不過門檻
 *   → 技術不過：六條件 4/6 不過門檻
 *
 *   Risk=red：hardBlocker p-02 戒律觸發 → 風控否決
 *   → 風控紅燈：硬擋 戒律 P-02 戒律觸發 → 風控否決
 */
export function replaceAgentTerms(text: string | undefined | null): string {
  if (!text) return '';
  let out = text;
  for (const [re, replacement] of TERM_PAIRS) {
    out = out.replace(re, replacement);
  }
  return out;
}
