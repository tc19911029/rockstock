const HOLDING_RISK_PROHIBITION = /戒律[6789]|底底低|結構.*(?:轉弱|破壞)|趨勢.*(?:空頭|轉空)/;

export function isHoldingRiskProhibition(reason: string): boolean {
  return HOLDING_RISK_PROHIBITION.test(reason);
}

export function pickHoldingRiskProhibitions(reasons: readonly string[]): string[] {
  return reasons.filter(isHoldingRiskProhibition);
}
