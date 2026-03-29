/**
 * Token cost tracker — records every Claude API call's usage.
 * COST-01: Auto-record input/output tokens + model.
 * COST-02: Per-role breakdown.
 * COST-03: Cumulative session counter (server-side in-memory, client persists via localStorage).
 */
import { calculateCost } from './config';

export interface UsageRecord {
  timestamp: string;
  model: string;
  role: string;           // e.g. "chat", "sentiment", "technical-analyst", "research-director"
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

interface SessionCost {
  records: UsageRecord[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  byRole: Record<string, { calls: number; costUsd: number; inputTokens: number; outputTokens: number }>;
}

/** In-memory session store (resets on server restart) */
let session: SessionCost = {
  records: [],
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostUsd: 0,
  byRole: {},
};

/**
 * Record a Claude API call's token usage.
 * Call this after every messages.create() or stream.finalMessage().
 */
export function recordUsage(
  model: string,
  role: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0
): UsageRecord {
  const costUsd = calculateCost(model, inputTokens, outputTokens, cacheReadTokens);

  const record: UsageRecord = {
    timestamp: new Date().toISOString(),
    model,
    role,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    costUsd,
  };

  session.records.push(record);
  session.totalInputTokens += inputTokens;
  session.totalOutputTokens += outputTokens;
  session.totalCostUsd += costUsd;

  // Update per-role breakdown
  if (!session.byRole[role]) {
    session.byRole[role] = { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
  }
  const r = session.byRole[role];
  r.calls += 1;
  r.costUsd += costUsd;
  r.inputTokens += inputTokens;
  r.outputTokens += outputTokens;

  return record;
}

/** Get current session cost summary */
export function getSessionCost(): SessionCost {
  return {
    ...session,
    totalCostUsd: Math.round(session.totalCostUsd * 10000) / 10000,
  };
}

/** Reset session (for testing) */
export function resetSession(): void {
  session = {
    records: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    byRole: {},
  };
}
