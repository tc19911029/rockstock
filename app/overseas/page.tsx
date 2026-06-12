'use client';

/**
 * /overseas — 海外同業對照（純顯示層，不入選股）
 *
 * 按題材分組：左台股成分、右海外領先股，各 horizon（d1/d5/d20/d60）漲跌幅。
 * 用途：判斷台股題材是「落後補漲」還是「自己短炒」；記憶體組海外動能
 * 同時當 DRAM/NAND 報價方向 proxy。
 * 單一事實：lib/scanner/peerMap.ts；資料 API：/api/overseas/peers。
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { PageShell, PageHeader } from '@/components/shared';
import { bullBearClass } from '@/lib/format';
import { cn } from '@/lib/utils';

interface ReturnsRow {
  last: number | null;
  lastDate: string | null;
  d1: number | null;
  d5: number | null;
  d20: number | null;
  d60: number | null;
}

interface TWStockRow extends ReturnsRow {
  symbol: string;
  code: string;
  name: string;
}

interface OverseasRow extends ReturnsRow {
  ticker: string;
  name: string;
}

interface ThemeBlock {
  id: string;
  theme: string;
  note: string | null;
  twStocks: TWStockRow[];
  overseas: OverseasRow[];
}

interface ApiResponse {
  ok: boolean;
  generatedAt: string;
  themes: ThemeBlock[];
  reference: OverseasRow[];
  error?: string;
}

const HORIZONS = [
  { key: 'd1' as const, label: 'd1' },
  { key: 'd5' as const, label: 'd5' },
  { key: 'd20' as const, label: 'd20' },
  { key: 'd60' as const, label: 'd60' },
];

function fmtPct1(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '–';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function PctCell({ v }: { v: number | null }) {
  return (
    <td className={cn('px-2 py-1 text-right font-mono tabular-nums', bullBearClass(v))}>
      {fmtPct1(v)}
    </td>
  );
}

function ReturnsTable({
  title,
  rows,
  idCell,
}: {
  title: string;
  rows: (ReturnsRow & { name: string })[];
  idCell: (row: ReturnsRow & { name: string }) => React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <div className="px-3 py-1.5 text-xs font-semibold bg-muted/50 border-b border-border">
        {title}
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted-foreground border-b border-border/60">
            <th className="px-2 py-1 text-left font-normal">代號</th>
            <th className="px-2 py-1 text-left font-normal">名稱</th>
            <th className="px-2 py-1 text-right font-normal">收盤</th>
            {HORIZONS.map((h) => (
              <th key={h.key} className="px-2 py-1 text-right font-normal">{h.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border/40 last:border-0 hover:bg-muted/30">
              <td className="px-2 py-1 font-mono">{idCell(r)}</td>
              <td className="px-2 py-1 whitespace-nowrap">{r.name}</td>
              <td
                className="px-2 py-1 text-right font-mono tabular-nums text-muted-foreground"
                title={r.lastDate ? `資料至 ${r.lastDate}` : '尚無資料'}
              >
                {r.last != null ? r.last.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '–'}
              </td>
              {HORIZONS.map((h) => (
                <PctCell key={h.key} v={r[h.key]} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function OverseasPeersPage() {
  const [resp, setResp] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    // loading 初始即 true（僅掛載時抓一次），不在 effect 內 setState
    fetch('/api/overseas/peers')
      .then((r) => r.json())
      .then((json: ApiResponse) => {
        if (aborted) return;
        if (json && json.ok) { setResp(json); setErrMsg(null); }
        else { setResp(null); setErrMsg(json?.error || '海外同業資料載入失敗'); }
      })
      .catch(() => { if (!aborted) { setResp(null); setErrMsg('海外同業資料載入失敗（網路或伺服器錯誤）'); } })
      .finally(() => { if (!aborted) setLoading(false); });
    return () => { aborted = true; };
  }, []);

  const overseasStale =
    resp?.themes?.every((t) => t.overseas.every((o) => o.last == null)) ?? false;

  return (
    <PageShell
      headerSlot={
        <PageHeader
          title="🌏 海外同業對照"
          subtitle="台股題材 vs 海外領先股動能 · d1/d5/d20/d60"
          backButton
        />
      }
    >
      <div className="p-3 space-y-4 max-w-6xl mx-auto">
        {/* 定位聲明 */}
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          📌 顯示層參考，不入選股 — 海外領先股動能用於判讀台股題材是「落後補漲」還是「自己短炒」；
          記憶體組同時當 DRAM/NAND 報價方向 proxy。不進任何選股分數 / gate（鐵則 #5）。
        </div>

        {loading && (
          <div className="text-sm text-muted-foreground py-8 text-center">載入海外同業對照…</div>
        )}
        {errMsg && !loading && (
          <div className="text-sm text-bear py-8 text-center">{errMsg}</div>
        )}

        {resp && !loading && (
          <>
            {/* 指數參考 */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {resp.reference.map((r) => (
                <div key={r.ticker} className="rounded-lg border border-border px-3 py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-semibold">{r.name}</span>
                    <span className="text-[10px] font-mono text-muted-foreground">{r.ticker}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-xs">
                    <span
                      className="font-mono tabular-nums"
                      title={r.lastDate ? `資料至 ${r.lastDate}` : '尚無資料'}
                    >
                      {r.last != null ? r.last.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '–'}
                    </span>
                    {HORIZONS.map((h) => (
                      <span key={h.key} className="flex items-baseline gap-0.5">
                        <span className="text-[10px] text-muted-foreground">{h.label}</span>
                        <span className={cn('font-mono tabular-nums', bullBearClass(r[h.key]))}>
                          {fmtPct1(r[h.key])}
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {overseasStale && (
              <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                海外日K尚未落地 — 先跑 <code className="font-mono">/api/cron/fetch-global-peers</code> 抓取
                （台股端讀 L1 不受影響）。
              </div>
            )}

            {/* 題材分組對照 */}
            {resp.themes.map((t) => (
              <section key={t.id} className="space-y-2">
                <div className="flex items-baseline gap-2">
                  <h2 className="text-sm font-bold">{t.theme}</h2>
                  {t.note && <span className="text-[11px] text-muted-foreground">{t.note}</span>}
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                  <ReturnsTable
                    title={`台股成分（${t.twStocks.length}）`}
                    rows={t.twStocks}
                    idCell={(r) => {
                      const row = r as TWStockRow;
                      return (
                        <Link
                          href={`/?load=${encodeURIComponent(row.symbol)}`}
                          className="text-primary hover:underline"
                        >
                          {row.code}
                        </Link>
                      );
                    }}
                  />
                  <ReturnsTable
                    title={`海外領先股（${t.overseas.length}）`}
                    rows={t.overseas}
                    idCell={(r) => <span>{(r as OverseasRow).ticker}</span>}
                  />
                </div>
              </section>
            ))}

            <div className="text-[10px] text-muted-foreground pb-4">
              台股端讀本地 L1 日K；海外端 Yahoo Finance（每日 cron 落地 data/overseas/candles/）。
              d1 = 最新收盤 vs 前一根；d5/d20/d60 = 最新 vs N 根前收盤。紅漲綠跌。
              產生於 {new Date(resp.generatedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })} CST。
            </div>
          </>
        )}
      </div>
    </PageShell>
  );
}
