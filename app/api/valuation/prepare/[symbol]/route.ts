/**
 * POST /api/valuation/prepare/{symbol}?date=YYYY-MM-DD
 *
 * 為單檔股票準備估值推估的 question payload：
 *   - 抓 TTM EPS / quarterly history / monthly revenue / shares / 產業模板 / 現價
 *   - 寫 /tmp/rockstock-valuation/{symbol}-{date}-question.json
 *   - 使用者在 Claude Code 對話內輸入 `/valuation {symbol}` → skill 讀檔上網查 → 寫 data/valuation/{date}/{symbol}.json
 *
 * 走 buildValuationInputsTW（fundamentalAgent 內既有）— 不重做資料抓取。
 */

import { NextRequest } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { buildValuationInputsTW } from '@/lib/agents/agents/fundamentalAgent';
import { triggerSkillKeystroke } from '@/lib/ai/skillAutoTrigger';

export const runtime = 'nodejs';
export const maxDuration = 60;

const querySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const TMP_DIR = '/tmp/rockstock-valuation';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ symbol: string }> },
) {
  const { symbol: rawSymbol } = await params;
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);

  const date = parsed.data.date ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const bareSymbol = rawSymbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  const isTw = !/\.(SS|SZ)$/i.test(rawSymbol) && /^\d{4,5}$/.test(bareSymbol);

  if (!isTw) {
    return apiError('目前估值推估僅支援台股（TW/TWO）');
  }

  try {
    const fetchErrors: string[] = [];
    const valuationInputs = await buildValuationInputsTW(bareSymbol, undefined, fetchErrors);

    if (!valuationInputs) {
      return apiError('buildValuationInputsTW 回傳 undefined');
    }
    if (!valuationInputs.currentPrice || !valuationInputs.ttmEps) {
      return apiError(`資料不足（currentPrice=${valuationInputs.currentPrice}, ttmEps=${valuationInputs.ttmEps}）— FinMind 可能尚未開放或股票代號錯誤`);
    }

    const outputPath = `data/valuation/${date}/${bareSymbol}.json`;

    const question = {
      schemaVersion: 1,
      task: 'per-stock-valuation',
      date,
      symbol: bareSymbol,
      market: 'TW',
      outputPath,
      generatedAt: new Date().toISOString(),
      fetchErrors,
      groundTruth: {
        valuationInputs,
      },
      instructions: [
        '上網查最新法說會展望、法人預估（cnyes、商週、玩股網、moneydj）、近期月營收動能。',
        '推估三情境：悲觀 / 中性 / 樂觀 的 Q2-Q4 營收 + 淨利率 + EPS。',
        '計算月化 EPS：最新月營收 × Q1 淨利率 / 流通股數。',
        '每個 scenario 必須附 revenueBasis / netMarginBasis / assumptionEvidence（含 sourceUrl + rawQuote）。',
        '輸出格式對齊 lib/agents/types.ts 的 FundamentalAnswer.valuation 區塊（ttmPe + monthlyEpsEstimate + scenarios{pessimistic,base,optimistic}）。',
      ],
    };

    await fs.mkdir(TMP_DIR, { recursive: true });
    const questionPath = path.join(TMP_DIR, `${bareSymbol}-${date}-question.json`);
    await fs.writeFile(questionPath, JSON.stringify(question, null, 2), 'utf-8');

    // 自動觸發 skill — 透過 macOS automation 切到 Terminal/iTerm 內任一 claude session 注入 /valuation {symbol}
    const trigger = await triggerSkillKeystroke(`/valuation ${bareSymbol}`);
    console.log(`[valuation/prepare] auto-trigger /valuation ${bareSymbol}: ${trigger.ok ? 'OK' : 'fail — ' + trigger.detail}`);

    return apiOk({
      questionPath,
      outputPath,
      skillInvocation: `/valuation ${bareSymbol}`,
      ttmEps: valuationInputs.ttmEps,
      ttmPe: valuationInputs.ttmPe,
      currentPrice: valuationInputs.currentPrice,
      autoTrigger: trigger,
      message: trigger.ok
        ? `✓ 已自動觸發 /valuation ${bareSymbol}，請看 Claude session 內進度。`
        : `Question 已寫 ${questionPath}。自動觸發失敗（${trigger.detail}）— 請手動在 Claude 對話內輸入 /valuation ${bareSymbol}`,
    });
  } catch (e) {
    return apiError((e as Error).message);
  }
}
