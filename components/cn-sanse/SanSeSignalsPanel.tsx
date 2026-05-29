'use client';

// 三色訊號面板 — 今日「實際觸發」的買賣訊號（雙B / 主力 / 捕撈 三策略各自）。
// 與「條件」面板（全部 ✓/○ 清單）區別：這裡只列 kind='signal' 且 met 的訊號 = 當下可操作的點。

import { cn } from '@/lib/utils';
import { STAGE_LABEL, STAGE_ICON, type ConditionReport, type GroupReport, type CondGroup } from '@/lib/cn-sanse/conditions';

const GROUPS: { key: CondGroup; label: string }[] = [
  { key: 'doubleB', label: '🟦 雙B' },
  { key: 'mainforce', label: '🟪 主力' },
  { key: 'catch', label: '🟩 捕撈' },
];

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

      <div className="rounded-md border border-border p-2 text-[10px] text-muted-foreground leading-relaxed">
        <span className="text-foreground font-medium">操作：</span>
        雙B 站上智能交易線/金叉做多、跌破/死叉減碼；主力 紅+紫做短線、紅+黃做中線、三色齊揚最強；捕撈 動能金叉買、死叉賣、0軸上才安全。書本進場：上漲日 13:20 看盤、13:25 掛市價。
      </div>
    </div>
  );
}
