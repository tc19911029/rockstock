import {
  STRATEGY_EVIDENCE_DEFINITIONS,
  STRATEGY_EVIDENCE_LABELS,
  type StrategyEvidenceStatus,
} from '@/lib/strategy/strategyEvidence';

const STATUS_CLASS: Record<StrategyEvidenceStatus, string> = {
  trade: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-200',
  paper: 'border-amber-500/50 bg-amber-500/10 text-amber-200',
  research: 'border-slate-500/50 bg-slate-500/10 text-slate-300',
};

const COMPACT_LABEL: Record<StrategyEvidenceStatus, string> = {
  trade: '可交易',
  paper: '紙上',
  research: '研究',
};

interface StrategyEvidenceBadgeProps {
  status: StrategyEvidenceStatus;
  compact?: boolean;
  className?: string;
}

export function StrategyEvidenceBadge({
  status,
  compact = false,
  className = '',
}: StrategyEvidenceBadgeProps) {
  const label = compact ? COMPACT_LABEL[status] : STRATEGY_EVIDENCE_LABELS[status];
  const description = STRATEGY_EVIDENCE_DEFINITIONS[status];

  return (
    <span
      aria-label={`證據分級：${STRATEGY_EVIDENCE_LABELS[status]}`}
      title={`${STRATEGY_EVIDENCE_LABELS[status]}：${description}`}
      className={`inline-flex shrink-0 items-center rounded border px-1 py-px text-[8px] font-semibold leading-none ${STATUS_CLASS[status]} ${className}`}
    >
      {label}
    </span>
  );
}
