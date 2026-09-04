'use client';

// 三色條件面板 — 主力/雙B/捕撈三組的買進✓/賣出警示清單。
// 主頁中間「條件」tab（陸股）與 /cn-sanse 共用同一份 ConditionReport 渲染。

import { cn } from '@/lib/utils';
import { STAGE_LABEL, STAGE_ICON, COMBO_LABEL, COMBO_HINT, tradeVerdict, type ConditionReport, type GroupReport, type ResLevel, type ComboGrade, type TradeVerdict } from '@/lib/cn-sanse/conditions';

/** 一眼結論盒配色 + 大標（與訊號面板一致）。*/
const VERDICT_STYLE: Record<TradeVerdict, { head: string; cls: string }> = {
  buy:      { head: '🟢 可買進',   cls: 'bg-rose-500/15 text-rose-200 border-rose-400/50' },
  sell:     { head: '🔻 該賣 / 減碼', cls: 'bg-emerald-500/15 text-emerald-200 border-emerald-400/50' },
  conflict: { head: '⚠️ 訊號衝突',  cls: 'bg-amber-500/15 text-amber-200 border-amber-400/50' },
  wait:     { head: '🟡 觀望 · 等金叉', cls: 'bg-sky-500/15 text-sky-200 border-sky-400/40' },
  skip:     { head: '⚪ 不建議',    cls: 'bg-zinc-600/25 text-zinc-300 border-zinc-600/50' },
};

const RES_BADGE: Record<ResLevel, { label: string; cls: string }> = {
  strong: { label: '強共振', cls: 'bg-rose-500/20 text-rose-300 border-rose-500/40' },
  medium: { label: '中共振', cls: 'bg-amber-500/20 text-amber-300 border-amber-500/40' },
  weak: { label: '弱共振', cls: 'bg-secondary text-muted-foreground border-border' },
};

/** 使用順序評級 badge 配色（回測推導；強→弱）。*/
const COMBO_BADGE: Record<ComboGrade, string> = {
  top: 'bg-gradient-to-r from-rose-500/25 to-fuchsia-500/25 text-fuchsia-100 border-fuchsia-400/50',
  prime: 'bg-rose-500/20 text-rose-200 border-rose-400/40',
  mid: 'bg-amber-500/20 text-amber-200 border-amber-400/40',
  watch: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  weak: 'bg-zinc-600/20 text-zinc-400 border-zinc-600/40',
};

function CondList({ title, g, color }: { title: string; g: GroupReport; color: string }) {
  return (
    <div className="rounded-md border border-border p-2">
      <div className="flex items-center gap-1.5 mb-1">
        <span className={cn('text-[11px] font-medium', color)}>{title}</span>
        {g.buyHit && <span className="text-[9px] px-1 rounded bg-rose-500/15 text-rose-300">買進</span>}
        {g.sellHit && <span className="text-[9px] px-1 rounded bg-amber-500/15 text-amber-300">賣出</span>}
      </div>
      <div className="flex flex-wrap gap-1 text-[10px]">
        {g.buy.map((c) => (
          <span key={c.id} className={cn('px-1 py-0.5 rounded border', c.met ? (c.kind === 'signal' ? 'bg-rose-500/15 text-rose-300 border-rose-500/30' : 'bg-sky-500/10 text-sky-300 border-sky-500/30') : 'text-muted-foreground/35 border-border')}>
            {c.met ? '✓' : '○'}{c.label}
          </span>
        ))}
        {g.sell.filter((c) => c.met).map((c) => (
          <span key={c.id} className="px-1 py-0.5 rounded border bg-amber-500/15 text-amber-300 border-amber-500/30">⚠️{c.label}</span>
        ))}
      </div>
    </div>
  );
}

export function SanSeConditionsPanel({ report }: { report: ConditionReport | null }) {
  if (!report) {
    return <div className="p-3 text-[11px] text-muted-foreground">載入三色條件…（或此檔資料不足）</div>;
  }
  const r = report;
  const v = tradeVerdict(r);
  return (
    <div className="p-2.5 space-y-2">
      {/* 一眼結論：底反該買(最高把握) / 該買 / 該賣 / 觀望 */}
      <div className={cn('rounded-md border px-2 py-1 text-[12px] font-bold', v.reversal ? 'bg-rose-600/25 text-rose-100 border-rose-400/70 ring-1 ring-rose-400/50' : VERDICT_STYLE[v.tone].cls)}>
        {v.reversal ? '🔥 底反該買' : VERDICT_STYLE[v.tone].head}<span className="text-[10px] font-normal opacity-80"> — {v.reason}</span>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
        <span className="font-semibold text-fuchsia-300">🎨 三色條件</span>
        {r.combo && <span className={cn('px-1.5 py-0.5 rounded border font-medium', COMBO_BADGE[r.combo.grade])} title="使用順序評級：紅當前提 → 捕撈/雙B金叉觸發 → 三燈全亮且雙金叉的全共振">{COMBO_LABEL[r.combo.grade]}{r.combo.bottomReversal ? '·底部反彈' : ''}</span>}
        {r.level && <span className={cn('px-1.5 py-0.5 rounded border font-medium', RES_BADGE[r.level].cls)}>{RES_BADGE[r.level].label} {r.groupBuyCount}/3</span>}
        {r.mainStage && <span className="px-1.5 py-0.5 rounded bg-fuchsia-500/15 text-fuchsia-300 border border-fuchsia-500/30">主力{STAGE_LABEL[r.mainStage]}{STAGE_ICON[r.mainStage]}</span>}
        {r.conflict && <span className="px-1.5 py-0.5 rounded bg-amber-600/20 text-amber-200 border border-amber-500/40">訊號衝突</span>}
        {!r.selected && <span className="text-muted-foreground">未達任一組買點</span>}
      </div>
      {r.combo && <p className="text-[10px] leading-snug text-muted-foreground -mt-1">{COMBO_HINT[r.combo.grade]}</p>}

      <CondList title="🟦 雙B戰法" g={r.doubleB} color="text-rose-300" />
      <CondList title="🟪 主力狀態" g={r.mainforce} color="text-fuchsia-400" />
      <CondList title="🟩 捕撈季節" g={r.catch} color="text-emerald-400" />

      <div className="grid grid-cols-2 gap-1.5 pt-0.5">
        <Score label="短線上攻" v={r.scores.shortAttack} c="text-fuchsia-400" />
        <Score label="中線強勢" v={r.scores.midStrength} c="text-rose-300" />
        <Score label="中線控盤" v={r.scores.midControl} c="text-amber-300" />
        <Score label="控盤程度" v={r.scores.kongPan} c="text-sky-300" />
      </div>
    </div>
  );
}

function Score({ label, v, c }: { label: string; v: number; c: string }) {
  return (
    <div className="rounded-md border border-border px-2 py-1 text-center">
      <div className="text-muted-foreground text-[9px]">{label}</div>
      <div className={cn('font-bold tabular-nums text-sm', c)}>{Number.isFinite(v) ? v.toFixed(2) : '—'}</div>
    </div>
  );
}
