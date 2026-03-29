/**
 * AI model configuration — single source of truth for pricing and model IDs.
 * COST-04: Updating a price requires changing one line here.
 */

export interface ModelPricing {
  inputPerMillion: number;   // USD per 1M input tokens
  outputPerMillion: number;  // USD per 1M output tokens
  cacheReadPerMillion?: number; // USD per 1M cache-read tokens (if applicable)
}

/** Model pricing table (USD). Source: Anthropic pricing page, March 2026. */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-6': {
    inputPerMillion: 15.0,
    outputPerMillion: 75.0,
    cacheReadPerMillion: 1.5,
  },
  'claude-sonnet-4-6': {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cacheReadPerMillion: 0.3,
  },
  'claude-haiku-4-5-20251001': {
    inputPerMillion: 0.8,
    outputPerMillion: 4.0,
    cacheReadPerMillion: 0.08,
  },
};

/** Calculate USD cost for a single API call */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;
  const cacheCost = cacheReadTokens > 0 && pricing.cacheReadPerMillion
    ? (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMillion
    : 0;

  return inputCost + outputCost + cacheCost;
}
