'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { ChevronDown, Star, Briefcase, Plus, Pencil, Trash2 } from 'lucide-react';
import { POLLING } from '@/lib/config';
import { useWatchlistStore } from '@/store/watchlistStore';
import { usePortfolioStore, type PortfolioHolding } from '@/store/portfolioStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useReplayStore } from '@/store/replayStore';
import { type MarketTab, filterByMarket, classifyMarket, isFundSymbol } from '@/lib/market/classify';
import { ChartPracticeLedger } from '@/components/ChartPracticeLedger';
import { PortfolioProfileSwitcher } from '@/components/portfolio/PortfolioProfileSwitcher';
import { calcNetPnL, formatPrice } from '@/lib/portfolio/fees';
import { formatHoldingQty, marketFromSymbol, sharesToLots, unitLabelOf } from '@/lib/utils/shareUnits';
import { formatPercent, bullBearClass } from '@/lib/format';
import { fetchResolvedStockQuote } from '@/lib/stocks/fetchResolvedStockQuote';
import { isPlaceholderStockName, stockCodeOf, stockDisplayName } from '@/lib/stocks/stockIdentity';

// ── Types ────────────────────────────────────────────────────────────────────

interface PriceInfo {
  price: number;
  changePercent: number;
  name?: string;
  loading?: boolean;
  error?: string;
}

type PanelTab = 'watchlist' | 'portfolio';

// ── Helpers ──────────────────────────────────────────────────────────────────

function stripSuffix(symbol: string) {
  return symbol.replace(/\.(TW|TWO|SS|SZ|OF)$/i, '');
}

function formatMoney(n: number) {
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${(n / 1e8).toFixed(1)}億`;
  if (abs >= 1e4) return `${(n / 1e4).toFixed(1)}萬`;
  return n.toLocaleString('zh-TW', { maximumFractionDigits: 0 });
}

/**
 * 今日損益 = 股數 × (現價 − 昨收)。
 * PriceInfo 只有漲跌幅沒有昨收，故用 昨收 = 現價 / (1 + 漲幅%) 反推。
 * 基數必須是「昨收」不是「現價」—— 用現價當基數會把今日損益放大 (1 + 漲幅) 倍
 * （上漲日系統性高估、下跌日系統性高估虧損）。
 * 注意：當日盤中加碼的股數，券商以買進價計當日損益、此處仍用昨收，
 * 故加碼當天仍會偏離券商；T+1 後自動一致（屬持倉快照模型先天限制，非此公式問題）。
 */
function dayPnL(shares: number, cur: number, changePercent: number): number {
  if (cur <= 0) return 0;
  const prevClose = cur / (1 + changePercent / 100);
  if (!(prevClose > 0)) return 0;
  return shares * (cur - prevClose);
}

/** 取得 CST (Asia/Taipei) 今天 YYYY-MM-DD — 避免 UTC 凌晨回退前一天 */
function todayCST(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
}

/** 抓某 symbol 指定日（或往前最近一日）的收盤價，給「用當日收盤」自動填成本價用 */
async function fetchCloseOn(symbol: string, date: string): Promise<{ close: number; date: string } | null> {
  try {
    const params = new URLSearchParams({ symbol: symbol.trim(), interval: '1d', period: '1y' });
    const res = await fetch(`/api/stock?${params}`);
    if (!res.ok) return null;
    const json = await res.json();
    const candles = (json?.data?.candles ?? json?.candles ?? []) as Array<{ date: string; close: number }>;
    const target = candles.find(k => k.date === date);
    if ((target?.close ?? 0) > 0) return { close: target!.close, date };
    const before = candles.filter(k => k.date <= date);
    const nearest = before[before.length - 1];
    if ((nearest?.close ?? 0) > 0) return { close: nearest.close, date: nearest.date };
    return null;
  } catch {
    return null;
  }
}

// ── Component ────────────────────────────────────────────────────────────────

interface BottomPanelProps {
  /** 點任一筆持倉時觸發 — 用於把上面的 sideTab 切到「訊號」 */
  onSelectHolding?: () => void;
}

export default function BottomPanel({ onSelectHolding }: BottomPanelProps = {}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<PanelTab>('portfolio');
  const [prices, setPrices] = useState<Record<string, PriceInfo>>({});
  const [marketTab, setMarketTab] = useState<MarketTab>('all');

  const watchlist = useWatchlistStore(s => s.items);
  const holdings = usePortfolioStore(s => s.holdings);

  // Collect all symbols that need prices
  const allSymbols = [
    ...watchlist.map(w => w.symbol),
    ...holdings.map(h => h.symbol),
  ];
  const uniqueSymbols = [...new Set(allSymbols)];

  const _fetchPrice = useCallback(async (symbol: string) => {
    setPrices(prev => ({ ...prev, [symbol]: { ...prev[symbol], loading: true } as PriceInfo }));
    try {
      const strategyId = useSettingsStore.getState().activeStrategyId;
      const res = await fetch(
        `/api/watchlist/conditions?symbol=${encodeURIComponent(symbol)}&strategyId=${encodeURIComponent(strategyId)}`,
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setPrices(prev => ({
        ...prev,
        [symbol]: { price: json.price, changePercent: json.changePercent, name: json.name, loading: false },
      }));
    } catch {
      setPrices(prev => ({
        ...prev,
        [symbol]: { price: 0, changePercent: 0, loading: false, error: '—' },
      }));
    }
  }, []);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Lightweight polling via /api/portfolio/quotes（穩定快路徑）
  // 改進：AbortController 卸載時取消 + 8s timeout + 連續失敗才提示
  const failureCountRef = useRef(0);
  const uniqueSymbolsKey = uniqueSymbols.join(',');
  // 報價「拆批抓」，避免自選股拖垮持倉：
  // /api/portfolio/quotes 對無法解析的標的（指數 ^TWII、美股、已下市…）會把所有
  // fallback 來源都跑一輪才放棄，單一「冷」標的就要 3-4 秒。舊版把持倉＋自選股併成
  // 「一個」請求，自選股一多（實測 ~15 檔無法解析就 >8s）整批撞 8s 逾時 → 全部 abort
  // → 連持倉都一起空白，且 AbortError 被靜默吞掉（畫面無任何提示，reload 也救不回）。
  // 解法：持倉自成一批（少、必可解析、秒回），自選股再分小批；各批獨立逾時＋平行抓，
  // 哪批慢只拖到它自己，持倉永遠先亮；任一批失敗都「保留上一輪報價」不清空。
  const refreshQuotes = useCallback(async () => {
    if (uniqueSymbols.length === 0) return;

    const holdingSyms = [...new Set(usePortfolioStore.getState().holdings.map(h => h.symbol))];
    const holdingSet = new Set(holdingSyms);
    const watchSyms = uniqueSymbols.filter(s => !holdingSet.has(s));

    const groups: string[][] = [];
    if (holdingSyms.length) groups.push(holdingSyms);                      // 持倉：獨立一批，優先保證
    for (let i = 0; i < watchSyms.length; i += 6) groups.push(watchSyms.slice(i, i + 6)); // 自選股：小批

    // 一批報價回來就「立刻」併入畫面：持倉那批最快、先亮，不必等慢批（自選股冷標的）跑完
    const applyQuotes = (quotes: Array<{ symbol: string; canonicalSymbol?: string; price: number; changePercent: number; name?: string }>) => {
      if (quotes.length === 0) return;
      failureCountRef.current = 0; // 成功 reset 失敗計數
      setPrices(prev => {
        const next = { ...prev };
        for (const q of quotes) {
          if (q.price > 0) {
            next[q.symbol] = { ...next[q.symbol], price: q.price, changePercent: q.changePercent, loading: false, ...(q.name ? { name: q.name } : {}) };
          }
        }
        return next;
      });
      // Auto-backfill: 用 quote 帶回的真實 name 寫回 store
      const portfolioState = usePortfolioStore.getState();
      for (const q of quotes) {
        if (!q.name || q.price <= 0) continue;
        const holding = portfolioState.holdings.find(h => h.symbol === q.symbol);
        if (!holding) continue;
        const namePlaceholder = isPlaceholderStockName(holding.name, holding.symbol);
        const marketMissing = !holding.market;
        if (namePlaceholder || marketMissing) {
          const market: 'TW' | 'CN' = classifyMarket(holding.symbol) === 'CN' ? 'CN' : 'TW';
          portfolioState.update(holding.id, {
            ...(namePlaceholder ? { name: q.name } : {}),
            ...(marketMissing ? { market } : {}),
          });
        }
      }
    };

    const fetchGroup = async (syms: string[]): Promise<number> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(
          `/api/portfolio/quotes?symbols=${encodeURIComponent(syms.join(','))}`,
          { signal: ctrl.signal },
        );
        if (!res.ok) return 0;
        const json = await res.json();
        const quotes = (json.quotes ?? []) as Array<{ symbol: string; canonicalSymbol?: string; price: number; changePercent: number; name?: string }>;
        applyQuotes(quotes); // 一回來就上畫面
        return quotes.length;
      } catch {
        return 0; // 逾時/abort：放棄這批，不影響其他批，也不清空畫面上已有報價
      } finally {
        clearTimeout(timer);
      }
    };

    const counts = await Promise.all(groups.map(fetchGroup));
    if (counts.reduce((a, b) => a + b, 0) === 0) {
      // 完全沒拿到（含全部逾時）才算失敗；連續 3 次才提示，且不清掉畫面上已有報價
      failureCountRef.current++;
      if (failureCountRef.current >= 3) {
        toast.error('報價連續更新失敗，請檢查網路', { id: 'quote-error', duration: 4000 });
        failureCountRef.current = 0;
      }
    }
  }, [uniqueSymbolsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch prices 只要有持倉/自選就抓，**不綁面板展開 open**。
  // 原本綁 open 會出事：硬刷新後 open 先 false、持倉又是非同步從 server hydrate，
  // 兩者時序一錯開（展開當下 holdings 還沒到 → effect early return 沒設 interval，
  // 或收合時完全不抓）就會卡在「有持倉、卻一直沒報價 → 全部『—』」。
  // 解綁後：collapsed 也先備好價，展開瞬間就有數字。
  useEffect(() => {
    if (uniqueSymbols.length === 0) return;

    // 立即取得輕量報價（不用 watchlist/conditions，那個會 timeout）
    refreshQuotes();

    // Start 30s lightweight polling
    pollRef.current = setInterval(refreshQuotes, POLLING.QUOTE_INTERVAL);

    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [refreshQuotes, uniqueSymbols.length]);

  // ── Portfolio summary ──────────────────────────────────────────────────────

  function calcSummary(list: typeof holdings) {
    return list.reduce(
      (acc, h) => {
        const p = prices[h.symbol];
        const cur = p?.price ?? 0;
        const costVal = h.shares * h.costPrice;
        const mktVal = cur > 0 ? h.shares * cur : costVal;
        const dailyChange = dayPnL(h.shares, cur, p?.changePercent ?? 0);
        const { pnl } = calcNetPnL(h.symbol, h.shares, h.costPrice, cur);
        acc.totalCost += costVal;
        acc.totalValue += mktVal;
        acc.totalPnL += pnl;
        acc.todayPnL += dailyChange;
        return acc;
      },
      { totalCost: 0, totalValue: 0, totalPnL: 0, todayPnL: 0 },
    );
  }

  const filteredHoldings = filterByMarket(holdings, marketTab);
  const filteredWatchlist = filterByMarket(watchlist, marketTab);

  const filteredSummary = calcSummary(filteredHoldings);
  const filteredReturnPct = filteredSummary.totalCost > 0 ? (filteredSummary.totalPnL / filteredSummary.totalCost) * 100 : 0;

  // 分市場 summary（全部 tab 時顯示 TWD / CNY 分開）
  const twSummary = calcSummary(filterByMarket(filteredHoldings, 'TW'));
  const cnSummary = calcSummary(filterByMarket(filteredHoldings, 'CN'));
  const twReturnPct = twSummary.totalCost > 0 ? (twSummary.totalPnL / twSummary.totalCost) * 100 : 0;
  const cnReturnPct = cnSummary.totalCost > 0 ? (cnSummary.totalPnL / cnSummary.totalCost) * 100 : 0;

  const itemCount = tab === 'watchlist' ? filteredWatchlist.length : filteredHoldings.length;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="shrink-0 border-t border-border bg-card/80 rounded-b-lg overflow-hidden">
      {/* Header bar — always visible */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-foreground/80 hover:bg-muted transition-colors"
      >
        <div className="flex items-center gap-2">
          {tab === 'watchlist' ? <Star className="w-3 h-3 text-yellow-400" /> : <Briefcase className="w-3 h-3 text-sky-400" />}
          <span className="font-medium">{tab === 'watchlist' ? '自選股' : '持倉'}</span>
          <span className="text-muted-foreground">{itemCount}</span>
        </div>
        <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {/* Collapsible content — max-h 須容納「chrome（tab/誰的/市場 ~90px）＋ 內捲區 270px」，
          否則最後一筆持倉會被外層 overflow-hidden 裁掉、撞到下方 L1-L4 健康度條 */}
      <div className={`transition-all duration-300 ${open ? 'max-h-[400px]' : 'max-h-0'} overflow-hidden`}>
        {/* Tab switcher */}
        <div className="flex border-b border-border text-[11px]">
          {([
            { key: 'portfolio' as PanelTab, label: '持倉', icon: Briefcase },
            { key: 'watchlist' as PanelTab, label: '自選股', icon: Star },
          ]).map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex-1 py-1.5 font-medium transition-colors ${
                tab === t.key ? 'text-sky-400 border-b border-sky-400 bg-secondary/50' : 'text-muted-foreground hover:text-foreground/80'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Profile switcher（誰的持倉）+ 市場篩選 同一排：我的 ｜ 全部 台股 陸股 */}
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border">
          {tab === 'portfolio' && <PortfolioProfileSwitcher size="sm" />}
          <div className="flex gap-1">
            {([
              { id: 'all' as MarketTab, label: '全部' },
              { id: 'TW' as MarketTab, label: '台股' },
              { id: 'CN' as MarketTab, label: '陸股' },
            ]).map(m => (
              <button
                key={m.id}
                onClick={() => setMarketTab(m.id)}
                className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
                  marketTab === m.id
                    ? 'bg-sky-600 text-foreground'
                    : 'bg-secondary text-muted-foreground hover:bg-muted'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {/* Content area */}
        <div className="overflow-y-auto max-h-[270px]">
          {tab === 'portfolio' ? (
            <PortfolioContent
              holdings={filteredHoldings}
              prices={prices}
              summary={filteredSummary}
              totalReturnPct={filteredReturnPct}
              marketTab={marketTab}
              twSummary={twSummary}
              cnSummary={cnSummary}
              twReturnPct={twReturnPct}
              cnReturnPct={cnReturnPct}
              onSelectHolding={onSelectHolding}
            />
          ) : (
            <WatchlistContent watchlist={filteredWatchlist} prices={prices} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Portfolio Sub-component ──────────────────────────────────────────────────

type SummaryData = { totalCost: number; totalValue: number; totalPnL: number; todayPnL: number };

interface PortfolioContentProps {
  holdings: ReturnType<typeof usePortfolioStore.getState>['holdings'];
  prices: Record<string, PriceInfo>;
  summary: SummaryData;
  totalReturnPct: number;
  marketTab: MarketTab;
  twSummary: SummaryData;
  cnSummary: SummaryData;
  twReturnPct: number;
  cnReturnPct: number;
  onSelectHolding?: () => void;
}

function SummaryRow({ label, summary, returnPct, currency }: { label?: string; summary: SummaryData; returnPct: number; currency: string }) {
  return (
    <div className="grid grid-cols-3 gap-px bg-muted text-center text-[10px]">
      <div className="bg-card py-1 px-1">
        {label && <div className="text-[9px] text-sky-400 font-bold">{label}</div>}
        <div className="text-muted-foreground">今日損益</div>
        <div className={`font-mono font-bold text-xs ${summary.todayPnL >= 0 ? 'text-bull' : 'text-bear'}`}>
          {summary.todayPnL >= 0 ? '+' : ''}{formatMoney(summary.todayPnL)}
        </div>
      </div>
      <div className="bg-card py-1 px-1">
        <div className="text-muted-foreground">累積損益</div>
        <div className={`font-mono font-bold text-xs ${summary.totalPnL >= 0 ? 'text-bull' : 'text-bear'}`}>
          {summary.totalPnL >= 0 ? '+' : ''}{formatMoney(summary.totalPnL)}
        </div>
        <div className={`text-[9px] ${returnPct >= 0 ? 'text-bull/70' : 'text-bear/70'}`}>
          {formatPercent(returnPct)}
        </div>
      </div>
      <div className="bg-card py-1 px-1">
        <div className="text-muted-foreground">市值 <span className="text-[9px] text-muted-foreground/60">{currency}</span></div>
        <div className="font-mono font-bold text-xs text-foreground">{formatMoney(summary.totalValue)}</div>
        <div className="text-[9px] text-muted-foreground">成本 {formatMoney(summary.totalCost)}</div>
      </div>
    </div>
  );
}

function PortfolioContent({ holdings, prices, summary, totalReturnPct, marketTab, twSummary, cnSummary, twReturnPct, cnReturnPct, onSelectHolding }: PortfolioContentProps) {
  const remove = usePortfolioStore(s => s.remove);
  const [editingId, setEditingId] = useState<string | null>(null);

  if (holdings.length === 0) {
    return (
      <div>
        <PortfolioAddBar />
        <div className="py-5 text-center text-muted-foreground text-xs">
          <p>尚無持倉，在上方點「新增持倉」加入</p>
        </div>
        <ChartPracticeLedger />
      </div>
    );
  }

  const hasTW = twSummary.totalCost > 0 || holdings.some(h => classifyMarket(h.symbol) === 'TW');
  const hasCN = cnSummary.totalCost > 0 || holdings.some(h => classifyMarket(h.symbol) === 'CN');

  return (
    <div>
      {/* Summary — 全部時分 TWD/CNY 兩列，單市場時一列 */}
      {marketTab === 'all' && hasTW && hasCN ? (
        <>
          <SummaryRow label="台幣" summary={twSummary} returnPct={twReturnPct} currency="TWD" />
          <SummaryRow label="人民幣" summary={cnSummary} returnPct={cnReturnPct} currency="CNY" />
        </>
      ) : (
        <SummaryRow
          summary={summary}
          returnPct={totalReturnPct}
          currency={(marketTab === 'all' && hasCN && !hasTW) || marketTab === 'CN' ? 'CNY' : 'TWD'}
        />
      )}

      {/* 新增持倉（首頁直接做，免去 /portfolio 分頁） */}
      <PortfolioAddBar />

      {/* Holdings list */}
      <div className="divide-y divide-border">
        {holdings.map(h =>
          editingId === h.id ? (
            <HoldingEditForm key={h.id} holding={h} onDone={() => setEditingId(null)} />
          ) : (
            <HoldingRow
              key={h.id}
              h={h}
              price={prices[h.symbol]}
              onSelectHolding={onSelectHolding}
              onEdit={() => setEditingId(h.id)}
              onDelete={() => {
                if (window.confirm(`刪除「${stockDisplayName(h.name, h.symbol)}」這筆持倉？\n會永久移除、不留交易紀錄、無法復原。`)) {
                  remove(h.id);
                }
              }}
            />
          ),
        )}
      </div>

      {/* 走圖練習簿 — 跟著走圖游標做紙上交易（每檔獨立 ledger） */}
      <ChartPracticeLedger />
    </div>
  );
}

// ── 單筆持倉列（唯讀顯示 + 編輯/刪除入口）─────────────────────────────────────
function HoldingRow({ h, price, onSelectHolding, onEdit, onDelete }: {
  h: PortfolioHolding;
  price?: PriceInfo;
  onSelectHolding?: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const cur = price?.price ?? 0;
  const { pnl, pnlPct } = calcNetPnL(h.symbol, h.shares, h.costPrice, cur);
  const dailyPnL = dayPnL(h.shares, cur, price?.changePercent ?? 0);
  // 陸股股價一律顯示小數點兩位；台股維持 ≥100 取整、<100 兩位
  const isCN = classifyMarket(h.symbol) === 'CN';
  // 本金（成本）= 股數 × 均價；現值（市值）= 股數 × 現價（shares 為股、價為每股，直接相乘）
  const costTotal = h.shares * h.costPrice;
  const marketTotal = cur > 0 ? h.shares * cur : 0;

  return (
    <div>
      <button
        onClick={() => {
          const s = useReplayStore.getState();
          s.loadStock(isFundSymbol(h.symbol) ? h.symbol : stripSuffix(h.symbol)).then(() => s.startPolling());
          onSelectHolding?.();
        }}
        className="w-full px-3 pt-2 pb-1 hover:bg-muted/60 transition-colors text-left"
      >
        {/* Row 1: Name/Code/張數 ── Price + Change% */}
        <div className="flex items-baseline justify-between">
          <div className="flex items-baseline gap-1.5 min-w-0">
            <span className="text-xs font-bold text-foreground truncate">{stockDisplayName(price?.name ?? h.name, h.symbol)}</span>
            <span className="text-[10px] font-mono text-muted-foreground shrink-0">{stockCodeOf(h.symbol)}</span>
            <span className="text-[9px] text-muted-foreground/60 shrink-0">{formatHoldingQty(h.shares, h.symbol)}</span>
          </div>
          <div className="text-right shrink-0 ml-2">
            {price?.loading ? (
              <span className="text-[10px] text-muted-foreground animate-pulse">...</span>
            ) : cur > 0 ? (
              <span className="text-[11px] font-mono font-bold text-foreground">
                {cur.toFixed(isCN ? 2 : cur >= 100 ? 0 : 2)}
                <span className={`ml-1 text-[9px] ${bullBearClass(price?.changePercent ?? 0)}`}>
                  {formatPercent(price?.changePercent ?? 0)}
                </span>
              </span>
            ) : (
              <span className="text-[10px] text-muted-foreground">—</span>
            )}
          </div>
        </div>

        {/* Row 2: 今日損益 ── 累積損益 */}
        <div className="flex items-baseline justify-between mt-0.5">
          <span className="text-[9px] text-muted-foreground">
            今日
            <span className={`ml-1 font-mono ${dailyPnL >= 0 ? 'text-bull' : 'text-bear'}`}>
              {price?.loading ? '...' : dailyPnL !== 0 ? `${dailyPnL >= 0 ? '+' : ''}${formatMoney(dailyPnL)}` : '—'}
            </span>
          </span>
          <span className="text-[9px] text-muted-foreground">
            累積
            {cur > 0 ? (
              <span className={`ml-1 font-mono font-bold ${pnl >= 0 ? 'text-bull' : 'text-bear'}`}>
                {pnl >= 0 ? '+' : ''}{formatMoney(pnl)}
                <span className="font-normal ml-1">({formatPercent(pnlPct, 1)})</span>
              </span>
            ) : <span className="ml-1 text-muted-foreground">—</span>}
          </span>
        </div>

        {/* Row 3: 本金 ── 現值 */}
        <div className="flex items-baseline justify-between mt-0.5">
          <span className="text-[9px] text-muted-foreground">
            本金 <span className="ml-0.5 font-mono text-foreground/75">{formatMoney(costTotal)}</span>
          </span>
          <span className="text-[9px] text-muted-foreground">
            現值 {cur > 0
              ? <span className="ml-0.5 font-mono text-foreground/75">{formatMoney(marketTotal)}</span>
              : <span className="ml-0.5 text-muted-foreground">—</span>}
          </span>
        </div>
      </button>

      {/* Action row: 均價/買進日 + 編輯/刪除（獨立、不觸發走圖） */}
      <div className="flex items-center justify-between px-3 pb-1.5">
        <span className="text-[9px] text-muted-foreground/70">
          均價 <span className="font-mono">{formatPrice(h.costPrice)}</span> · 買進 {h.buyDate}
        </span>
        <div className="flex items-center gap-2.5 shrink-0">
          <button onClick={onEdit} className="flex items-center gap-0.5 text-[9px] text-muted-foreground hover:text-sky-400 transition-colors">
            <Pencil className="w-2.5 h-2.5" /> 編輯
          </button>
          <button onClick={onDelete} className="flex items-center gap-0.5 text-[9px] text-muted-foreground hover:text-red-400 transition-colors">
            <Trash2 className="w-2.5 h-2.5" /> 刪除
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 編輯持倉（inline，改股數/成本價/買進日）─────────────────────────────────
function HoldingEditForm({ holding, onDone }: { holding: PortfolioHolding; onDone: () => void }) {
  const update = usePortfolioStore(s => s.update);
  const [shares, setShares] = useState(String(holding.shares));
  const [cost, setCost] = useState(String(holding.costPrice));
  const [date, setDate] = useState(holding.buyDate);
  const [loadingClose, setLoadingClose] = useState(false);
  const mkt = marketFromSymbol(holding.symbol);
  const lots = Number(shares) > 0 ? sharesToLots(Number(shares), mkt) : 0;

  function save() {
    if (!shares || !cost) return;
    update(holding.id, { shares: Number(shares), costPrice: Number(cost), buyDate: date });
    toast.success(`已更新 ${stockDisplayName(holding.name, holding.symbol)}`);
    onDone();
  }

  async function fillClose() {
    setLoadingClose(true);
    const r = await fetchCloseOn(holding.symbol, date);
    if (r) { setCost(String(r.close)); setDate(r.date); }
    else toast.error('抓不到當日收盤，請手動輸入');
    setLoadingClose(false);
  }

  return (
    <div className="px-3 py-2 bg-muted/30 space-y-1.5">
      <div className="text-[11px] font-bold text-foreground">
        編輯 {stockDisplayName(holding.name, holding.symbol)}{' '}
        <span className="text-muted-foreground font-normal">{stripSuffix(holding.symbol)}</span>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <div>
          <div className="text-[9px] text-muted-foreground mb-0.5">
            持股數（股）
            {!isFundSymbol(holding.symbol) && lots > 0 && (
              <span className="text-muted-foreground/60"> = {lots % 1 === 0 ? lots : lots.toFixed(1)} {unitLabelOf(mkt)}</span>
            )}
          </div>
          <input type="number" value={shares} onChange={e => setShares(e.target.value)}
            className="w-full text-[11px] bg-muted/40 border border-border rounded px-2 py-1 text-foreground outline-none focus:border-blue-500" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[9px] text-muted-foreground mb-0.5">
            <span>成本價</span>
            <button type="button" onClick={fillClose} disabled={loadingClose}
              className="text-blue-400 hover:text-blue-300 disabled:opacity-40">
              {loadingClose ? '抓取中…' : '📥 當日收盤'}
            </button>
          </div>
          <input type="number" step="0.0001" value={cost} onChange={e => setCost(e.target.value)}
            className="w-full text-[11px] bg-muted/40 border border-border rounded px-2 py-1 text-foreground outline-none focus:border-blue-500" />
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-[9px] text-muted-foreground shrink-0">買進日</span>
        <input type="date" value={date} max={todayCST()} onChange={e => setDate(e.target.value)}
          className="flex-1 bg-muted/40 border border-border rounded px-1.5 py-0.5 text-[10px] text-foreground outline-none focus:border-blue-500" />
      </div>
      <div className="flex gap-1.5">
        <button onClick={save} disabled={!shares || !cost}
          className="flex-1 text-[11px] font-bold px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40">
          儲存
        </button>
        <button onClick={onDone} className="px-2.5 py-1 text-[11px] rounded bg-secondary text-muted-foreground hover:bg-muted">取消</button>
      </div>
    </div>
  );
}

// ── 新增持倉（首頁直接做，沿用 /portfolio 的代號解析 + 用當日收盤）──────────────
function PortfolioAddBar() {
  const add = usePortfolioStore(s => s.add);
  const [open, setOpen] = useState(false);
  const [symbol, setSymbol] = useState('');
  const [shares, setShares] = useState('');
  const [cost, setCost] = useState('');
  const [date, setDate] = useState(todayCST);
  const [loading, setLoading] = useState(false);
  const [loadingClose, setLoadingClose] = useState(false);

  const guessMkt: 'TW' | 'CN' = /^\d{6}$/.test(symbol.trim()) || /\.(SS|SZ|OF)$/i.test(symbol.trim()) ? 'CN' : 'TW';
  const lots = Number(shares) > 0 ? sharesToLots(Number(shares), guessMkt) : 0;

  async function fillClose() {
    if (!symbol.trim()) return;
    setLoadingClose(true);
    const r = await fetchCloseOn(symbol.trim(), date);
    if (r) { setCost(String(r.close)); setDate(r.date); }
    else toast.error('抓不到當日收盤，請手動輸入');
    setLoadingClose(false);
  }

  async function handleAdd() {
    const sym = symbol.trim();
    if (!sym || !shares || !cost) return;
    setLoading(true);
    try {
      const resolved = await fetchResolvedStockQuote(sym);
      const resolvedSymbol = resolved.canonicalSymbol;
      const resolvedName = resolved.name;

      const mkt: 'TW' | 'CN' = classifyMarket(resolvedSymbol) === 'CN' ? 'CN' : 'TW';
      add({
        symbol: resolvedSymbol,
        name: resolvedName,
        shares: Number(shares),
        costPrice: Number(cost),
        buyDate: date,
        market: mkt,
      });
      toast.success(`已新增 ${resolvedName}`);
      setSymbol(''); setShares(''); setCost(''); setDate(todayCST()); setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '新增失敗，請確認代號');
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center justify-center gap-1 py-1.5 text-[11px] font-medium text-sky-400 hover:bg-muted/40 border-b border-border transition-colors"
      >
        <Plus className="w-3 h-3" /> 新增持倉
      </button>
    );
  }

  return (
    <div className="px-3 py-2 border-b border-border space-y-1.5 bg-muted/20">
      <input
        value={symbol}
        onChange={e => setSymbol(e.target.value)}
        placeholder="代號（如 2330、600707）"
        className="w-full text-[11px] bg-muted/40 border border-border rounded px-2 py-1 text-foreground placeholder-muted-foreground outline-none focus:border-blue-500"
      />
      <div className="grid grid-cols-2 gap-1.5">
        <div>
          <input
            type="number" value={shares} onChange={e => setShares(e.target.value)}
            placeholder="持股數（股）"
            className="w-full text-[11px] bg-muted/40 border border-border rounded px-2 py-1 text-foreground placeholder-muted-foreground outline-none focus:border-blue-500"
          />
          {lots > 0 && (
            <p className="text-[9px] text-muted-foreground/60 mt-0.5">= {lots % 1 === 0 ? lots : lots.toFixed(1)} {unitLabelOf(guessMkt)}</p>
          )}
        </div>
        <div>
          <input
            type="number" step="0.0001" value={cost} onChange={e => setCost(e.target.value)}
            placeholder="成本價"
            className="w-full text-[11px] bg-muted/40 border border-border rounded px-2 py-1 text-foreground placeholder-muted-foreground outline-none focus:border-blue-500"
          />
          <button type="button" onClick={fillClose} disabled={loadingClose || !symbol.trim()}
            className="text-[9px] text-blue-400 hover:text-blue-300 disabled:opacity-40 mt-0.5">
            {loadingClose ? '抓取中…' : '📥 用當日收盤'}
          </button>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-[9px] text-muted-foreground shrink-0">買進日</span>
        <input
          type="date" value={date} max={todayCST()} onChange={e => setDate(e.target.value)}
          className="flex-1 bg-muted/40 border border-border rounded px-1.5 py-0.5 text-[10px] text-foreground outline-none focus:border-blue-500"
        />
      </div>
      <div className="flex gap-1.5">
        <button onClick={handleAdd} disabled={loading || !symbol.trim() || !shares || !cost}
          className="flex-1 text-[11px] font-bold px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40">
          {loading ? '...' : '確認新增'}
        </button>
        <button onClick={() => setOpen(false)} className="px-2.5 py-1 text-[11px] rounded bg-secondary text-muted-foreground hover:bg-muted">取消</button>
      </div>
    </div>
  );
}

// ── Watchlist Sub-component ──────────────────────────────────────────────────

interface WatchlistContentProps {
  watchlist: ReturnType<typeof useWatchlistStore.getState>['items'];
  prices: Record<string, PriceInfo>;
}

function WatchlistNoteEditor({ symbol, note }: { symbol: string; note?: string }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(note ?? '');
  const updateNote = useWatchlistStore(s => s.updateNote);

  const save = () => {
    updateNote(symbol, val.trim());
    setEditing(false);
  };

  return (
    <div className="px-3 pb-1.5" onClick={e => e.stopPropagation()}>
      {editing ? (
        <input
          autoFocus
          value={val}
          onChange={e => setVal(e.target.value)}
          onBlur={save}
          onKeyDown={e => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') setEditing(false);
          }}
          className="w-full text-[9px] bg-muted/40 border border-border rounded px-1.5 py-0.5 text-foreground outline-none"
          placeholder="加備注..."
        />
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="w-full text-left text-[9px] text-muted-foreground hover:text-foreground/70 truncate"
        >
          {val ? val : <span className="italic opacity-50">加備注...</span>}
        </button>
      )}
    </div>
  );
}

/** 自動補取加入時收盤價（L1 本地快取，失敗靜默） */
function useFetchAddedPrice(symbol: string, addedAt: string, hasPrice: boolean) {
  const updateAddedPrice = useWatchlistStore(s => s.updateAddedPrice);
  useEffect(() => {
    if (hasPrice) return;
    const date = addedAt.slice(0, 10);
    fetch(`/api/watchlist/price-at?symbol=${encodeURIComponent(symbol)}&date=${date}`)
      .then(r => r.ok ? r.json() : null)
      .then((d: { price?: number } | null) => {
        if (d?.price && d.price > 0) updateAddedPrice(symbol, d.price);
      })
      .catch(() => {});
  }, [symbol, addedAt, hasPrice, updateAddedPrice]);
}

function WatchlistItemRow({ item, prices }: { item: ReturnType<typeof useWatchlistStore.getState>['items'][0]; prices: Record<string, PriceInfo> }) {
  const p = prices[item.symbol];
  const cur = p?.price ?? 0;
  const isCN = classifyMarket(item.symbol) === 'CN';
  const remove = useWatchlistStore(s => s.remove);
  const sinceAddedPct = item.addedPrice && cur > 0
    ? ((cur - item.addedPrice) / item.addedPrice) * 100
    : null;

  useFetchAddedPrice(item.symbol, item.addedAt, !!item.addedPrice);

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        onClick={() => { const s = useReplayStore.getState(); s.loadStock(stripSuffix(item.symbol)).then(() => s.startPolling()); }}
        className="w-full px-3 pt-2 pb-1 hover:bg-muted/60 transition-colors text-left"
      >
        {/* Row 1: 名稱+代號 | 現價+今日% */}
        <div className="flex items-baseline justify-between">
          <div className="flex items-baseline gap-1.5 min-w-0">
            <span className="text-xs font-bold text-foreground truncate">{stockDisplayName(p?.name ?? item.name, item.symbol)}</span>
            <span className="text-[10px] text-muted-foreground shrink-0">{stripSuffix(item.symbol)}</span>
          </div>
          <div className="text-right shrink-0 ml-2">
            {p?.loading ? (
              <span className="text-[10px] text-muted-foreground animate-pulse">...</span>
            ) : cur > 0 ? (
              <span className="text-[11px] font-mono font-bold text-foreground">
                {cur.toFixed(isCN ? 2 : cur >= 100 ? 0 : 2)}
                <span className={`ml-1 text-[9px] ${bullBearClass(p?.changePercent ?? 0)}`}>
                  {formatPercent(p?.changePercent ?? 0)}
                </span>
              </span>
            ) : (
              <span className="text-[10px] text-muted-foreground">—</span>
            )}
          </div>
        </div>

        {/* Row 2: 加入日期 | 加入至今漲幅 */}
        <div className="flex items-baseline justify-between mt-0.5">
          <span className="text-[9px] text-muted-foreground">
            加入 {item.addedAt.slice(0, 10)}
          </span>
          {sinceAddedPct != null ? (
            <span className={`text-[9px] font-mono ${bullBearClass(sinceAddedPct)}`}>
              {formatPercent(sinceAddedPct)}
            </span>
          ) : (
            <span className="text-[9px] text-muted-foreground/40 animate-pulse">抓取中...</span>
          )}
        </div>
      </button>

      {/* Row 3: 備注（獨立，不觸發走圖）+ 移除鈕 */}
      <div className="flex items-center">
        <div className="flex-1 min-w-0">
          <WatchlistNoteEditor symbol={item.symbol} note={item.note} />
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); remove(item.symbol); }}
          className="px-2.5 pb-1.5 pt-0.5 text-muted-foreground/40 hover:text-red-400 transition-colors shrink-0 text-xs leading-none"
          title="移除自選股"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

/** 走圖主頁直接新增自選股（沿用 /watchlist 頁的代號解析 + 加入價基準邏輯） */
function WatchlistAddBar() {
  const add = useWatchlistStore(s => s.add);
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  const [addInput, setAddInput] = useState('');
  const [addDate, setAddDate] = useState(today);
  const [loading, setLoading] = useState(false);

  async function handleAdd() {
    const sym = addInput.trim();
    if (!sym) return;
    setLoading(true);
    try {
      const resolved = await fetchResolvedStockQuote(sym);
      const resolvedSymbol = resolved.canonicalSymbol;
      const resolvedName = resolved.name;
      const resolvedPrice = resolved.price;

      let addedPrice: number | undefined;
      if (addDate === today()) {
        addedPrice = resolvedPrice > 0 ? resolvedPrice : undefined;
      } else {
        try {
          const pr = await fetch(`/api/watchlist/price-at?symbol=${encodeURIComponent(resolvedSymbol)}&date=${addDate}`);
          if (pr.ok) {
            const pd = await pr.json() as { price?: number };
            if (pd.price && pd.price > 0) addedPrice = pd.price;
          }
        } catch { /* ignore */ }
      }

      add(resolvedSymbol, resolvedName, addedPrice, addDate + 'T00:00:00.000Z');
      setAddInput('');
      toast.success(`已加入 ${resolvedName}${addedPrice ? `（基準 ${addedPrice}）` : ''}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '找不到股票，請確認代號是否正確');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="px-3 py-2 border-b border-border space-y-1.5">
      <div className="flex gap-1.5">
        <input
          value={addInput}
          onChange={e => setAddInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
          placeholder="代號（如 2330、600707）"
          className="flex-1 min-w-0 text-[11px] bg-muted/40 border border-border rounded px-2 py-1 text-foreground placeholder-muted-foreground outline-none focus:border-blue-500"
        />
        <button
          onClick={handleAdd}
          disabled={loading || !addInput.trim()}
          className="shrink-0 text-[11px] font-bold px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40"
        >
          {loading ? '...' : '+ 加入'}
        </button>
      </div>
      <div className="flex items-center gap-1.5 text-[9px] text-muted-foreground">
        <span title="這個日期當作「加入價」基準，用來算之後的漲跌幅">加入日基準</span>
        <input
          type="date"
          value={addDate}
          max={today()}
          onChange={e => setAddDate(e.target.value)}
          className="bg-muted/40 border border-border rounded px-1.5 py-0.5 text-[9px] text-foreground outline-none focus:border-blue-500"
        />
      </div>
    </div>
  );
}

function WatchlistContent({ watchlist, prices }: WatchlistContentProps) {
  if (watchlist.length === 0) {
    return (
      <div>
        <WatchlistAddBar />
        <div className="py-6 text-center text-muted-foreground text-xs">
          <p>尚無自選股，在上方輸入代號加入</p>
        </div>
      </div>
    );
  }

  const twList = watchlist.filter(i => classifyMarket(i.symbol) === 'TW');
  const cnList = watchlist.filter(i => classifyMarket(i.symbol) === 'CN');

  function marketSummary(list: typeof watchlist, label: string) {
    if (list.length === 0) return null;
    const withReturn = list.filter(i => i.addedPrice && (prices[i.symbol]?.price ?? 0) > 0);
    const avgPct = withReturn.length > 0
      ? withReturn.reduce((sum, i) => {
          const cur = prices[i.symbol]?.price ?? 0;
          return sum + ((cur - i.addedPrice!) / i.addedPrice!) * 100;
        }, 0) / withReturn.length
      : null;

    return (
      <div className="grid grid-cols-3 gap-px bg-muted text-center text-[10px] border-b border-border">
        <div className="bg-card py-1 px-1">
          <div className="text-[9px] text-sky-400 font-bold">{label}</div>
          <div className="text-muted-foreground">{list.length} 支</div>
        </div>
        <div className="bg-card py-1 px-1 col-span-2">
          <div className="text-muted-foreground">加入平均漲幅</div>
          {avgPct != null ? (
            <div className={`font-mono font-bold text-xs ${bullBearClass(avgPct)}`}>
              {formatPercent(avgPct)}
            </div>
          ) : (
            <div className="text-muted-foreground/40 text-[9px]">計算中...</div>
          )}
        </div>
      </div>
    );
  }

  const hasBoth = twList.length > 0 && cnList.length > 0;

  return (
    <div>
      <WatchlistAddBar />

      {/* 市場匯總（有台股+陸股時各顯一行） */}
      {hasBoth ? (
        <>
          {marketSummary(twList, '台股')}
          {marketSummary(cnList, '陸股')}
        </>
      ) : twList.length > 0 ? (
        marketSummary(twList, '台股')
      ) : (
        marketSummary(cnList, '陸股')
      )}

      <div>
        {watchlist.map(item => (
          <WatchlistItemRow key={item.symbol} item={item} prices={prices} />
        ))}
      </div>
    </div>
  );
}
