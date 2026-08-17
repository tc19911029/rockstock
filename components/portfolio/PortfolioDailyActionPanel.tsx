'use client';

import { useCallback, useEffect, useState } from 'react';
import type { DailyActionResponse, DailyActionItem } from '@/app/api/portfolio/daily-action/route';
import { PARTIAL_EXIT_SIGNAL_TYPE_SET } from '@/lib/portfolio/holdingExecution';
import type { HoldingAction } from '@/lib/agents/holdingsActionEngine';
import { MarketRegimeFlag } from '@/components/MarketRegimeFlag';
import { usePortfolioProfileStore } from '@/store/portfolioProfileStore';

const ACTION_CLASS: Record<HoldingAction | 'no_data', string> = {
  stop_loss:   'bg-red-900/60 text-red-100 border-red-500',
  exit_all:    'bg-orange-900/60 text-orange-100 border-orange-500',
  reduce_half: 'bg-amber-900/60 text-amber-100 border-amber-500',
  watch_stop:  'bg-yellow-900/40 text-yellow-200 border-yellow-700',
  can_add:     'bg-cyan-900/50 text-cyan-100 border-cyan-500',
  hold:        'bg-slate-800/60 text-slate-200 border-slate-600',
  cover_all:   'bg-orange-900/60 text-orange-100 border-orange-500', // 賠少-1：做空回補
  no_data:     'bg-secondary text-muted-foreground border-border',
};

function fmtCurrency(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '−';
  const abs = Math.abs(Math.round(n));
  return `${sign}NT$${abs.toLocaleString()}`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`;
}

export function PortfolioDailyActionPanel() {
  const [data, setData] = useState<DailyActionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const activeProfileId = usePortfolioProfileStore(s => s.activeProfileId);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/portfolio/daily-action?profile=${encodeURIComponent(activeProfileId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? 'unknown error');
      setData(json as DailyActionResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'fetch failed');
    } finally {
      setLoading(false);
    }
  }, [activeProfileId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (loading && !data) {
    return (
      <div className="rounded-xl ring-1 ring-foreground/10 bg-card p-3 text-xs text-muted-foreground">
        持倉 daily action 載入中…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-rose-700/50 bg-rose-950/30 p-3 text-xs text-rose-200">
        ⚠ daily-action 載入失敗：{error}
        <button type="button" onClick={fetchData} className="ml-2 underline">重試</button>
      </div>
    );
  }

  if (!data || data.items.length === 0) return null;

  const actionable = data.items.filter(it =>
    ['stop_loss', 'exit_all', 'reduce_half', 'watch_stop', 'cover_all'].includes(it.action),
  );

  return (
    <div className="rounded-xl ring-1 ring-foreground/10 bg-card overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-gradient-to-r from-sky-900/30 to-transparent border-b border-border">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-foreground">📋 今日操作建議</span>
          <MarketRegimeFlag regime={data.marketRegime} size="xs" />
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>帳上 <span className={`font-mono font-bold ${data.totalUnrealized >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{fmtCurrency(data.totalUnrealized)}</span></span>
          <button type="button" onClick={fetchData} className="text-sky-400 hover:underline" title="重新抓即時報價">↻</button>
        </div>
      </div>

      {actionable.length > 0 && (
        <div className="px-3 py-1.5 bg-amber-950/30 border-b border-amber-900/50 text-[11px] text-amber-200">
          ⚠ 有 {actionable.length} 檔需要動作：{actionable.map(it => it.name).join('、')}
        </div>
      )}

      <div className="divide-y divide-border/50">
        {data.items.map(it => (
          <DailyActionRow key={it.symbol} item={it} />
        ))}
      </div>

      <div className="px-3 py-1.5 text-[9px] text-muted-foreground/70 bg-secondary/30 border-t border-border">
        💡 訊號依朱家泓寶典＋課程：跌破 MA5+漲≥10% → 減半｜跌破 MA10+漲≥10% → 全出｜跌破 MA20+漲≥20% → 全出｜賺&gt;20% 破 MA5 → 全出（CH8-4）｜爆量反轉+賺&gt;15% → 先賣1/2、次日下跌全出（CH9-3）｜當日跌&gt;5% 列警示股、套牢分級（CH10-1）。課程停損口徑=進場價 −5% 收盤確認（系統各軌 5/7/10% 為回測背書值）。不是 financial advice。
      </div>
    </div>
  );
}

function DailyActionRow({ item }: { item: DailyActionItem }) {
  const cls = ACTION_CLASS[item.action];
  const isProfit = (item.profitPct ?? 0) >= 0;
  const activeProfileId = usePortfolioProfileStore(s => s.activeProfileId);
  const [saving, setSaving] = useState<'partial' | 'stop' | null>(null);

  const patchHolding = async (body: Record<string, unknown>, kind: 'partial' | 'stop') => {
    setSaving(kind);
    try {
      const res = await fetch(`/api/agents/portfolio?profile=${encodeURIComponent(activeProfileId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      window.location.reload();
    } catch (error) {
      window.alert(`保存失敗：${error instanceof Error ? error.message : String(error)}`);
      setSaving(null);
    }
  };

  const confirmHalf = () => {
    const signal = item.signals.find(s => PARTIAL_EXIT_SIGNAL_TYPE_SET.has(s.type));
    if (!signal || !item.asOfDate) return;
    if (!window.confirm(`確認「${item.name}」已依 ${signal.label} 賣出一半？\n\n確認後會把 server 持股數更新為剩餘股數，並留下執行紀錄。`)) return;
    void patchHolding({
      action: 'confirm_partial_exit',
      symbol: item.symbol,
      signalDate: item.asOfDate,
      signalType: signal.type,
      executionPrice: item.todayClose ?? undefined,
    }, 'partial');
  };

  const applyStop = () => {
    if (!item.asOfDate || !item.stopLossMethod) return;
    if (!window.confirm(`套用「${item.name}」策略停損 ${item.stopLoss.toFixed(2)}？\n\n停損只能往有利方向收緊，不能放寬。`)) return;
    void patchHolding({
      action: 'apply_stop_loss',
      symbol: item.symbol,
      price: item.stopLoss,
      method: item.stopLossMethod,
      sourceDate: item.asOfDate,
      positionSide: item.positionSide,
    }, 'stop');
  };
  return (
    <div className="px-3 py-2 hover:bg-muted/30 transition-colors">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 min-w-0">
          {item.positionSide === 'short' && (
            <span className="text-[9px] px-1 rounded bg-rose-900/50 text-rose-200 border border-rose-700" title="做空（放空）部位">🔻空</span>
          )}
          <span className="font-mono text-[11px] text-foreground/80">{item.symbol.replace(/\.(TW|TWO)$/, '')}</span>
          <span className="text-xs font-medium text-foreground truncate">{item.name}</span>
        </div>
        <span
          className={`text-[11px] px-1.5 py-0.5 rounded border font-bold ${cls}`}
          title={item.signals.map(s => `${s.label}: ${s.detail}`).join('\n') || `帳務成本 ${item.entryPrice}, 策略參考 ${item.strategyReferencePrice ?? item.entryPrice}, 停損 ${item.stopLoss}`}
        >
          {item.label}
        </span>
        {item.intradayProvisional && item.action !== 'hold' && item.action !== 'no_data' && (
          <span className="text-[9px] px-1 rounded bg-amber-950/50 text-amber-300 border border-amber-800" title="課程鐵律：均線/K線出場要「收盤確認」。現在是盤中半根K，尾盤可能拉回 — 13:20 再看一次收盤價確認（固定停損觸價除外）。">
            盤中預警·收盤確認
          </span>
        )}
        {item.entryPrice === 0 && item.strategyReferencePrice != null && (
          <span className="text-[9px] px-1 rounded bg-violet-950/50 text-violet-300 border border-violet-800" title="帳務成本維持 0；技術停損與報酬判定使用取得日附近市場價，不會改寫持倉成本。">
            零成本·策略參考 {item.strategyReferencePrice.toFixed(2)}
          </span>
        )}
        <div className="flex-1" />
        <span className="text-[11px] font-mono">
          today <span className="text-foreground font-bold">{item.todayClose?.toFixed(2) ?? '—'}</span>
        </span>
        <span className={`text-[11px] font-mono font-bold ${isProfit ? 'text-emerald-300' : 'text-rose-300'}`} title="總報酬（買進至今未實現），非今日漲跌幅">
          總 {fmtPct(item.profitPct)}
        </span>
        <span className={`text-[10px] font-mono ${isProfit ? 'text-emerald-400/70' : 'text-rose-400/70'}`}>
          {fmtCurrency(item.unrealizedAmount)}
        </span>
      </div>

      <div className="mt-1 flex items-center gap-2 flex-wrap text-[10px]">
        {item.signals.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            {item.signals.map((s, i) => (
              <span
                key={i}
                title={s.detail}
                className={`px-1 rounded ${
                  s.severity === 'high' ? 'bg-rose-900/40 text-rose-200'
                  : s.severity === 'medium' ? 'bg-amber-900/40 text-amber-200'
                  : 'bg-cyan-900/40 text-cyan-200'
                }`}
              >
                {s.label}
              </span>
            ))}
          </div>
        )}

        {item.positionSide !== 'short' && item.suggestedStop != null && item.suggestedStop > item.stopLoss + 0.01 && (
          <span className="text-cyan-300/80" title="建議把停損上移到此價（鎖獲利）">
            💡 停損上移 {item.stopLoss.toFixed(2)} → <span className="font-bold">{item.suggestedStop.toFixed(2)}</span>
          </span>
        )}

        {item.action === 'reduce_half' && !item.partialExitExecuted && item.asOfDate && (
          <button
            type="button"
            onClick={confirmHalf}
            disabled={saving != null}
            className="min-h-8 rounded border border-amber-600 bg-amber-900/40 px-2 font-bold text-amber-100 disabled:opacity-50"
          >
            {saving === 'partial' ? '保存中…' : '確認已執行賣半'}
          </button>
        )}

        {item.positionSide !== 'short' && item.stopLossSource === 'strategy_dynamic' && item.asOfDate && (
          <button
            type="button"
            onClick={applyStop}
            disabled={saving != null}
            className="min-h-8 rounded border border-cyan-700 bg-cyan-950/40 px-2 font-bold text-cyan-200 disabled:opacity-50"
            title={item.stopLossMethod}
          >
            {saving === 'stop' ? '保存中…' : `保存策略停損 ${item.stopLoss.toFixed(2)}`}
          </button>
        )}

        {item.positionSide !== 'short' && item.nearestTarget != null && (
          <span className="text-violet-300/80" title="課程 CH9-2：六種壓力位（長均線/前高/切線/盤整區/缺口/大量黑K）中最近的上方壓力，作獲利目標預估。純顯示。">
            🎯 壓力 <span className="font-bold">{item.nearestTarget.toFixed(2)}</span>
            {item.todayClose != null && item.todayClose > 0 && (
              <span className="opacity-70">（+{((item.nearestTarget / item.todayClose - 1) * 100).toFixed(1)}%）</span>
            )}
          </span>
        )}

        {item.metrics && (
          <span className="text-muted-foreground/70 ml-auto font-mono">
            MA5 {item.metrics.ma5?.toFixed(1) ?? '—'} ｜
            MA10 {item.metrics.ma10?.toFixed(1) ?? '—'} ｜
            MA20 {item.metrics.ma20?.toFixed(1) ?? '—'}
          </span>
        )}
      </div>
    </div>
  );
}
