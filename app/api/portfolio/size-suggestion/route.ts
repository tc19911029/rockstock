/**
 * /api/portfolio/size-suggestion — 部位大小建議（Phase 2.1）
 *
 * POST body:
 *   {
 *     "candidate": {
 *       "symbol": "2330.TW",
 *       "name": "台積電",
 *       "entryPrice": 1100,
 *       "letter": "N",
 *       "matchedMethods": ["N", "Q"],
 *       "industry": "半導體 - 晶圓代工",
 *       "track": "reversal",
 *       "stopLoss": 1020
 *     },
 *     "totalCapital": 76007400,
 *     "modeOverride": "letterAware",  // 可選，不傳走 config.mode
 *     "currentPortfolioMddPct": 0.05  // 可選，給 mdd guard 用
 *   }
 *
 * 行為：
 *   - 讀 sizing-config.json
 *   - 讀 holdings.json open（TW-only）+ 計算 currentValue from latest K-line close
 *   - dispatch mode + applyRiskGuards
 *   - 回 lot-aligned shares + 含費總成本 + warnings
 */

import { NextRequest } from 'next/server';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import {
  suggestPositionSize, loadSizingConfig, INDEX_NEAR_ATH_RATIO, regimeExposureCap,
  type SizingMode, type ExistingHolding,
} from '@/lib/portfolio/positionSizer';
import { detectMarketRegime } from '@/lib/agents/marketRegime';
import type { Candle } from '@/types';
import { listOpenHoldings } from '@/lib/agents/portfolio/storage';
import { trackOf } from '@/lib/scanner/buyMethodTracks';
import type { MarketId } from '@/lib/scanner/types';
import { classifyMarket } from '@/lib/market/classify';
import { loadLatestClose } from '@/lib/portfolio/latestClose';

export const runtime = 'nodejs';

const bodySchema = z.object({
  candidate: z.object({
    symbol: z.string().regex(/^[A-Za-z0-9._-]+$/),
    name: z.string().min(1),
    entryPrice: z.coerce.number().positive(),
    letter: z.string().optional(),
    matchedMethods: z.array(z.string()).optional(),
    industry: z.string().optional(),
    track: z.string().optional(),
    stopLoss: z.coerce.number().positive().optional(),
    market: z.enum(['TW', 'CN']).optional(),
  }),
  totalCapital: z.coerce.number().positive(),
  modeOverride: z.enum(['fixedFraction', 'kelly', 'letterAware', 'riskParity']).optional(),
  currentPortfolioMddPct: z.coerce.number().min(0).optional(),
});

/**
 * 書本 CH5-06 + 直播 2026-07-01 QA#15（2026-07-04 體檢補）：
 * 從 ^TWII 歷史 K 算「總投入成數上限」— 大多頭 8 成 / 高檔或盤整 5 成 / 空頭做多 3 成。
 * 近歷史高檔（收盤 ≥ 歷史最高收盤 × 0.95）即使強多頭也壓五成。
 * 讀不到指數資料回 null（不啟用 cap，fail-open）。
 */
async function computeTotalInvestCap(totalCapital?: number): Promise<number | null> {
  try {
    const p = path.join(process.cwd(), 'data', 'candles', 'TW', '^TWII.json');
    const raw = await fs.readFile(p, 'utf-8');
    const data = JSON.parse(raw) as { candles?: Candle[] };
    const cs = (data.candles ?? []).filter(c => c.close > 0);
    if (cs.length < 60) return null;
    const ath = Math.max(...cs.map(c => c.close));
    const nearAth = cs[cs.length - 1].close >= ath * INDEX_NEAR_ATH_RATIO;
    const regime = detectMarketRegime(cs).regime;
    return regimeExposureCap(regime, nearAth, totalCapital);
  } catch { return null; }
}

/** 從 holdings.json 取既有部位（含 currentValue），TW-only */
async function loadExistingHoldings(): Promise<ExistingHolding[]> {
  const all = await listOpenHoldings();
  const tw = all.filter(h => h.market === 'TW');
  const enriched = await Promise.all(tw.map(async (h) => {
    const close = await loadLatestClose(h.symbol, 'TW');
    return {
      symbol: h.symbol,
      industry: h.industry,
      track: undefined,  // holdings.json schema 沒存 track；未來增強
      currentValue: close ? h.shares * close : 0,
    };
  }));
  return enriched;
}

/** 從 backtest_results_per_letter.json 取 letter stats（給 kelly 用）*/
async function loadLetterStats(): Promise<Record<string, { winRate: number; maxGainMedian: number; maxLossMedian: number; samples: number }>> {
  const p = path.join(process.cwd(), 'data', 'backtest_results_per_letter.json');
  try {
    const raw = await fs.readFile(p, 'utf-8');
    const data = JSON.parse(raw) as { letterStats?: Array<{ letter: string; winRate: number; maxGainMedian: number; maxLossMedian: number; samples: number }> };
    const out: Record<string, { winRate: number; maxGainMedian: number; maxLossMedian: number; samples: number }> = {};
    for (const s of data.letterStats ?? []) {
      out[s.letter] = {
        winRate: s.winRate,
        maxGainMedian: s.maxGainMedian,
        maxLossMedian: s.maxLossMedian,
        samples: s.samples,
      };
    }
    return out;
  } catch { return {}; }
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch { return apiError('invalid JSON body', 400); }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return apiValidationError(parsed.error);

  const { candidate, totalCapital, modeOverride, currentPortfolioMddPct } = parsed.data;
  // DF1 修正：原 endsWith('.TW') 會把上櫃 .TWO 與裸碼（如打 2330 不加後綴）誤判成 CN
  // → 張數/手續費套錯市場。改用 classifyMarket（處理 .TWO / .SS / 裸碼位數）。
  const market: MarketId = candidate.market ?? (classifyMarket(candidate.symbol) === 'CN' ? 'CN' : 'TW');

  // track 推導
  const track = candidate.track ?? (candidate.letter ? trackOf(candidate.letter) : undefined);

  const [config, existingHoldings, letterStatsByLetter, totalInvestCapPct] = await Promise.all([
    loadSizingConfig(),
    loadExistingHoldings(),
    loadLetterStats(),
    // 書本 CH5-06 + 直播 QA#15：大盤 regime → 總投入成數（sizer 業務 TW-only，指數看 ^TWII；CN 候選不啟用）
    market === 'TW' ? computeTotalInvestCap(totalCapital) : Promise.resolve(null),
  ]);

  const effectiveConfig = modeOverride ? { ...config, mode: modeOverride } : config;

  const result = suggestPositionSize({
    totalCapital,
    candidatePrice: candidate.entryPrice,
    market,
    letter: candidate.letter,
    matchedMethods: candidate.matchedMethods,
    industry: candidate.industry,
    track,
    candidateStopLoss: candidate.stopLoss,
    existingHoldings,
    letterStatsByLetter,
    currentPortfolioMddPct,
    totalInvestCapPct: totalInvestCapPct ?? undefined,
  }, effectiveConfig);

  return apiOk({
    candidate,
    mode: effectiveConfig.mode,
    totalCapital,
    existingHoldingsCount: existingHoldings.length,
    sizing: result,
  });
}

export async function GET() {
  const config = await loadSizingConfig();
  return apiOk({ config });
}
