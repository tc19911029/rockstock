'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePortfolioStore } from '@/store/portfolioStore';
import type { MarketId } from '@/lib/scanner/types';
import type { DailyActionList, HoldingMonitor, BuyRecommendation } from '@/lib/portfolio/types';
import { fetchDailyActionList } from '../api';
import { AddHoldingForm } from './AddHoldingForm';
import { SellHoldingDialog } from './SellHoldingDialog';
import { RealizedSummary } from './RealizedSummary';
import { AskCoachDialog } from './AskCoachDialog';

const ACTION_LABEL: Record<HoldingMonitor['action'], { label: string; tone: string; emoji: string }> = {
  HOLD:               { label: '繼續持有',     tone: 'text-foreground',  emoji: '⚪' },
  WATCH:              { label: '密切觀察',     tone: 'text-amber-400',   emoji: '🟡' },
  SELL_STOP:          { label: '跌破停損',     tone: 'text-red-400',     emoji: '🔴' },
  SELL_TREND:         { label: '頭頭低出場',   tone: 'text-red-400',     emoji: '🔴' },
  SELL_PROHIBITION:   { label: '觸發戒律',     tone: 'text-red-400',     emoji: '🔴' },
  SELL_ELIMINATION:   { label: '觸發淘汰法',   tone: 'text-red-400',     emoji: '🔴' },
  SELL_DABAN_BREAK:   { label: '跌破漲停 K 低', tone: 'text-red-400',     emoji: '🔴' },
};

function formatMoney(n: number): string {
  return n.toLocaleString('zh-TW', { maximumFractionDigits: 0 });
}

function formatPct(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

export function DailyActionPanel() {
  const holdings = usePortfolioStore(s => s.holdings);
  const cashBalance = usePortfolioStore(s => s.cashBalance);
  const setCashBalance = usePortfolioStore(s => s.setCashBalance);
  const removeHolding = usePortfolioStore(s => s.remove);

  const [market, setMarket] = useState<MarketId | 'ALL'>('ALL');
  const [data, setData] = useState<DailyActionList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  /** 正在賣出的持倉 + 系統建議帶入的賣價 / 原因 */
  const [sellTarget, setSellTarget] = useState<{ holdingId: string; suggestedPrice?: number; suggestedReason?: string } | null>(null);
  /** 詢問教練：null=未開、{focus:undefined}=全局、有 focus=針對特定一檔 */
  const [coachOpen, setCoachOpen] = useState<{ focus?: { kind: 'holding'; holding: HoldingMonitor } | { kind: 'buy'; rec: BuyRecommendation } } | null>(null);

  const normalizedHoldings = useMemo(() => holdings.map(h => ({
    id: h.id,
    symbol: h.symbol,
    name: h.name || h.symbol,
    market: (h.market ?? 'TW') as MarketId,
    shares: h.shares,
    costPrice: h.costPrice,
    buyDate: h.buyDate,
    entryKbar: h.entryKbar,
    notes: h.notes,
  })), [holdings]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchDailyActionList({
        market,
        cashBalance,
        cashReservePct: 0,
        useMultiTimeframe: false,
        holdings: normalizedHoldings,
      });
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fetch failed');
    } finally {
      setLoading(false);
    }
  }, [market, cashBalance, normalizedHoldings]);

  useEffect(() => { refresh(); }, [refresh]);

  const sellList = data?.holdings.filter(h => h.action.startsWith('SELL_')) ?? [];
  const watchHoldings = data?.holdings.filter(h => h.action === 'WATCH') ?? [];
  const holdList = data?.holdings.filter(h => h.action === 'HOLD') ?? [];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Header: 設定區 ───────────────────────────────────────────── */}
      <div className="shrink-0 px-3 py-2 border-b border-border bg-secondary/30 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-xs text-muted-foreground whitespace-nowrap">台股現金</label>
          <input
            type="number"
            value={cashBalance.TW}
            onChange={e => setCashBalance('TW', parseFloat(e.target.value) || 0)}
            step="10000"
            className="w-28 px-2 py-1 bg-secondary/40 border border-border rounded text-xs text-foreground"
          />
          <label className="text-xs text-muted-foreground whitespace-nowrap">陸股現金</label>
          <input
            type="number"
            value={cashBalance.CN}
            onChange={e => setCashBalance('CN', parseFloat(e.target.value) || 0)}
            step="10000"
            className="w-28 px-2 py-1 bg-secondary/40 border border-border rounded text-xs text-foreground"
          />
        </div>

        <div className="flex items-center gap-2">
          <div className="flex bg-secondary/40 rounded border border-border overflow-hidden text-xs">
            {(['ALL', 'TW', 'CN'] as const).map(m => (
              <button
                key={m}
                onClick={() => setMarket(m)}
                className={`px-2.5 py-1 transition-colors ${market === m ? 'bg-blue-500/80 text-white' : 'text-muted-foreground hover:bg-muted'}`}
              >{m === 'ALL' ? '全部' : m === 'TW' ? '台股' : '陸股'}</button>
            ))}
          </div>
          <button
            onClick={refresh}
            disabled={loading}
            className="px-2.5 py-1 bg-secondary border border-border hover:bg-muted text-foreground rounded text-xs disabled:opacity-50"
          >
            {loading ? '計算中…' : '🔄 重新計算'}
          </button>
          <button
            disabled={!data || loading}
            onClick={() => setCoachOpen({})}
            className="ml-auto px-2.5 py-1 bg-purple-500/80 hover:bg-purple-500 disabled:opacity-40 text-white rounded text-xs font-semibold"
            title="請朱老師教練解讀今日清單"
          >
            💬 問老師
          </button>
          <button
            onClick={() => setShowAddForm(s => !s)}
            className="px-2.5 py-1 bg-blue-500/80 hover:bg-blue-500 text-white rounded text-xs font-semibold"
          >
            {showAddForm ? '取消' : '➕ 我買了一檔'}
          </button>
        </div>

        {showAddForm && (
          <div className="border border-border rounded p-2 bg-card">
            <AddHoldingForm onClose={() => setShowAddForm(false)} />
          </div>
        )}
      </div>

      {/* ── Body: 操作清單 ─────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-3 text-xs">
        {error && (
          <div className="text-red-400 border border-red-500/40 rounded p-2">
            錯誤：{error}
          </div>
        )}

        {/* 帳戶總覽（每市場一張卡） */}
        {data && data.accounts.length > 0 && (
          <div className="space-y-2 pb-2 border-b border-border/60">
            {data.accounts.map(acc => (
              <div key={acc.market} className="border border-border/60 rounded p-2 bg-card/40">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] font-semibold text-foreground">
                    {acc.market === 'TW' ? '台股帳戶' : '陸股帳戶'}
                  </span>
                  <span className={`text-[11px] font-semibold ${acc.unrealizedPL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {acc.unrealizedPL >= 0 ? '+' : ''}{formatMoney(acc.unrealizedPL)} ({formatPct(acc.unrealizedPLPct)})
                  </span>
                </div>
                <div className="grid grid-cols-4 gap-1 text-[10px]">
                  <Stat label="總值" value={formatMoney(acc.totalCapital)} />
                  <Stat label="持倉" value={formatMoney(acc.invested)} />
                  <Stat label="現金" value={formatMoney(acc.cashBalance)} />
                  <Stat label="可買" value={formatMoney(acc.cashAvailable)} />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 賣出建議 */}
        {sellList.length > 0 && (
          <Section title={`🔴 今日建議賣出（${sellList.length}）`}>
            {sellList.map(h => (
              <HoldingRow
                key={h.symbol} h={h}
                onSell={() => setSellTarget({
                  holdingId: holdingIdOf(h.symbol, holdings),
                  suggestedPrice: h.currentPrice,
                  suggestedReason: h.reasons[0],
                })}
                onRemove={() => removeHolding(holdingIdOf(h.symbol, holdings))}
                onAsk={() => setCoachOpen({ focus: { kind: 'holding', holding: h } })}
              />
            ))}
          </Section>
        )}

        {/* 買入建議：六條件派 vs 打板派 分兩段（不同性質：前者是建議、後者是達標 alert） */}
        {data && (() => {
          const sixCond = data.buyRecommendations.filter(
            r => !r.scanResult.triggeredRules?.some(t => t.ruleId === 'daban'),
          );
          const daban = data.buyRecommendations.filter(
            r => r.scanResult.triggeredRules?.some(t => t.ruleId === 'daban'),
          );
          return (
            <>
              {sixCond.length > 0 && (
                <Section title={`🟢 今日建議買進（${sixCond.length}）`}>
                  {sixCond.map(r => (
                    <BuyRow
                      key={r.symbol} r={r}
                      onAsk={() => setCoachOpen({ focus: { kind: 'buy', rec: r } })}
                    />
                  ))}
                </Section>
              )}
              {daban.length > 0 && (
                <Section title={`🎯 9:25 開盤達標候選（${daban.length}・自行判斷）`}>
                  {daban.map(r => (
                    <BuyRow
                      key={r.symbol} r={r}
                      onAsk={() => setCoachOpen({ focus: { kind: 'buy', rec: r } })}
                    />
                  ))}
                </Section>
              )}
            </>
          );
        })()}

        {/* 警示觀察 */}
        {watchHoldings.length > 0 && (
          <Section title={`🟡 接近停損（${watchHoldings.length}）`}>
            {watchHoldings.map(h => (
              <HoldingRow
                key={h.symbol} h={h}
                onSell={() => setSellTarget({ holdingId: holdingIdOf(h.symbol, holdings), suggestedPrice: h.currentPrice })}
                onRemove={() => removeHolding(holdingIdOf(h.symbol, holdings))}
                onAsk={() => setCoachOpen({ focus: { kind: 'holding', holding: h } })}
              />
            ))}
          </Section>
        )}

        {/* 持有不動 */}
        {holdList.length > 0 && (
          <Section title={`⚪ 持有不動（${holdList.length}）`}>
            {holdList.map(h => (
              <HoldingRow
                key={h.symbol} h={h}
                onSell={() => setSellTarget({ holdingId: holdingIdOf(h.symbol, holdings), suggestedPrice: h.currentPrice })}
                onRemove={() => removeHolding(holdingIdOf(h.symbol, holdings))}
                onAsk={() => setCoachOpen({ focus: { kind: 'holding', holding: h } })}
              />
            ))}
          </Section>
        )}

        {/* 觀察清單（候選但沒推薦） */}
        {data && data.watchList.length > 0 && (
          <Section title={`👀 候選觀察（${data.watchList.length}）`}>
            {data.watchList.map(w => (
              <div key={w.symbol} className="border border-border/60 rounded p-2 bg-card/40">
                <div className="font-semibold">{w.symbol} {w.name}</div>
                <div className="text-muted-foreground">
                  {w.currentPrice.toFixed(2)} ・ {w.reason}
                </div>
              </div>
            ))}
          </Section>
        )}

        {data && data.holdings.length === 0 && data.buyRecommendations.length === 0 && (
          <div className="text-muted-foreground text-center py-8">
            尚未有持倉。點右上「➕ 我買了一檔」登記。
          </div>
        )}

        {/* 已實現損益（永遠顯示，沒紀錄會自動隱藏） */}
        <RealizedSummary />

        {data && (
          <div className="text-muted-foreground text-[10px] pt-2 border-t border-border/40">
            資料截止：{data.asOfDate} ・ 候選池來自最新 L4 掃描結果
          </div>
        )}
      </div>

      {/* 賣出對話框 */}
      {sellTarget && (() => {
        const holding = holdings.find(h => h.id === sellTarget.holdingId);
        if (!holding) return null;
        return (
          <SellHoldingDialog
            holding={holding}
            suggestedPrice={sellTarget.suggestedPrice}
            suggestedReason={sellTarget.suggestedReason}
            onClose={() => setSellTarget(null)}
          />
        );
      })()}

      {/* 問老師對話框 */}
      {coachOpen && data && (
        <AskCoachDialog
          data={data}
          focusItem={coachOpen.focus}
          onClose={() => setCoachOpen(null)}
        />
      )}
    </div>
  );
}

function holdingIdOf(symbol: string, all: ReturnType<typeof usePortfolioStore.getState>['holdings']): string {
  return all.find(h => h.symbol === symbol)?.id ?? '';
}

function Stat({ label, value, tone = 'text-foreground' }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-muted-foreground text-[10px]">{label}</div>
      <div className={`font-semibold ${tone}`}>{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="font-semibold text-foreground">{title}</div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function HoldingRow({ h, onSell, onRemove, onAsk }: { h: HoldingMonitor; onSell: () => void; onRemove: () => void; onAsk: () => void }) {
  const conf = ACTION_LABEL[h.action];
  return (
    <div className="border border-border/60 rounded p-2 bg-card/40 space-y-1">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`font-semibold ${conf.tone}`}>
            {conf.emoji} {h.symbol} {h.name}
          </span>
          <span className="text-[10px] px-1 py-0.5 bg-secondary/60 rounded text-muted-foreground">
            {h.market}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onAsk}
            className="text-[10px] text-purple-300 hover:text-purple-200 px-1 py-0.5 rounded hover:bg-purple-500/10"
            title="問老師教練"
          >💬</button>
          <button
            onClick={onSell}
            className="text-[10px] text-emerald-300 hover:text-emerald-200 px-1.5 py-0.5 rounded bg-emerald-500/10 hover:bg-emerald-500/20"
            title="登記賣出（記錄已實現損益）"
          >✅ 賣出</button>
          <button
            onClick={() => {
              if (confirm(`確定要刪除 ${h.symbol} 的持倉紀錄嗎？\n（這只是清除紀錄，不會記錄賣出損益）`)) onRemove();
            }}
            className="text-[10px] text-muted-foreground hover:text-red-400 px-1 py-0.5 rounded hover:bg-muted"
            title="刪除（不記錄損益）"
          >🗑️</button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
        <div className="text-muted-foreground">
          現價 <span className="text-foreground">{h.currentPrice.toFixed(2)}</span>
        </div>
        <div className="text-muted-foreground">
          成本 <span className="text-foreground">{h.costPrice.toFixed(2)}</span>
        </div>
        <div className="text-muted-foreground">
          停損 <span className="text-foreground">{h.stopLossPrice.toFixed(2)}</span>
          <span className={`ml-1 ${h.stopLossDistancePct < 0 ? 'text-red-400' : 'text-muted-foreground'}`}>
            ({formatPct(h.stopLossDistancePct)})
          </span>
        </div>
        <div className="text-muted-foreground">
          損益 <span className={h.unrealizedPL >= 0 ? 'text-emerald-400' : 'text-red-400'}>
            {h.unrealizedPL >= 0 ? '+' : ''}{formatMoney(h.unrealizedPL)} ({formatPct(h.unrealizedPLPct)})
          </span>
        </div>
      </div>
      {h.reasons.length > 0 && (
        <div className={`text-[11px] ${conf.tone}`}>
          {h.reasons[0]}
        </div>
      )}
      {h.warnings.length > 0 && (
        <div className="text-[11px] text-amber-400">
          ⚠️ {h.warnings[0]}
        </div>
      )}
      <div className="text-[10px] text-muted-foreground/80">
        停損依據：{h.stopLossBasis}
      </div>
    </div>
  );
}

function BuyRow({ r, onAsk }: { r: BuyRecommendation; onAsk: () => void }) {
  return (
    <div className="border border-emerald-600/40 rounded p-2 bg-emerald-500/5 space-y-1">
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold text-emerald-300">
          🟢 #{r.rank} {r.symbol} {r.name}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onAsk}
            className="text-[10px] text-purple-300 hover:text-purple-200 px-1 py-0.5 rounded hover:bg-purple-500/10"
            title="問老師教練"
          >💬</button>
          <span className="text-[10px] px-1 py-0.5 bg-secondary/60 rounded text-muted-foreground">{r.market}</span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
        <div className="text-muted-foreground">
          進場 <span className="text-foreground">{r.entryPrice.toFixed(2)}</span>
        </div>
        <div className="text-muted-foreground">
          停損 <span className="text-foreground">{r.stopLossPrice.toFixed(2)}</span>
          <span className="text-muted-foreground"> (-{r.stopLossDistancePct}%)</span>
        </div>
        <div className="text-muted-foreground">
          股數 <span className="text-foreground">{formatMoney(r.suggestedShares)}</span>
        </div>
        <div className="text-muted-foreground">
          金額 <span className="text-foreground">{formatMoney(r.suggestedAmount)}</span>
          <span className="text-muted-foreground"> ({r.positionPct}%)</span>
        </div>
        <div className="text-muted-foreground col-span-2">
          風險金額 <span className="text-amber-300">{formatMoney(r.riskAmount)}</span>（觸發停損會虧）
        </div>
      </div>
      {r.reasons.length > 0 && (
        <div className="text-[11px] text-muted-foreground">
          {r.reasons.map((reason, i) => <div key={i}>・{reason}</div>)}
        </div>
      )}
    </div>
  );
}
