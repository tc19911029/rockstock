import type { MarketId, MtfMode, ScanDirection } from '@/lib/scanner/types';
import { validateFundamentalSession } from '@/lib/strategy/fundamentalRevaluation/validation';

export interface StrategyArtifactStatus {
  key: string;
  ready: boolean;
  reason?: string;
  /** false = 已知尚未支援，顯示狀態但不納入每日 readiness 分母 */
  required?: boolean;
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
  const required = artifacts.filter((artifact) => artifact.required !== false);
  const missing = required.filter((a) => !a.ready && a.reason === 'missing').map((a) => a.key);
  const invalid = required.filter((a) => !a.ready && a.reason !== 'missing').map((a) => a.key);
  const readyCount = required.filter((a) => a.ready).length;
  return {
    date,
    status: readyCount === required.length ? 'ready' : 'partial',
    readyCount,
    requiredCount: required.length,
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

  if (market === 'TW') {
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
  } else {
    artifacts.push({ key: 'V', ready: false, required: false, reason: 'unsupported' });
  }

  return summarizeStrategyArtifacts(date, artifacts.sort((a, b) => a.key.localeCompare(b.key)));
}
