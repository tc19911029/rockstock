// ============================================================
// 題材×三色 — 交叉選股核心（純函式，無 I/O）。
//
// 三組：
//   cross  = 過三色 gate 且 ∈ 前 N 熱門題材（交叉）
//   theme  = 熱門題材成分（不要求三色；對照組「只看題材」）
//   sanse  = 過三色 gate（不論題材；對照組「只看三色」）
//
// 全部資料由 caller 傳入 → 可單元測試、確定性、防前視（呼叫端傳 asOf 重算的 records）。
// 判定一律衍生自既有 ConditionReport / NamedStrategy / tradeVerdict，不另算指標、
// 不改 combo grade 定義、不進書本選股鏈（鐵則 #5）。
// ============================================================

import { COMBO_RANK, tradeVerdict, type ConditionReport } from '@/lib/cn-sanse/conditions';
import { matchedStrategies } from '@/lib/cn-sanse/namedStrategies';
import type { ResonanceRecord } from '@/lib/cn-sanse/scan';
import { bareCode, fullSymbolFromCode, isCnGrowthBoardCode } from './codes';
import {
  DEFAULT_CROSS_THRESHOLDS,
  SANSE_STATE_LABEL,
  type CohortSelection,
  type CrossCandidate,
  type CrossThresholds,
  type HotTheme,
  type SanseCandidate,
  type ThemeCandidate,
  type ThemeRef,
  type ThemeSanseCoverage,
  type TsMarket,
} from './types';

/** 三色 gate：combo rank ≥ 門檻 且 一眼結論非排除（sell/conflict）且 有買進共振。 */
export function passesSanse(report: ConditionReport, t: CrossThresholds): boolean {
  const rank = report.combo ? COMBO_RANK[report.combo.grade] : 0;
  if (rank < t.minComboRank) return false;
  if (!report.selected) return false;
  const v = tradeVerdict(report);
  if (t.excludeVerdicts.includes(v.tone)) return false;
  return true;
}

function stratLabel(report: ConditionReport): string {
  const m = matchedStrategies(report);
  if (m.length > 0) return m[0].label;
  return report.combo?.label ?? '三色';
}

function buildReason(themeName: string, rank: number, report: ConditionReport): string {
  const v = tradeVerdict(report);
  const stateLabel = report.mainStage ? SANSE_STATE_LABEL[report.mainStage] : '—';
  const action = v.reversal ? '底反該買🔥' : v.tone === 'buy' ? '可追高' : '等回踩';
  return `題材【${themeName}】熱度#${rank} ＋ 三色【${stratLabel(report)}】（${stateLabel}）→ ${action}`;
}

function buildRiskNote(report: ConditionReport, coverage: ThemeSanseCoverage): string {
  const parts: string[] = [];
  if (report.mainStage === 'full') parts.push('位階偏高、追高有套牢風險');
  else if (tradeVerdict(report).tone === 'wait') parts.push('今天還沒金叉觸發，等回踩較穩');
  if (report.sellWarnings.length > 0) parts.push(`留意賣訊：${report.sellWarnings.join('、')}`);
  if (coverage === 'main_board_only') parts.push('龍頭在創業板/科創、此檔為主板成員（三色掃不到龍頭）');
  return parts.length > 0 ? parts.join('；') : '無明顯警示';
}

/**
 * 交叉選股。
 * @param market 決定全代號與「龍頭是否在創業/科創」覆蓋揭露。
 * @param hotThemes 熱門題材（含 heatRank、leaderCode、members）。
 * @param sanseRecords 三色掃描 records（已對 asOf 重算）。
 * @param codeToThemes 裸碼 → 所屬熱門題材 refs（與 hotThemes 同源、heatRank 一致）。
 */
export function crossSelect(
  market: TsMarket,
  hotThemes: HotTheme[],
  sanseRecords: ResonanceRecord[],
  codeToThemes: Map<string, ThemeRef[]>,
  thresholds: CrossThresholds = DEFAULT_CROSS_THRESHOLDS,
): CohortSelection {
  const themeById = new Map<string, HotTheme>(hotThemes.map((t) => [t.id, t]));
  const topThemeIds = new Set(
    hotThemes.filter((t) => t.heatRank <= thresholds.topThemes).map((t) => t.id),
  );

  // ── cross + sanse-only ──
  const cross: CrossCandidate[] = [];
  const sanse: SanseCandidate[] = [];
  for (const rec of sanseRecords) {
    if (!passesSanse(rec.report, thresholds)) continue;
    const code = bareCode(rec.symbol);
    const v = tradeVerdict(rec.report);
    const named = matchedStrategies(rec.report).map((s) => s.id);

    // sanse-only：過 gate 即收（不論題材）
    sanse.push({
      code,
      symbol: rec.symbol,
      name: rec.name,
      industry: rec.industry,
      namedStrategies: named,
      sanseState: rec.report.mainStage,
      comboGrade: rec.report.combo?.grade ?? 'weak',
      verdict: v.tone,
      reason: `三色【${stratLabel(rec.report)}】（${rec.report.mainStage ? SANSE_STATE_LABEL[rec.report.mainStage] : '—'}）`,
    });

    // cross：再要求 ∈ 前 N 熱門題材
    const refs = (codeToThemes.get(code) ?? []).filter((r) => topThemeIds.has(r.themeId));
    if (refs.length === 0) continue;
    const sorted = [...refs].sort((a, b) => a.heatRank - b.heatRank);
    const best = sorted[0];
    const coverage: ThemeSanseCoverage =
      market === 'CN' &&
      sorted.some((r) => {
        const lc = themeById.get(r.themeId)?.leaderCode;
        return lc != null && isCnGrowthBoardCode(lc);
      })
        ? 'main_board_only'
        : 'full';
    cross.push({
      code,
      symbol: rec.symbol,
      name: rec.name,
      themes: sorted,
      bestThemeRank: best.heatRank,
      namedStrategies: named,
      sanseState: rec.report.mainStage,
      comboGrade: rec.report.combo?.grade ?? 'weak',
      verdict: v.tone,
      verdictReason: v.reason,
      verdictReversal: v.reversal,
      reason: buildReason(best.themeName, best.heatRank, rec.report),
      riskNote: buildRiskNote(rec.report, coverage),
      themeSanseCoverage: coverage,
    });
  }

  // 排序：底反優先 → 題材最熱 → combo grade 高 → 紫(短攻)高
  const recByCode = new Map(sanseRecords.map((r) => [bareCode(r.symbol), r]));
  cross.sort((a, b) => {
    if (a.verdictReversal !== b.verdictReversal) return a.verdictReversal ? -1 : 1;
    if (a.bestThemeRank !== b.bestThemeRank) return a.bestThemeRank - b.bestThemeRank;
    const ra = recByCode.get(a.code)?.report.combo?.rank ?? 0;
    const rb = recByCode.get(b.code)?.report.combo?.rank ?? 0;
    if (ra !== rb) return rb - ra;
    const sa = recByCode.get(a.code)?.report.scores.shortAttack ?? 0;
    const sb = recByCode.get(b.code)?.report.scores.shortAttack ?? 0;
    return sb - sa;
  });

  // ── theme-only 對照：熱門題材成分（不要求三色）──
  const themeBest = new Map<string, ThemeCandidate>();
  for (const t of hotThemes) {
    if (t.heatRank > thresholds.topThemes) continue;
    const top = [...t.members]
      .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))
      .slice(0, thresholds.themeOnlyTopPerTheme);
    for (const m of top) {
      const cand: ThemeCandidate = {
        code: m.code,
        symbol: m.symbol || fullSymbolFromCode(market, m.code),
        name: m.name,
        theme: t.name,
        themeHeatRank: t.heatRank,
        score: m.score,
        reason: `熱門題材【${t.name}】熱度#${t.heatRank} 成分股`,
      };
      const prev = themeBest.get(m.code);
      // 同股屬多熱題材 → 留最熱（heatRank 小）的那筆
      if (!prev || cand.themeHeatRank < prev.themeHeatRank) themeBest.set(m.code, cand);
    }
  }
  const theme = [...themeBest.values()].sort(
    (a, b) => a.themeHeatRank - b.themeHeatRank || (b.score ?? -Infinity) - (a.score ?? -Infinity),
  );

  return { cross, theme, sanse };
}
