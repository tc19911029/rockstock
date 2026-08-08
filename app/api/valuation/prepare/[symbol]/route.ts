/**
 * POST /api/valuation/prepare/{symbol}?date=YYYY-MM-DD
 *
 * 為單檔股票準備估值推估的 question payload：
 *   - 抓 TTM EPS / quarterly history / monthly revenue / shares / 產業模板 / 現價
 *   - 寫 /tmp/rockstock-valuation/{symbol}-{date}-question.json
 *   - 由 Rockstar 內建 Codex 背景工作執行 valuation skill → 寫 data/valuation/{date}/{symbol}.json
 *
 * 依市場走 buildValuationInputsTW / buildValuationInputsCN（fundamentalAgent 內既有）。
 */

import { NextRequest } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { checkSameOriginOrCron } from '@/lib/api/sameOriginAuth';
import { buildValuationInputsCN, buildValuationInputsTW } from '@/lib/agents/agents/fundamentalAgent';
import { getValuationAnalysisStatus, startValuationAnalysis } from '@/lib/valuation/autoRunner';
import { detectValuationMarket } from '@/lib/valuation/market';

export const runtime = 'nodejs';
export const maxDuration = 60;

const querySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dryRun: z.enum(['0', '1']).default('0'),
  force: z.enum(['0', '1']).default('0'),
});

const TMP_DIR = '/tmp/rockstock-valuation';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ symbol: string }> },
) {
  const { symbol: rawSymbol } = await params;
  const bareSymbol = rawSymbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  const date = new URL(req.url).searchParams.get('date')
    ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  if (!/^\d{4,6}$/.test(bareSymbol) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return apiError('股票代號或日期格式不合法', 400);
  }
  return apiOk({ job: await getValuationAnalysisStatus({ symbol: bareSymbol, date }) });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ symbol: string }> },
) {
  const authError = checkSameOriginOrCron(req);
  if (authError) return authError;

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
      schemaVersion: 4,
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
        required: ['generatedAt', 'currentPriceContext', 'ttmPe', 'fiscalYear', 'reportedThrough', 'actualEpsYtd', 'dataAsOf', 'peerComparison', 'scenarios'],
        peerComparison: {
          minimumIncludedPeers: 3,
          requiredPeerFields: ['symbol', 'name', 'market', 'ttmPe', 'currentYearPe', 'excluded', 'asOf', 'sourceUrl'],
          requiredSummaryFields: ['selectionBasis', 'medianTtmPe', 'medianCurrentYearPe', 'lowerQuartilePe', 'upperQuartilePe', 'appliedPeRationale'],
        },
        ntmEstimate: '只有取得真正未來四季 EPS 預估時才輸出；不得以本年度 EPS 代替。',
        valuationMethod: '至少一個產業適配的主估值法與一個獨立交叉驗證；不得所有產業一律只套歷史 PE。',
        compatibility: '保留既有 monthlyEpsEstimate、dilution、riskFlags、conclusion、reasoning 與三情境欄位。',
        scenarioArithmetic: '每個情境必填 valuationEps 與 valuationEpsBasis；forwardPe=currentPrice/valuationEps，fairPrice=valuationEps*fairPe。fullYearEps 可保留報表口徑，但不得再拿不同 EPS 口徑混算。',
      },
      instructions: [
        '所有數字先核對資料日期；公司公告、交易所與法說會為第一優先，法人預估只能作為輔助，不得把新聞轉述當成公司正式財測。',
        '依商業模式、獲利驅動因子與景氣循環位置挑選真正可比同業；列出同業 TTM PE／本年預估 PE，排除虧損、一次性收益與極端值後，以中位數及四分位距校準合理 PE。',
        '估值採產業適配的雙模型：高成長股以正常化 Forward PE 為主、PEG／反向 DCF 為交叉驗證；景氣循環股以中周期正常化 EPS×PE 為主、PB-ROE／EV-EBITDA 為交叉驗證；成熟穩定股用 PE 搭配 DCF／股利模型；虧損股不得用 PE，改用 EV/Sales 或 EV/EBITDA。輸出 valuationMethod 說明模型與理由。',
        '合理 PE 不能直接照抄同業中位數：需明確調整未來營收／EPS 成長、ROE／利潤率、財務槓桿、客戶集中、流動性、治理與景氣位置。若同業 forward PE 不足三家，信心最高只能 low，且必須列為限制。',
        '將非經常損益、資產處分、公允價值變動、補貼與匯兌等拆出，reported EPS、normalized EPS、最新股數備考 EPS、完全稀釋 EPS 四種口徑不得混用。報表 EPS 仍遵循各期加權平均股數，最新股數重算值只能標為備考。',
        '檢查最新股本、流通股數、增資、GDR、私募與可轉債等潛在稀釋；EPS 與合理價一律使用最新完全稀釋股數重算。',
        market === 'TW'
          ? '台股納入逐月營收與自結／正式 EPS；valuationInputs.selfReportedMonthlyActuals 是公司依注意股規定公告的單月合併自結實績，優先級高於模型。若 latestCumulativeActual 存在，actualEpsYtd 必須直接採交易所累計 EPS，不得把單季 EPS 相加取代。只有 selfReportedMonthlyActuals 沒有該月 EPS 時，才可以最近一個已公告季度的正常化淨利率估算，並清楚標示為模型值。'
          : '陸股以正式季報為主，valuationInputs.earningsGuidance 補充業績快報與業績預告；預告不得混入正式 TTM，但必須另算預告隱含 EPS／PE。quarterlyHistory 已轉成單季口徑，沒有月營收時不得虛構月度 EPS。',
        '若 selfReportedMonthlyActuals 有值，輸出 monthlyEpsActuals 並逐筆保留 period、EPS、營收、淨利、公告日與 sourceUrl；同月份不得再輸出 monthlyEpsEstimate。已公告累計 EPS 仍只代表正式季報累計，季後單月自結要另列並納入尚未公告季度的情境底線。',
        '先辨識 valuationInputs.quarterlyHistory 中本年度已公告到哪一季；已公告季度必須照實列入 actualEpsYtd，不得再估一次，只推估尚未公告季度。',
        '推估悲觀／中性／樂觀三情境的後續季度營收、淨利率、EPS，以及情境成立所需的月營收或營收成長門檻；scenarios 的已公告季度欄位填實際值。',
        '區分 TTM PE、以本年度 EPS 計算的預估 PE，以及真正未來 12 個月 NTM PE；資料不足時不得混用或假裝精確。',
        'currentPriceContext 必須包含 currentPrice、priceDate、sharesOutstanding、ttmEps；priceDate 採報價資料源真正交易日，休市日不得填今天。',
        '每個情境必填 valuationEps 與 valuationEpsBasis；Forward PE、合理價與距現價必須全部用 valuationEps 計算。若採完全稀釋或正常化 EPS，fullYearEps 仍可另列，但不得混用公式。',
        '每個 scenario 必須附 revenueBasis / netMarginBasis / assumptionEvidence（含 sourceUrl + rawQuote），並提供後續可驗證的 validationTriggers。',
        '三情境請給機率並計算機率加權合理價；機率總和必須為 100%，但中性合理價仍單獨保留。缺乏正式指引時應放寬區間並降低信心，不得用更多小數位假裝精確。',
        '輸出 peerComparison：至少 3 家未排除的真正可比同業（不足時如實說明），逐家列 TTM PE／本年度預估 PE／來源日期／URL／排除原因，並計算中位數與四分位。',
        '若能取得未來四季預估，輸出 ntmEstimate{period,eps,pe,method}；否則省略此欄位，不得以本年度 EPS 冒充 NTM。',
        `輸出 dataAsOf{financialReportPeriod,monthlyRevenuePeriod,selfReportedPeriod,sharesOutstanding,dilutionSignature}；sharesOutstanding=${valuationInputs.sharesOutstanding ?? 'null'}，dilutionSignature=${JSON.stringify((valuationInputs.dilutionEvents ?? []).map(e => [e.type, e.status ?? '', e.newShares, e.expectedDate ?? '', e.announcedAt ?? '', e.sourceUrl ?? ''].join('|')).sort().join('||'))}。精確記錄本次實際納入的季報、月營收、自結、股數與稀釋事件，讓前端在公司行動後立即判定估值失效。`,
        '輸出格式對齊 lib/agents/types.ts 的 FundamentalAnswer.valuation 區塊，並包含 fiscalYear、reportedThrough、actualEpsYtd、dataAsOf、monthlyEpsActuals、peerComparison；所有舊欄位保持相容。',
      ],
    };

    if (parsed.data.dryRun === '1') {
      return apiOk({
        dryRun: true,
        market,
        outputPath,
        ttmEps: valuationInputs.ttmEps,
        ttmPe: valuationInputs.ttmPe,
        proFormaTtmEps: valuationInputs.proFormaTtmEps ?? null,
        proFormaTtmPe: valuationInputs.proFormaTtmPe ?? null,
        currentPrice: valuationInputs.currentPrice,
        currentPriceDate: valuationInputs.currentPriceDate ?? null,
        sharesOutstanding: valuationInputs.sharesOutstanding,
        quarterlyRows: valuationInputs.quarterlyHistory.length,
        monthlyRows: valuationInputs.monthlyRevenueHistory.length,
        latestRevenuePeriod: valuationInputs.monthlyRevenueHistory[0]?.month ?? null,
        latestCumulativeActual: valuationInputs.latestCumulativeActual ?? null,
        latestSelfReportedActual: valuationInputs.selfReportedMonthlyActuals?.[0] ?? null,
        fetchErrors,
      });
    }

    await fs.mkdir(TMP_DIR, { recursive: true });
    const questionPath = path.join(TMP_DIR, `${bareSymbol}-${date}-question.json`);
    await fs.writeFile(questionPath, JSON.stringify(question, null, 2), 'utf-8');

    // 直接由 Rockstar 啟動 headless Codex；不依賴 Terminal/iTerm 視窗或人工輸入指令。
    const analysisJob = await startValuationAnalysis({
      symbol: bareSymbol,
      date,
      questionPath,
      outputPath,
      force: parsed.data.force === '1',
    });
    console.log(`[valuation/prepare] background valuation ${bareSymbol}: ${analysisJob.ok ? analysisJob.status : 'fail'} — ${analysisJob.detail}`);

    return apiOk({
      questionPath,
      outputPath,
      ttmEps: valuationInputs.ttmEps,
      ttmPe: valuationInputs.ttmPe,
      currentPrice: valuationInputs.currentPrice,
      analysisJob,
      // 保留舊欄位一版，避免尚未更新的前端把成功工作誤判成失敗。
      autoTrigger: { ok: analysisJob.ok, detail: analysisJob.detail },
      message: analysisJob.ok
        ? `Rockstar 已在背景執行 ${bareSymbol} 深度估值，不需要開啟 Terminal。`
        : `估值資料已整理，但內建分析引擎啟動失敗：${analysisJob.detail}`,
    });
  } catch (e) {
    return apiError((e as Error).message);
  }
}
