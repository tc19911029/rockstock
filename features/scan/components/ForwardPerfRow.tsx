'use client';

import type { StockForwardPerformance } from '@/lib/scanner/types';

export const COMPACT_FWD = [
  { key: 'openReturn' as const, label: '隔日開' },
  { key: 'd1Return' as const, label: '1日' },
  { key: 'd2Return' as const, label: '2日' },
  { key: 'd3Return' as const, label: '3日' },
  { key: 'd4Return' as const, label: '4日' },
  { key: 'd5Return' as const, label: '5日' },
  { key: 'd6Return' as const, label: '6日' },
  { key: 'd7Return' as const, label: '7日' },
  { key: 'd8Return' as const, label: '8日' },
  { key: 'd9Return' as const, label: '9日' },
  { key: 'd10Return' as const, label: '10日' },
  { key: 'd20Return' as const, label: '20日' },
  { key: 'maxGain' as const, label: '最高' },
  { key: 'maxLoss' as const, label: '最低' },
] as const;

export function fmtRet(val: number | null | undefined): string {
  if (val == null) return '—';
  return `${val >= 0 ? '+' : ''}${val.toFixed(1)}%`;
}

export function retColor(val: number | null | undefined): string {
  if (val == null) return 'text-muted-foreground/50';
  if (val > 0) return 'text-bull';
  if (val < 0) return 'text-bear';
  return 'text-muted-foreground';
}

interface Props {
  performance: StockForwardPerformance | undefined;
  isFetching?: boolean;
}

export function ForwardPerfRow({ performance, isFetching }: Props) {
  return (
    <div className="flex items-center gap-0.5">
      {COMPACT_FWD.map(({ key, label }) => {
        const val = performance ? performance[key] : undefined;
        return (
          <div key={key} className="flex-1 text-center">
            <div className="text-[8px] text-muted-foreground/60">{label}</div>
            <div className={`text-[9px] font-mono ${retColor(val as number | null | undefined)}`}>
              {isFetching && !performance ? '…' : fmtRet(val as number | null | undefined)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
