'use client';

/**
 * /agents/portfolio?date=YYYY-MM-DD
 *
 * 持股追蹤頁：
 *   - 持股清單（顯示進場價/現價/損益）
 *   - 新增持股 form
 *   - 當日檢視結果（mini-agent 判定 + 動作）
 *   - 出場/刪除
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { PageShell, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import type {
  PortfolioAction,
  PortfolioHolding,
  PortfolioHoldingReview,
  PortfolioReviewFile,
} from '@/lib/agents/portfolio/types';

interface PortfolioListResp {
  ok: boolean;
  holdings: PortfolioHolding[];
  count: number;
}

interface ReviewResp {
  ok: boolean;
  date: string;
  exists: boolean;
  review: PortfolioReviewFile | null;
}

function todayYmd(): string {
  const tpe = new Date(Date.now() + 8 * 3600_000);
  return tpe.toISOString().slice(0, 10);
}

const ACTION_CFG: Record<PortfolioAction, { label: string; cls: string; emoji: string }> = {
  hold_strong:  { label: '強勢續抱',   cls: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/60', emoji: '🟢' },
  hold_observe: { label: '續抱觀察',   cls: 'bg-amber-900/40 text-amber-300 border-amber-700/60',       emoji: '👀' },
  add:          { label: '加碼',       cls: 'bg-sky-900/40 text-sky-300 border-sky-700/60',             emoji: '🚀' },
  reduce:       { label: '減碼',       cls: 'bg-orange-900/40 text-orange-300 border-orange-700/60',    emoji: '✂️' },
  take_profit:  { label: '停利',       cls: 'bg-purple-900/40 text-purple-300 border-purple-700/60',    emoji: '💰' },
  stop_loss:    { label: '停損',       cls: 'bg-rose-900/40 text-rose-300 border-rose-700/60',          emoji: '⛔' },
  no_add:       { label: '不建議加碼', cls: 'bg-muted/60 text-muted-foreground border-border',           emoji: '🚫' },
};

export default function PortfolioPageWrapper() {
  return <Suspense fallback={<div className="p-6 text-muted-foreground">載入中…</div>}><PortfolioPage /></Suspense>;
}

function PortfolioPage() {
  const searchParams = useSearchParams();
  const initialDate = searchParams.get('date') ?? todayYmd();
  const [date, setDate] = useState(initialDate);
  const [holdings, setHoldings] = useState<PortfolioHolding[]>([]);
  const [review, setReview] = useState<PortfolioReviewFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [hRes, rRes] = await Promise.all([
        fetch(`/api/agents/portfolio?status=open`).then(r => r.json() as Promise<PortfolioListResp>),
        fetch(`/api/agents/portfolio/review?date=${date}`).then(r => r.json() as Promise<ReviewResp>),
      ]);
      setHoldings(hRes.holdings ?? []);
      setReview(rRes.review);
    } catch (err) {
      setError(err instanceof Error ? err.message : '讀取失敗');
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const prepareReview = useCallback(async () => {
    setBusy(true);
    setBanner(null);
    setError(null);
    try {
      const res = await fetch(`/api/agents/portfolio/review?date=${date}`, { method: 'POST' });
      const json = await res.json() as { ok?: boolean; error?: string; holdings?: number; questionPath?: string };
      if (!res.ok) setError(json.error ?? `HTTP ${res.status}`);
      else {
        setBanner(`✅ 已準備 ${json.holdings} 檔，請到對話視窗執行檢視指令`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '準備失敗');
    } finally {
      setBusy(false);
    }
  }, [date]);

  const reviewBySymbol = useMemo(() => {
    const map = new Map<string, PortfolioHoldingReview>();
    if (review) for (const r of review.reviews) map.set(r.symbol, r);
    return map;
  }, [review]);

  const headerActions = (
    <>
      <Button onClick={prepareReview} disabled={busy || holdings.length === 0} variant="secondary" size="sm">
        {busy ? '準備中…' : '準備檢視'}
      </Button>
      <Button onClick={() => setShowForm(!showForm)} size="sm">
        {showForm ? '取消' : '+ 新增'}
      </Button>
      <Button onClick={fetchAll} disabled={loading} variant="ghost" size="sm">
        重整
      </Button>
    </>
  );

  return (
    <PageShell
      headerSlot={
        <PageHeader
          title="💼 持股追蹤"
          backButton={`/agents?date=${date}`}
          subtitle={`${holdings.length} 檔 · ${review ? `已檢視 ${review.date}` : '尚無檢視'}`}
          actions={headerActions}
        />
      }
    >
      <div className="max-w-6xl mx-auto p-3 sm:p-4 space-y-3 sm:space-y-4">

        {/* 日期 */}
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <label className="flex items-center gap-1 text-muted-foreground">
            日期
            <input
              type="date" value={date} onChange={(e) => setDate(e.target.value)}
              className="bg-secondary border border-border rounded px-2 py-1 text-foreground font-mono focus:outline-none focus:border-sky-500"
            />
          </label>
        </div>

        {banner && (
          <div className="border border-sky-500/40 bg-sky-500/10 text-sky-300 rounded-lg p-3 text-sm">
            {banner}
          </div>
        )}
        {error && (
          <div className="border border-red-700/50 bg-red-900/30 text-red-300 rounded-lg p-3 text-sm">
            {error}
          </div>
        )}

        {showForm && <AddHoldingForm onAdded={() => { setShowForm(false); fetchAll(); }} />}

        {loading && !holdings.length && (
          <div className="text-sm text-muted-foreground animate-pulse">載入中…</div>
        )}

        {!loading && holdings.length === 0 && (
          <div className="border-2 border-dashed border-border rounded-lg p-6 text-sm text-muted-foreground text-center space-y-2">
            <p>尚無持股。</p>
            <p>點上方「+ 新增」開始追蹤。</p>
          </div>
        )}

        {holdings.length > 0 && (
          <div className="space-y-3">
            {holdings.map(h => {
              const r = reviewBySymbol.get(h.symbol);
              return (
                <HoldingCard
                  key={h.symbol}
                  holding={h}
                  review={r ?? null}
                  onClose={() => fetchAll()}
                />
              );
            })}
          </div>
        )}

        {/* 使用流程 */}
        <div className="border-2 border-dashed border-border rounded-lg p-3 text-xs text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">使用流程</p>
          <ol className="list-decimal ml-5 space-y-0.5">
            <li>「+ 新增」填進場價/數量/停損/停利 → 加進追蹤清單</li>
            <li>「準備檢視」對所有持股拉當日 技術/籌碼/消息 資料 → 寫到暫存區</li>
            <li>到對話視窗執行檢視指令</li>
            <li>對每檔跑 技術 / 風控 / 消息 mini 代理，產 續抱/加碼/減碼/停利/停損 建議</li>
            <li>回此頁按「重整」看結果</li>
          </ol>
        </div>
      </div>
    </PageShell>
  );
}

function AddHoldingForm({ onAdded }: { onAdded: () => void }) {
  const [form, setForm] = useState({
    symbol: '', name: '', market: 'TW' as 'TW' | 'CN',
    entryDate: todayYmd(),
    entryPrice: '', shares: '',
    stopLoss: '', target1: '', target2: '', notes: '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const payload = {
        symbol: form.symbol,
        name: form.name || form.symbol,
        market: form.market,
        entryDate: form.entryDate,
        entryPrice: Number(form.entryPrice),
        shares: Number(form.shares),
        stopLoss: form.stopLoss ? Number(form.stopLoss) : undefined,
        target1: form.target1 ? Number(form.target1) : undefined,
        target2: form.target2 ? Number(form.target2) : undefined,
        notes: form.notes || undefined,
      };
      const res = await fetch('/api/agents/portfolio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) setErr(json.error ?? `HTTP ${res.status}`);
      else onAdded();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '送出失敗');
    } finally {
      setBusy(false);
    }
  };

  const Field = ({
    label, k, type = 'text', required = false, placeholder = '',
  }: { label: string; k: keyof typeof form; type?: string; required?: boolean; placeholder?: string }) => (
    <label className="space-y-1">
      <span className="text-xs text-muted-foreground">{label}{required && ' *'}</span>
      <input
        type={type}
        value={form[k]}
        onChange={(e) => setForm({ ...form, [k]: e.target.value })}
        placeholder={placeholder}
        className="bg-secondary border border-border rounded px-2 py-1 text-sm w-full text-foreground placeholder-muted-foreground/60 focus:outline-none focus:border-sky-500"
      />
    </label>
  );

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <h3 className="text-xs font-semibold tracking-wider text-foreground">▸ 新增持股</h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Field label="股票代號" k="symbol" required placeholder="2330.TW" />
        <Field label="名稱" k="name" placeholder="台積電" />
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">市場</span>
          <select
            value={form.market}
            onChange={(e) => setForm({ ...form, market: e.target.value as 'TW' | 'CN' })}
            className="bg-secondary border border-border rounded px-2 py-1 text-sm w-full text-foreground focus:outline-none focus:border-sky-500"
          >
            <option value="TW">台股</option>
            <option value="CN">陸股</option>
          </select>
        </label>
        <Field label="進場日期" k="entryDate" type="date" required />
        <Field label="進場價" k="entryPrice" type="number" required placeholder="215" />
        <Field label="張數 / 股數" k="shares" type="number" required placeholder="2" />
        <Field label="停損價" k="stopLoss" type="number" placeholder="195" />
        <Field label="目標 1" k="target1" type="number" placeholder="240" />
        <Field label="目標 2" k="target2" type="number" placeholder="260" />
        <label className="col-span-2 space-y-1">
          <span className="text-xs text-muted-foreground">備註</span>
          <input
            type="text"
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            className="bg-secondary border border-border rounded px-2 py-1 text-sm w-full text-foreground placeholder-muted-foreground/60 focus:outline-none focus:border-sky-500"
            placeholder="多代理買進訊號"
          />
        </label>
      </div>
      {err && (
        <div className="border border-red-700/50 bg-red-900/30 text-red-300 rounded p-2 text-xs">{err}</div>
      )}
      <Button
        onClick={submit}
        disabled={busy || !form.symbol || !form.entryPrice || !form.shares}
        size="sm"
      >
        {busy ? '建立中…' : '建立'}
      </Button>
    </div>
  );
}

function HoldingCard({
  holding, review, onClose,
}: { holding: PortfolioHolding; review: PortfolioHoldingReview | null; onClose: () => void }) {
  const [showClose, setShowClose] = useState(false);
  const [closeForm, setCloseForm] = useState({ price: '', reason: '' });
  const [busy, setBusy] = useState(false);

  const closeHolding = async () => {
    setBusy(true);
    try {
      await fetch(
        `/api/agents/portfolio?symbol=${encodeURIComponent(holding.symbol)}&closedPrice=${closeForm.price}&closeReason=${encodeURIComponent(closeForm.reason)}`,
        { method: 'DELETE' },
      );
      setShowClose(false);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  // UX2 修正：未檢視前不要用進場價假裝現價（否則顯示誤導的 0.00% 損益）。
  const reviewedPrice = review?.currentPrice ?? null;
  const hasPrice = reviewedPrice != null;
  const currentPrice = reviewedPrice;
  const returnPct = hasPrice ? ((reviewedPrice - holding.entryPrice) / holding.entryPrice) * 100 : null;
  const actionCfg = review ? ACTION_CFG[review.action] : null;

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <div>
            <div className="font-mono font-semibold text-foreground">{holding.symbol}</div>
            <div className="text-xs text-muted-foreground">{holding.name}</div>
          </div>
          {actionCfg && (
            <span className={`inline-flex items-center px-3 py-1 rounded-lg border text-xs font-semibold ${actionCfg.cls}`}>
              {actionCfg.emoji} {actionCfg.label}
            </span>
          )}
        </div>
        <Button onClick={() => setShowClose(!showClose)} variant="ghost" size="sm" className="text-rose-400 hover:text-rose-300">
          出場
        </Button>
      </div>

      {/* 損益概覽 */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-center text-sm border-t border-border/60 pt-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">進場</div>
          <div className="font-mono text-foreground">{holding.entryPrice} × {holding.shares}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">現價</div>
          <div className="font-mono text-foreground">{hasPrice ? currentPrice : <span className="text-muted-foreground/50 text-xs">— 待檢視</span>}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">損益</div>
          <div className={`font-mono font-semibold ${returnPct == null ? 'text-muted-foreground/50' : returnPct > 0 ? 'text-rose-400' : returnPct < 0 ? 'text-emerald-400' : 'text-muted-foreground'}`}>
            {returnPct == null ? '—' : `${returnPct > 0 ? '+' : ''}${returnPct.toFixed(2)}%`}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">停損</div>
          <div className="font-mono text-foreground">{holding.stopLoss ?? '—'}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">停利</div>
          <div className="font-mono text-foreground">{holding.target1 ?? '—'} / {holding.target2 ?? '—'}</div>
        </div>
      </div>

      {/* Mini-Agent 判定 */}
      {review && (
        <div className="border-t border-border/60 pt-3 space-y-2">
          <div className="grid grid-cols-3 gap-2">
            <MiniVerdictCard label="技術" v={review.technical?.verdict ?? null} overview={review.technical?.overview ?? ''} />
            <MiniVerdictCard label="風控" v={review.risk?.verdict ?? null} overview={review.risk?.overview ?? ''} riskMode />
            <MiniVerdictCard label="消息" v={review.news?.verdict ?? null} overview={review.news?.overview ?? ''} />
          </div>
          <p className="text-xs text-foreground/90">
            <span className="text-muted-foreground">理由：</span>
            {review.reasoning}
          </p>
          {review.keyPriceLevels && (
            <div className="text-xs text-muted-foreground flex gap-3 flex-wrap">
              {review.keyPriceLevels.supportPrice != null && <span>支撐 <span className="font-mono text-foreground">{review.keyPriceLevels.supportPrice}</span></span>}
              {review.keyPriceLevels.resistancePrice != null && <span>壓力 <span className="font-mono text-foreground">{review.keyPriceLevels.resistancePrice}</span></span>}
              {review.keyPriceLevels.stopLossPrice != null && <span>停損 <span className="font-mono text-foreground">{review.keyPriceLevels.stopLossPrice}</span></span>}
              {review.keyPriceLevels.takeProfitPrice != null && <span>停利 <span className="font-mono text-foreground">{review.keyPriceLevels.takeProfitPrice}</span></span>}
            </div>
          )}
        </div>
      )}

      {holding.notes && (
        <p className="text-xs text-muted-foreground border-t border-border/60 pt-2">📝 {holding.notes}</p>
      )}

      {showClose && (
        <div className="border-t border-border/60 pt-3 space-y-2">
          <h4 className="text-xs font-semibold text-foreground">出場登記</h4>
          <div className="flex gap-2 flex-wrap items-end">
            <label className="space-y-1">
              <div className="text-xs text-muted-foreground">出場價</div>
              <input
                type="number"
                value={closeForm.price}
                onChange={(e) => setCloseForm({ ...closeForm, price: e.target.value })}
                className="bg-secondary border border-border rounded px-2 py-1 text-sm w-24 text-foreground focus:outline-none focus:border-sky-500"
              />
            </label>
            <label className="space-y-1 flex-1 min-w-[200px]">
              <div className="text-xs text-muted-foreground">原因</div>
              <input
                type="text"
                value={closeForm.reason}
                onChange={(e) => setCloseForm({ ...closeForm, reason: e.target.value })}
                placeholder="停利達標 / 跌破停損"
                className="bg-secondary border border-border rounded px-2 py-1 text-sm w-full text-foreground placeholder-muted-foreground/60 focus:outline-none focus:border-sky-500"
              />
            </label>
            <Button
              onClick={closeHolding}
              disabled={busy || !closeForm.price || !closeForm.reason}
              variant="destructive"
              size="sm"
            >
              {busy ? '處理中…' : '確認出場'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const PORTFOLIO_VERDICT_ZH: Record<string, string> = {
  pass: '通過', watch: '觀察', fail: '不通過',
  green: '綠燈', yellow: '黃燈', red: '紅燈',
};

function MiniVerdictCard({ label, v, overview, riskMode = false }: { label: string; v: string | null; overview: string; riskMode?: boolean }) {
  let cls = 'bg-muted/40 text-muted-foreground border-border';
  if (v) {
    if (riskMode) {
      cls =
        v === 'green'  ? 'bg-emerald-900/30 text-emerald-300 border-emerald-700/50'
        : v === 'yellow' ? 'bg-amber-900/30 text-amber-300 border-amber-700/50'
        : 'bg-rose-900/30 text-rose-300 border-rose-700/50';
    } else {
      cls =
        v === 'pass'  ? 'bg-emerald-900/30 text-emerald-300 border-emerald-700/50'
        : v === 'watch' ? 'bg-amber-900/30 text-amber-300 border-amber-700/50'
        : 'bg-rose-900/30 text-rose-300 border-rose-700/50';
    }
  }
  return (
    <div className={`rounded-lg border p-2 text-center ${cls}`}>
      <div className="text-[10px] uppercase tracking-wider opacity-80">{label}</div>
      <div className="font-semibold text-sm">{v ? (PORTFOLIO_VERDICT_ZH[v] ?? v) : '—'}</div>
      {overview && <div className="text-[11px] mt-1 line-clamp-2 opacity-80">{overview}</div>}
    </div>
  );
}
