'use client';

import { useState, useEffect, useRef } from 'react';
import { useBacktestStore } from '@/store/backtestStore';
import { useReplayStore } from '@/store/replayStore';
import { ScanResultsCompact } from './components/ScanResultsCompact';
import { DabanResultsCompact } from './components/DabanResultsCompact';
import { ScanCoachDigest } from './components/ScanCoachDigest';
import { LockWatchPanel } from './components/LockWatchPanel';
import { SanSeScanCompact } from './components/SanSeScanCompact';
// 2026-05-11 ReentryCandidatesPanel 移除：用戶反饋無實質用途（跟 B 回後買上漲重疊高、書本對齊度低）。檔案保留供日後重做
import { SectionBoundary } from '@/components/ErrorBoundary';
import { DatePicker } from '@/components/ui/DatePicker';
import type { SelectedStock } from './components/ScanChartPanel';
import {
  BULLISH_TRACK_LETTERS,
  BULLISH_TRACK_SET,
  REVERSAL_TRACK_LETTERS,
  REVERSAL_TRACK_SET,
  SYSTEM_TRACK_SET,
  MECHANICAL_TRACK_SET,
  SMARTMONEY_TRACK_SET,
  INSTDIP_TRACK_SET,
  INSTSTEAL_TRACK_SET,
  LETTER_NAMES,
} from '@/lib/scanner/buyMethodTracks';

interface ScanPanelVerticalProps {
  onSelectStock?: (stock: SelectedStock) => void;
}

export function ScanPanelVertical({ onSelectStock }: ScanPanelVerticalProps) {
  const {
    market, scanDate,
    useMultiTimeframe, toggleMultiTimeframe,
    setMarket,
    isScanning, scanProgress, scanningStock, scanningCount, scanError,
    scanResults, isFetchingForward, forwardError,
    clearCurrent,
    setScanOnly,
    scanDirection, setScanDirection,
    marketTrend,
    cancelScan,
    cronDates, fetchCronDates,
    isLoadingCronSession,
    autoLoadLatest,
    activeBuyMethod, setActiveBuyMethod, isLoadingBuyMethod,
    sanseLevel, setSanseLevel,
    // setScanOnly 暫保留 destructure（以後可能會加回手動掃描）
  } = useBacktestStore();
  void setScanOnly;
  void useMultiTimeframe;
  void toggleMultiTimeframe;

  const [coachCollapsed, setCoachCollapsed] = useState(true);

  // 三色資金（自創策略，台股+陸股）— 放在「朱老師戰法」排的 Q/R 旁邊，選一個 level 就切到該策略結果。
  // null = 走書本買法（A-R 字母）；非 null = 顯示三色資金該 level 命中清單。
  // level 提升到 backtestStore（單一事實來源），讓中間「條件/訊號」面板也能跟著三色/書本切換。
  const cnSanSeLevel = sanseLevel;
  const setCnSanSeLevel = setSanseLevel;
  const sanSeMode = cnSanSeLevel !== null;
  // 走圖目前選中的代號 → 三色資金清單高亮
  const selectedTicker = useReplayStore(s => s.currentStock?.ticker ?? null);

  // 載入歷史日期；市場/方向切換後自動載入最新結果
  const conditionMountedRef = useRef(false);
  useEffect(() => {
    const isInitialMount = !conditionMountedRef.current;
    conditionMountedRef.current = true;

    if (scanDirection === 'daban') {
      fetchCronDates(market, 'long');
      return;
    }
    const dir = scanDirection === 'short' ? 'short' : 'long';
    if (isInitialMount) {
      autoLoadLatest();
    } else {
      fetchCronDates(market, dir).then(() => {
        const dates = useBacktestStore.getState().cronDates.filter(c => c.market === market);
        if (dates.length > 0) {
          const bestDate = dates.find(c => c.resultCount > 0)?.date ?? dates[0].date;
          useBacktestStore.getState().loadCronSession(market, bestDate, { scanOnly: true, direction: dir });
        }
      });
    }

    // Periodic refresh
    const timer = window.setInterval(() => {
      const dir2 = useBacktestStore.getState().scanDirection === 'short' ? 'short' : 'long';
      fetchCronDates(useBacktestStore.getState().market, dir2);
    }, 5 * 60 * 1000);

    return () => window.clearInterval(timer);
  }, [market, scanDirection, fetchCronDates]); // eslint-disable-line react-hooks/exhaustive-deps

  const isBusy = isScanning || isFetchingForward;

  return (
    <div className="flex flex-col min-h-0 h-full text-foreground text-xs">
      {/* 大盤 banner 已移到走圖面板頂端（app/page.tsx 的 topAlertSlot） */}
      {/* 日期導航已下移到結果列表上方（對齊三色資金版型，見下方「股票卡片清單」前） */}

      {/* ── Toolbar: vertical stacked ── */}
      <div className="shrink-0 px-2.5 py-2 border-b border-border space-y-1.5">
        {/* Row 1: Market + Direction */}
        <div className="flex items-center gap-1.5">
          <div className="flex rounded overflow-hidden border border-border">
            {(['TW', 'CN'] as const).map(m => (
              <button key={m} onClick={async () => {
                if (m === market) return;
                setMarket(m);
                clearCurrent();
                const dir = scanDirection === 'long' || scanDirection === 'short' ? scanDirection : 'long';
                setScanDirection(dir);

                // 如果當前走圖是市場指數（^TWII / 000001.SS），自動切到新市場的指數
                // 個股 ticker 不動，避免使用者切市場意外失去當前看的股
                const currentTicker = useReplayStore.getState().currentStock?.ticker;
                const INDEX_TICKERS = new Set(['^TWII', '^TWOII', '000001.SS', '000300.SS']);
                if (currentTicker && INDEX_TICKERS.has(currentTicker)) {
                  const newIndex = m === 'TW' ? '^TWII' : '000001.SS';
                  if (currentTicker !== newIndex) {
                    useReplayStore.getState().loadStock(newIndex, '1d', '2y').catch(() => {});
                  }
                }

                await fetchCronDates(m, dir);
                const mDates = useBacktestStore.getState().cronDates.filter(c => c.market === m);
                if (mDates.length > 0) {
                  const bestDate = mDates.find(c => c.resultCount > 0)?.date ?? mDates[0].date;
                  useBacktestStore.getState().loadCronSession(m, bestDate, { scanOnly: true, direction: dir });
                }
              }}
                className={`min-h-9 px-2 py-1 text-[11px] font-medium ${market === m ? 'bg-blue-600 text-foreground' : 'bg-secondary text-muted-foreground hover:bg-muted'}`}>
                {m === 'TW' ? '台股' : '陸股'}
              </button>
            ))}
          </div>

          <div className="flex rounded overflow-hidden border border-border">
            <button onClick={() => { setScanDirection('long'); clearCurrent(); }}
              className={`min-h-9 px-2 py-1 text-[11px] font-medium ${scanDirection === 'long' ? 'bg-red-600 text-foreground' : 'bg-secondary text-muted-foreground hover:bg-muted'}`}>多</button>
            <button onClick={() => { setScanDirection('short'); clearCurrent(); }}
              className={`min-h-9 px-2 py-1 text-[11px] font-medium ${scanDirection === 'short' ? 'bg-green-600 text-foreground' : 'bg-secondary text-muted-foreground hover:bg-muted'}`}>空</button>
            {market === 'CN' && (
              <button onClick={() => { setScanDirection('daban'); }}
                className={`min-h-9 cursor-pointer px-2 py-1 text-[11px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${scanDirection === 'daban' ? 'bg-amber-600 text-foreground' : 'bg-secondary text-muted-foreground hover:bg-muted'}`}>打板</button>
            )}
          </div>

          {/* 長線保護短線 toggle — 暫時隱藏（保留 store 邏輯，日後可恢復）
          {scanDirection !== 'daban' && (
            <button onClick={toggleMultiTimeframe}
              className={`px-1.5 py-1 rounded text-[10px] font-medium border ${useMultiTimeframe ? 'bg-blue-700/60 border-blue-600 text-blue-200' : 'bg-secondary border-border text-muted-foreground hover:bg-muted'}`}>
              長線保護短線
            </button>
          )}
          */}

        </div>

        {/* 4 區塊策略選擇（書本五步法分層）— 只在做多時顯示
            ┌─ Step 1 池子 ─ A
            ├─ Step 2 多頭進場 ─ B/C/E/K/L/M/P（從 Step 1 挑）
            ├─ 反轉訊號 ─ D/F/J/N/O（不過 Step 1；J=ABC 突破 2026-07-05 移入，突破日天生短空）
            └─ 戰法軌 ─ Q（自含 SOP，套戒律）
        */}
        {scanDirection === 'long' && (() => {
          // META: name 從 LETTER_NAMES 單一事實來源讀；track/ma 是本 panel 特有顯示欄位
          const META: Record<string, { name: string; track: string; ma: string }> = {
            A: { name: LETTER_NAMES.A, track: '預選池', ma: '—' },
            // A30：六條件(30分K)盤中掃描 — 非買法字母，獨立 30分K宇宙變體(mtf=daily30)
            A30: { name: '六條件(30分)', track: '盤中30分', ma: '30分K' },
            B: { name: LETTER_NAMES.B, track: '多頭軌', ma: 'MA5' },
            C: { name: LETTER_NAMES.C, track: '多頭軌', ma: 'MA10' },
            D: { name: LETTER_NAMES.D, track: '轉折軌', ma: 'MA20' },
            E: { name: LETTER_NAMES.E, track: '多頭軌', ma: 'MA10' },
            F: { name: LETTER_NAMES.F, track: '轉折軌', ma: 'MA3' },
            J: { name: LETTER_NAMES.J, track: '轉折軌', ma: 'MA20' },
            K: { name: LETTER_NAMES.K, track: '多頭軌', ma: 'MA10' },
            L: { name: LETTER_NAMES.L, track: '多頭軌', ma: 'MA10' },
            M: { name: LETTER_NAMES.M, track: '多頭軌', ma: 'MA10' },
            N: { name: LETTER_NAMES.N, track: '轉折軌', ma: 'MA10' },
            O: { name: LETTER_NAMES.O, track: '轉折軌', ma: 'MA20' },
            P: { name: LETTER_NAMES.P, track: '多頭軌', ma: 'MA5' },
            Q: { name: LETTER_NAMES.Q, track: '戰法軌', ma: 'MA10' },
            R: { name: LETTER_NAMES.R, track: '機械軌', ma: 'MA20' },
            W: { name: LETTER_NAMES.W, track: '大戶軌', ma: '—' },
            X: { name: LETTER_NAMES.X, track: '接刀軌', ma: '—' },
            Y: { name: LETTER_NAMES.Y, track: '偷買軌(原)', ma: '—' },
          };
          type M = 'A' | 'A30' | 'B' | 'C' | 'D' | 'E' | 'F' | 'J' | 'K' | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q' | 'R' | 'W' | 'X' | 'Y';
          const renderBtn = (method: M, color: string) => {
            const m = META[method];
            const isBullish = BULLISH_TRACK_SET.has(method);
            const isReversal = REVERSAL_TRACK_SET.has(method);
            const isSystem = SYSTEM_TRACK_SET.has(method);
            const isMechanical = MECHANICAL_TRACK_SET.has(method);
            const isSmartMoney = SMARTMONEY_TRACK_SET.has(method);
            const isInstDip = INSTDIP_TRACK_SET.has(method);
            const isInstSteal = INSTSTEAL_TRACK_SET.has(method);
            const tooltip = method === 'A'
              ? `A · ${m.name}（書本五步法 Step 1 預選池：六條件 + 戒律 + 淘汰法）。多頭軌字母 B/C/E/K/L/M/P 都從這個池子挑進場時機。`
              : method === 'A30'
              ? `${m.name} · 盤中每 30 分鐘用「30分K」掃六條件、名單累加（成交額前 500 大台股）。\n早盤攻擊訊號最多、午後幾乎不動（六條件「紅K實體≥2%」是日K尺度）→ 累加不取代，名單整天越疊越完整，13:30 那次是當天最終。\n⚠️ 30分K為快照近似值；回測顯示此法無穩定超額，屬盯盤/紀律工具。`
              : isBullish
                ? `${method} · ${m.name} · ${m.track} · 守 ${m.ma}\n✓ 從 Step 1 池子篩選（結果為 A 子集；若池子被重新生成過，舊 session 不會 retro-filter）`
                : isReversal
                  ? `${method} · ${m.name} · ${m.track} · 守 ${m.ma}\n⚠ 全市場掃 — 不過 Step 1（抓底/反轉先過六條件就抓不到底；ABC 突破日天生短空也過不了六條件）`
                  : isSystem
                    ? `${method} · ${m.name} · ${m.track} · 守 ${m.ma}\n⚠ 全市場掃 — 自含 SOP（過戒律但不過 Step 1）`
                    : isMechanical
                      ? `${method} · ${m.name} · ${m.track} · 守 ${m.ma}\n⚙ 純機械式排名 — 不過六條件、不過戒律、不過 Step 0 大盤過濾\n做多：成交額前500中乖離率最負 top10 / 做空：成交額前500中乖離率最正 top10`
                      : isSmartMoney
                        ? `${method} · ${m.name}（籌碼集中度軌）\n成交額前500中：近5日股價在跌 + 三大法人逆勢買超集中度高，依集中度排序\n不過六條件、不過戒律、不過 Step 0。歷史回測不等於目前有效。`
                        : isInstDip
                          ? `${method} · ${m.name}（接刀軌，2026-06-14）\n成交額前500中：股價在跌/長黑 + 法人逆勢買，剔除大戶持股超高，依法人買超排序\n不過六條件/戒律/Step 0。結果尚未依單檔持倉與市場交易規則驗證，不可直接下單。`
                          : isInstSteal
                            ? `${method} · ${m.name}（最初版三條件，2026-06-14）\n🕵️ 股價在跌 + 5日籌碼集中度在增加 + 法人連續買，三個同時成立\n不過六條件/戒律/Step 0。⚠️ 回測扣成本後超額≈0、贏大盤<50%（train負test正、不穩）→ 觀察用非明牌`
                            : `${method} · ${m.name} · ${m.track} · 守 ${m.ma}`;
            return (
              <button key={method}
                onClick={() => { setCnSanSeLevel(null); setActiveBuyMethod(method); }}
                disabled={isLoadingBuyMethod}
                className={`min-h-8 cursor-pointer px-2 py-1 rounded text-[10px] font-medium border transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
                  activeBuyMethod === method && !sanSeMode
                    ? color
                    : 'bg-secondary border-border text-muted-foreground hover:bg-muted'
                }`}
                title={tooltip}>
                {m.name}
              </button>
            );
          };

          return (
            <div className="space-y-1.5">
              {/* Step 1：選股池 */}
              <div className="space-y-0.5">
                <div className="text-[9px] text-muted-foreground/70 px-0.5"
                  title="Step 1 預選池：過六條件 + 戒律 + 淘汰法的合格股票。所有 Step 2 多頭軌字母都從這個池子挑。">
                  <span className="font-bold text-amber-300/80">Step 1 選股池</span>
                  <span className="ml-1.5">過六條件 + 戒律 + 淘汰法的合格股票（所有 Step 2 多頭軌的源頭）</span>
                </div>
                <div className="flex items-center gap-1 flex-wrap">
                  {renderBtn('A', 'bg-amber-700/70 border-amber-600 text-amber-100')}
                  {renderBtn('A30', 'bg-amber-700/70 border-amber-600 text-amber-100')}
                </div>
              </div>

              {/* Step 2：多頭進場（從 Step 1 池子挑）*/}
              <div className="space-y-0.5">
                <div className="text-[9px] text-muted-foreground/70 px-0.5"
                  title="多頭軌字母（B/C/E/K/L/M/P）只從 Step 1 池子裡挑；結果必為 A 子集（ABC 突破在反轉訊號列 — 突破日天生短空過不了六條件）">
                  <span className="font-bold text-red-300/80">Step 2 多頭進場</span>
                  <span className="ml-1.5">✓ 從 Step 1 池子挑進場時機 · 書本多頭位置</span>
                </div>
                <div className="flex items-center gap-1 flex-wrap">
                  {BULLISH_TRACK_LETTERS.map(m =>
                    renderBtn(m, 'bg-red-700/70 border-red-600 text-red-100'),
                  )}
                </div>
              </div>

              {/* 反轉訊號（不過 Step 1，全市場掃）*/}
              <div className="space-y-0.5">
                <div className="text-[9px] text-muted-foreground/70 px-0.5"
                  title="反轉軌（跳空抓底 / V 反轉 / ABC 突破 / 型態確認 / 打底完成）全市場掃，不過 Step 1；結果可能不在六條件池子裡（抓底不能先過六條件；ABC 突破日天生短空也過不了）。注意：ABC 突破操作上仍是順勢進場（守 MA20/C 底），不套「翻黑就走」逆勢出場">
                  <span className="font-bold text-blue-300/80">反轉訊號</span>
                  <span className="ml-1.5">⚠ 全市場掃 · 不過六條件（抓底/反轉 + ABC 突破）</span>
                </div>
                <div className="flex items-center gap-1 flex-wrap">
                  {REVERSAL_TRACK_LETTERS.map(m =>
                    renderBtn(m, 'bg-blue-700/70 border-blue-600 text-blue-100'),
                  )}
                </div>
              </div>

              {/* 朱老師戰法 row：Q 三條均線（戰法軌）+ R 乖離率（機械軌）並排（2026-05-21）*/}
              <div className="space-y-0.5">
                <div className="text-[9px] text-muted-foreground/70 px-0.5"
                  title="戰法軌 Q（朱老師三均線，自含 SOP + 過戒律）；機械軌 R（純排名 = 成交額前500 + MA20 乖離率）。兩者都不過 Step 1 池子。">
                  <span className="font-bold text-purple-300/80">朱老師戰法</span>
                  <span className="ml-1.5">⚠ 三條均線戰法（《抓住線圖》p.262） + ⚙ 乖離率（純排名，不過六條件）</span>
                </div>
                <div className="flex items-center gap-1 flex-wrap">
                  {renderBtn('Q', 'bg-purple-700/70 border-purple-600 text-purple-100')}
                  {renderBtn('R', 'bg-cyan-700/70 border-cyan-600 text-cyan-100')}
                  {/* 大戶偷買(W) / 法人接刀(X) 2026-06-15 從畫面拿掉（程式留著、可選回）— 只留 Y */}
                  {/* 大戶法人偷買（Y，2026-06-14）— 三條件 AND */}
                  {renderBtn('Y', 'bg-amber-700/70 border-amber-600 text-amber-100')}
                  {/* 三色資金（自創策略，台股+陸股）— 嚴格/中等/寬鬆 三檔並排在乖離率旁邊 */}
                  {([
                    ['strict', '三色(嚴格)', '三色資金共振：短攻>2.8 + 中強>3.9 + 金叉/牛熊線/控盤>80 全到位'],
                    ['medium', '三色(中等)', '更新版：短攻/中強/中控 三分數都 > 0'],
                    ['loose', '三色(寬鬆)', '游資資金翻正：短線動能今天剛由負轉正'],
                    ['reversal', '三色(底反)', '底反該買 = 該買(紅機構在場＋雙B/捕撈觸發) ＋ 捕撈0軸下空頭區金叉。現行按鈕條件較廣，尚未證明穩定超額，不可直接下單'],
                    // 具名型態策略（從 records 衍生、掃全市場命中；判定 = lib/cn-sanse/namedStrategies）
                    ['resonance', '三色(全共振⭐)', '🔴🟣🟡三燈全亮 ＋ 雙B金叉 ＋ 捕撈金叉同日。條件嚴格且稀有，應獨立看樣本數與市場階段'],
                    ['red_yellow_trigger', '三色(紅+黃+觸發)', '紅(機構) ＋ 黃(控盤) 中線骨架 ＋ 一個觸發（雙B金叉/突破 或 捕撈金叉）。尚未證明穩定超額，需獨立看樣本與市場階段'],
                    ['red_dualb_gold', '三色(紅+雙B金叉)', '紅(機構)在場 ＋ 主圖黃線穿紅線（雙B黃紅金叉、只認金叉）。訊號較窄不代表勝率較高'],
                    ['red_dualb_any', '三色(紅+雙B金叉/突破)', '🔴紅(機構)在場 ＋（黃紅金叉 或 收盤突破智能交易線）'],
                  ] as const).map(([lv, label, tip]) => (
                    <button key={lv}
                      onClick={() => setCnSanSeLevel(lv)}
                      className={`min-h-8 cursor-pointer px-2 py-1 rounded text-[10px] font-medium border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-400 ${
                        cnSanSeLevel === lv
                          ? 'bg-fuchsia-700/70 border-fuchsia-600 text-fuchsia-100'
                          : 'bg-secondary border-border text-muted-foreground hover:bg-muted'
                      }`}
                      title={`${label} · ${market === 'TW' ? '台股' : '陸股'}自創策略\n${tip}`}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          );
        })()}

        {/* 機械軌 R（做空方向獨立區塊，與 long 共用同一 R 字母但載入 short session）*/}
        {scanDirection === 'short' && (
          <div className="space-y-0.5">
            <div className="text-[9px] text-muted-foreground/70 px-0.5"
              title="機械軌（R）做空：成交額前500中 MA20 乖離率最正 top10。不過六條件、不過 Step 0。">
              <span className="font-bold text-cyan-300/80">朱老師戰法（做空）</span>
              <span className="ml-1.5">⚙ 乖離率（做空）· 成交額前500 + MA20 乖離率正最多 top10</span>
            </div>
            <div className="flex items-center gap-1 flex-wrap">
              <button
                onClick={() => setActiveBuyMethod('R')}
                disabled={isLoadingBuyMethod}
                className={`min-h-8 cursor-pointer px-2 py-1 rounded text-[10px] font-medium border transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${
                  activeBuyMethod === 'R'
                    ? 'bg-cyan-700/70 border-cyan-600 text-cyan-100'
                    : 'bg-secondary border-border text-muted-foreground hover:bg-muted'
                }`}
                title={`R · ${LETTER_NAMES.R} · 機械軌 · 守 MA20\n不過六條件、不過 Step 0 大盤過濾\n做空：成交額前500中乖離率最正 top10`}>
                {LETTER_NAMES.R}
              </button>
            </div>
          </div>
        )}

        {/* 進度提示（cron 已自動跑掃描 + 22 天日期列已可切歷史，原手動掃描按鈕拿掉）*/}
        {isBusy && (
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span>{isScanning ? `掃描中 ${Math.round(scanProgress)}%` : '載入中…'}</span>
            <button onClick={cancelScan}
              className="ml-auto shrink-0 px-1.5 py-0.5 bg-red-700 hover:bg-red-600 text-foreground text-[10px] rounded">
              取消
            </button>
          </div>
        )}

      </div>

      {sanSeMode && scanDirection === 'long' ? (
        // 三色僅做多；切到 空/打板 時退回書本買法清單（level 仍保留，切回「多」會自動恢復三色）
        <SanSeScanCompact market={market} level={cnSanSeLevel ?? 'medium'} onSelectStock={onSelectStock} selectedSymbol={selectedTicker} />
      ) : (
      <>
      {/* ── 鎖股觀察（4 區塊之後，結果列表之前）── */}
      <div className="shrink-0 border-b border-border bg-card/40">
        {scanDirection !== 'daban' && <LockWatchPanel market={market} onSelectStock={onSelectStock} />}
      </div>

      {/* 朱老師跨檔分析（只在非打板時顯示） */}
      <div className="shrink-0 border-b border-border bg-card/40">
        {scanDirection !== 'daban' && scanResults.length > 0 && (
          <div>
            <button
              onClick={() => setCoachCollapsed(v => !v)}
              className="w-full flex items-center justify-between px-2.5 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors">
              <span className="font-medium">朱老師分析</span>
              <span>{coachCollapsed ? '▶' : '▼'}</span>
            </button>
            {!coachCollapsed && (
              <div className="px-2.5 pb-1.5 max-h-[55vh] overflow-y-auto">
                <ScanCoachDigest
                  market={market}
                  scanDate={scanDate}
                  direction={scanDirection === 'short' ? 'short' : 'long'}
                  marketTrend={String(marketTrend ?? '')}
                  results={scanResults}
                  buyMethod={activeBuyMethod}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── 日期導航：點哪天看哪天的結果（移到結果列表上方，對齊三色資金版型）── */}
      {cronDates.some(c => c.market === market) && (
        <div className="shrink-0 px-2.5 py-1.5 border-b border-border bg-card/40">
          <DatePicker
            value={scanDate}
            onChange={(nextDate) => {
              if (isBusy || isLoadingCronSession) return;
              if (scanDirection === 'daban') {
                useBacktestStore.setState({ scanDate: nextDate });
              } else {
                useBacktestStore.getState().loadCronSession(market, nextDate, { scanOnly: true, direction: scanDirection });
              }
            }}
            dates={cronDates.filter(c => c.market === market)
              .filter((c, i, arr) => arr.findIndex(x => x.date === c.date) === i)
              .map(c => c.date)}
            meta={Object.fromEntries(cronDates.filter(c => c.market === market)
              .map(c => [c.date, { count: c.resultCount >= 0 ? c.resultCount : undefined }]))}
            size="sm"
            disabled={isBusy || isLoadingCronSession}
            ariaLabel="策略掃描歷史日期"
          />
        </div>
      )}

      {/* ── 下方可滑動：股票卡片清單 ── */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Progress bar */}
        {(isScanning || isFetchingForward) && (
          <div className="px-2.5 py-1.5 border-b border-border">
            <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-0.5">
              <span className="truncate">{isScanning ? (scanningStock || '掃描中…') : '計算績效…'}</span>
              {isScanning && scanningCount && <span className="font-mono shrink-0">{scanningCount}</span>}
            </div>
            <div className="h-1 bg-secondary rounded-full overflow-hidden">
              <div className="h-full bg-sky-500 rounded-full transition-all duration-500"
                style={{ width: isScanning ? `${scanProgress}%` : '100%' }} />
            </div>
          </div>
        )}

        {/* Loading */}
        {isLoadingCronSession && scanResults.length === 0 && (
          <div className="px-3 py-3 text-center text-muted-foreground">
            <span className="inline-block w-3 h-3 border border-sky-500/30 border-t-sky-500 rounded-full animate-spin mr-1.5" />
            <span className="text-[11px]">載入中…</span>
          </div>
        )}

        {/* Error / Warning */}
        {(scanError || forwardError) && (() => {
          const msg = scanError || forwardError || '';
          const isWarning = msg.includes('\u90e8\u5206\u8986\u84cb') || msg.includes('\u8986\u84cb\u7387') || msg.includes('無符合');
          const isInfo = msg.includes('正常現象');
          const colorClass = isInfo
            ? 'bg-blue-950/60 border border-blue-900 text-blue-300'
            : isWarning
              ? 'bg-amber-950/60 border border-amber-900 text-amber-300'
              : 'bg-red-950/60 border border-red-900 text-red-300';
          return (
            <div className={`mx-2.5 my-1.5 px-2.5 py-2 rounded text-[10px] leading-relaxed ${colorClass}`}>
              {msg.split('\n').map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          );
        })()}

        {/* Results — compact card view */}
        <div className="py-1.5">
          {scanDirection === 'daban' ? (
            <SectionBoundary section="打板掃描結果">
              <DabanResultsCompact date={scanDate} onSelectStock={onSelectStock} />
            </SectionBoundary>
          ) : (
            <SectionBoundary section="掃描結果">
              <ScanResultsCompact onSelectStock={onSelectStock} />
            </SectionBoundary>
          )}
        </div>
      </div>
      </>
      )}
    </div>
  );
}
