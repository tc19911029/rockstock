'use client';

/**
 * 鎖股名單（獵兔計劃）面板 — 課程 CH5-6（批次D 2026-07-05）
 * 10~15 檔持久化名單 + 8 分類「在等什麼」+ 緊迫度排序 + 每日汰弱紀錄。
 * 資料來源 /api/lockroster（server FS，每日 19:05 cron 重算）。
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { LockRoster, RosterReview } from '@/lib/scanner/lockRoster';
import { stockDisplayName } from '@/lib/stocks/stockIdentity';

const CAT_EMOJI: Record<number, string> = {
  1: '🏗', 2: '📦', 3: '🎢', 4: '🔁', 5: '➖', 6: '📐', 7: '🧩', 8: '⬛',
};

export default function LockRosterPanel({ market = 'TW' }: { market?: 'TW' | 'CN' }) {
  const [roster, setRoster] = useState<LockRoster | null>(null);
  const [reviews, setReviews] = useState<RosterReview[]>([]);
  const [showReviews, setShowReviews] = useState(false);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const res = await fetch(`/api/lockroster?market=${market}`, { cache: 'no-store' });
      const j = await res.json();
      // apiOk 回的是最外層 { ok, roster, recentReviews }，沒有 data 包一層（舊版讀 j.data.* → 永遠空）
      setRoster(j?.roster ?? null);
      setReviews(j?.recentReviews ?? []);
    } catch { /* 顯示空狀態 */ }
    setLoading(false);
  }, [market]);

  useEffect(() => { void reload(); }, [reload]);

  const removeSymbol = useCallback(async (symbol: string) => {
    await fetch('/api/lockroster', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ market, action: 'remove', symbol }),
    });
    void reload();
  }, [market, reload]);

  if (loading) return null;

  return (
    <div className="rounded-lg border border-border bg-card p-3 mb-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-bold">
          🐇 鎖股名單（獵兔計劃）
          <span className="ml-2 text-[11px] text-muted-foreground font-normal">
            課程 CH5-6：汰弱留強 10~15 檔，按「在等什麼」排操作順序
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/lockroster" className="text-[11px] text-blue-400 hover:underline">
            開看板 →
          </Link>
          <button
            type="button"
            onClick={() => setShowReviews(s => !s)}
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            汰弱紀錄 {showReviews ? '▾' : '▸'}
          </button>
        </div>
      </div>

      {(!roster || roster.entries.length === 0) ? (
        <div className="text-[12px] text-muted-foreground py-2">
          名單為空 — 每日 19:05 從盤後掃描結果自動補位（或手動加入）。
        </div>
      ) : (
        <div className="space-y-1">
          {roster.entries.map((e, i) => (
            <div key={e.symbol} className="flex items-start gap-2 text-[12px] px-2 py-1.5 rounded bg-secondary/40">
              <span className="text-muted-foreground font-mono w-5 shrink-0">{i + 1}.</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Link href={`/?load=${e.symbol}`} className="font-bold hover:underline">
                    {stockDisplayName(e.name, e.symbol)} <span className="font-mono text-muted-foreground">{e.symbol}</span>
                  </Link>
                  <span className="px-1.5 py-0.5 rounded bg-secondary text-[10px]">
                    {CAT_EMOJI[e.category]} {e.label}
                  </span>
                  <span className="text-[10px] text-amber-400 font-mono" title="操作順序分（三角收斂尾端最前）">
                    緊迫 {e.urgency.toFixed(0)}
                  </span>
                  {e.source === 'manual' && <span className="text-[10px] text-muted-foreground">✋手動</span>}
                  {e.weakFlags.length > 0 && (
                    <span className="text-[10px] text-rose-400" title={e.weakFlags.join('\n')}>
                      ⚠️ 轉弱×{e.weakFlags.length}
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground truncate" title={`${e.waitingFor}\n${e.urgencyDetail}`}>
                  {e.waitingFor}
                  {e.triggerLevel != null && e.lastClose > 0 && (
                    <span className="ml-1 font-mono">
                      （關鍵價 {e.triggerLevel.toFixed(2)}，距 {(((e.triggerLevel - e.lastClose) / e.lastClose) * 100).toFixed(1)}%）
                    </span>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void removeSymbol(e.symbol)}
                className="text-muted-foreground/60 hover:text-rose-400 text-[11px] shrink-0"
                title="移出鎖股名單"
              >✕</button>
            </div>
          ))}
        </div>
      )}

      {showReviews && (
        <div className="mt-2 pt-2 border-t border-border space-y-1.5">
          {reviews.length === 0 && <div className="text-[11px] text-muted-foreground">尚無汰弱紀錄</div>}
          {reviews.map(r => (
            <div key={r.date} className="text-[11px]">
              <span className="font-mono text-muted-foreground">{r.date}</span>
              <span className="ml-2">留 {r.kept}｜進 {r.added.length}｜汰 {r.removed.length}</span>
              {r.removed.length > 0 && (
                <div className="ml-4 text-muted-foreground">
                  {r.removed.map(x => `${x.name}（${x.reasons.join('、')}）`).join('；')}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
