/**
 * Chip Source — 籌碼面候選
 *
 * 對 L4 daily session 的每檔 candidate 並行打 /api/chip 拉籌碼資料，
 * 篩選 chipScore 高 / 法人買超大 的進入 pool。
 *
 * §0 隔離：只回報籌碼指標，不評論技術面或基本面。
 *
 * 篩選條件（任一觸發即進 pool）：
 *   - chipScore ≥ 50
 *   - foreignBuy ≥ 1,000,000 元（外資買超）
 *   - trustBuy ≥ 500,000 元（投信買超）
 *   - 三大法人合計買超 ≥ 3,000,000 元
 *
 * FIX-4（2026-05-22）：
 *   - 原本只讀 candidateRow.chipScore 但 L4 完全沒填 → 改為打 /api/chip API
 *   - 放寬閾值（原值過嚴，5/22 命中 0 檔）
 */

import { loadScanSession } from '@/lib/storage/scanStorage';
import { fetchJSON, internalUrl } from '@/lib/agents/agents/_fetchHelper';
import type {
  CandidateSources,
  ChipSourceAttribution,
  SourceCandidate,
  SourceExtractor,
  SourceResult,
} from '../types';

const CHIP_SCORE_MIN     = 50;
const FOREIGN_BUY_MIN    = 1_000_000;
const TRUST_BUY_MIN      = 500_000;
const TOTAL_INST_BUY_MIN = 3_000_000;
/** 對應 tier 大戶持股佔比門檻（≥ 此值代表「籌碼集中」訊號）*/
const HOLDER_TIER_CONCENTRATED_MIN = 40;

interface ChipApiResponse {
  chipScore?: number | null;
  foreignBuy?: number | null;
  trustBuy?: number | null;
  dealerBuy?: number | null;
  // 集保大戶各 tier（用於股價分層判斷）
  holder100Pct?: number | null;
  holder200Pct?: number | null;
  holder400Pct?: number | null;
  largeHolderPct?: number | null;        // 1000 張↑
  largeHolderChange?: number | null;     // 1000 張↑ 週變化
  structureBuilding?: boolean | null;    // 400/600/800/1000 四級全到位
}

async function fetchChip(symbol: string): Promise<ChipApiResponse | null> {
  const raw = await fetchJSON(internalUrl(`/api/chip?symbol=${encodeURIComponent(symbol)}`));
  if (!raw || typeof raw !== 'object') return null;
  return raw as ChipApiResponse;
}

/**
 * 依股價選大戶 tier（業界 + 朱書實務）：
 *   - 千金股（≥ 1000）→ 100 張↑
 *   - 高價股（200-1000）→ 200 張↑
 *   - 中價股（50-200）→ 400 張↑（業界主流）
 *   - 平價股（< 50）→ 1000 張↑
 */
function pickHolderTier(price: number): {
  key: 'holder100Pct' | 'holder200Pct' | 'holder400Pct' | 'largeHolderPct';
  label: string;
} {
  if (price >= 1000) return { key: 'holder100Pct', label: '100 張↑' };
  if (price >= 200)  return { key: 'holder200Pct', label: '200 張↑' };
  if (price >= 50)   return { key: 'holder400Pct', label: '400 張↑' };
  return { key: 'largeHolderPct', label: '1000 張↑' };
}

export const chipSource: SourceExtractor = {
  source: 'chip',
  async extract({ market, date, strategyId }): Promise<SourceResult> {
    try {
      const session = await loadScanSession(market, date, 'long', 'daily', strategyId);
      if (!session || !session.results) {
        return { source: 'chip', ran: true, candidates: [] };
      }

      // 並行打 /api/chip 對每檔 L4 candidate（限 200 檔避免 5/22 大量 candidate 拖慢）
      const targets = session.results.slice(0, 200);
      const settled = await Promise.all(
        targets.map(async (r) => ({ row: r, chip: await fetchChip(r.symbol) })),
      );

      const candidates: SourceCandidate[] = [];
      for (const { row, chip } of settled) {
        if (!chip) continue;
        const signals: string[] = [];
        const reasons: string[] = [];

        if ((chip.chipScore ?? 0) >= CHIP_SCORE_MIN) {
          signals.push('chip_score_high');
          reasons.push(`chipScore=${chip.chipScore} (≥ ${CHIP_SCORE_MIN})`);
        }
        if ((chip.foreignBuy ?? 0) >= FOREIGN_BUY_MIN) {
          signals.push('foreign_strong_buy');
          reasons.push(`外資買超 ${formatMoney(chip.foreignBuy!)} 元`);
        }
        if ((chip.trustBuy ?? 0) >= TRUST_BUY_MIN) {
          signals.push('trust_buy');
          reasons.push(`投信買超 ${formatMoney(chip.trustBuy!)} 元`);
        }
        const totalInst = (chip.foreignBuy ?? 0) + (chip.trustBuy ?? 0) + (chip.dealerBuy ?? 0);
        if (totalInst >= TOTAL_INST_BUY_MIN) {
          signals.push('total_inst_strong');
          reasons.push(`三大法人合計買超 ${formatMoney(totalInst)} 元`);
        }

        // ── 集保大戶結構（新版：股價分層 + 主力卡位）───────────────────────
        // 1. 主力卡位（400/600/800/1000 四級全到位）= 最強籌碼結構訊號
        if (chip.structureBuilding) {
          signals.push('chip_structure_building');
          reasons.push('主力卡位（400/600/800/1000 四級全到位）');
        }
        // 2. 對應 tier 大戶持股集中（千金股看 100 張、平價看 1000 張）
        const tier = pickHolderTier(row.price ?? 0);
        const tierPct = chip[tier.key] ?? 0;
        if (tierPct >= HOLDER_TIER_CONCENTRATED_MIN) {
          signals.push('chip_tier_concentrated');
          reasons.push(`${tier.label}大戶持股 ${tierPct.toFixed(1)}%（股價 ${row.price ?? 0} 元）`);
        }

        if (signals.length === 0) continue;

        const attribution: ChipSourceAttribution = {
          chipScore: chip.chipScore ?? null,
          signals,
          reasons,
        };

        candidates.push({
          symbol: row.symbol,
          name: row.name,
          market: row.market,
          industry: row.industry,
          attribution: attribution as CandidateSources['chip'],
        });
      }

      return { source: 'chip', ran: true, candidates };
    } catch (err) {
      return {
        source: 'chip',
        ran: false,
        error: err instanceof Error ? err.message : String(err),
        candidates: [],
      };
    }
  },
};

function formatMoney(v: number): string {
  if (Math.abs(v) >= 100_000_000) return `${(v / 100_000_000).toFixed(2)}億`;
  if (Math.abs(v) >= 10_000) return `${(v / 10_000).toFixed(0)}萬`;
  return v.toString();
}
