import type { StrategyReadiness } from './strategyReadiness';

export interface StrategyGap {
  date: string;
  key: string;
  reason: string;
  attempts: number;
  state: 'pending' | 'running' | 'failed' | 'blocked';
  detail?: string;
}
export interface StrategyAudit {
  market: 'TW' | 'CN';
  checkedAt: string;
  endDate: string;
  status: 'checking' | 'ready' | 'partial';
  days: StrategyReadiness[];
  gaps: StrategyGap[];
}

export function collectStrategyGaps(days: StrategyReadiness[], previous: StrategyGap[] = []): StrategyGap[] {
  return days.flatMap(day => day.artifacts.filter(a => a.required !== false && !a.ready).map(a => {
    const old = previous.find(g => g.date === day.date && g.key === a.key);
    return { date: day.date, key: a.key, reason: a.reason ?? 'invalid',
      attempts: old?.attempts ?? 0, state: 'pending' as const,
      ...(old?.state === 'running' ? { detail: 'previous repair interrupted; artifact still incomplete' } : {}),
    };
  }));
}

/** Only replay routes whose historical inputs are supported. Never silently use latest fundamentals. */
export function repairEndpoint(market: 'TW' | 'CN', gap: StrategyGap, endDate: string): string | null {
  const date = `date=${gap.date}`;
  if (gap.key === 'SanSe') return `/api/cron/scan-${market.toLowerCase()}-sanse?${date}`;
  if (gap.key === 'Y' && market === 'TW') return `/api/cron/scan-inststeal-track?${date}`;
  // Other historical routes have additional pool/side-effect dependencies; require reviewed replay.
  if (gap.date !== endDate) return null;
  if (gap.key.startsWith('A-')) return `/api/cron/scan-${market.toLowerCase()}?${date}&force=1`;
  const tracks: Record<string, string[]> = {
    bullish: ['B', 'C', 'E', 'J', 'K', 'L', 'M', 'P'], reversal: ['D', 'F', 'N', 'O'],
    system: ['Q'], mechanical: ['R-long', 'R-short'],
  };
  const track = Object.keys(tracks).find(t => tracks[t].includes(gap.key));
  return track ? `/api/cron/scan-bm-batch?market=${market}&track=${track}&${date}` : null;
}

export function scanArtifactReason(session: { results?: { symbol: string; price: number }[]; resultCount?: number;
  step1Filter?: string; dataFreshness?: { dataStatus: string } } | null): string | undefined {
  if (!session) return 'missing';
  if (!Array.isArray(session.results) || session.resultCount !== session.results.length) return 'result-count-mismatch';
  if (session.step1Filter === 'missing') return 'step1-pool-missing';
  if (session.dataFreshness?.dataStatus === 'insufficient') return 'insufficient-input';
  if (session.results.some(r => !r.symbol || !Number.isFinite(r.price) || r.price <= 0)) return 'invalid-price-or-symbol';
  if (new Set(session.results.map(r => r.symbol)).size !== session.results.length) return 'duplicate-symbol';
  return undefined;
}
