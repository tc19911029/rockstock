/**
 * decisionPath 英文代碼 → 中文 label
 *
 * Multi-agent decisionBuilder 內部用 snake_case 代碼分類最終決策原因，
 * UI 顯示給使用者看時轉成中文（朱書語）。
 *
 * 對應 lib/agents/types.ts:DecisionPath
 */

export type DecisionPathCode =
  | 'technical_fail'
  | 'risk_red'
  | 'buy_signal'
  | 'debate_neutral_watch'
  | 'technical_watch'
  | 'risk_yellow_watch'
  | 'default_watch';

const DECISION_PATH_LABEL: Record<string, string> = {
  technical_fail:        '技術面不過 — 六條件 / 戒律未通過',
  risk_red:              '風控紅燈 — 戒律觸發',
  buy_signal:            '進場訊號 — 四面向通過',
  debate_neutral_watch:  '多空辯論平手 — 觀察',
  technical_watch:       '技術面觀察 — 部分條件未到位',
  risk_yellow_watch:     '風控黃燈 — 轉觀察、不冒進',
  default_watch:         '預設觀察 — 無明確訊號',
};

export function decisionPathZh(code: string | undefined | null): string {
  if (!code) return '—';
  return DECISION_PATH_LABEL[code] ?? code;
}
