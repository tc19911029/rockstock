/**
 * holdingsGuard — 持倉保命警報層（純函數，無 IO）
 *
 * 掛在 realtime-scan 30s 迴圈內，對「持倉」跑三條即時保命規則：
 *   1. stop-loss-breach — 最新報價跌破停損價（做空反向：漲破回補停損）。不暖機。
 *   2. pump-reversal    — 當日曾大漲後自當日高點回檔（拉高出貨保護）。
 *   3. rapid-drop       — 近 N 分鐘急跌（1 分 K 滾動視窗，拉低出貨保護）。
 *
 * 定位：即時「提醒」層 — 正式操作建議仍由 portfolio-notify（120s，holdingsActionEngine）
 * 負責，雙軌並存。純警報：不下單、不改持倉檔、不進選股鏈路（鐵則 #5 不受影響）。
 *
 * ⚠ 與 blowoffDetector 同款 caveat：分時推論、非書本日 K 規則，未經回測。
 *
 * Dedup：三規則皆為 level 型（價格在門檻附近震盪會反覆成立）→ GuardSignal 帶
 * dedupScope: 'day'，由 alertDispatcher 做「同日同檔同規則只 fire 一次」的 disk-backed 去重。
 * 本模組不做內部記憶，每輪重算 candidate 即可。
 */

import type { MinuteBar } from './minuteBarStore';
import type { MonitoredHoldingInfo, MonitoredSymbol } from './monitorPool';
import { HOLDINGS_GUARD, type GuardScope } from '@/lib/config';
import { DEFAULT_STOP_LOSS_MULT } from '@/lib/agents/holdingsActionEngine';

export type GuardRuleId = 'stop-loss-breach' | 'pump-reversal' | 'rapid-drop' | 'reversal-open-low' | 'gap-open-buffer';

export interface GuardQuote {
  /** 最新成交價 */
  price: number;
  /** 當日最高（vendor 直供 — 比重啟後殘缺的分 K 可靠） */
  dayHigh?: number;
  /** 昨收 */
  prevClose?: number;
}

export interface GuardContext {
  symbol: string;
  market: 'TW' | 'CN';
  source: MonitoredSymbol['source'];
  isHolding: boolean;
  /** 從 monitorPool 透傳（source='holding' 才有） */
  holding?: MonitoredHoldingInfo;
}

export interface GuardSignal {
  rule: GuardRuleId;
  symbol: string;
  market: 'TW' | 'CN';
  /** 觸發時 wall-clock，floor 到分鐘（day dedup 不看 ts，僅記錄用） */
  ts: number;
  tfMin: 1;
  /** level 型規則：同日同檔同規則只推一次 */
  dedupScope: 'day';
  meta: {
    price: number;
    /** 股名（推播訊息用，來自持倉檔） */
    name?: string;
    stopLoss?: number;
    entryPrice?: number;
    positionSide?: 'long' | 'short';
    prevClose?: number;
    dayHigh?: number;
    /** 規則2：當日高 vs 昨收漲幅 % */
    dayGainPct?: number;
    /** 規則2：自當日高點回檔 % */
    drawdownPct?: number;
    /** 規則3：視窗內跌幅 % */
    dropPct?: number;
    /** 規則3：視窗長度（分鐘） */
    windowMin?: number;
    /** 規則3：視窗基準價 */
    refClose?: number;
    /** 規則5：昨日轉折訊號名（課程 CH2 變盤家族） */
    reversalLabel?: string;
    /** 規則5：昨日最低（收盤跌破=出場執行線） */
    yLow?: number;
    /** 規則5：昨收（開低基準） */
    yClose?: number;
    /** 規則5/6：目前開低幅度 % */
    openLowPct?: number;
  };
  caveat: 'minute-inference';
  isHolding: boolean;
  source: MonitoredSymbol['source'];
}

/**
 * Scope 判斷（export 供 alertDispatcher 的規則4 gate 重用 + 單元測試）。
 * - 'holding'：isHolding=true（含 extra-symbols 標 isHolding 的 manual 項）
 * - 'holding_manual'：持倉 + 全部 manual 監控
 * - 缺 source 視為 'scan'（fail-safe 最窄）
 */
export function scopeAllows(
  scope: GuardScope,
  sig: { isHolding: boolean; source?: string },
): boolean {
  switch (scope) {
    case 'off': return false;
    case 'holding': return sig.isHolding;
    case 'holding_manual': return sig.isHolding || (sig.source ?? 'scan') === 'manual';
    case 'all': return true;
    default: return false;
  }
}

/**
 * 主入口 — 對單一 symbol 跑三規則。
 *
 * @param quote  最新 vendor quote（null = 該輪沒抓到 → 只跑純分K的規則3）
 * @param bars1m 該 symbol 當日 1 分 K（規則3 用；規則1/2 純靠 quote，buffer 淺也能跑）
 * @param ctx    symbol/market/source/isHolding/holding
 * @param now    可注入時間（測試用；缺省 Date.now()）
 */
export function detectGuardSignals(
  quote: GuardQuote | null,
  bars1m: MinuteBar[],
  ctx: GuardContext,
  now: number = Date.now(),
): GuardSignal[] {
  if (!HOLDINGS_GUARD.ENABLED) return [];

  const signals: GuardSignal[] = [];
  const sinceOpen = minutesSinceOpen(ctx.market, now);
  const warmedUp = sinceOpen >= HOLDINGS_GUARD.OPEN_WARMUP_MIN;
  const side = ctx.holding?.positionSide ?? 'long';
  // CN 09:15-09:25 集合競價可撤單時段：EastMoney f2 是虛擬撮合價，掛大單假殺穿再撤單
  // 會誤觸 priority-5 停損還吃掉當日 dedup → 09:25 前不吃 quote（-5 = 09:25，開盤價已定）。
  // TW 試撮在 09:00 前、不在盤中窗內，無此問題。
  const cnAuction = ctx.market === 'CN' && sinceOpen < -5;

  // ── 規則1：跌破停損價（保命，不暖機）─────────────────────────────────
  if (
    quote && quote.price > 0 && ctx.holding && !cnAuction
    && scopeAllows(HOLDINGS_GUARD.SCOPE.STOP_LOSS_BREACH, ctx)
  ) {
    const h = ctx.holding;
    if (side === 'short') {
      // 做空回補停損 = 進場黑K最高點（entryHigh ?? 明示 stopLoss）— 同 holdingsActionEngine
      // coverStop 語意。注意：×0.93 預設停損是做多方向，對空單不能當 fallback（方向錯）。
      const coverStop = h.entryHigh ?? h.stopLoss;
      if (coverStop != null && quote.price >= coverStop) {
        signals.push(makeSignal('stop-loss-breach', ctx, now, {
          price: quote.price, stopLoss: coverStop, entryPrice: h.entryPrice, positionSide: 'short',
        }));
      }
    } else {
      // fallback 衍生值過 round2（232.5×0.93=216.22500000000002 不能上推播文字）；
      // 使用者明示的 stopLoss 保持原樣
      const stop = h.stopLoss ?? round2(h.entryPrice * DEFAULT_STOP_LOSS_MULT);
      if (quote.price <= stop) {
        signals.push(makeSignal('stop-loss-breach', ctx, now, {
          price: quote.price, stopLoss: stop, entryPrice: h.entryPrice, positionSide: 'long',
        }));
      }
    }
  }

  // ── 規則2：拉高出貨保護（當日大漲後自高點回檔）─────────────────────────
  // quote 缺 dayHigh/prevClose → skip（不 fallback 用分K算 dayHigh — server 中途重啟
  // 分K缺前段會低估當日高，寧可不報不誤報）。short 持倉 skip（拉高回落對空單是利多）。
  if (
    quote && quote.price > 0 && warmedUp && side !== 'short'
    && quote.dayHigh != null && quote.dayHigh > 0
    && quote.prevClose != null && quote.prevClose > 0
    && scopeAllows(HOLDINGS_GUARD.SCOPE.PUMP_REVERSAL, ctx)
  ) {
    const dayGain = quote.dayHigh / quote.prevClose - 1;
    const drawdown = 1 - quote.price / quote.dayHigh;
    if (dayGain >= HOLDINGS_GUARD.PUMP_MIN_GAIN_PCT && drawdown >= HOLDINGS_GUARD.PUMP_DRAWDOWN_PCT) {
      signals.push(makeSignal('pump-reversal', ctx, now, {
        price: quote.price,
        dayHigh: quote.dayHigh,
        prevClose: quote.prevClose,
        dayGainPct: round2(dayGain * 100),
        drawdownPct: round2(drawdown * 100),
      }));
    }
  }

  // ── 規則3：急殺（近 N 分鐘 1 分 K 視窗跌幅）───────────────────────────
  // 用 ts 視窗（非 index）— 分K可能有缺洞。基準 = 「至少 N 分鐘前」的最近一根 close；
  // 找不到（buffer 太淺/剛重啟）→ skip。short 持倉 skip（急殺對空單是利多）。
  if (
    warmedUp && side !== 'short' && bars1m.length >= 2
    && scopeAllows(HOLDINGS_GUARD.SCOPE.RAPID_DROP, ctx)
  ) {
    const last = bars1m[bars1m.length - 1];
    const cutoff = last.ts - HOLDINGS_GUARD.RAPID_DROP_WINDOW_MIN * 60_000;
    let ref: MinuteBar | null = null;
    for (let i = bars1m.length - 2; i >= 0; i--) {
      if (bars1m[i].ts <= cutoff) { ref = bars1m[i]; break; }
    }
    // 基準太舊（CN 午休/斷線缺口）→ 視同無基準 skip：13:02 對上午 11:30 收盤 bar
    // 或斷線 40 分鐘的緩跌，都不能當「近 5 分鐘急殺」推
    if (ref && ref.ts < cutoff - HOLDINGS_GUARD.RAPID_DROP_REF_TOLERANCE_MIN * 60_000) {
      ref = null;
    }
    if (ref && ref.close > 0 && last.close > 0) {
      const drop = 1 - last.close / ref.close;
      if (drop >= HOLDINGS_GUARD.RAPID_DROP_PCT) {
        signals.push(makeSignal('rapid-drop', ctx, now, {
          price: last.close,
          refClose: ref.close,
          dropPct: round2(drop * 100),
          windowMin: HOLDINGS_GUARD.RAPID_DROP_WINDOW_MIN,
        }));
      }
    }
  }

  // ── 規則5（2026-07-05 漏網-3）：昨日轉折訊號 + 今晨開低 = 變盤確認 ────────
  // 課程 CH2-9「次日開盤方向定強弱」：昨日日K出現高檔變盤/轉折（母子/遭遇/吞噬/貫穿/覆蓋），
  // 今晨開盤窗（前 30 分鐘）現價低於昨收 0.5% → 開低確認變盤，即時提醒（不等收盤）。
  // 收盤級的正式出場判定仍在 daily-action（這裡是「開盤那一刻的早鳥提醒」）。
  if (
    quote && quote.price > 0 && side !== 'short' && !cnAuction
    && ctx.holding?.reversalWatch
    && sinceOpen >= 0 && sinceOpen <= HOLDINGS_GUARD.REVERSAL_OPEN_WINDOW_MIN
    && scopeAllows(HOLDINGS_GUARD.SCOPE.REVERSAL_OPEN, ctx)
  ) {
    const rw = ctx.holding.reversalWatch;
    const openLow = 1 - quote.price / rw.yClose;
    if (rw.yClose > 0 && openLow >= HOLDINGS_GUARD.REVERSAL_OPEN_LOW_PCT) {
      signals.push(makeSignal('reversal-open-low', ctx, now, {
        price: quote.price,
        reversalLabel: rw.label,
        yLow: rw.yLow,
        yClose: rw.yClose,
        openLowPct: round2(openLow * 100),
      }));
    }
  }

  // ── 規則6（2026-07-05 直播 QA③）：大跌開低「禁開盤殺單」緩衝提示 ──────────
  // 課程紀律：大跌開低日開盤那批市價殺單常成交在最差價；先觀察開盤緩衝窗，
  // 交易時點在 13:20-13:25 按規則處理（含停損執行）。純提醒、不壓抑規則1。
  if (
    quote && quote.price > 0 && side !== 'short' && !cnAuction
    && ctx.isHolding
    && quote.prevClose != null && quote.prevClose > 0
    && sinceOpen >= 0 && sinceOpen <= HOLDINGS_GUARD.GAP_OPEN_WINDOW_MIN
    && scopeAllows(HOLDINGS_GUARD.SCOPE.GAP_OPEN_BUFFER, ctx)
  ) {
    const openLow = 1 - quote.price / quote.prevClose;
    if (openLow >= HOLDINGS_GUARD.GAP_OPEN_LOW_PCT) {
      signals.push(makeSignal('gap-open-buffer', ctx, now, {
        price: quote.price,
        prevClose: quote.prevClose,
        openLowPct: round2(openLow * 100),
      }));
    }
  }

  return signals;
}

// ── helpers ──────────────────────────────────────────────────────────────

function makeSignal(
  rule: GuardRuleId,
  ctx: GuardContext,
  now: number,
  meta: GuardSignal['meta'],
): GuardSignal {
  return {
    rule,
    symbol: ctx.symbol,
    market: ctx.market,
    ts: Math.floor(now / 60_000) * 60_000,
    tfMin: 1,
    dedupScope: 'day',
    meta: { name: ctx.holding?.name, ...meta },
    caveat: 'minute-inference',
    isHolding: ctx.isHolding,
    source: ctx.source,
  };
}

/**
 * 距當日開盤幾分鐘（TW 09:00 / CN 09:30，市場時區）。
 * 開盤前回負值（規則2/3 的暖機 gate 自然擋掉）；CN 午休不另算（暖機只針對開盤噪音）。
 */
function minutesSinceOpen(market: 'TW' | 'CN', now: number): number {
  const tz = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(now)).split(':');
  const hhmm = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  const open = market === 'TW' ? 9 * 60 : 9 * 60 + 30;
  return hhmm - open;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
