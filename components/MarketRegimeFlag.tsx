import type { MarketRegime, RegimeDetectResult } from '@/lib/agents/marketRegime';
import { regimeLabel } from '@/lib/agents/marketRegime';

const REGIME_CLASS: Record<MarketRegime, string> = {
  strong_bull: 'bg-orange-900/40 text-orange-200 border-orange-600/70',
  normal:      'bg-slate-800/50 text-slate-300 border-slate-600',
  bear:        'bg-rose-900/40 text-rose-200 border-rose-600/70',
};

const REGIME_ICON: Record<MarketRegime, string> = {
  strong_bull: '🔥',
  normal:      '〰',
  bear:        '🐻',
};

function buildTitle(r: RegimeDetectResult): string {
  const lines: string[] = [];
  lines.push(`大盤 regime：${regimeLabel(r.regime)}`);
  for (const reason of r.reasons) lines.push(`  • ${reason}`);
  if (r.regime === 'strong_bull') {
    lines.push('');
    lines.push('閾值已放寬：連 3 漲停才擋｜月線乖離 25%｜季線乖離 40%');
  } else if (r.regime === 'normal') {
    lines.push('');
    lines.push('標準閾值：連 2 漲停｜月線乖離 15%｜季線乖離 25%');
  }
  return lines.join('\n');
}

interface Props {
  regime: RegimeDetectResult | undefined;
  size?: 'sm' | 'xs';
}

export function MarketRegimeFlag({ regime, size = 'sm' }: Props) {
  if (!regime) return null;
  const sizeClass = size === 'xs'
    ? 'text-[9px] px-1 py-0'
    : 'text-[10px] px-1.5 py-0.5';
  return (
    <span
      title={buildTitle(regime)}
      className={`inline-flex items-center gap-0.5 rounded border font-medium ${sizeClass} ${REGIME_CLASS[regime.regime]}`}
    >
      <span aria-hidden>{REGIME_ICON[regime.regime]}</span>
      <span>{regimeLabel(regime.regime)}</span>
      {regime.regime === 'strong_bull' && (
        <span className="opacity-80 ml-0.5">·gate 放寬</span>
      )}
    </span>
  );
}
