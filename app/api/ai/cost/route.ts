import { NextResponse } from 'next/server';
import { getSessionCost } from '@/lib/ai/costTracker';

/** GET /api/ai/cost — return current session cost summary */
export async function GET(): Promise<NextResponse> {
  const cost = getSessionCost();
  return NextResponse.json({
    totalCostUsd: cost.totalCostUsd,
    totalInputTokens: cost.totalInputTokens,
    totalOutputTokens: cost.totalOutputTokens,
    callCount: cost.records.length,
    byRole: cost.byRole,
    recentCalls: cost.records.slice(-10).reverse(),
  });
}
