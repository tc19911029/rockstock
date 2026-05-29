/**
 * GET /api/agents/portfolio/holding-summary?date=&symbols=2330,3661,...
 *
 * 批量回傳每檔持股的 agent 分析摘要（給 /portfolio 持股 row inline 顯示）。
 * 對每個 symbol 嘗試讀：
 *   - data/agents/runs/{date}/{symbol}/decision.json 的 verdict (buy/sell/hold/avoid)
 *   - data/agents/runs/{date}/{symbol}/fundamental.json 的 valuation.conclusion (undervalued/fair/overvalued)
 *
 * 找不到就回 null（表示該檔尚未分析）。
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiValidationError } from '@/lib/api/response';
import { agentsGet } from '@/lib/agents/persistStorage';
import type { FinalDecision, FundamentalAnswer } from '@/lib/agents/types';

export const runtime = 'nodejs';

const querySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  symbols: z.string().min(1),
});

export interface HoldingSummary {
  symbol: string;
  decisionVerdict: string | null;       // buy / hold / reduce / avoid / sell (or whatever decision schema gives)
  valuationConclusion: 'undervalued' | 'fair' | 'overvalued' | null;
  fundamentalVerdict: 'pass' | 'watch' | 'fail' | null;
  hasAnalysis: boolean;
}

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { date, symbols } = parsed.data;

  const symbolList = symbols.split(',').map((s) => s.trim()).filter(Boolean);

  const results = await Promise.all(
    symbolList.map(async (symbol): Promise<HoldingSummary> => {
      // 嘗試三種 symbol 格式：原樣、去掉 .TW/.TWO、去掉 .SS/.SZ
      // 因為 holdings 通常帶 .TW/.SS 後綴，但 agent runs 目錄是裸代號
      const bare = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
      const candidates = symbol === bare ? [symbol] : [symbol, bare];

      const tryRead = async <T,>(filename: string): Promise<T | null> => {
        for (const s of candidates) {
          const r = await agentsGet<T>(`agents/runs/${date}/${s}/${filename}`);
          if (r) return r;
        }
        return null;
      };

      const [decision, fundamental] = await Promise.all([
        tryRead<FinalDecision>('decision.json'),
        tryRead<FundamentalAnswer>('fundamental.json'),
      ]);

      const decisionVerdict = decision
        ? (decision as unknown as { verdict?: string; action?: string }).verdict
          ?? (decision as unknown as { action?: string }).action
          ?? null
        : null;

      return {
        symbol,
        decisionVerdict,
        valuationConclusion: fundamental?.valuation?.conclusion ?? null,
        fundamentalVerdict: fundamental?.verdict ?? null,
        hasAnalysis: Boolean(decision || fundamental),
      };
    }),
  );

  return apiOk({ summaries: results });
}
