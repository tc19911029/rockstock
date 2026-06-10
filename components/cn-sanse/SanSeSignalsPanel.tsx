'use client';

// 三色訊號面板 — 今日「實際觸發」的買賣訊號（雙B / 主力 / 捕撈 三策略各自）。
// 與「條件」面板（全部 ✓/○ 清單）區別：這裡只列 kind='signal' 且 met 的訊號 = 當下可操作的點。

import { cn } from '@/lib/utils';
import { STAGE_LABEL, STAGE_ICON, COMBO_LABEL, COMBO_HINT, tradeVerdict, type ConditionReport, type GroupReport, type CondGroup, type TradeVerdict } from '@/lib/cn-sanse/conditions';
import { HeavinessBadge, HeavinessBadgeFor } from '@/components/shared/HeavinessBadge';
import { lookupSellHeaviness, SELL_HEAVINESS_WINDOW } from '@/lib/analysis/sellHeavinessTable';

const GROUPS: { key: CondGroup; label: string }[] = [
  { key: 'doubleB', label: '🟦 雙B' },
  { key: 'mainforce', label: '🟪 主力' },
  { key: 'catch', label: '🟩 捕撈' },
];

/** 三色賣訊輕重參考（依回測重要性排序）。 */
const SANSE_SELL_REF: { id: string; short: string }[] = [
  { id: 'c_dead', short: '捕撈死叉' },
  { id: 'b_breakdn', short: '智能線跌破' },
  { id: 'b_dead', short: '雙B死叉' },
  { id: 'b_sresonance', short: '雙重共振' },
];

/** 一眼結論盒配色 + 大標。*/
const VERDICT_STYLE: Record<TradeVerdict, { head: string; cls: string }> = {
  buy:      { head: '🟢 可買進',   cls: 'bg-rose-500/15 text-rose-200 border-rose-400/50' },
  sell:     { head: '🔻 該賣 / 減碼', cls: 'bg-emerald-500/15 text-emerald-200 border-emerald-400/50' },
  conflict: { head: '⚠️ 訊號衝突',  cls: 'bg-amber-500/15 text-amber-200 border-amber-400/50' },
  wait:     { head: '🟡 觀望 · 等金叉', cls: 'bg-sky-500/15 text-sky-200 border-sky-400/40' },
  skip:     { head: '⚪ 不建議',    cls: 'bg-zinc-600/25 text-zinc-300 border-zinc-600/50' },
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

export function SanSeSignalsPanel({ report, market }: { report: ConditionReport | null; market?: 'TW' | 'CN' | 'other' }) {
  if (!report) return <div className="p-3 text-[11px] text-muted-foreground">載入三色訊號…（或此檔資料不足）</div>;
  const r = report;
  const buys: { g: string; label: string }[] = [];
  const sells: { g: string; label: string; id: string }[] = [];
  for (const G of GROUPS) {
    const gr = r[G.key] as GroupReport;
    for (const c of gr.buy) if (c.kind === 'signal' && c.met) buys.push({ g: G.label, label: c.label });
    for (const c of gr.sell) if (c.kind === 'signal' && c.met) sells.push({ g: G.label, label: c.label, id: c.id });
  }
  const hasHeaviness = (market === 'TW' || market === 'CN');
  // 位階旗標（key states）
  const flags: string[] = [];
  if (r.doubleB.buy.some((c) => c.id === 'b_above' && c.met)) flags.push('站上多空線(多頭格局)');
  if (r.catch.buy.some((c) => c.id === 'c_above' && c.met)) flags.push('安全做多區(0軸上)');
  if (r.mainforce.buy.some((c) => c.id === 'm_three' && c.met)) flags.push('紅紫黃三色都亮');
  if (r.doubleB.sell.some((c) => c.id === 'b_below' && c.met)) flags.push('⚠️ 跌破多空線(轉空)');
  if (r.mainforce.sell.some((c) => c.id === 'm_blue' && c.met)) flags.push('⚠️ 散戶主導');
  const v = tradeVerdict(r);

  return (
    <div className="p-2.5 space-y-2 text-xs">
      <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
        <span className="font-semibold text-fuchsia-300">🎨 三色訊號</span>
        {r.level && <span className="px-1.5 py-0.5 rounded border border-border bg-secondary text-muted-foreground">共振 {r.groupBuyCount}/3</span>}
        {r.mainStage && <span className="px-1.5 py-0.5 rounded bg-fuchsia-500/15 text-fuchsia-300 border border-fuchsia-500/30">主力{STAGE_LABEL[r.mainStage]}{STAGE_ICON[r.mainStage]}</span>}
        {r.conflict && <span className="px-1.5 py-0.5 rounded bg-amber-600/20 text-amber-200 border border-amber-500/40">訊號衝突</span>}
      </div>

      {/* 一眼結論：底反該買(最高把握) / 該買 / 該賣 / 觀望 */}
      <div className={cn('rounded-md border p-2', v.reversal ? 'bg-rose-600/25 text-rose-100 border-rose-400/70 ring-1 ring-rose-400/50' : VERDICT_STYLE[v.tone].cls)}>
        <div className="text-[15px] font-bold leading-none">{v.reversal ? '🔥 底反該買 · 最高把握' : VERDICT_STYLE[v.tone].head}</div>
        <div className="text-[11px] mt-1 leading-snug">{v.reason}</div>
        {r.combo && <div className="text-[10px] mt-1.5 opacity-75">評級：{COMBO_LABEL[r.combo.grade]}{r.combo.bottomReversal ? '·底部反彈' : ''}｜{COMBO_HINT[r.combo.grade]}</div>}
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
          ? <ul className="space-y-0.5 list-disc pl-4">{sells.map((b, k) => (
              <li key={k}>
                <span className="text-muted-foreground">{b.g}</span> {b.label}
                {hasHeaviness && <HeavinessBadgeFor market={market} signalId={b.id} className="ml-1" />}
              </li>
            ))}</ul>
          : <span className="text-muted-foreground">今日無賣出訊號</span>}
        {hasHeaviness && (
          <div className="mt-2 pt-1.5 border-t border-emerald-500/15">
            <div className="text-[9px] text-muted-foreground mb-1">
              賣訊輕重（{market}·{SELL_HEAVINESS_WINDOW.label}回測，越負越重；落後=反指、弱=不顯著）
            </div>
            <div className="flex flex-wrap gap-x-2.5 gap-y-1">
              {SANSE_SELL_REF.map(({ id, short }) => {
                const e = lookupSellHeaviness(market, id);
                return e ? (
                  <span key={id} className="inline-flex items-center gap-1 text-[10px]">
                    <span className="text-muted-foreground">{short}</span>
                    <HeavinessBadge entry={e} />
                  </span>
                ) : null;
              })}
            </div>
          </div>
        )}
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
          紅(機構)在場才當前提（紫色當門票回測最弱）→ 捕撈/雙B金叉觸發進場（0軸下底部反彈金叉也可）→ 三組齊發(共振3/3)最強但很稀有，平時看「紅當前提+觸發」即可；出場守紅翻負/雙B死叉。書本進場：上漲日 13:20 看盤、13:25 掛市價。
        </div>
      </div>
    </div>
  );
}
