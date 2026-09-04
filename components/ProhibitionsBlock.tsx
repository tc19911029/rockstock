'use client';

/**
 * ProhibitionsBlock.tsx — 進場 10 大戒律狀態（2026-05-10）
 *
 * 顯示位置：六條件 / 買法條件 panel 末段
 * 用途：戒律是「硬性禁忌」— 任一條觸發 → 即使六條件全過，書本也禁止進場
 *
 * 書本依據：《活用技術分析寶典》p.54 + p.82-85（《抓飆股》Part 2 也有對應整理）
 *
 * 設計：
 *   未觸發 → 一行綠字「✓ 戒律全過 — 無禁止進場條件」（低調）
 *   觸發 N 條 → 黃/紅框 + 條目列表 + 書本根據短註
 */

import { useReplayStore } from '@/store/replayStore';

interface Props {
  /** 是否要顯示「未觸發時的成功訊息」（預設 true）；false 時觸發才出現 */
  showWhenClean?: boolean;
  direction?: 'long' | 'short';
  mode?: 'veto' | 'warning';
}

export default function ProhibitionsBlock({ showWhenClean = true, direction = 'long', mode = 'veto' }: Props) {
  const { longProhibitions, shortProhibitions } = useReplayStore();
  const prohibitions = direction === 'short' ? shortProhibitions : longProhibitions;

  if (!prohibitions) return null;

  const triggered = prohibitions.prohibited;
  const reasons = prohibitions.reasons ?? [];

  if (!triggered) {
    if (!showWhenClean) return null;
    return (
      <div className="mt-3 px-3 py-2 border-t border-border">
        <div className="flex items-center gap-1.5 text-[11px] text-emerald-400/80">
          <span>✓</span>
          <span className="font-semibold">戒律全過</span>
          <span className="text-muted-foreground/70">— 無禁止{direction === 'short' ? '放空' : '做多'}條件</span>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 px-3 py-2 border-t border-border bg-amber-900/15">
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-amber-300 text-sm">⚠</span>
        <span className="text-[11px] font-bold text-amber-300">
          戒律觸發 {reasons.length} 條 — {mode === 'warning' ? '此策略保留訊號、列為風險警示' : `書本：禁止${direction === 'short' ? '進場放空' : '進場做多'}`}
        </span>
      </div>
      <ul className="space-y-0.5 pl-1">
        {reasons.slice(0, 6).map((r, i) => (
          <li key={i} className="text-[10px] text-amber-200/90 leading-snug">
            · {r}
          </li>
        ))}
      </ul>
      <p className="text-[9px] text-muted-foreground/70 mt-1.5 leading-snug">
        {mode === 'warning'
          ? '反轉／戰法軌依各自型態 SOP 掃描，戒律不剔除；此處保留完整風險供人工判斷。'
          : '書本《活用技術分析寶典》p.54 / p.82-85：戒律是硬性禁忌，任一條觸發即不應進場，即使六條件全過。'}
      </p>
    </div>
  );
}
