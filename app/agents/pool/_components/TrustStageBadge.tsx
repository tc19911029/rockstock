'use client';

/**
 * 投信動向 badge — pool table 列用，顯示 30 天投信動向分區 + pp。
 *
 * 自己 fetch /api/chip，每 row 獨立 — sharesIssued 走 24h cache 所以效能 OK。
 */

import { useEffect, useState } from 'react';

type Stage = 'unknown' | 'cooling' | 'building' | 'accelerating' | 'peak';

interface ChipSlim {
  trustHoldingChange30d: number | null;
  trustMomentumStage: Stage;
  trustDataCoverageDays: number;
}

const STAGE_META: Record<Stage, { zh: string; cls: string }> = {
  unknown:      { zh: '無',    cls: 'bg-slate-700/40 text-slate-500 border-slate-600' },
  cooling:      { zh: '冷卻',  cls: 'bg-rose-900/40 text-rose-300 border-rose-700/50' },
  building:     { zh: '試水',  cls: 'bg-slate-700/40 text-slate-300 border-slate-600' },
  accelerating: { zh: '甜蜜★',cls: 'bg-emerald-900/50 text-emerald-300 border-emerald-700/60' },
  peak:         { zh: '爆量',  cls: 'bg-amber-900/40 text-amber-300 border-amber-700/50' },
};

export function TrustStageBadge({ symbol, date }: { symbol: string; date: string }) {
  const [chip, setChip] = useState<ChipSlim | null | undefined>(undefined);

  useEffect(() => {
    fetch(`/api/chip?symbol=${encodeURIComponent(symbol)}&date=${date}`)
      .then((r) => r.json())
      .then((r) => {
        if (r.ok === false) return setChip(null);
        setChip({
          trustHoldingChange30d: r.trustHoldingChange30d ?? null,
          trustMomentumStage: r.trustMomentumStage ?? 'unknown',
          trustDataCoverageDays: r.trustDataCoverageDays ?? 0,
        });
      })
      .catch(() => setChip(null));
  }, [symbol, date]);

  if (chip === undefined) {
    return <span className="inline-flex px-2 py-0.5 rounded border text-[10px] bg-slate-800/40 text-slate-600 border-slate-700">…</span>;
  }
  if (chip === null) {
    return <span className="inline-flex px-2 py-0.5 rounded border text-[10px] bg-slate-800/40 text-slate-600 border-slate-700">—</span>;
  }

  const meta = STAGE_META[chip.trustMomentumStage];
  const pp = chip.trustHoldingChange30d;
  const ppStr = pp === null ? '—' : `${pp >= 0 ? '+' : ''}${pp.toFixed(2)}pp`;
  return (
    <span
      title={`30 天投信動向 ${ppStr}（涵蓋 ${chip.trustDataCoverageDays} 天 inst raw）`}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-medium ${meta.cls}`}
    >
      <span>{meta.zh}</span>
      <span className="font-mono text-[9px] opacity-80">{ppStr}</span>
    </span>
  );
}

/** Exposed for sorting in pool page — fetch and cache externally if needed. */
export type { Stage };
