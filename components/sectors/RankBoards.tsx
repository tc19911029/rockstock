'use client';

/**
 * 資金流入 / 資金輪動 排行榜面板（2026-06-19）— 台股題材 + 陸股板塊共用。
 *
 * 兩種排名（顯示層，描述性，不參與選股 鐵則 #5）：
 *   💰 資金流入：誰今天最強/錢最多。給兩個指標都顯示：
 *       - 依今日漲幅
 *       - 依今日金額（台股=法人買超金額、陸股=主力淨流入）
 *   🔄 資金輪動：今日漲幅「名次」vs 昨天爬升最多的（a→b名）。
 *
 * 2026-06-19 改日線：原本用 5 日漲幅 + 比 5 交易日前，反應太慢 → 全改今天 vs 昨天。
 * 名次基準＝各市場用「今日漲幅」互相排名次（與 /sectors 輪動欄同一套）。
 */

import { bullBearClass } from '@/lib/format';

export interface RankItem {
  key: string;
  name: string;
  /** 漲幅（5日漲幅，%）— 資金流入·漲幅指標 */
  pct: number | null;
  /** 金額（元）— 台股法人買超 / 陸股主力淨流入 */
  money: number | null;
  /** 近 5 交易日名次變化（正 = 爬升）；無 prior = null */
  rotDelta: number | null;
  rotPrev: number | null;
  rotNow: number | null;
}

function fmtPct(v: number | null) {
  if (v == null) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}
function fmtMoney(v: number | null) {
  if (v == null) return '—';
  const a = Math.abs(v);
  const t = a >= 1e8 ? `${(v / 1e8).toFixed(1)}億` : a >= 1e4 ? `${Math.round(v / 1e4)}萬` : `${Math.round(v)}`;
  return `${v > 0 ? '+' : ''}${t}`;
}

function MiniList({ title, hint, rows }: {
  title: string; hint: string;
  rows: Array<{ key: string; name: string; valueText: string; valueClass?: string; sub?: string }>;
}) {
  return (
    <div className="rounded-lg ring-1 ring-foreground/10 bg-card/60 p-3">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-[10px] text-muted-foreground/60">{hint}</span>
      </div>
      {rows.length === 0 ? (
        <div className="text-xs text-muted-foreground/50 py-2">資料不足</div>
      ) : (
        <ol className="space-y-1">
          {rows.map((r, i) => (
            <li key={r.key} className="flex items-center gap-2 text-sm">
              <span className={`w-4 text-right tabular-nums ${i === 0 ? 'text-orange-400 font-semibold' : 'text-muted-foreground/50'}`}>{i + 1}</span>
              <span className="flex-1 truncate">{r.name}</span>
              {r.sub && <span className="text-[10px] text-muted-foreground/60 tabular-nums whitespace-nowrap">{r.sub}</span>}
              <span className={`tabular-nums whitespace-nowrap ${r.valueClass ?? ''}`}>{r.valueText}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function FlowRotationBoards({ items, moneyLabel, topN = 5 }: {
  items: RankItem[]; moneyLabel: string; topN?: number;
}) {
  const byPct = [...items].filter((x) => x.pct != null).sort((a, b) => (b.pct! - a.pct!)).slice(0, topN);
  const byMoney = [...items].filter((x) => x.money != null).sort((a, b) => (b.money! - a.money!)).slice(0, topN);
  // 輪動：只列有 prior 名次且確實往上爬（rotDelta > 0）的，由爬最多排起
  const byRot = [...items].filter((x) => x.rotDelta != null && x.rotDelta > 0).sort((a, b) => (b.rotDelta! - a.rotDelta!)).slice(0, topN);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
      <MiniList
        title="💰 資金流入·漲幅"
        hint="今日漲最多"
        rows={byPct.map((x) => ({ key: x.key, name: x.name, valueText: fmtPct(x.pct), valueClass: bullBearClass(x.pct) }))}
      />
      <MiniList
        title={`💰 資金流入·${moneyLabel}`}
        hint="今日買最多"
        rows={byMoney.map((x) => ({ key: x.key, name: x.name, valueText: fmtMoney(x.money), valueClass: bullBearClass(x.money) }))}
      />
      <MiniList
        title="🔄 資金輪動"
        hint="昨天→今天爬升"
        rows={byRot.map((x) => ({
          key: x.key, name: x.name,
          sub: x.rotPrev != null && x.rotNow != null ? `${x.rotPrev}→${x.rotNow}名` : undefined,
          valueText: `+${x.rotDelta}`, valueClass: 'text-bull',
        }))}
      />
    </div>
  );
}
