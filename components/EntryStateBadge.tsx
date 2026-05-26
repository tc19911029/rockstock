import type { EntryGateResult, EntryState } from '@/lib/agents/entryGate';
import { entryStateLabel } from '@/lib/agents/entryGate';

const STATE_CLASS: Record<EntryState, string> = {
  can_enter: 'bg-emerald-900/50 text-emerald-200 border-emerald-600',
  watch:     'bg-slate-800/60 text-slate-300 border-slate-600',
  no_chase:  'bg-rose-900/50 text-rose-200 border-rose-600',
};

const STATE_ICON: Record<EntryState, string> = {
  can_enter: '✓',
  watch:     '·',
  no_chase:  '✕',
};

interface Props {
  gate: EntryGateResult | undefined;
  /** 'sm' 跟 rating badge 一致；'xs' 給表格列用 */
  size?: 'sm' | 'xs';
  /** showReasons=true 時 badge 旁邊接一段 reasons 文字（hover 還是會 tooltip） */
  showReasons?: boolean;
}

function buildTitle(gate: EntryGateResult): string {
  const m = gate.metrics;
  const lines: string[] = [];
  lines.push(`進場時機：${entryStateLabel(gate.state)}`);
  if (gate.reasons.length > 0) {
    for (const r of gate.reasons) lines.push(`  • ${r}`);
  }
  const stat: string[] = [];
  if (m.distanceToMa5 != null) stat.push(`距MA5 ${(m.distanceToMa5 * 100).toFixed(1)}%`);
  if (m.deviationMa20 != null) stat.push(`月線乖離 ${(m.deviationMa20 * 100).toFixed(1)}%`);
  if (m.deviationMa60 != null) stat.push(`季線乖離 ${(m.deviationMa60 * 100).toFixed(1)}%`);
  if (m.consecutiveLimitUp > 0) stat.push(`連 ${m.consecutiveLimitUp} 漲停`);
  if (stat.length > 0) {
    lines.push('');
    lines.push(stat.join('｜'));
  }
  return lines.join('\n');
}

export function EntryStateBadge({ gate, size = 'sm', showReasons = false }: Props) {
  if (!gate) return null;
  const sizeClass = size === 'xs'
    ? 'text-[9px] px-1 py-0'
    : 'text-[10px] px-1.5 py-0.5';
  return (
    <span
      title={buildTitle(gate)}
      className={`inline-flex items-center gap-0.5 rounded border ${sizeClass} ${STATE_CLASS[gate.state]}`}
    >
      <span aria-hidden>{STATE_ICON[gate.state]}</span>
      <span className="font-medium">{entryStateLabel(gate.state)}</span>
      {showReasons && gate.reasons.length > 0 && (
        <span className="ml-0.5 opacity-80 font-normal truncate max-w-[10rem]">
          {gate.reasons[0]}
        </span>
      )}
    </span>
  );
}
