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
      const capUsed = capitalInput ? Number(capitalInput) : totalCapital ?? 0;
      if (!capUsed || capUsed <= 0) {
        setError('總資產為 0；先設定（自動讀 growth-path 或手動填入）');
        setLoading(false);
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

  const header = <PageHeader title="📐 部位試算" backButton subtitle="輸入個股 + entry/stop，算出該下幾張 + 風險金額" />;

  return (
    <PageShell headerSlot={header}>
      <div className="max-w-3xl mx-auto px-4 py-4 space-y-4">

        {/* 總資產提示 */}
        <div className="rounded-lg border border-sky-700/40 bg-sky-900/15 p-3 text-xs text-sky-200">
          <div className="font-semibold text-sky-300 mb-0.5">💰 試算基準</div>
          <p>
            {capitalInput
              ? <>使用手動：<span className="font-mono">{formatNT(Number(capitalInput))}</span></>
              : totalCapital != null
                ? <>讀 growth-path：<span className="font-mono">{formatNT(totalCapital)}</span></>
                : <>無 growth-path 資料；請手動填入</>}
          </p>
        </div>

        {/* Form */}
        <div className="rounded-xl ring-1 ring-foreground/10 bg-card p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="股票代號" value={symbol} onChange={setSymbol} placeholder="2330.TW" />
            <Field label="名稱" value={name} onChange={setName} />
            <Field label="進場價" value={entryPrice} onChange={setEntryPrice} type="number" />
            <Field label="停損價" value={stopLoss} onChange={setStopLoss} type="number" hint="留空 = 走 sizing-config 預設" />
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">買法字母</label>
              <select value={letter} onChange={e => setLetter(e.target.value)}
                className="w-full px-3 py-1.5 bg-background border border-border rounded text-sm">
                {LETTERS.map(l => (
                  <option key={l} value={l}>{l || '— 不指定（走 fixedFraction）'}</option>
                ))}
              </select>
            </div>
            <Field label="產業（選填）" value={industry} onChange={setIndustry} placeholder="半導體 - 晶圓代工" />
            <div className="col-span-2">
              <label className="text-xs text-muted-foreground mb-1 block">總資產手動覆寫（選填）</label>
              <Input value={capitalInput} onChange={e => setCapitalInput(e.target.value)} type="number"
                placeholder={totalCapital != null ? `自動 ${formatNT(totalCapital)}` : '必填'} />
            </div>
          </div>
          <Button onClick={compute} disabled={loading}
            className="w-full bg-sky-600 hover:bg-sky-500 font-bold">
            {loading ? '計算中…' : '📐 試算'}
          </Button>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-lg border border-red-700/50 bg-red-900/20 p-3 text-sm text-red-300">
            ❌ {error}
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
                  <div className="text-xs font-semibold text-amber-300">⚠ Warnings ({s.warnings.length})</div>
                  {s.warnings.map((w, i) => (
                    <div key={i} className="text-[11px] text-amber-200">· {w}</div>
                  ))}
                </div>
              )}

              {s.appliedGuards.length > 0 && (
                <div className="text-[10px] text-muted-foreground italic">
                  Risk guards 已套用：{s.appliedGuards.join(', ')}
                </div>
              )}

              <div className="text-[10px] text-muted-foreground border-t border-emerald-700/30 pt-2">
                mode={result.mode} · totalCapital={result.totalCapital ? formatNT(result.totalCapital) : '—'} · 既有持倉 {result.existingHoldingsCount ?? 0} 檔
              </div>
            </div>
          );
        })()}

        {/* 提示 */}
        <div className="text-[10px] text-muted-foreground/60 italic">
          書本基準：固定 fraction / Kelly Half / letter-aware mode 由 <code className="bg-secondary px-1 rounded">sizing-config.json</code> 控制。
          產業上限 perIndustryMaxPct 目前設 1.0（「台灣半導體最熱」，不限制）。
        </div>
      </div>
    </PageShell>
  );
}

function Field({ label, value, onChange, type = 'text', hint, placeholder }: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; hint?: string; placeholder?: string;
}) {
  return (
    <div>
      <label className="text-xs text-muted-foreground mb-1 block">
        {label}
        {hint && <span className="text-muted-foreground/60 ml-1">— {hint}</span>}
      </label>
      <Input value={value} onChange={e => onChange(e.target.value)} type={type} placeholder={placeholder} />
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded bg-emerald-900/30 p-2">
      <div className="text-[10px] text-emerald-400/70">{label}</div>
      <div className={`font-mono font-semibold ${highlight ? 'text-emerald-200' : 'text-emerald-300'}`}>{value}</div>
    </div>
  );
}
