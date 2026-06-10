/**
 * DailyAnalysis 的「股票代號 ↔ 名稱」對應驗證 —— 單一事實來源。
 *
 * Claude 在對話內寫 analysis JSON 時，偶爾把名稱寫得跟 stock-master 不一致
 * （例：4958 寫「臻鼎」但 master 是「臻鼎-KY」、2327 寫「國巨」但 master 是「國巨*」）。
 * 這支函式被「寫入時」(saveDailyAnalysis 寫進 git 前擋下) 與「合約測試」共用同一份規則，
 * 讓「事前防止」與「事後偵測」永遠一致、不會 drift。
 *
 * 容忍：master 的命名標記差異（除權息 *、-KY 破折號、空白）用 norm() 抹平。
 */
import type { DailyAnalysis } from './analysisStorage';
import type { StockMasterFile } from './stockMaster';

function norm(s: string): string {
  return s.replace(/[\*\-\s]/g, '');
}

// 已知 master 短名 vs 常見全名差異（必須是「同一支股票、只是顯示名不同」，不可放成兩支股票的代號）
export const KNOWN_NAME_VARIANTS: Record<string, string[]> = {
  '5347': ['世界先進'],  // master: '世界'
  '6415': ['矽力-KY'],   // master: '矽力*-KY'（* 為除權息標記、會隨時間變動）
};

/**
 * 驗證 analysis 內所有 (code, name) 對是否對應 master 的真實股票/別名。
 * @returns 違規訊息陣列；空陣列 = 全部 OK。
 */
export function validateAnalysisNames(a: DailyAnalysis, master: StockMasterFile): string[] {
  const byCode = new Map(master.entries.map(e => [e.code, { name: e.name, aliases: e.aliases ?? [] }]));
  const violations: string[] = [];

  const checkPair = (where: string, code: string, name: string) => {
    const real = byCode.get(code);
    if (real === undefined) {
      violations.push(`${where}: code ${code} (${name}) not in stock-master`);
      return;
    }
    const acceptable = new Set([
      norm(real.name),
      ...real.aliases.map(norm),
      ...(KNOWN_NAME_VARIANTS[code] ?? []).map(norm),
    ]);
    if (!acceptable.has(norm(name))) {
      violations.push(`${where}: code ${code} mapped to "${name}" but master/aliases are [${[real.name, ...real.aliases].join(', ')}]`);
    }
  };

  for (const s of a.weak_signal_stocks ?? []) {
    if (s.matched) checkPair('weak_signal', s.matched.code, s.matched.name);
  }
  for (const s of a.high_consensus_stocks ?? []) {
    if (s.matched) checkPair('high_consensus', s.matched.code, s.matched.name);
  }
  for (const s of a.stock_scoring ?? []) {
    checkPair('stock_scoring', s.stock_code, s.stock_name);
  }

  return violations;
}
