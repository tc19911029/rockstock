'use client';

// 三色訊號面板 — 今日「實際觸發」的買賣訊號（雙B / 主力 / 捕撈 三策略各自）。
// 與「條件」面板（全部 ✓/○ 清單）區別：這裡只列 kind='signal' 且 met 的訊號 = 當下可操作的點。

import { cn } from '@/lib/utils';
import { STAGE_LABEL, STAGE_ICON, COMBO_LABEL, COMBO_HINT, type ConditionReport, type GroupReport, type CondGroup, type ComboGrade } from '@/lib/cn-sanse/conditions';

const GROUPS: { key: CondGroup; label: string }[] = [
  { key: 'doubleB', label: '🟦 雙B' },
  { key: 'mainforce', label: '🟪 主力' },
  { key: 'catch', label: '🟩 捕撈' },
];

/** 使用順序評級 badge 配色（回測推導；強→弱）。*/
const COMBO_BADGE: Record<ComboGrade, string> = {
  top: 'bg-gradient-to-r from-rose-500/25 to-fuchsia-500/25 text-fuchsia-100 border-fuchsia-400/50',
  prime: 'bg-rose-500/20 text-rose-200 border-rose-400/40',
  mid: 'bg-amber-500/20 text-amber-200 border-amber-400/40',
  watch: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  weak: 'bg-zinc-600/20 text-zinc-400 border-zinc-600/40',
};

/** 依本檔當下三色狀態給一句具體操作建議（回測推導的使用順序）。 */
function comboAction(r: ConditionReport): string {
  const g = r.combo?.grade;
  let s = '';
  if (g === 'top' || g === 'prime') s = '本檔已有紅(機構)在場＋金叉觸發 → 可進場；短線守雙B死叉或固定5–10日、中線守紅翻負/雙B死叉。';
  else if (g === 'mid') s = '本檔紅＋黃中線骨架、今日無金叉 → 等捕撈/雙B金叉再進，或續抱看紅翻負。';
  else if (g === 'watch') s = '本檔紅(機構)在場、尚無觸發 → 等捕撈/雙B金叉。';
  else if (g === 'weak') s = '本檔紅(機構)未在場 → 僅憑紫色/單指標進場回測勝率最低，建議觀望。';
  if (r.combo?.bottomReversal) s += '（捕撈為0軸下底部反彈金叉，回測勝率較高）';
  if (r.sellWarnings.length > 0) s += ` ⚠️ 同時有賣出訊號（${r.sellWarnings.join('、')}），謹慎/不追。`;
  return s;
}

export function SanSeSignalsPanel({ report }: { report: ConditionReport | null }) {
  if (!report) return <div className="p-3 text-[11px] text-muted-foreground">載入三色訊號…（或此檔資料不足）</div>;
  const r = report;
  const buys: { g: string; label: string }[] = [];
  const sells: { g: string; label: string }[] = [];
  for (const G of GROUPS) {
    const gr = r[G.key] as GroupReport;
    for (const c of gr.buy) if (c.kind === 'signal' && c.met) buys.push({ g: G.label, label: c.label });
    for (const c of gr.sell) if (c.kind === 'signal' && c.met) sells.push({ g: G.label, label: c.label });
  }
  // 位階旗標（key states）
  const flags: string[] = [];
  if (r.doubleB.buy.some((c) => c.id === 'b_above' && c.met)) flags.push('站上多空線(多頭格局)');
  if (r.catch.buy.some((c) => c.id === 'c_above' && c.met)) flags.push('安全做多區(0軸上)');
  if (r.mainforce.buy.some((c) => c.id === 'm_three' && c.met)) flags.push('三色戰法齊揚');
  if (r.doubleB.sell.some((c) => c.id === 'b_below' && c.met)) flags.push('⚠️ 跌破多空線(轉空)');
  if (r.mainforce.sell.some((c) => c.id === 'm_blue' && c.met)) flags.push('⚠️ 散戶主導');

  return (
    <div className="p-2.5 space-y-2 text-xs">
      <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
        <span className="font-semibold text-fuchsia-300">🎨 三色訊號</span>
        {r.level && <span className="px-1.5 py-0.5 rounded border border-border bg-secondary text-muted-foreground">共振 {r.groupBuyCount}/3</span>}
        {r.mainStage && <span className="px-1.5 py-0.5 rounded bg-fuchsia-500/15 text-fuchsia-300 border border-fuchsia-500/30">主力{STAGE_LABEL[r.mainStage]}{STAGE_ICON[r.mainStage]}</span>}
        {r.conflict && <span className="px-1.5 py-0.5 rounded bg-amber-600/20 text-amber-200 border border-amber-500/40">訊號衝突</span>}
      </div>

      {r.combo && (
        <div className={cn('rounded-md border p-2', COMBO_BADGE[r.combo.grade])}>
          <div className="text-[11px] font-semibold mb-0.5">使用順序：{COMBO_LABEL[r.combo.grade]}{r.combo.bottomReversal ? '·底部反彈' : ''}</div>
          <div className="text-[10px] leading-snug opacity-90">{COMBO_HINT[r.combo.grade]}</div>
        </div>
      )}

      <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-2">
        <div className="text-rose-400 font-medium mb-1">🔺 今日買進訊號</div>
        {buys.length
          ? <ul className="space-y-0.5 list-disc pl-4">{buys.map((b, k) => <li key={k}><span className="text-muted-foreground">{b.g}</span> {b.label}</li>)}</ul>
          : <span className="text-muted-foreground">今日無買進訊號</span>}
      </div>

      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2">
        <div className="text-emerald-400 font-medium mb-1">🔻 今日賣出 / 減碼訊號</div>
        {sells.length
          ? <ul className="space-y-0.5 list-disc pl-4">{sells.map((b, k) => <li key={k}><span className="text-muted-foreground">{b.g}</span> {b.label}</li>)}</ul>
          : <span className="text-muted-foreground">今日無賣出訊號</span>}
      </div>

      {flags.length > 0 && (
        <div className="rounded-md border border-border p-2 text-[10px] text-muted-foreground">
          <span className="text-foreground font-medium">位階：</span>{flags.join('｜')}
        </div>
      )}

      <div className="rounded-md border border-border p-2 text-[10px] text-muted-foreground leading-relaxed space-y-1">
        {r.combo && <div className="text-foreground/90"><span className="text-foreground font-medium">操作：</span>{comboAction(r)}</div>}
        <div>
          <span className="text-foreground font-medium">通則：</span>
          紅(機構)在場才當前提（紫色當門票回測最弱）→ 捕撈/雙B金叉觸發進場（0軸下底部反彈金叉也可）→ 三色齊揚最強；出場守紅翻負/雙B死叉。書本進場：上漲日 13:20 看盤、13:25 掛市價。
        </div>
      </div>
    </div>
  );
}
