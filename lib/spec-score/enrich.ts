/**
 * specScore 池子 enrichment（server-side；2026-06-12 A3）
 *
 * 在 pool build（盤後）時跑一次，把 specScore 附掛到每個 candidate（持久化進 pool JSON）。
 * 共用資料（大盤 regime / 板塊排名 / 估值檔清單）只讀一次。
 *
 * 紅線：只「附掛」不影響 merger 排序與 computeFacetScores（合約測試守）。
 */
import fs from 'fs/promises';
import path from 'path';
import type { Candidate, CandidatesPool } from '@/lib/agents/candidates/types';
import { computeFacetScores } from '@/lib/agents/candidates/poolWeights';
import { detectMarketRegime, regimeLabel, type MarketRegime } from '@/lib/agents/marketRegime';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { readLatestSectorRanking, type ThemeStage } from '@/lib/themes/sectorRanking';
import { classifyStockType } from './stockType';
import { computeSpecScore, type SpecScoreInputs } from './compute';

// ── 維度分數對照（顯示用 heuristic，非書本規則；升級成排序權重須先回測）─────────

const REGIME_SCORE: Record<MarketRegime, number> = {
  strong_bull: 80,
  normal: 55,
  bear: 25,
};

const STAGE_SCORE: Record<ThemeStage, number> = {
  '剛啟動': 75,
  '主升段': 80,
  '高潮噴出': 45, // 過熱：規格書「高潮噴出要小心追高」
  '震盪換手': 55,
  '盤整': 50,
  '退潮': 30,
  '補跌': 20,
};

function valuationScore(upsidePct: number): number {
  if (upsidePct >= 30) return 85;
  if (upsidePct >= 15) return 70;
  if (upsidePct >= 0) return 55;
  if (upsidePct >= -15) return 40;
  return 25;
}

// ── 估值檔查找（data/valuation/{date}/{code}.json，14 天內最新）──────────────────

const VALUATION_ROOT = path.join(process.cwd(), 'data', 'valuation');

async function loadValuationUpside(code: string, asOf: string): Promise<{ upside: number; date: string } | null> {
  let dirs: string[] = [];
  try {
    dirs = (await fs.readdir(VALUATION_ROOT)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  } catch {
    return null;
  }
  const floor = new Date(`${asOf}T00:00:00Z`);
  floor.setUTCDate(floor.getUTCDate() - 14);
  const floorIso = floor.toISOString().slice(0, 10);
  for (const d of dirs) {
    if (d > asOf || d < floorIso) continue;
    try {
      const raw = await fs.readFile(path.join(VALUATION_ROOT, d, `${code}.json`), 'utf-8');
      const json = JSON.parse(raw) as { scenarios?: Record<string, { upside?: number | string }> };
      // 中性情境 upside（valuation skill schema：scenarios.{pessimistic|base|optimistic}）
      const base = json.scenarios?.base ?? json.scenarios?.['中性'];
      const upside = base?.upside != null ? Number(base.upside) : NaN;
      if (Number.isFinite(upside)) return { upside, date: d };
    } catch { /* 該日無此檔，往前找 */ }
  }
  return null;
}

// ── 主 enrichment ────────────────────────────────────────────────────────────

export async function enrichSpecScores(pool: CandidatesPool): Promise<void> {
  if (pool.market !== 'TW' || pool.candidates.length === 0) return;

  // 共用資料一次讀
  const [indexFile, sectorFile] = await Promise.all([
    readCandleFile('^TWII', 'TW').catch(() => null),
    readLatestSectorRanking().catch(() => null),
  ]);
  const regime = detectMarketRegime(indexFile?.candles);

  // 題材 → {stage, 5 日排名 percentile 分數}
  const themeInfo = new Map<string, { stage: ThemeStage; sectorScore: number }>();
  if (sectorFile) {
    const n = sectorFile.themes.length;
    sectorFile.themes.forEach((t, i) => {
      // 排名第 1 → 100、最後 → 0（線性 percentile）
      const sectorScore = n > 1 ? Math.round(((n - 1 - i) / (n - 1)) * 100) : 50;
      themeInfo.set(t.theme, { stage: t.stage, sectorScore });
    });
  }

  for (const c of pool.candidates) {
    try {
      c.specScore = await buildOne(c, regime.regime, themeInfo, pool.date);
    } catch { /* enrichment 失敗不可擋 pool 落地 */ }
  }
}

async function buildOne(
  c: Candidate,
  regime: MarketRegime,
  themeInfo: Map<string, { stage: ThemeStage; sectorScore: number }>,
  date: string,
): Promise<Candidate['specScore']> {
  const code = c.symbol.split('.')[0];
  const stockType = classifyStockType(code);
  const facets = computeFacetScores(c);

  // 產業強弱：只對齊 candidate 上的 TWSE／TPEx 官方產業別（一檔一類）。
  let themeInput: SpecScoreInputs['theme'];
  let sectorInput: SpecScoreInputs['sector'];
  const themes = c.industry && themeInfo.has(c.industry) ? [c.industry] : [];
  let bestStage: { score: number; note: string } | null = null;
  let bestSector: { score: number; note: string } | null = null;
  for (const t of themes) {
    const info = themeInfo.get(t);
    if (!info) continue;
    const stageScore = STAGE_SCORE[info.stage];
    if (!bestStage || stageScore > bestStage.score) bestStage = { score: stageScore, note: `${t}·${info.stage}` };
    if (!bestSector || info.sectorScore > bestSector.score) bestSector = { score: info.sectorScore, note: `${t} 板塊強度` };
  }
  if (bestStage) themeInput = { score: bestStage.score, note: bestStage.note };
  if (bestSector) sectorInput = { score: bestSector.score, note: bestSector.note };

  const valuation = await loadValuationUpside(code, date);

  const inputs: SpecScoreInputs = {
    market: { score: REGIME_SCORE[regime], note: regimeLabel(regime) },
    ...(themeInput ? { theme: themeInput } : {}),
    ...(sectorInput ? { sector: sectorInput } : {}),
    // overseas / priceTrend：TODO B4 global-peers 資料落地後接上（v1 缺 = 不入分）
    technical: { score: c.sources.technical ? facets.technical : null },
    chip: { score: c.sources.chip ? facets.chip : null },
    fundamental: { score: c.sources.fundamental ? facets.fundamental : null },
    news: { score: c.sources.youtube ? facets.news : null },
    ...(valuation ? { valuation: { score: valuationScore(valuation.upside), note: `中性上漲空間 ${valuation.upside > 0 ? '+' : ''}${valuation.upside}%（${valuation.date}）` } } : {}),
  };

  return computeSpecScore(stockType, inputs);
}
