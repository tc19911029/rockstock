/**
 * POST /api/valuation/prepare/{symbol}?date=YYYY-MM-DD
 *
 * 為單檔股票準備估值推估的 question payload：
 *   - 抓 TTM EPS / quarterly history / monthly revenue / shares / 產業模板 / 現價
 *   - 寫 /tmp/rockstock-valuation/{symbol}-{date}-question.json
 *   - 使用者在 Claude Code 對話內輸入 `/valuation {symbol}` → skill 讀檔上網查 → 寫 data/valuation/{date}/{symbol}.json
 *
 * 依市場走 buildValuationInputsTW / buildValuationInputsCN（fundamentalAgent 內既有）。
 */

import { NextRequest } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { buildValuationInputsCN, buildValuationInputsTW } from '@/lib/agents/agents/fundamentalAgent';
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
  const market = /\.(SS|SZ)$/i.test(rawSymbol) || /^\d{6}$/.test(bareSymbol) ? 'CN' : 'TW';
  const isSupported = market === 'TW' ? /^\d{4,5}$/.test(bareSymbol) : /^\d{6}$/.test(bareSymbol);

  if (!isSupported) {
    return apiError('目前估值推估支援台股 4–5 碼與陸股 6 碼代號');
  }

  try {
    const fetchErrors: string[] = [];
    const valuationInputs = market === 'TW'
      ? await buildValuationInputsTW(bareSymbol, undefined, fetchErrors)
      : await buildValuationInputsCN(rawSymbol, undefined, fetchErrors);

    if (!valuationInputs) {
      return apiError(`buildValuationInputs${market} 回傳 undefined`);
    }
    if (!valuationInputs.currentPrice || !valuationInputs.ttmEps) {
      const cp = valuationInputs.currentPrice;
      const reason = market === 'TW'
        ? cp && !valuationInputs.ttmEps
          ? 'FinMind 季財報請求可能被限流或近 4 季財報尚未齊全 — 請稍後重試'
          : 'FinMind 可能尚未開放或股票代號錯誤'
        : cp && !valuationInputs.ttmEps
          ? 'EastMoney 尚未提供可用的 TTM PE／EPS，可能為虧損股或資料尚未更新'
          : 'EastMoney 目前無法取得行情或股票代號錯誤';
      return apiError(`資料不足（currentPrice=${cp}, ttmEps=${valuationInputs.ttmEps}）— ${reason}`);
    }

    const outputPath = `data/valuation/${date}/${bareSymbol}.json`;

    const question = {
      schemaVersion: 2,
      task: 'per-stock-valuation',
      date,
      symbol: bareSymbol,
      market,
      outputPath,
      generatedAt: new Date().toISOString(),
      fetchErrors,
      groundTruth: {
        valuationInputs,
      },
      instructions: [
        '所有數字先核對資料日期；公司公告、交易所與法說會為第一優先，法人預估只能作為輔助，不得把新聞轉述當成公司正式財測。',
        '依商業模式、獲利驅動因子與景氣循環位置挑選真正可比同業；列出同業 TTM PE／本年預估 PE，排除虧損、一次性收益與極端值後，以中位數及四分位距校準合理 PE。',
        '檢查最新股本、流通股數、增資、GDR、私募與可轉債等潛在稀釋；EPS 與合理價一律使用最新完全稀釋股數重算。',
        market === 'TW'
          ? '台股納入逐月營收與自結 EPS；月營收沒有正式 EPS 時，才以最近一季正常化淨利率估算，並清楚標示為模型值。'
          : '陸股以正式季報為主，補充業績快報與業績預告；沒有月營收時不得虛構月度 EPS，改用季度情境與累計口徑推估。',
        '推估悲觀／中性／樂觀三情境的後續季度營收、淨利率、EPS，以及情境成立所需的月營收或營收成長門檻。',
        '區分 TTM PE、以本年度 EPS 計算的預估 PE，以及真正未來 12 個月 NTM PE；資料不足時不得混用或假裝精確。',
        '每個 scenario 必須附 revenueBasis / netMarginBasis / assumptionEvidence（含 sourceUrl + rawQuote），並提供後續可驗證的 validationTriggers。',
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
