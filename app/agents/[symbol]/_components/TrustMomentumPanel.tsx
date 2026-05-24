'use client';

/**
 * 投信動向追蹤 — 陳威良「3比8 法則」proxy
 *
 * 顯示最近 30/60/90 天投信淨買累計（張）+ 持股變化（pp）+ 動向分區。
 *
 * 重要：這是「動向 proxy」(最近窗口淨買 ÷ 已發行股數)，不是陳威良講的「絕對持股 %」。
 * 因為 FinMind 免費層無投信絕對持股資料源，後續可加 Goodinfo 爬蟲補上絕對值。
 *
 * 參考：陳威良 @《週末鈔能力》2026-05-24 [61:43]
 *   - 持股比 < 3%：早期試探（風險高）
 *   - 持股比 3-8% ⭐：跟著起飛甜蜜期（投信都幫你研究好了）
 *   - 持股比 8-15%：白馬股、空間有限
 *   - 持股比 > 15%：警戒區、隨時注意反手
 */

import { useEffect, useState } from 'react';

type TrustMomentumStage = 'unknown' | 'cooling' | 'building' | 'accelerating' | 'peak';

interface ChipApiData {
  symbol: string;
  sharesIssued: number;
  trustNetBuy30d: number;
  trustNetBuy60d: number;
  trustNetBuy90d: number;
  trustHoldingChange30d: number | null;
  trustHoldingChange60d: number | null;
  trustHoldingChange90d: number | null;
  trustDataCoverageDays: number;
  trustMomentumStage: TrustMomentumStage;
}

const STAGE_LABEL: Record<TrustMomentumStage, { zh: string; tone: string; desc: string }> = {
  unknown:      { zh: '無資料',     tone: 'bg-slate-700/40 text-slate-400 border-slate-600',  desc: 'inst 籌碼資料未涵蓋' },
  cooling:      { zh: '冷卻',       tone: 'bg-rose-900/40 text-rose-300 border-rose-700/50',  desc: '近 30 天投信淨賣超 — 反手獲利了結中' },
  building:     { zh: '試水溫',     tone: 'bg-slate-700/40 text-slate-300 border-slate-600',  desc: '近 30 天投信微幅加碼（< 0.5pp）— 早期布局或觀望' },
  accelerating: { zh: '甜蜜期 ⭐',  tone: 'bg-emerald-900/50 text-emerald-300 border-emerald-700/60', desc: '近 30 天投信積極加碼（0.5-1.5pp）— 3比8 法則起飛區' },
  peak:         { zh: '爆量加碼',   tone: 'bg-amber-900/40 text-amber-300 border-amber-700/50', desc: '近 30 天投信爆量買進（≥ 1.5pp）— 動能最強，但接近滿倉時要警戒' },
};

export function TrustMomentumPanel({ symbol, date }: { symbol: string; date?: string }) {
  const [data, setData] = useState<ChipApiData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const url = `/api/chip?symbol=${encodeURIComponent(symbol)}${date ? `&date=${date}` : ''}`;
    setLoading(true);
    setError(null);
    fetch(url)
      .then((r) => r.json())
      .then((r) => {
        if (r.ok === false) throw new Error(r.error ?? '籌碼資料讀取失敗');
        setData(r);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [symbol, date]);

  return (
    <section className="border border-emerald-700/40 bg-slate-900 rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-xs font-semibold tracking-wider text-emerald-400">
          ▸ 投信動向追蹤 · 陳威良 3比8 proxy
        </h2>
        <span className="text-[10px] text-slate-500 italic">
          動向 (pp) = 累計淨買 ÷ 已發行股數；非絕對持股 %
        </span>
      </div>

      {loading && <p className="text-xs text-slate-500">載入中…</p>}
      {error && <p className="text-xs text-rose-400">⚠ {error}</p>}

      {data && (
        <>
          <StageBadge stage={data.trustMomentumStage} />
          <WindowsTable data={data} />
          <Reference data={data} />
          <Caveat />
        </>
      )}
    </section>
  );
}

function StageBadge({ stage }: { stage: TrustMomentumStage }) {
  // API 對某些 symbol（指數、新股、無 inst 資料）可能未回 stage，fallback 到 unknown 避免 crash
  const meta = STAGE_LABEL[stage] ?? STAGE_LABEL.unknown;
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <span className={`inline-flex px-3 py-1 rounded-full border text-sm font-medium ${meta.tone}`}>
        {meta.zh}
      </span>
      <span className="text-xs text-slate-300 italic">{meta.desc}</span>
    </div>
  );
}

function WindowsTable({ data }: { data: ChipApiData }) {
  const cover = data.trustDataCoverageDays;
  const windows = [
    { label: '30 天', netBuy: data.trustNetBuy30d, change: data.trustHoldingChange30d, available: true },
    { label: '60 天', netBuy: data.trustNetBuy60d, change: data.trustHoldingChange60d, available: cover >= 45 },
    { label: '90 天', netBuy: data.trustNetBuy90d, change: data.trustHoldingChange90d, available: cover >= 75 },
  ];
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="bg-slate-800/60 text-slate-400 text-xs uppercase tracking-wider">
            <th className="px-2 py-1.5 text-left font-medium">窗口</th>
            <th className="px-2 py-1.5 text-right font-medium">投信累計淨買 (張)</th>
            <th className="px-2 py-1.5 text-right font-medium">持股變化 (pp)</th>
          </tr>
        </thead>
        <tbody>
          {windows.map((w) => {
            // API 對部分 symbol（指數、新股、無 inst 資料）可能未回 trustNetBuyXd / trustHoldingChangeXd
            // 欄位，wrap 成 hasNetBuy / hasChange 避免 .toLocaleString / .toFixed 對 undefined crash
            const hasNetBuy = typeof w.netBuy === 'number';
            const hasChange = typeof w.change === 'number';
            const showNetBuy = w.available && hasNetBuy;
            const showChange = w.available && hasChange;
            return (
              <tr key={w.label} className="border-t border-slate-800">
                <td className="px-2 py-1.5 text-slate-300">{w.label}</td>
                <td className={`px-2 py-1.5 text-right font-mono ${!showNetBuy ? 'text-slate-600' : (w.netBuy ?? 0) > 0 ? 'text-emerald-300' : (w.netBuy ?? 0) < 0 ? 'text-rose-300' : 'text-slate-400'}`}>
                  {showNetBuy ? (w.netBuy as number).toLocaleString() : '—'}
                </td>
                <td className={`px-2 py-1.5 text-right font-mono ${!showChange ? 'text-slate-600' : (w.change ?? 0) > 0 ? 'text-emerald-300' : (w.change ?? 0) < 0 ? 'text-rose-300' : 'text-slate-400'}`}>
                  {showChange ? `${(w.change as number) >= 0 ? '+' : ''}${(w.change as number).toFixed(3)}` : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {cover < 75 && (
        <p className="text-[10px] text-slate-500 mt-1 italic">
          inst 籌碼資料涵蓋 {cover} 天，60/90 天視窗顯示需更多歷史
        </p>
      )}
    </div>
  );
}

function Reference({ data }: { data: ChipApiData }) {
  const ppMonth = data.trustHoldingChange30d;
  if (ppMonth === null) return null;
  // 簡單推算：以當前 30 天速度推進，幾個月會到 3% / 8% / 15%？
  // 只顯示 +ve 速度的推算
  if (ppMonth <= 0) return null;
  const monthsToPct = (target: number) => Math.ceil(target / ppMonth);
  return (
    <div className="text-xs text-slate-400 bg-slate-800/30 rounded p-2 border border-slate-700/50">
      <p className="font-medium text-slate-300 mb-1">3比8 推算（假設目前速度持續）</p>
      <p className="font-mono">
        當前速度：+{ppMonth.toFixed(3)} pp / 30 天 → 推到 3% 約 <span className="text-emerald-400">{monthsToPct(3)}</span> 個月｜
        8% 約 <span className="text-amber-400">{monthsToPct(8)}</span> 個月｜
        15% 約 <span className="text-rose-400">{monthsToPct(15)}</span> 個月
      </p>
    </div>
  );
}

function Caveat() {
  return (
    <div className="border border-amber-700/40 bg-amber-900/15 rounded p-2 text-[11px] text-amber-200/80 italic leading-relaxed">
      ⚠ 此為「動向 proxy」（最近窗口淨買 ÷ 已發行股數），<strong>不是</strong>陳威良講的「絕對持股佔股本 %」。
      要絕對值需另接 Goodinfo / CMoney 等資料源。但「動向」本身仍可看出投信加碼/減碼節奏。
    </div>
  );
}
