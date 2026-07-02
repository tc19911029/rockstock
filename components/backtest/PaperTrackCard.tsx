'use client';

/**
 * Paper-trade 追蹤卡（2026-06-12，B2）— 「若每天照系統做」的 live walk-forward 績效。
 * 資料：GET /api/cron/paper-track（無參數 = 公開唯讀 summary）。
 * 每晚 19:05 launchd 自動開單/補進場/書本規則出場；進場=隔日收盤（≈13:25 市價）。
 */
import { useEffect, useState } from 'react';

interface Summary {
  updatedAt: string;
  total: number; open: number; closed: number; unfillable: number;
  openAvgPnlPct: number | null;
  byStrategy: Record<string, { n: number; openN: number; avgPnlPct: number | null; winRatePct: number | null }>;
  trades: Array<{
    id: string; market: string; symbol: string; name: string; strategy: string;
    scanDate: string; status: string; entryDate?: string; entryPrice?: number;
    pnlPct?: number; exitDate?: string; exitReason?: string;
  }>;
}

const STRAT_LABEL: Record<string, string> = { resonance: '⭐全共振', buytop: '應買top3' };
const fmtPct = (x: number | null | undefined) => x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`;

export function PaperTrackCard() {
  const [s, setS] = useState<Summary | null>(null);
  useEffect(() => {
    fetch('/api/cron/paper-track')
      .then(r => r.json())
      .then(j => setS((j.data ?? j) as Summary))
      .catch(() => setS(null));
  }, []);

  if (!s || s.total === 0) {
    return (
      <div className="rounded-md border border-zinc-800 bg-zinc-900/50 p-3 text-xs text-zinc-500">
        🧪 Paper-trade 追蹤：每晚 19:05 自動把「⭐全共振 + 應買top3」開模擬單（進場=隔日收盤≈13:25），
        書本規則出場。累積一個月後這裡會回答「若照系統做會如何」。目前尚無紀錄。
      </div>
    );
  }
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/50 p-3 text-xs space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-zinc-200">🧪 若照系統做（paper-trade live 追蹤）</span>
        <span className="text-[10px] text-zinc-500">開倉 {s.open}・已平 {s.closed}・買不到 {s.unfillable}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {Object.entries(s.byStrategy).map(([k, v]) => (
          <div key={k} className="rounded border border-zinc-800/70 p-2">
            <div className="text-zinc-300">{STRAT_LABEL[k] ?? k}</div>
            <div className="text-zinc-500">已平 {v.n} 筆・均 {fmtPct(v.avgPnlPct)}・勝率 {v.winRatePct != null ? v.winRatePct + '%' : '—'}・在倉 {v.openN}</div>
          </div>
        ))}
      </div>
      {s.trades.length > 0 && (
        <div className="max-h-44 overflow-y-auto space-y-0.5">
          {s.trades.map(t => (
            <div key={t.id} className="flex items-center justify-between text-[11px] text-zinc-400">
              <span className="truncate">
                {t.scanDate} {STRAT_LABEL[t.strategy] ?? t.strategy}｜{t.name}
                <span className="text-zinc-600 ml-1">{t.symbol.replace(/\.(TW|TWO|SS|SZ)$/, '')}</span>
              </span>
              <span className={
                t.status === 'closed' ? ((t.pnlPct ?? 0) > 0 ? 'text-red-400' : 'text-emerald-400')
                : t.status === 'open' ? 'text-zinc-300'
                : 'text-zinc-600'
              }>
                {t.status === 'pending_entry' ? '待進場' : t.status === 'unfillable' ? '買不到' : fmtPct(t.pnlPct)}
                {t.status === 'closed' && t.exitReason ? `（${t.exitReason}）` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="text-[10px] text-zinc-600">進場=掃描隔日收盤（≈朱書13:25市價）；出場=書本規則（停損7%/MA5減半/MA10·MA20全出）。模擬紀錄非建議。</p>
    </div>
  );
}
