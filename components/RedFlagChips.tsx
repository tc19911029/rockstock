/**
 * 買進前紅旗 chip — 候選列上的避雷警示標（純顯示）。
 *
 * 紅=硬風險、黃=警示、灰=參考。hover 看具體依據（detail）。
 * 用於台股 pool（CandidatesPoolPanel）與陸股今日總決策（CnAgentsTab）。
 */

import type { RedFlag, RedFlagSeverity } from '@/lib/redflags/types';

const SEV_CLS: Record<RedFlagSeverity, string> = {
  red: 'bg-red-600/30 text-red-200 border-red-500/70',
  yellow: 'bg-amber-500/25 text-amber-200 border-amber-500/60',
  info: 'bg-zinc-600/30 text-zinc-300 border-zinc-500/50',
};

const SEV_DOT: Record<RedFlagSeverity, string> = {
  red: '🔴',
  yellow: '🟡',
  info: 'ℹ️',
};

export function RedFlagChips({ flags, size = 'xs' }: { flags?: RedFlag[]; size?: 'xs' | 'sm' }) {
  if (!flags || flags.length === 0) return null;
  const textSize = size === 'sm' ? 'text-[10px]' : 'text-[9px]';
  return (
    <span className="inline-flex flex-wrap gap-0.5 align-middle">
      {flags.map((f) => (
        <span
          key={f.code}
          title={`${SEV_DOT[f.severity]} ${f.label}：${f.detail}`}
          className={`inline-flex items-center px-1 py-0.5 rounded border ${textSize} ${SEV_CLS[f.severity]}`}
        >
          {f.label}
        </span>
      ))}
    </span>
  );
}
