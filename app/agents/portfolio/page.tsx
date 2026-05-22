'use client';

/**
 * /agents/portfolio?date=YYYY-MM-DD
 *
 * 持股追蹤頁：
 *   - 持股清單（顯示進場價/現價/損益）
 *   - 新增持股 form
 *   - 當日 Review 結果（mini-agent verdict + action）
 *   - 出場/刪除
 *
 * UX 設計：上方持股總覽表，點任一檔展開 mini-agent review 詳情
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { PageShell } from '@/components/shared';
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
  hold_strong:  { label: '強勢續抱',     cls: 'bg-green-100 text-green-900 border-green-400',   emoji: '🟢' },
  hold_observe: { label: '續抱觀察',     cls: 'bg-yellow-100 text-yellow-900 border-yellow-400', emoji: '👀' },
  add:          { label: '加碼',         cls: 'bg-blue-100 text-blue-900 border-blue-400',     emoji: '🚀' },
  reduce:       { label: '減碼',         cls: 'bg-orange-100 text-orange-900 border-orange-400', emoji: '✂️' },
  take_profit:  { label: '停利',         cls: 'bg-purple-100 text-purple-900 border-purple-400', emoji: '💰' },
  stop_loss:    { label: '停損',         cls: 'bg-red-100 text-red-900 border-red-400',         emoji: '⛔' },
  no_add:       { label: '不建議加碼',   cls: 'bg-gray-100 text-gray-900 border-gray-400',     emoji: '🚫' },
};

export default function PortfolioPage() {
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
      setError(err instanceof Error ? err.message : 'fetch failed');
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
        setBanner(`✅ 已 prepare ${json.holdings} 檔，請在 Claude Code 對話執行 /portfolio-review`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'prepare failed');
    } finally {
      setBusy(false);
    }
  }, [date]);

  const reviewBySymbol = useMemo(() => {
    const map = new Map<string, PortfolioHoldingReview>();
    if (review) for (const r of review.reviews) map.set(r.symbol, r);
    return map;
  }, [review]);

  return (
    <PageShell>
      <div className="space-y-4 p-4 max-w-6xl mx-auto">
        <header className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold">Portfolio 持股追蹤</h1>
            <p className="text-sm text-gray-500">{holdings.length} 檔持股 · {review ? `Review ${review.date} ✓` : '尚無 Review'}</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="border rounded px-2 py-1 text-sm"
            />
            <button
              onClick={prepareReview}
              disabled={busy || holdings.length === 0}
              className="border rounded px-3 py-1 text-sm bg-blue-50 hover:bg-blue-100 disabled:opacity-50"
            >
              {busy ? 'Preparing…' : 'Prepare Review'}
            </button>
            <button
              onClick={() => setShowForm(!showForm)}
              className="border rounded px-3 py-1 text-sm bg-green-50 hover:bg-green-100"
            >
              {showForm ? '取消' : '+ 新增持股'}
            </button>
            <button
              onClick={fetchAll}
              disabled={loading}
              className="border rounded px-3 py-1 text-sm hover:bg-gray-50 disabled:opacity-50"
            >
              重整
            </button>
            <Link href={`/agents?date=${date}`} className="text-sm text-blue-600 hover:underline">
              ← 回主頁
            </Link>
          </div>
        </header>

        {banner && (
          <div className="border border-blue-300 bg-blue-50 text-blue-900 rounded p-3 text-sm">
            {banner}
          </div>
        )}
        {error && (
          <div className="border border-red-300 bg-red-50 text-red-800 rounded p-3 text-sm">
            {error}
          </div>
        )}

        {showForm && <AddHoldingForm onAdded={() => { setShowForm(false); fetchAll(); }} />}

        {loading && !holdings.length && <p className="text-gray-500">載入中…</p>}

        {!loading && holdings.length === 0 && (
          <div className="border border-dashed border-gray-300 rounded p-6 text-sm text-gray-500 text-center space-y-2">
            <p>尚無持股。</p>
            <p>點上方「+ 新增持股」開始追蹤。</p>
          </div>
        )}

        {holdings.length > 0 && (
          <div className="space-y-2">
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
        <div className="border border-dashed border-gray-300 rounded p-3 text-xs text-gray-500 space-y-1">
          <p className="font-medium text-gray-700">使用流程</p>
          <ol className="list-decimal ml-5 space-y-0.5">
            <li>「+ 新增持股」填進場價/數量/停損/停利 → 加進 watch list</li>
            <li>「Prepare Review」對所有持股拉當日 L4/chip/news context → 寫 /tmp question</li>
            <li>在 Claude Code 對話執行 <code className="bg-gray-100 px-1 rounded">/portfolio-review</code></li>
            <li>skill 對每檔跑 Technical/Risk/News mini-agent，產 hold/add/reduce/take_profit/stop_loss 建議</li>
            <li>回此頁按「重整」看 review 結果</li>
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
      setErr(e instanceof Error ? e.message : 'submit failed');
    } finally {
      setBusy(false);
    }
  };

  const Field = ({ label, k, type = 'text', required = false, placeholder = '' }: { label: string; k: keyof typeof form; type?: string; required?: boolean; placeholder?: string }) => (
    <label className="text-sm space-y-1">
      <span className="text-xs text-gray-600">{label}{required && ' *'}</span>
      <input
        type={type}
        value={form[k]}
        onChange={(e) => setForm({ ...form, [k]: e.target.value })}
        placeholder={placeholder}
        className="border rounded px-2 py-1 text-sm w-full"
      />
    </label>
  );

  return (
    <div className="border rounded p-4 bg-gray-50 space-y-3">
      <h3 className="font-medium">新增持股</h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Field label="股票代號" k="symbol" required placeholder="2330.TW" />
        <Field label="名稱" k="name" placeholder="台積電" />
        <label className="text-sm space-y-1">
          <span className="text-xs text-gray-600">市場</span>
          <select value={form.market} onChange={(e) => setForm({ ...form, market: e.target.value as 'TW' | 'CN' })} className="border rounded px-2 py-1 text-sm w-full">
            <option value="TW">TW 台股</option>
            <option value="CN">CN 陸股</option>
          </select>
        </label>
        <Field label="進場日期" k="entryDate" type="date" required />
        <Field label="進場價" k="entryPrice" type="number" required placeholder="215" />
        <Field label="張數/股數" k="shares" type="number" required placeholder="2" />
        <Field label="停損價" k="stopLoss" type="number" placeholder="195" />
        <Field label="目標 1" k="target1" type="number" placeholder="240" />
        <Field label="目標 2" k="target2" type="number" placeholder="260" />
        <label className="col-span-2 text-sm space-y-1">
          <span className="text-xs text-gray-600">備註</span>
          <input type="text" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="border rounded px-2 py-1 text-sm w-full" placeholder="multi-agent buy_signal" />
        </label>
      </div>
      {err && <p className="text-xs text-red-700">{err}</p>}
      <button
        onClick={submit}
        disabled={busy || !form.symbol || !form.entryPrice || !form.shares}
        className="border rounded px-4 py-1 text-sm bg-green-100 hover:bg-green-200 disabled:opacity-50"
      >
        {busy ? '建立中…' : '建立'}
      </button>
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
      await fetch(`/api/agents/portfolio?symbol=${encodeURIComponent(holding.symbol)}&closedPrice=${closeForm.price}&closeReason=${encodeURIComponent(closeForm.reason)}`, { method: 'DELETE' });
      setShowClose(false);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const currentPrice = review?.currentPrice ?? holding.entryPrice;
  const returnPct = ((currentPrice - holding.entryPrice) / holding.entryPrice) * 100;
  const actionCfg = review ? ACTION_CFG[review.action] : null;

  return (
    <div className="border rounded p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <div>
            <div className="font-mono font-semibold">{holding.symbol}</div>
            <div className="text-sm text-gray-600">{holding.name}</div>
          </div>
          {actionCfg && (
            <span className={`inline-flex items-center px-3 py-1 rounded-md border text-sm font-semibold ${actionCfg.cls}`}>
              {actionCfg.emoji} {actionCfg.label}
            </span>
          )}
        </div>
        <button
          onClick={() => setShowClose(!showClose)}
          className="text-xs text-red-600 hover:underline"
        >
          出場
        </button>
      </div>

      {/* 損益概覽 */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-sm border-t pt-3">
        <div>
          <div className="text-xs text-gray-500">進場</div>
          <div className="font-mono">{holding.entryPrice} × {holding.shares}</div>
        </div>
        <div>
          <div className="text-xs text-gray-500">現價</div>
          <div className="font-mono">{currentPrice ?? '—'}</div>
        </div>
        <div>
          <div className="text-xs text-gray-500">損益</div>
          <div className={`font-mono font-semibold ${returnPct > 0 ? 'text-red-600' : returnPct < 0 ? 'text-green-600' : 'text-gray-600'}`}>
            {returnPct > 0 ? '+' : ''}{returnPct.toFixed(2)}%
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500">停損</div>
          <div className="font-mono">{holding.stopLoss ?? '—'}</div>
        </div>
        <div>
          <div className="text-xs text-gray-500">停利</div>
          <div className="font-mono">{holding.target1 ?? '—'} / {holding.target2 ?? '—'}</div>
        </div>
      </div>

      {/* Mini-Agent verdict 並列 */}
      {review && (
        <div className="border-t pt-3 space-y-2">
          <div className="grid grid-cols-3 gap-2">
            <MiniVerdictCard label="技術" v={review.technical?.verdict ?? null} overview={review.technical?.overview ?? ''} />
            <MiniVerdictCard label="風控" v={review.risk?.verdict ?? null} overview={review.risk?.overview ?? ''} riskMode />
            <MiniVerdictCard label="消息" v={review.news?.verdict ?? null} overview={review.news?.overview ?? ''} />
          </div>
          <p className="text-sm">
            <span className="text-gray-500 text-xs">理由：</span>
            {review.reasoning}
            <span className="text-xs text-gray-500 ml-2">[{review.actionPath}]</span>
          </p>
          {review.keyPriceLevels && (
            <div className="text-xs text-gray-600 flex gap-3 flex-wrap">
              {review.keyPriceLevels.supportPrice != null && <span>支撐 {review.keyPriceLevels.supportPrice}</span>}
              {review.keyPriceLevels.resistancePrice != null && <span>壓力 {review.keyPriceLevels.resistancePrice}</span>}
              {review.keyPriceLevels.stopLossPrice != null && <span>停損 {review.keyPriceLevels.stopLossPrice}</span>}
              {review.keyPriceLevels.takeProfitPrice != null && <span>停利 {review.keyPriceLevels.takeProfitPrice}</span>}
            </div>
          )}
        </div>
      )}

      {holding.notes && (
        <p className="text-xs text-gray-500 border-t pt-2">📝 {holding.notes}</p>
      )}

      {showClose && (
        <div className="border-t pt-3 space-y-2">
          <h4 className="text-sm font-medium">出場登記</h4>
          <div className="flex gap-2 flex-wrap items-end">
            <label className="text-sm">
              <div className="text-xs text-gray-600">出場價</div>
              <input
                type="number"
                value={closeForm.price}
                onChange={(e) => setCloseForm({ ...closeForm, price: e.target.value })}
                className="border rounded px-2 py-1 text-sm w-24"
              />
            </label>
            <label className="text-sm flex-1 min-w-[200px]">
              <div className="text-xs text-gray-600">原因</div>
              <input
                type="text"
                value={closeForm.reason}
                onChange={(e) => setCloseForm({ ...closeForm, reason: e.target.value })}
                placeholder="停利達 target1 / stop loss 跌破 MA20"
                className="border rounded px-2 py-1 text-sm w-full"
              />
            </label>
            <button
              onClick={closeHolding}
              disabled={busy || !closeForm.price || !closeForm.reason}
              className="border rounded px-3 py-1 text-sm bg-red-100 hover:bg-red-200 disabled:opacity-50"
            >
              {busy ? '處理中…' : '確認出場'}
            </button>
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
  let cls = 'bg-gray-100 text-gray-500';
  if (v) {
    if (riskMode) {
      cls = v === 'green' ? 'bg-green-100 text-green-800' : v === 'yellow' ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800';
    } else {
      cls = v === 'pass' ? 'bg-green-100 text-green-800' : v === 'watch' ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800';
    }
  }
  return (
    <div className={`rounded p-2 ${cls}`}>
      <div className="text-xs">{label}</div>
      <div className="font-semibold text-sm">{v ? (PORTFOLIO_VERDICT_ZH[v] ?? v) : '—'}</div>
      {overview && <div className="text-xs mt-1 line-clamp-2">{overview}</div>}
    </div>
  );
}
