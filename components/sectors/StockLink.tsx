'use client';

/**
 * 題材分類共用的「點股票」連結（2026-06-19）。
 *
 * 兩種情境用同一套：
 *   - 整頁 /sectors：沒有 onSelectStock → 退回 <Link href="/?load=代號">（會導頁）。
 *   - 首頁右側「題材分類」分頁：有 onSelectStock（透過 context 注入）→ 在原地換左側 K 線、不跳轉。
 *
 * 用 context 注入 onSelectStock，避免一路 prop-drill 穿過 PerfGrid/HotRow/SectorRow/CnView 一堆連結點。
 * `code` = 要餵給走圖的代號：台股裸碼（如 2330）、陸股帶後綴（如 600519.SS）。
 */
import { createContext, useContext, type ReactNode } from 'react';
import Link from 'next/link';
import { useWatchlistStore } from '@/store/watchlistStore';
import { navKey } from '@/lib/chartListNav';
import { isPlaceholderStockName } from '@/lib/stocks/stockIdentity';

export type SectorSelectStock = (code: string) => void;

export const SectorsNavContext = createContext<SectorSelectStock | null>(null);

/** 策略掃描對某檔的信號（交叉比對 /api/scanner/results 帶入卡片）。 */
export interface ScanSig { six: number; trend: string; pos: string; patterns: string[]; methods: string[] }

/** 六大進場條件 + 趨勢（/api/themes/six-conditions 逐檔即時判讀，覆蓋全部成分股）。 */
export interface SixCondSig { six: number; core: number; ready: boolean; trend: '多頭' | '空頭' | '盤整'; pos: string }

/** 跨來源徽章資料：近期 YouTube 提及 / 今日三色選中（裸碼 Set）+ 策略掃描信號 + 六條件判讀（裸碼→sig）。 */
export interface SectorBadgeSets { youtube: Set<string>; sanse: Set<string>; scan: Map<string, ScanSig>; six: Map<string, SixCondSig> }
export const SectorsBadgesContext = createContext<SectorBadgeSets | null>(null);
export function useSectorBadges(): SectorBadgeSets | null { return useContext(SectorsBadgesContext); }

/** 趨勢徽章顏色（多頭=紅、空頭=綠、盤整=灰）。 */
function trendBadge(trend: string) {
  if (trend === '多頭') return <span title="趨勢：多頭（頭頭高、底底高）" className="text-[10px] px-1 py-0.5 rounded bg-red-500/15 text-red-400 whitespace-nowrap">多頭</span>;
  if (trend === '空頭') return <span title="趨勢：空頭（頭頭低、底底低）" className="text-[10px] px-1 py-0.5 rounded bg-green-500/15 text-green-400 whitespace-nowrap">空頭</span>;
  if (trend === '盤整') return <span title="趨勢：盤整" className="text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground whitespace-nowrap">盤整</span>;
  return null;
}

/** 六條件 + 趨勢徽章（台股／陸股共用，同一視覺）。核心 5 條全過才掛六條件徽章、6/6 加金邊。 */
export function SixCondTrendBadges({ six, ready, trend }: { six: number | null; ready: boolean; trend: string }) {
  return (
    <>
      {six != null && ready && (
        <span title="符合朱老師六大進場條件（前 5 條核心門檻全過；6/6 含 KD／MACD）"
          className={`text-[10px] px-1 py-0.5 rounded whitespace-nowrap font-medium ${six >= 6 ? 'bg-amber-500/20 text-amber-300 ring-1 ring-amber-400/40' : 'bg-orange-500/15 text-orange-400'}`}>
          {six >= 6 ? '✅' : '🎯'}六條件 {six}/6
        </span>
      )}
      {trendBadge(trend)}
    </>
  );
}

/**
 * 個股跨來源小徽章：📺=YouTube 近期提及、🎨三色=三色策略今日選中、
 * 六條件徽章（核心 5 條全過才掛、6/6 加金邊）、趨勢（多頭/空頭/盤整）、買法/型態（策略掃描命中）。命中才顯示。
 */
export function StockBadges({ code }: { code: string }) {
  const b = useContext(SectorsBadgesContext);
  if (!b) return null;
  const yt = b.youtube.has(code);
  const ss = b.sanse.has(code);
  const sx = b.six.get(code);
  const sc = b.scan.get(code);
  // 六條件分數/趨勢：優先用逐檔即時判讀（覆蓋全成分股），退回掃描結果（只含合格股）
  const six = sx?.six ?? sc?.six ?? null;
  const ready = sx?.ready ?? (sc ? sc.six >= 5 : false);
  const trend = sx?.trend ?? sc?.trend ?? '';
  if (!yt && !ss && six == null && !sc) return null;
  return (
    <>
      {yt && <Link href={`/youtube/stocks/${code}`} title="看是哪天哪個節目提及（提及時間軸）" onClick={(e) => e.stopPropagation()}
        className="text-[10px] px-1 py-0.5 rounded bg-purple-500/15 text-purple-400 hover:bg-purple-500/30 whitespace-nowrap">📺</Link>}
      {ss && <span title="三色資金策略今日選中" className="text-[10px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-400 whitespace-nowrap">🎨三色</span>}
      <SixCondTrendBadges six={six} ready={ready} trend={trend} />
      {sc?.methods?.length ? <span title={`朱老師買法命中：${sc.methods.join('、')}`} className="text-[10px] px-1 py-0.5 rounded bg-green-500/15 text-green-400 whitespace-nowrap">買法{sc.methods.join('')}</span> : null}
      {sc?.patterns?.map((p) => <span key={p} title={`型態：${p}`} className="text-[10px] px-1 py-0.5 rounded bg-sky-500/15 text-sky-400 whitespace-nowrap">{p}</span>)}
    </>
  );
}

export function StockLink({ code, className, title, children }: {
  code: string;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const onSelect = useContext(SectorsNavContext);
  // data-navstock：鍵盤 ↑↓ 跳股用的裸碼標記（見 lib/chartListNav）
  if (onSelect) {
    return (
      <button type="button" className={className} title={title} data-navstock={navKey(code)}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSelect(code); }}>
        {children}
      </button>
    );
  }
  return (
    <Link href={`/?load=${code}`} className={className} title={title} data-navstock={navKey(code)}
      onClick={(e) => e.stopPropagation()}>
      {children}
    </Link>
  );
}

/** 加入自選鈕（reactive：加入後即時顯示 ✓）。台股傳裸碼、陸股傳帶後綴 symbol。 */
export function AddWatchBtn({ code, name }: { code: string; name: string }) {
  const has = useWatchlistStore((s) => s.items.some((i) => i.symbol === code));
  const unresolved = isPlaceholderStockName(name, code);
  return (
    <button type="button" disabled={unresolved} title={unresolved ? '中文名稱尚未解析，暫時不能加入自選' : has ? '已在自選' : '加入自選'}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); useWatchlistStore.getState().add(code, name); }}
      className={`text-[10px] px-1.5 py-0.5 rounded border whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-40 ${has ? 'border-emerald-500/40 text-emerald-400' : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/30'}`}>
      {has ? '✓' : unresolved ? '待補' : '＋'}
    </button>
  );
}
