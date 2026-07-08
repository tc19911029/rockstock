'use client';

/**
 * 獵兔鎖股看板 — 課程 CH5-6 白話決策版
 *
 * 把既有的持久化 roster（lib/scanner/lockRoster.ts + /api/lockroster）做成
 * 「每天打開就知道盯誰、明天怎麼辦」的看板：
 *   - 明天最可能發動 top 3（緊迫度高＋離關鍵價近）highlight
 *   - 每檔一句白話「明天怎麼辦」（課程紀律：13:20 看、13:25 掛市價、開高≥5% 別追）
 *   - weakFlags 轉弱直接變 🚩 警示（課程：連放都不要放）
 * 全部用現成 API 資料 + 前端衍生，不動後端、不碰選股 gate。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PageShell, PageHeader, StatsCard, EmptyState } from '@/components/shared';
import type { LockRoster, LockRosterEntry, RosterReview } from '@/lib/scanner/lockRoster';

type Market = 'TW' | 'CN';

const CAT_EMOJI: Record<number, string> = {
  1: '🏗', 2: '📦', 3: '🎢', 4: '🔁', 5: '➖', 6: '📐', 7: '🧩', 8: '⬛',
};

/** 等突破類（關鍵價在上方，越過就進場） */
const BREAKOUT_CATS = new Set([2, 5, 6, 7, 8]);

/** 距關鍵價百分比（正=還要漲才到、負=已越過） */
function distancePct(e: LockRosterEntry): number | null {
  if (e.triggerLevel == null || e.lastClose <= 0) return null;
  return ((e.triggerLevel - e.lastClose) / e.lastClose) * 100;
}

/** 緊迫度 → 白話狀態 */
function readiness(urgency: number): { text: string; tone: 'hot' | 'warm' | 'cool' } {
  if (urgency >= 85) return { text: '即將發動', tone: 'hot' };
  if (urgency >= 65) return { text: '準備中', tone: 'warm' };
  return { text: '等待中', tone: 'cool' };
}

/** 一句白話「明天怎麼辦」（課程紀律 + 分類差異） */
function tomorrowAction(e: LockRosterEntry): string {
  const trig = e.triggerLevel != null ? e.triggerLevel.toFixed(2) : null;
  if (BREAKOUT_CATS.has(e.category) && trig) {
    return `盯關鍵價 ${trig}。明天帶量紅K「收盤」站上就進 → 13:20 看、13:25 沒被打下來掛市價；開高 ≥5% 先別追（等回後買）。`;
  }
  if (e.category === 4) {
    return trig
      ? `回檔中。站回 5 均＋紅K過前高 ${trig} 再進；跌破前低就放棄、別凹單。`
      : '多頭中繼，等下一個回檔買點（站回 5 均＋紅K過前高）。';
  }
  if (e.category === 3) {
    return '位置太高、別追。等它拉回止跌（長下影或紅K、不破前低）再看；拉回爆長黑就不做。';
  }
  if (e.category === 1) {
    return '底部還沒完成，先觀察不動。等多頭確認（頭頭高＋底底高）再鎖進場。';
  }
  return e.waitingFor;
}

/** 轉弱是否含硬汰弱等級（跌破/爆量/連黑） */
function hasHardWeak(e: LockRosterEntry): boolean {
  return e.weakFlags.some(f => /跌破|爆量|連3黑|連4黑/.test(f));
}

export default function LockRosterBoardPage() {
  const [market, setMarket] = useState<Market>('TW');
  const [roster, setRoster] = useState<LockRoster | null>(null);
  const [reviews, setReviews] = useState<RosterReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [showReviews, setShowReviews] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/lockroster?market=${market}`, { cache: 'no-store' });
      const j = await res.json();
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

  // avoid 級（處置股/法人連賣等）往下沉，同級按緊迫度
  const entries = useMemo(
    () => [...(roster?.entries ?? [])].sort((a, b) =>
      (a.avoidLevel === 'avoid' ? 1 : 0) - (b.avoidLevel === 'avoid' ? 1 : 0) || b.urgency - a.urgency),
    [roster],
  );
  // 明天最可能發動：排除避雷級（不推薦陷阱）
  const top3 = entries.filter(e => e.avoidLevel !== 'avoid').slice(0, 3);
  const hotCount = entries.filter(e => e.urgency >= 85 && e.avoidLevel !== 'avoid').length;
  const weakCount = entries.filter(e => e.weakFlags.length > 0).length;
  const avoidCount = entries.filter(e => e.avoidLevel === 'avoid').length;

  const header = (
    <PageHeader
      title="🐇 獵兔鎖股看板"
      subtitle={`課程 CH5-6｜${entries.length} 檔`}
      backButton
      actions={
        <div className="flex items-center gap-1">
          {(['TW', 'CN'] as Market[]).map(m => (
            <button
              key={m}
              type="button"
              onClick={() => setMarket(m)}
              className={`px-2 py-0.5 rounded text-[11px] ${
                market === m ? 'bg-foreground text-background font-bold' : 'text-muted-foreground hover:text-foreground'
              }`}
            >{m === 'TW' ? '台股' : '陸股'}</button>
          ))}
        </div>
      }
    />
  );

  return (
    <PageShell headerSlot={header}>
      <div className="p-3 sm:p-4 max-w-4xl mx-auto space-y-4">

        {/* 說明 */}
        <p className="text-[12px] text-muted-foreground">
          鎖股名單汰弱留強、每檔標「在等什麼」。每日 19:05 從盤後掃描自動補位，破月線／前低自動汰弱。
          「明天怎麼辦」是課程紀律提示，不是自動下單。
          <span className="text-muted-foreground/70">（排序＝離發動遠近的組織順序；回測顯示緊迫度不預測勝率，別把「即將發動」當包贏。）</span>
        </p>

        {loading ? (
          <div className="text-sm text-muted-foreground py-8 text-center">載入中…</div>
        ) : entries.length === 0 ? (
          <EmptyState
            title="名單為空"
            description="每日 19:05 從盤後掃描結果自動補位，或到自選股頁手動加入鎖股。"
          />
        ) : (
          <>
            {/* 數字卡 */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
              <StatsCard label="鎖股檔數" value={`${entries.length} / 15`} sub="課程：10~15 檔最好" />
              <StatsCard label="即將發動" value={hotCount} tone={hotCount > 0 ? 'bull' : 'muted'} sub="緊迫 ≥ 85（不含避雷）" />
              <StatsCard label="避雷紅旗" value={avoidCount} tone={avoidCount > 0 ? 'bear' : 'muted'} sub="🚫 別碰（處置/法人連賣）" />
              <StatsCard label="出現轉弱" value={weakCount} tone={weakCount > 0 ? 'bear' : 'muted'} sub="課程：連放都不要放" />
            </div>

            {/* 明天最可能發動 top 3 */}
            <div>
              <div className="text-sm font-bold mb-2">🔥 明天最可能發動</div>
              <div className="grid gap-2 sm:grid-cols-3">
                {top3.map(e => {
                  const d = distancePct(e);
                  const r = readiness(e.urgency);
                  const flagged = e.weakFlags.length > 0;
                  return (
                    <div
                      key={e.symbol}
                      className={`rounded-xl bg-card ring-1 px-3 py-3 flex flex-col gap-1.5 ${
                        flagged ? 'ring-bear/40' : r.tone === 'hot' ? 'ring-bull/40' : 'ring-foreground/10'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <Link href={`/?load=${e.symbol}`} className="font-bold hover:underline truncate">
                          {e.name} <span className="font-mono text-muted-foreground text-xs">{e.symbol}</span>
                        </Link>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${
                          r.tone === 'hot' ? 'bg-bull/15 text-bull' : r.tone === 'warm' ? 'bg-amber-400/15 text-amber-400' : 'bg-secondary text-muted-foreground'
                        }`}>{r.text}</span>
                      </div>
                      <div className="text-[11px]">
                        <span className="px-1.5 py-0.5 rounded bg-secondary">{CAT_EMOJI[e.category]} {e.label}</span>
                        {e.triggerLevel != null && d != null && (
                          <span className="ml-1.5 font-mono text-muted-foreground">
                            關鍵價 {e.triggerLevel.toFixed(2)}（{d >= 0 ? '距 +' : '已越 '}{Math.abs(d).toFixed(1)}%）
                          </span>
                        )}
                      </div>
                      {e.avoidLevel === 'avoid' && e.avoidFlags && e.avoidFlags.length > 0 && (
                        <div className="text-[11px] text-bear font-medium">🚫 {e.avoidFlags.join('、')}</div>
                      )}
                      {flagged && (
                        <div className={`text-[11px] ${hasHardWeak(e) ? 'text-bear font-medium' : 'text-amber-400'}`}>
                          🚩 {e.weakFlags.join('、')}
                        </div>
                      )}
                      <div className="text-[11px] text-muted-foreground leading-snug">{tomorrowAction(e)}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 完整名單 */}
            <div>
              <div className="text-sm font-bold mb-2">📋 完整鎖股名單（按操作順序）</div>
              <div className="space-y-1.5">
                {entries.map((e, i) => {
                  const d = distancePct(e);
                  const r = readiness(e.urgency);
                  return (
                    <div key={e.symbol} className="rounded-lg bg-card ring-1 ring-foreground/10 px-3 py-2">
                      <div className="flex items-start gap-2">
                        <span className="text-muted-foreground font-mono text-xs w-5 shrink-0 pt-0.5">{i + 1}.</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <Link href={`/?load=${e.symbol}`} className="font-bold hover:underline text-sm">
                              {e.name} <span className="font-mono text-muted-foreground text-xs">{e.symbol}</span>
                            </Link>
                            <span className="px-1.5 py-0.5 rounded bg-secondary text-[10px]">{CAT_EMOJI[e.category]} {e.label}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                              r.tone === 'hot' ? 'bg-bull/15 text-bull' : r.tone === 'warm' ? 'bg-amber-400/15 text-amber-400' : 'bg-secondary text-muted-foreground'
                            }`}>{r.text} {e.urgency.toFixed(0)}</span>
                            {e.source === 'manual' && <span className="text-[10px] text-muted-foreground">✋手動</span>}
                            {e.triggerLevel != null && d != null && (
                              <span className="text-[10px] font-mono text-muted-foreground">
                                關鍵價 {e.triggerLevel.toFixed(2)}｜{d >= 0 ? '距 +' : '已越 '}{Math.abs(d).toFixed(1)}%
                              </span>
                            )}
                            {e.avoidLevel === 'avoid' && e.avoidFlags && e.avoidFlags.length > 0 && (
                              <span className="text-[10px] text-bear font-medium" title={e.avoidFlags.join('\n')}>
                                🚫 {e.avoidFlags[0]}{e.avoidFlags.length > 1 ? ` +${e.avoidFlags.length - 1}` : ''}
                              </span>
                            )}
                            {e.avoidLevel === 'notice' && (
                              <span className="text-[10px] text-amber-400" title="注意股">🚫 注意股</span>
                            )}
                            {e.weakFlags.length > 0 && (
                              <span className={`text-[10px] ${hasHardWeak(e) ? 'text-bear font-medium' : 'text-amber-400'}`} title={e.weakFlags.join('\n')}>
                                🚩 轉弱×{e.weakFlags.length}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-muted-foreground leading-snug mt-0.5">
                            {tomorrowAction(e)}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void removeSymbol(e.symbol)}
                          className="text-muted-foreground/50 hover:text-bear text-xs shrink-0"
                          title="移出鎖股名單"
                        >✕</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 汰弱紀錄 */}
            <div>
              <button
                type="button"
                onClick={() => setShowReviews(s => !s)}
                className="text-[12px] text-muted-foreground hover:text-foreground"
              >
                📉 每日汰弱紀錄 {showReviews ? '▾' : '▸'}
              </button>
              {showReviews && (
                <div className="mt-2 space-y-1.5">
                  {reviews.length === 0 && <div className="text-[11px] text-muted-foreground">尚無汰弱紀錄</div>}
                  {reviews.map(rv => (
                    <div key={rv.date} className="text-[11px] rounded bg-card ring-1 ring-foreground/10 px-2.5 py-1.5">
                      <span className="font-mono text-muted-foreground">{rv.date}</span>
                      <span className="ml-2">留 {rv.kept}｜進 {rv.added.length}｜汰 {rv.removed.length}</span>
                      {rv.removed.length > 0 && (
                        <div className="ml-2 mt-0.5 text-muted-foreground">
                          汰弱：{rv.removed.map(x => `${x.name}（${x.reasons.join('、')}）`).join('；')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </PageShell>
  );
}
