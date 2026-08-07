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
import { detectValuationMarket } from '@/lib/valuation/market';

export const runtime = 'nodejs';
export const maxDuration = 60;

const querySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dryRun: z.enum(['0', '1']).default('0'),
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
  const market = detectValuationMarket(rawSymbol);

  if (!market) {
    return apiError('目前估值推估支援台股 4–5 碼與陸股 6 碼代號', 400);
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
      schemaVersion: 3,
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
      outputContract: {
        required: ['ttmPe', 'fiscalYear', 'reportedThrough', 'actualEpsYtd', 'peerComparison', 'scenarios'],
        peerComparison: {
          minimumIncludedPeers: 3,
          requiredPeerFields: ['symbol', 'name', 'market', 'ttmPe', 'currentYearPe', 'excluded', 'asOf', 'sourceUrl'],
          requiredSummaryFields: ['selectionBasis', 'medianTtmPe', 'medianCurrentYearPe', 'lowerQuartilePe', 'upperQuartilePe', 'appliedPeRationale'],
        },
        ntmEstimate: '只有取得真正未來四季 EPS 預估時才輸出；不得以本年度 EPS 代替。',
        compatibility: '保留既有 monthlyEpsEstimate、dilution、riskFlags、conclusion、reasoning 與三情境欄位。',
      },
      instructions: [
        '所有數字先核對資料日期；公司公告、交易所與法說會為第一優先，法人預估只能作為輔助，不得把新聞轉述當成公司正式財測。',
        '依商業模式、獲利驅動因子與景氣循環位置挑選真正可比同業；列出同業 TTM PE／本年預估 PE，排除虧損、一次性收益與極端值後，以中位數及四分位距校準合理 PE。',
        '檢查最新股本、流通股數、增資、GDR、私募與可轉債等潛在稀釋；EPS 與合理價一律使用最新完全稀釋股數重算。',
        market === 'TW'
          ? '台股納入逐月營收與自結 EPS；月營收沒有正式 EPS 時，才以最近一個已公告季度的正常化淨利率估算，並清楚標示為模型值。'
          : '陸股以正式季報為主，補充業績快報與業績預告；quarterlyHistory 已轉成單季口徑，沒有月營收時不得虛構月度 EPS。',
        '先辨識 valuationInputs.quarterlyHistory 中本年度已公告到哪一季；已公告季度必須照實列入 actualEpsYtd，不得再估一次，只推估尚未公告季度。',
        '推估悲觀／中性／樂觀三情境的後續季度營收、淨利率、EPS，以及情境成立所需的月營收或營收成長門檻；scenarios 的已公告季度欄位填實際值。',
        '區分 TTM PE、以本年度 EPS 計算的預估 PE，以及真正未來 12 個月 NTM PE；資料不足時不得混用或假裝精確。',
        '每個 scenario 必須附 revenueBasis / netMarginBasis / assumptionEvidence（含 sourceUrl + rawQuote），並提供後續可驗證的 validationTriggers。',
        '輸出 peerComparison：至少 3 家未排除的真正可比同業（不足時如實說明），逐家列 TTM PE／本年度預估 PE／來源日期／URL／排除原因，並計算中位數與四分位。',
        '若能取得未來四季預估，輸出 ntmEstimate{period,eps,pe,method}；否則省略此欄位，不得以本年度 EPS 冒充 NTM。',
        '輸出格式對齊 lib/agents/types.ts 的 FundamentalAnswer.valuation 區塊，並包含 fiscalYear、reportedThrough、actualEpsYtd、peerComparison；所有舊欄位保持相容。',
      ],
    };

    if (parsed.data.dryRun === '1') {
      return apiOk({
        dryRun: true,
        market,
        outputPath,
        ttmEps: valuationInputs.ttmEps,
        ttmPe: valuationInputs.ttmPe,
        currentPrice: valuationInputs.currentPrice,
        quarterlyRows: valuationInputs.quarterlyHistory.length,
        monthlyRows: valuationInputs.monthlyRevenueHistory.length,
        fetchErrors,
      });
    }

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
