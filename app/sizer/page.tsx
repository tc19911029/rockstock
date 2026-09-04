'use client';

/**
 * /sizer — Position Sizer 試算工具
 *
 * 為了 7000萬→3億 user 在 /agents/[symbol] 看到「部位 0.5%」之外，
 * 還能丟入「entry / stop / letter」直接算出該下幾張 + 風險金額 + warnings。
 *
 * 走 server `/api/portfolio/size-suggestion` POST。
 * 預設總資產讀 growth-path startCapital。
 */

import { useEffect, useState } from 'react';
import { PageShell, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTotalCapital, formatNT } from '@/lib/portfolio/useTotalCapital';

interface SizingResult {
  ok: boolean;
  sizing?: {
    mode: string;
    rawCapital: number;
    cappedCapital: number;
    shares: number;
    lots: number;
    capitalUsed: number;
    capitalUsedPct: number;  // decimal 0-1
    buyFee: number;
    totalCost: number;
    appliedGuards: string[];
    warnings: string[];
    reasoning: string;
  };
  mode?: string;
  totalCapital?: number;
  existingHoldingsCount?: number;
  error?: string;
}

const LETTERS = ['', 'B', 'C', 'D', 'E', 'F', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q'] as const;

export default function SizerPage() {
  const totalCapital = useTotalCapital();

  const [symbol, setSymbol] = useState('2330.TW');
  const [name, setName] = useState('台積電');
  const [entryPrice, setEntryPrice] = useState('');  // 不帶寫死範例價（避免顯示與現價差很遠的過時數字）
  const [stopLoss, setStopLoss] = useState('');
  const [letter, setLetter] = useState<string>('');
  const [industry, setIndustry] = useState('');
  const [capitalInput, setCapitalInput] = useState('');

  const [result, setResult] = useState<SizingResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // C2（2026-06-12）：支援 query 預填 — 掃描卡/今日最優先卡「📐 試算」一鍵帶入
  // /sizer?symbol=2330.TW&name=台積電&entry=985&stop=920&letter=B
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const qs = q.get('symbol'); if (qs) setSymbol(qs);
    const qn = q.get('name'); if (qn) setName(qn);
    const qe = q.get('entry'); if (qe && Number(qe) > 0) setEntryPrice(qe);
    const qst = q.get('stop'); if (qst && Number(qst) > 0) setStopLoss(qst);
    const ql = q.get('letter'); if (ql) setLetter(ql);
  }, []);

  async function compute() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      if (!symbol.trim()) {
        setError('請輸入股票代號。');
        return;
      }
      if (!entryPrice || Number(entryPrice) <= 0) {
        setError('請輸入大於 0 的進場價。');
        return;
      }
      if (stopLoss && Number(stopLoss) >= Number(entryPrice)) {
        setError('停損價必須低於進場價。');
        return;
      }
      const capUsed = capitalInput ? Number(capitalInput) : totalCapital ?? 0;
      if (!capUsed || capUsed <= 0) {
        setError('缺少總資產，請在下方輸入本次試算使用的總資產。');
        return;
      }
      const body = {
        candidate: {
          symbol,
          name,
          entryPrice: Number(entryPrice),
          stopLoss: stopLoss ? Number(stopLoss) : undefined,
          letter: letter || undefined,
          industry: industry || undefined,
        },
        totalCapital: capUsed,
      };
      const r = await fetch('/api/portfolio/size-suggestion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error ?? `HTTP ${r.status}`);
      } else {
        setResult(j as SizingResult);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fetch failed');
    } finally {
      setLoading(false);
    }
  }

  const header = <PageHeader title="倉位試算" backButton subtitle="依進場價、停損價與總資產計算建議股數" />;

  return (
    <PageShell headerSlot={header}>
      <div className="max-w-3xl mx-auto px-4 py-4 space-y-4">

        {/* 總資產提示 */}
        <div className="rounded-lg border border-sky-700/40 bg-sky-900/15 p-4 text-sm text-sky-100">
          <div className="font-semibold text-sky-300 mb-1">試算基準</div>
          <p>
            {capitalInput
              ? <>使用手動：<span className="font-mono">{formatNT(Number(capitalInput))}</span></>
              : totalCapital != null
                ? <>目前總資產：<span className="font-mono tabular-nums">{formatNT(totalCapital)}</span></>
                : <>尚未設定總資產，請在表單中手動填入。</>}
          </p>
        </div>

        {/* Form */}
        <div className="rounded-xl ring-1 ring-foreground/10 bg-card p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field id="sizer-symbol" label="股票代號" value={symbol} onChange={setSymbol} placeholder="例如 2330.TW" required />
            <Field id="sizer-name" label="股票名稱" value={name} onChange={setName} placeholder="例如 台積電" />
            <Field id="sizer-entry" label="進場價" value={entryPrice} onChange={setEntryPrice} type="number" inputMode="decimal" required />
            <Field id="sizer-stop" label="停損價" value={stopLoss} onChange={setStopLoss} type="number" inputMode="decimal" hint="未填寫時使用保守預設值" />
            <div>
              <label htmlFor="sizer-strategy" className="text-sm font-medium text-foreground mb-1.5 block">進場策略（選填）</label>
              <select id="sizer-strategy" value={letter} onChange={e => setLetter(e.target.value)}
                className="w-full min-h-11 px-3 py-2 bg-background border border-border rounded text-base">
                {LETTERS.map(l => (
                  <option key={l} value={l}>{l || '不指定（使用固定風險比例）'}</option>
                ))}
              </select>
            </div>
            <Field id="sizer-industry" label="產業（選填）" value={industry} onChange={setIndustry} placeholder="例如 半導體" />
            <div className="sm:col-span-2">
              <label htmlFor="sizer-capital" className="text-sm font-medium text-foreground mb-1.5 block">本次試算總資產（選填）</label>
              <Input id="sizer-capital" value={capitalInput} onChange={e => setCapitalInput(e.target.value)} type="number" inputMode="decimal" min="1"
                placeholder={totalCapital != null ? `自動 ${formatNT(totalCapital)}` : '必填'} />
              <p className="mt-1 text-sm text-muted-foreground">留空時使用投資組合中設定的總資產。</p>
            </div>
          </div>
          <Button onClick={compute} disabled={loading}
            className="w-full min-h-11 bg-sky-600 hover:bg-sky-500 font-bold">
            {loading ? '正在計算…' : '計算建議倉位'}
          </Button>
        </div>

        {/* Error */}
        {error && (
          <div role="alert" className="rounded-lg border border-red-700/50 bg-red-900/20 p-3 text-sm text-red-200">
            {error}
          </div>
        )}

        {/* Result */}
        {result?.sizing && (() => {
          const s = result.sizing;
          // 風險金額 = (entry - stop) × shares（若有 stopLoss）
          const entry = Number(entryPrice);
          const stop = Number(stopLoss);
          const riskAmount = (entry > 0 && stop > 0 && stop < entry) ? (entry - stop) * s.shares : null;
          const riskPctOfCapital = riskAmount && result.totalCapital ? (riskAmount / result.totalCapital * 100) : null;
          return (
            <div className="rounded-lg border border-emerald-700/50 bg-emerald-900/15 p-4 space-y-3">
              <div>
                <div className="text-xs text-muted-foreground mb-1">建議部位</div>
                <div className="text-3xl font-bold font-mono text-emerald-300">
                  {s.shares.toLocaleString()} 股
                  <span className="text-sm text-emerald-400 ml-2">（{s.lots} 張）</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <Stat label="總成本（含買費）" value={formatNT(s.totalCost)} highlight />
                <Stat label="名目（股數×進場）" value={formatNT(s.capitalUsed)} />
                <Stat label="買進手續費" value={formatNT(s.buyFee)} />
                <Stat label="占總資金 %" value={`${(s.capitalUsedPct * 100).toFixed(2)}%`} />
                {riskAmount != null && (
                  <Stat label="風險金額（到停損）" value={formatNT(riskAmount)} highlight />
                )}
                {riskPctOfCapital != null && (
                  <Stat label="風險 %（占總資）" value={`${riskPctOfCapital.toFixed(2)}%`} />
                )}
              </div>

              <div className="text-xs text-emerald-200 italic border-t border-emerald-700/30 pt-2">
                <span className="font-semibold">推導：</span>{s.reasoning}
              </div>

              {s.warnings.length > 0 && (
                <div className="rounded border border-amber-700/40 bg-amber-900/20 p-2 space-y-1">
                  <div className="text-sm font-semibold text-amber-300">風險提醒（{s.warnings.length}）</div>
                  {s.warnings.map((w, i) => (
                    <div key={i} className="text-sm text-amber-100">· {w}</div>
                  ))}
                </div>
              )}

              <div className="text-sm text-muted-foreground border-t border-emerald-700/30 pt-2">
                試算基準 {result.totalCapital ? formatNT(result.totalCapital) : '—'} · 既有持倉 {result.existingHoldingsCount ?? 0} 檔
              </div>
            </div>
          );
        })()}

        {/* 提示 */}
        <div className="text-sm text-muted-foreground leading-relaxed">
          試算會依目前風險規則、既有持倉與選擇的進場策略調整部位。結果僅供資金管理參考，送出前仍需確認價格與風險承受度。
        </div>
      </div>
    </PageShell>
  );
}

function Field({ id, label, value, onChange, type = 'text', hint, placeholder, inputMode, required }: {
  id: string;
  label: string; value: string; onChange: (v: string) => void;
  type?: string; hint?: string; placeholder?: string; inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode']; required?: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium text-foreground mb-1.5 block">
        {label}{required && <span className="ml-1 text-red-400" aria-hidden="true">*</span>}
      </label>
      <Input id={id} value={value} onChange={e => onChange(e.target.value)} type={type} inputMode={inputMode} required={required} min={type === 'number' ? '0' : undefined} step={type === 'number' ? 'any' : undefined} placeholder={placeholder} />
      {hint && <p className="mt-1 text-sm text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded bg-emerald-900/30 p-2">
      <div className="text-sm text-emerald-300">{label}</div>
      <div className={`font-mono tabular-nums font-semibold ${highlight ? 'text-emerald-100' : 'text-emerald-200'}`}>{value}</div>
    </div>
  );
}
