import type { MarketId, MtfMode, ScanDirection } from '@/lib/scanner/types';
import { validateFundamentalSession } from '@/lib/strategy/fundamentalRevaluation/validation';

export interface StrategyArtifactStatus {
  key: string;
  ready: boolean;
  reason?: string;
}

export interface StrategyReadiness {
  date: string;
  status: 'ready' | 'partial';
  readyCount: number;
  requiredCount: number;
  missing: string[];
  invalid: string[];
  artifacts: StrategyArtifactStatus[];
}

const LETTERS: MtfMode[] = ['B', 'C', 'D', 'E', 'F', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q'];

export function summarizeStrategyArtifacts(
  date: string,
  artifacts: StrategyArtifactStatus[],
): StrategyReadiness {
  const missing = artifacts.filter((a) => !a.ready && a.reason === 'missing').map((a) => a.key);
  const invalid = artifacts.filter((a) => !a.ready && a.reason !== 'missing').map((a) => a.key);
  const readyCount = artifacts.filter((a) => a.ready).length;
  return {
    date,
    status: readyCount === artifacts.length ? 'ready' : 'partial',
    readyCount,
    requiredCount: artifacts.length,
    missing,
    invalid,
    artifacts,
  };
}

export async function loadStrategyReadiness(
  market: MarketId,
  date: string,
): Promise<StrategyReadiness> {
  const { loadPostCloseScanSession } = await import('@/lib/storage/scanStorage');
  const artifacts: StrategyArtifactStatus[] = [];

  const addScan = async (key: string, direction: ScanDirection, mode: MtfMode) => {
    const session = await loadPostCloseScanSession(market, date, direction, mode);
    artifacts.push({ key, ready: session !== null, ...(!session && { reason: 'missing' }) });
  };

  await Promise.all([
    addScan('A-long-daily', 'long', 'daily'),
    addScan('A-long-mtf', 'long', 'mtf'),
    addScan('A-short-daily', 'short', 'daily'),
    addScan('A-short-mtf', 'short', 'mtf'),
    ...LETTERS.map((letter) => addScan(letter, 'long', letter)),
    addScan('R-long', 'long', 'R'),
    addScan('R-short', 'short', 'R'),
    ...(market === 'TW'
      ? [addScan('A30', 'long', 'daily30'), addScan('Y', 'long', 'Y')]
      : []),
  ]);

  const sanse = market === 'TW'
    ? await (await import('@/lib/tw-sanse/scanStorage')).loadTwSanSeScan(date)
    : await (await import('@/lib/cn-sanse/scanStorage')).loadSanSeScan(date);
  artifacts.push({
    key: 'SanSe',
    ready: !!sanse && sanse.evaluated > 0,
    ...(!sanse ? { reason: 'missing' } : sanse.evaluated <= 0 ? { reason: 'evaluated=0' } : {}),
  });

  const fundamental = await (await import('@/lib/strategy/fundamentalRevaluation/storage'))
    .loadSession(market, date);
  const fundamentalValidation = fundamental ? validateFundamentalSession(fundamental) : null;
  artifacts.push({
    key: 'V',
    ready: fundamentalValidation?.valid === true,
    ...(!fundamental
      ? { reason: 'missing' }
      : !fundamentalValidation?.valid
        ? { reason: fundamentalValidation?.reason ?? 'invalid' }
        : {}),
  });

  return summarizeStrategyArtifacts(date, artifacts.sort((a, b) => a.key.localeCompare(b.key)));
}
