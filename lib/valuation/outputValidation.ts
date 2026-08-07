export type ValuationQualitySeverity = 'error' | 'warning';

export interface ValuationQualityIssue {
  severity: ValuationQualitySeverity;
  code: string;
  message: string;
  path?: string;
}

export interface ValuationQualityReport {
  valid: boolean;
  checkedAt: string;
  errors: ValuationQualityIssue[];
  warnings: ValuationQualityIssue[];
}

const SCENARIO_KEYS = ['pessimistic', 'base', 'optimistic'] as const;
const REQUIRED_NUMBERS = [
  'q2Revenue', 'q3Revenue', 'q4Revenue',
  'q2NetMargin', 'q3NetMargin', 'q4NetMargin',
  'q2Eps', 'q3Eps', 'q4Eps', 'fullYearEps',
  'valuationEps', 'forwardPe', 'fairPe', 'fairPrice', 'upside',
] as const;

function isRecord(value: unknown): value is Record<string, any> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function closeEnough(actual: number, expected: number, relativeTolerance = 0.005): boolean {
  return Math.abs(actual - expected) <= Math.max(0.02, Math.abs(expected) * relativeTolerance);
}

/**
 * 驗證 skill 產出的估值快照。這是讀取時的最後一道防線：不替缺值猜數字，
 * 也不允許顯示 EPS、Forward PE 與合理價採不同口徑。
 */
export function validateValuationOutput(value: unknown, now = new Date()): ValuationQualityReport {
  const issues: ValuationQualityIssue[] = [];
  const add = (severity: ValuationQualitySeverity, code: string, message: string, path?: string) =>
    issues.push({ severity, code, message, ...(path ? { path } : {}) });

  if (!isRecord(value)) {
    add('error', 'not_object', '估值輸出不是 JSON 物件');
    return finish(issues, now);
  }

  const generatedAt = Date.parse(String(value.generatedAt ?? ''));
  if (!Number.isFinite(generatedAt)) {
    add('error', 'missing_generated_at', '缺少有效 generatedAt', 'generatedAt');
  } else if (generatedAt > now.getTime() + 5 * 60_000) {
    add('error', 'future_generated_at', 'generatedAt 晚於目前時間，快照時間不可信', 'generatedAt');
  }

  const priceContext = value.currentPriceContext;
  const price = isRecord(priceContext) && Number.isFinite(priceContext.currentPrice)
    ? Number(priceContext.currentPrice)
    : null;
  if (price == null || price <= 0) add('error', 'missing_price', '缺少估值基準股價', 'currentPriceContext.currentPrice');
  if (!isRecord(priceContext) || !/^\d{4}-\d{2}-\d{2}$/.test(String(priceContext.priceDate ?? ''))) {
    add('error', 'missing_price_date', '缺少報價真正所屬交易日', 'currentPriceContext.priceDate');
  }

  if (!Number.isFinite(value.ttmPe) || value.ttmPe <= 0) {
    add('error', 'invalid_ttm_pe', 'TTM PE 必須是正數', 'ttmPe');
  }

  const scenarios = value.scenarios;
  let probabilitySum = 0;
  let probabilityCount = 0;
  for (const key of SCENARIO_KEYS) {
    const scenario = isRecord(scenarios) ? scenarios[key] : null;
    const path = `scenarios.${key}`;
    if (!isRecord(scenario)) {
      add('error', 'missing_scenario', `缺少${key}情境`, path);
      continue;
    }
    if (Number.isFinite(scenario.probability) && scenario.probability >= 0 && scenario.probability <= 1) {
      probabilitySum += scenario.probability;
      probabilityCount += 1;
    } else {
      add('warning', 'missing_scenario_probability', `${path} 缺少有效情境機率`, `${path}.probability`);
    }
    for (const field of REQUIRED_NUMBERS) {
      if (!Number.isFinite(scenario[field])) {
        add('error', 'missing_scenario_number', `${path}.${field} 缺少有效數字`, `${path}.${field}`);
      }
    }
    if (!['reported', 'latest_shares', 'fully_diluted', 'normalized'].includes(String(scenario.valuationEpsBasis ?? ''))) {
      add('error', 'missing_eps_basis', `${path} 未說明估值 EPS 口徑`, `${path}.valuationEpsBasis`);
    }
    if (!Array.isArray(scenario.assumptionEvidence) || scenario.assumptionEvidence.length < 2) {
      add('error', 'insufficient_evidence', `${path} 至少需要兩筆可追溯假設依據`, `${path}.assumptionEvidence`);
    } else {
      scenario.assumptionEvidence.forEach((e: unknown, index: number) => {
        if (!isRecord(e) || !e.field || !e.sourceUrl || !e.rawQuote) {
          add('error', 'invalid_evidence', `${path} 第 ${index + 1} 筆依據不完整`, `${path}.assumptionEvidence.${index}`);
        }
      });
    }
    if (Number.isFinite(scenario.valuationEps) && Number.isFinite(scenario.fairPe) && Number.isFinite(scenario.fairPrice)) {
      const expected = scenario.valuationEps * scenario.fairPe;
      if (!closeEnough(scenario.fairPrice, expected)) {
        add('error', 'fair_price_mismatch', `${path} 合理價不等於估值 EPS × 合理 PE`, `${path}.fairPrice`);
      }
    }
    if (price != null && Number.isFinite(scenario.valuationEps) && scenario.valuationEps > 0 && Number.isFinite(scenario.forwardPe)) {
      const expected = price / scenario.valuationEps;
      if (!closeEnough(scenario.forwardPe, expected)) {
        add('error', 'forward_pe_mismatch', `${path} Forward PE 與估值 EPS 口徑不一致`, `${path}.forwardPe`);
      }
    }
  }

  if (probabilityCount === 3 && !closeEnough(probabilitySum, 1, 0.0001)) {
    add('error', 'probability_sum_mismatch', '三情境機率總和必須等於 1', 'scenarios');
  }

  const includedPeers = isRecord(value.peerComparison) && Array.isArray(value.peerComparison.peers)
    ? value.peerComparison.peers.filter((peer: unknown) => isRecord(peer) && peer.excluded !== true)
    : [];
  if (includedPeers.length < 3) {
    add('warning', 'insufficient_peers', '未排除的真正可比同業少於三家', 'peerComparison.peers');
  }
  if (includedPeers.every((peer: Record<string, any>) => !Number.isFinite(peer.currentYearPe))) {
    add('warning', 'missing_forward_peer_pe', '同業缺少本年度預估 PE，只能用歷史 PE 交叉校準', 'peerComparison.peers');
  }
  if (!isRecord(value.valuationMethod) || !value.valuationMethod.primaryModel || !Array.isArray(value.valuationMethod.crossChecks) || value.valuationMethod.crossChecks.length === 0) {
    add('warning', 'missing_cross_check_model', '缺少產業適配的第二估值法交叉驗證', 'valuationMethod');
  }

  if (value.dilution != null && isRecord(value.dilution)) {
    for (const field of ['originalShares', 'newShares', 'ratio', 'pessimisticDilutedEps', 'baseDilutedEps', 'optimisticDilutedEps', 'pessimisticDilutedPrice', 'baseDilutedPrice', 'optimisticDilutedPrice']) {
      if (!Number.isFinite(value.dilution[field])) {
        add('error', 'incomplete_dilution', `稀釋計算缺少 ${field}`, `dilution.${field}`);
      }
    }
  }

  return finish(issues, now);
}

function finish(issues: ValuationQualityIssue[], now: Date): ValuationQualityReport {
  const errors = issues.filter(issue => issue.severity === 'error');
  const warnings = issues.filter(issue => issue.severity === 'warning');
  return { valid: errors.length === 0, checkedAt: now.toISOString(), errors, warnings };
}
