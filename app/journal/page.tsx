'use client';

/**
 * /journal — 交易日誌
 *
 * 顯示 trades.json 的已平倉交易 join trade-journal.json annotations。
 * 每筆可編輯 entryReason / exitRule / postMortem / lessons / executionScore。
 *
 * 上方 stats: 累計交易數 / 勝率 / 平均 hold 天 / 各 exitReason 分布。
 *
 * trades.json 本身 append-only — 註記寫到 overlay file（lib/portfolio/tradeJournal.ts）
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PageShell, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { formatNT } from '@/lib/portfolio/useTotalCapital';

interface ClosedTrade {
  tradeId: string;
  symbol: string;
  name: string;
  industry?: string;
  entryDate: string;
  entryPrice: number;
  shares: number;
  exitDate: string;
  exitPrice: number;
  exitReason: string;
  exitNote?: string;
  holdDays: number;
  grossPnL: number;
  fees: number;
  netPnL: number;
  netReturnPct: number;
  stopLoss?: number;
  triggerSignal?: string;
}

interface JournalEntry {
  tradeId: string;
  entryReason?: string;
  exitRule?: string;
  postMortem?: string;
  lessons?: string[];
  executionScore?: number;
  updatedAt: string;
}

interface ItemJoin {
  trade: ClosedTrade;
  journal: JournalEntry | null;
}

const EXIT_REASON_ZH: Record<string, string> = {
  target_hit: '🎯 達目標',
  stop_loss: '🛑 停損',
  discipline_break: '⚠ 戒律觸發',
  risk_red: '🚨 風控紅燈',
  hold_days_max: '⏰ 持有上限',
  manual: '✋ 人工',
  swap: '🔄 換股',
  other: '— 其他',
};

export default function JournalPage() {
  const [items, setItems] = useState<ItemJoin[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterWinLose, setFilterWinLose] = useState<'all' | 'win' | 'lose'>('all');

  async function refresh() {
    setLoading(true);
    try {
      const r = await fetch('/api/portfolio/trade-journal').then(r => r.json());
      setItems((r?.items as ItemJoin[]) ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  const stats = useMemo(() => {
    const all = items.map(i => i.trade);
    if (all.length === 0) return null;
    const wins = all.filter(t => t.netPnL > 0);
    const losses = all.filter(t => t.netPnL < 0);
    const totalPnL = all.reduce((s, t) => s + t.netPnL, 0);
    const avgHold = all.reduce((s, t) => s + t.holdDays, 0) / all.length;
    const avgWinPct = wins.length > 0 ? wins.reduce((s, t) => s + t.netReturnPct, 0) / wins.length : 0;
    const avgLossPct = losses.length > 0 ? losses.reduce((s, t) => s + t.netReturnPct, 0) / losses.length : 0;
    const reasonDist: Record<string, number> = {};
    for (const t of all) reasonDist[t.exitReason] = (reasonDist[t.exitReason] ?? 0) + 1;
    return {
      total: all.length,
      wins: wins.length,
      losses: losses.length,
      winRate: (wins.length / all.length) * 100,
      totalPnL,
      avgHold,
      avgWinPct,
      avgLossPct,
      // 0 敗時盈虧比未定義（不是 0）— 用 null 代表「尚無虧損」，顯示層轉成 ∞
      payoffRatio: avgLossPct !== 0 ? Math.abs(avgWinPct / avgLossPct) : null,
      reasonDist,
    };
  }, [items]);

  const filtered = items.filter(i => {
    if (filterWinLose === 'win') return i.trade.netPnL > 0;
    if (filterWinLose === 'lose') return i.trade.netPnL < 0;
    return true;
  });

  const header = <PageHeader title="📓 交易日誌" backButton subtitle="已平倉交易 + 進場理由 / 出場規則 / 事後 review" />;

  return (
    <PageShell headerSlot={header}>
      <div className="max-w-6xl mx-auto px-4 py-4 space-y-4">

        {/* Stats */}
        {stats && (
          <section className="grid grid-cols-2 md:grid-cols-5 gap-2">
            <StatCard label="累計" value={`${stats.total} 筆`} />
            <StatCard label="勝率" value={`${stats.winRate.toFixed(1)}%`} tone={stats.winRate >= 50 ? 'good' : 'warn'} />
            <StatCard label="累計損益" value={formatNT(stats.totalPnL)} tone={stats.totalPnL >= 0 ? 'good' : 'bad'} />
            <StatCard label="平均持有" value={`${stats.avgHold.toFixed(1)} 天`} />
            <StatCard label="盈虧比"
              value={stats.payoffRatio == null ? (stats.wins > 0 ? '∞' : '—') : stats.payoffRatio.toFixed(2)}
              tone={stats.payoffRatio == null ? (stats.wins > 0 ? 'good' : undefined) : stats.payoffRatio >= 1.5 ? 'good' : 'warn'}
              hint={`勝 +${stats.avgWinPct.toFixed(1)}% / 敗 ${stats.losses > 0 ? stats.avgLossPct.toFixed(1) + '%' : '— 尚無虧損'}`} />
          </section>
        )}

        {stats && Object.keys(stats.reasonDist).length > 0 && (
          <section className="text-xs flex items-center gap-2 flex-wrap text-muted-foreground">
            <span>出場原因：</span>
            {Object.entries(stats.reasonDist).map(([reason, count]) => (
              <span key={reason} className="px-2 py-0.5 rounded bg-secondary border border-border">
                {EXIT_REASON_ZH[reason] ?? reason} × {count}
              </span>
            ))}
          </section>
        )}

        {/* Filter */}
        <section className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">過濾：</span>
          {(['all', 'win', 'lose'] as const).map(f => (
            <button
              key={f}
              type="button"
              onClick={() => setFilterWinLose(f)}
              className={`px-2 py-1 rounded ${
                filterWinLose === f
                  ? 'bg-sky-900/40 text-sky-300 border border-sky-700/50'
                  : 'bg-secondary text-muted-foreground hover:text-foreground border border-border'
              }`}
            >
              {f === 'all' ? '全部' : f === 'win' ? '勝' : '敗'}
            </button>
          ))}
        </section>

        {/* List */}
        {loading && <p className="text-sm text-muted-foreground text-center py-8">載入中…</p>}
        {!loading && filtered.length === 0 && (
          <div className="text-center py-12 text-sm text-muted-foreground space-y-2">
            <p className="text-4xl">📓</p>
            <p>{items.length === 0 ? '尚未有任何已平倉交易' : '此 filter 下無交易'}</p>
            {items.length === 0 && (
              <p className="text-xs">
                在 <Link href="/portfolio" className="underline text-sky-400">/portfolio</Link> 平倉後會自動寫入 trades.json
              </p>
            )}
          </div>
        )}

        {!loading && filtered.map(item => (
          <TradeCard key={item.trade.tradeId} item={item} onSaved={refresh} />
        ))}
      </div>
    </PageShell>
  );
}

function StatCard({ label, value, tone, hint }: { label: string; value: string; tone?: 'good' | 'bad' | 'warn'; hint?: string }) {
  const cls = {
    good: 'border-emerald-700/40 bg-emerald-900/15',
    bad:  'border-red-700/40 bg-red-900/15',
    warn: 'border-amber-700/40 bg-amber-900/15',
    undefined: 'border-border bg-card',
  }[tone ?? 'undefined'] ?? 'border-border bg-card';
  return (
    <div className={`rounded-lg border p-3 ${cls}`} title={hint}>
      <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</div>
      <div className="text-lg font-bold font-mono mt-0.5">{value}</div>
      {hint && <div className="text-[9px] text-muted-foreground/70 mt-0.5">{hint}</div>}
    </div>
  );
}

function TradeCard({ item, onSaved }: { item: ItemJoin; onSaved: () => void }) {
  const { trade, journal } = item;
  const win = trade.netPnL > 0;
  const [edit, setEdit] = useState(false);
  const [entryReason, setEntryReason] = useState(journal?.entryReason ?? '');
  const [exitRule, setExitRule] = useState(journal?.exitRule ?? '');
  const [postMortem, setPostMortem] = useState(journal?.postMortem ?? '');
  const [lessonsRaw, setLessonsRaw] = useState((journal?.lessons ?? []).join('\n'));
  const [exec, setExec] = useState(journal?.executionScore ?? 3);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const lessons = lessonsRaw.split('\n').map(s => s.trim()).filter(Boolean);
      await fetch('/api/portfolio/trade-journal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tradeId: trade.tradeId,
          entryReason, exitRule, postMortem, lessons,
          executionScore: exec,
        }),
      });
      setEdit(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className={`rounded-lg border p-3 space-y-2 ${
      win ? 'border-emerald-700/40 bg-emerald-900/10' : 'border-red-700/40 bg-red-900/10'
    }`}>
      {/* Header */}
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <span className="font-bold text-base">{trade.name}</span>
          <span className="font-mono text-xs text-muted-foreground ml-2">{trade.symbol}</span>
          {trade.industry && <span className="text-xs text-muted-foreground ml-2">· {trade.industry}</span>}
        </div>
        <div className={`text-base font-bold font-mono ${win ? 'text-bull' : 'text-bear'}`}>
          {win ? '+' : ''}{formatNT(trade.netPnL)} ({trade.netReturnPct >= 0 ? '+' : ''}{trade.netReturnPct.toFixed(2)}%)
        </div>
      </header>

      {/* Trade facts */}
      <div className="text-[11px] text-muted-foreground font-mono grid grid-cols-2 md:grid-cols-4 gap-x-3 gap-y-1">
        <div>進場 {trade.entryDate} @ {trade.entryPrice}</div>
        <div>出場 {trade.exitDate} @ {trade.exitPrice}</div>
        <div>持有 {trade.holdDays} 天 · {trade.shares.toLocaleString()} 股</div>
        <div>{EXIT_REASON_ZH[trade.exitReason] ?? trade.exitReason}{trade.exitNote ? ` · ${trade.exitNote}` : ''}</div>
        {trade.stopLoss && <div>停損 {trade.stopLoss}（{trade.exitPrice <= trade.stopLoss ? '已觸發' : '未觸發'}）</div>}
        {trade.triggerSignal && <div>進場字母 {trade.triggerSignal}</div>}
        <div className="text-muted-foreground/60">手續費+稅 {formatNT(trade.fees)}</div>
      </div>

      {/* Journal */}
      {!edit && (
        <div className="border-t border-border/40 pt-2 space-y-1 text-xs">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-muted-foreground text-[10px]">日誌</span>
            <Button variant="secondary" size="sm" onClick={() => setEdit(true)} className="text-[10px] h-6 px-2">
              {journal ? '編輯' : '+ 寫日誌'}
            </Button>
          </div>
          {journal ? (
            <div className="space-y-1 text-foreground/80">
              {journal.entryReason && <div><span className="text-emerald-400">進場理由：</span>{journal.entryReason}</div>}
              {journal.exitRule && <div><span className="text-amber-400">出場規則：</span>{journal.exitRule}</div>}
              {journal.postMortem && <div><span className="text-sky-400">事後 review：</span>{journal.postMortem}</div>}
              {journal.lessons && journal.lessons.length > 0 && (
                <ul className="ml-4 list-disc text-muted-foreground">
                  {journal.lessons.map((l, i) => <li key={i}>{l}</li>)}
                </ul>
              )}
              {journal.executionScore != null && (
                <div className="text-muted-foreground">執行 {'★'.repeat(journal.executionScore)}{'☆'.repeat(5 - journal.executionScore)}</div>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground italic">無日誌記錄</p>
          )}
        </div>
      )}

      {edit && (
        <div className="border-t border-border/40 pt-2 space-y-2 text-xs">
          <Textarea label="進場理由（為什麼買？book rule / signal / 多源共識）" value={entryReason} onChange={setEntryReason} />
          <Textarea label="出場規則（什麼時候會出？守紅K低 / MA5 跌破 / 10 日換股）" value={exitRule} onChange={setExitRule} />
          <Textarea label="事後 review（對在哪、錯在哪、下次怎麼做）" value={postMortem} onChange={setPostMortem} />
          <Textarea label="lessons（一行一條，從這筆學到什麼）" value={lessonsRaw} onChange={setLessonsRaw} />
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">執行契合度：</span>
            {[1, 2, 3, 4, 5].map(n => (
              <button key={n} type="button" onClick={() => setExec(n)}
                className={`text-base ${n <= exec ? 'text-amber-400' : 'text-muted-foreground/30'}`}>
                ★
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <Button onClick={save} disabled={saving} className="bg-sky-600 hover:bg-sky-500 text-xs h-7">
              {saving ? '存中…' : '儲存'}
            </Button>
            <Button variant="secondary" onClick={() => setEdit(false)} className="text-xs h-7">取消</Button>
          </div>
        </div>
      )}
    </article>
  );
}

function Textarea({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="text-[10px] text-muted-foreground block mb-0.5">{label}</label>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={2}
        className="w-full bg-background border border-border rounded px-2 py-1 text-xs font-mono resize-vertical"
      />
    </div>
  );
}
