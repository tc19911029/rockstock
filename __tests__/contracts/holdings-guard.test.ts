/**
 * 合約測試 — 持倉保命警報層（holdingsGuard + alertDispatcher 泛化）
 *
 * 鎖定行為：
 *   1. stop-loss-breach：做多 price ≤ stopLoss / 缺 stopLoss 用 DEFAULT_STOP_LOSS_MULT
 *      （單一事實）/ 做空 price ≥ entryHigh（fallback 明示 stopLoss）/ 無 holding 不觸發
 *   2. pump-reversal：當日漲 ≥4% + 自高點回檔 ≥3%；缺 dayHigh/prevClose skip；
 *      short skip；開盤暖機 skip
 *   3. rapid-drop：5 分鐘 ts 視窗跌 ≥3%（分K缺洞也對）；緩跌不觸發；buffer 淺 skip
 *   4. dispatcher day-dedup：dedupScope='day' 同日同檔同規則只 fire 一次（不同 ts 也擋）
 *   5. decideNotify：持倉形態訊號推、非持倉不推、blowoff-bullish 不推、
 *      BLOWOFF_NTFY_ENABLED 舊全域語意不變、HOLDINGS_GUARD_NTFY_DISABLED 滅音
 */

// mock sendNtfy：測試環境不打真網路；預設回 disabled（與 NTFY_ENABLED 未設行為一致）
jest.mock('@/lib/notify/ntfy', () => ({
  sendNtfy: jest.fn(async () => ({ ok: false, reason: 'disabled' })),
}));

import {
  detectGuardSignals, scopeAllows,
  type GuardContext, type GuardSignal,
} from '@/lib/realtime/holdingsGuard';
import { dispatch, decideNotify, _resetDebounceForTest } from '@/lib/realtime/alertDispatcher';
import { DEFAULT_STOP_LOSS_MULT } from '@/lib/agents/holdingsActionEngine';
import { sendNtfy } from '@/lib/notify/ntfy';
import type { MinuteBar } from '@/lib/realtime/minuteBarStore';
import type { Signal } from '@/lib/realtime/blowoffDetector';

const mockSendNtfy = sendNtfy as jest.Mock;

const BASE_DATE = '2026-05-12';

function tsAt(hh: number, mm: number): number {
  const iso = `${BASE_DATE}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+08:00`;
  return new Date(iso).getTime();
}

function bar(
  hh: number, mm: number, open: number, high: number, low: number, close: number, volume = 100,
): MinuteBar {
  return {
    symbol: '9999.TW', market: 'TW', ts: tsAt(hh, mm),
    open, high, low, close, volume, tickCount: 1,
  };
}

const longCtx = (over: Partial<GuardContext['holding'] & object> = {}): GuardContext => ({
  symbol: '9999.TW', market: 'TW', source: 'holding', isHolding: true,
  holding: {
    name: '測試股', entryPrice: 100, stopLoss: 93, positionSide: 'long',
    ...over,
  },
});

// now = 10:00（開盤後 60 分，暖機已過）
const NOW = tsAt(10, 0);

describe('holdingsGuard — 規則1 stop-loss-breach', () => {
  test('做多 price ≤ stopLoss 觸發（priority 由 dispatcher 定，這裡驗 meta）', () => {
    const sigs = detectGuardSignals({ price: 92.5 }, [], longCtx(), NOW);
    const hit = sigs.find(s => s.rule === 'stop-loss-breach');
    expect(hit).toBeDefined();
    expect(hit!.dedupScope).toBe('day');
    expect(hit!.caveat).toBe('minute-inference');
    expect(hit!.meta).toMatchObject({ price: 92.5, stopLoss: 93, entryPrice: 100, positionSide: 'long', name: '測試股' });
  });

  test('做多 price > stopLoss 不觸發', () => {
    const sigs = detectGuardSignals({ price: 94 }, [], longCtx(), NOW);
    expect(sigs.find(s => s.rule === 'stop-loss-breach')).toBeUndefined();
  });

  test('缺 stopLoss → 用 entryPrice × DEFAULT_STOP_LOSS_MULT（單一事實）', () => {
    const ctx = longCtx({ stopLoss: undefined });
    const stop = 100 * DEFAULT_STOP_LOSS_MULT; // 93
    const hit = detectGuardSignals({ price: stop - 0.1 }, [], ctx, NOW)
      .find(s => s.rule === 'stop-loss-breach');
    expect(hit).toBeDefined();
    expect(hit!.meta.stopLoss).toBe(stop);
    // 剛好在停損上方不觸發
    expect(
      detectGuardSignals({ price: stop + 0.1 }, [], ctx, NOW)
        .find(s => s.rule === 'stop-loss-breach'),
    ).toBeUndefined();
  });

  test('做空 price ≥ entryHigh 觸發（回補停損）', () => {
    const ctx = longCtx({ positionSide: 'short', entryHigh: 110, stopLoss: undefined });
    const hit = detectGuardSignals({ price: 111 }, [], ctx, NOW)
      .find(s => s.rule === 'stop-loss-breach');
    expect(hit).toBeDefined();
    expect(hit!.meta.positionSide).toBe('short');
    expect(hit!.meta.stopLoss).toBe(110);
  });

  test('做空缺 entryHigh → fallback 明示 stopLoss；兩者皆缺 → 不觸發（×0.93 方向錯不能用）', () => {
    const withStop = longCtx({ positionSide: 'short', entryHigh: undefined, stopLoss: 108 });
    expect(
      detectGuardSignals({ price: 109 }, [], withStop, NOW)
        .find(s => s.rule === 'stop-loss-breach'),
    ).toBeDefined();
    const noStop = longCtx({ positionSide: 'short', entryHigh: undefined, stopLoss: undefined });
    expect(
      detectGuardSignals({ price: 999 }, [], noStop, NOW)
        .find(s => s.rule === 'stop-loss-breach'),
    ).toBeUndefined();
  });

  test('無 holding 資訊（非持倉）不觸發', () => {
    const ctx: GuardContext = { symbol: '9999.TW', market: 'TW', source: 'scan', isHolding: false };
    expect(detectGuardSignals({ price: 1 }, [], ctx, NOW)).toEqual([]);
  });

  test('開盤暖機內（09:02）保命規則照樣觸發（不暖機）', () => {
    const sigs = detectGuardSignals({ price: 92.5 }, [], longCtx(), tsAt(9, 2));
    expect(sigs.find(s => s.rule === 'stop-loss-breach')).toBeDefined();
  });

  test('CN 集合競價（09:25 前）虛擬撮合價不觸發停損；09:25 後恢復', () => {
    const cnCtx: GuardContext = {
      symbol: '600000.SS', market: 'CN', source: 'holding', isHolding: true,
      holding: { name: '測試CN', entryPrice: 100, stopLoss: 93, positionSide: 'long' },
    };
    // 09:16 可撤單時段：EastMoney f2 是虛擬價，掛大單假殺穿不能推
    expect(detectGuardSignals({ price: 92.5 }, [], cnCtx, tsAt(9, 16))
      .find(s => s.rule === 'stop-loss-breach')).toBeUndefined();
    // 09:26 開盤價已定：真跳空破停損要推（比 09:30 連續競價早 5 分保命）
    expect(detectGuardSignals({ price: 92.5 }, [], cnCtx, tsAt(9, 26))
      .find(s => s.rule === 'stop-loss-breach')).toBeDefined();
  });
});

describe('holdingsGuard — 規則2 pump-reversal', () => {
  test('當日漲 ≥4% 且自高點回檔 ≥3% 觸發', () => {
    const hit = detectGuardSignals(
      { price: 100, dayHigh: 105, prevClose: 100 }, [], longCtx(), NOW,
    ).find(s => s.rule === 'pump-reversal');
    expect(hit).toBeDefined();
    expect(hit!.meta.dayGainPct).toBe(5);
    expect(hit!.meta.drawdownPct).toBeCloseTo(4.76, 1);
  });

  test('當日漲幅不足 4% 不觸發', () => {
    expect(detectGuardSignals(
      { price: 99, dayHigh: 103, prevClose: 100 }, [], longCtx(), NOW,
    ).find(s => s.rule === 'pump-reversal')).toBeUndefined();
  });

  test('回檔不足 3% 不觸發', () => {
    expect(detectGuardSignals(
      { price: 103.5, dayHigh: 105, prevClose: 100 }, [], longCtx(), NOW,
    ).find(s => s.rule === 'pump-reversal')).toBeUndefined();
  });

  test('缺 dayHigh 或 prevClose → skip（寧可不報不誤報）', () => {
    expect(detectGuardSignals(
      { price: 100, prevClose: 100 }, [], longCtx(), NOW,
    ).find(s => s.rule === 'pump-reversal')).toBeUndefined();
    expect(detectGuardSignals(
      { price: 100, dayHigh: 105 }, [], longCtx(), NOW,
    ).find(s => s.rule === 'pump-reversal')).toBeUndefined();
  });

  test('short 持倉 skip（拉高回落對空單是利多）', () => {
    const ctx = longCtx({ positionSide: 'short', entryHigh: 200 });
    expect(detectGuardSignals(
      { price: 100, dayHigh: 105, prevClose: 100 }, [], ctx, NOW,
    ).find(s => s.rule === 'pump-reversal')).toBeUndefined();
  });

  test('開盤暖機（09:02）內 skip', () => {
    expect(detectGuardSignals(
      { price: 100, dayHigh: 105, prevClose: 100 }, [], longCtx(), tsAt(9, 2),
    ).find(s => s.rule === 'pump-reversal')).toBeUndefined();
  });
});

describe('holdingsGuard — 規則3 rapid-drop', () => {
  test('5 分鐘內跌 ≥3% 觸發', () => {
    const bars = [
      bar(9, 53, 100, 100, 100, 100),
      bar(9, 54, 100, 100, 100, 100),
      bar(9, 55, 100, 100, 100, 100),   // cutoff 基準（10:00 - 5min）
      bar(9, 57, 99, 99, 98, 98.5),
      bar(9, 59, 98, 98, 97, 97),
      bar(10, 0, 97, 97, 96, 96.5),     // 1 - 96.5/100 = 3.5%
    ];
    const hit = detectGuardSignals(null, bars, longCtx(), NOW)
      .find(s => s.rule === 'rapid-drop');
    expect(hit).toBeDefined();
    expect(hit!.meta.dropPct).toBe(3.5);
    expect(hit!.meta.refClose).toBe(100);
    expect(hit!.meta.windowMin).toBe(5);
  });

  test('分K小缺洞（容忍度內）：視窗用 ts 不用 index，跳缺根也找對基準', () => {
    const bars = [
      bar(9, 53, 100, 100, 100, 100),   // cutoff 09:55，容忍度 3 分 → [09:52, 09:55] 內有效
      bar(9, 58, 97, 97, 96, 97),
      bar(9, 59, 97, 97, 96, 96.5),
      bar(10, 0, 96, 96, 95, 96),       // 1 - 96/100 = 4%
    ];
    const hit = detectGuardSignals(null, bars, longCtx(), NOW)
      .find(s => s.rule === 'rapid-drop');
    expect(hit).toBeDefined();
    expect(hit!.meta.refClose).toBe(100);
  });

  test('基準太舊（CN 午休/斷線缺口 > 容忍度）→ skip 不誤報成急殺', () => {
    const bars = [
      bar(9, 40, 100, 100, 100, 100),   // 距 cutoff 09:55 有 15 分 > 容忍 3 分
      bar(9, 58, 97, 97, 96, 97),
      bar(9, 59, 97, 97, 96, 96.5),
      bar(10, 0, 96, 96, 95, 96),
    ];
    expect(detectGuardSignals(null, bars, longCtx(), NOW)
      .find(s => s.rule === 'rapid-drop')).toBeUndefined();
  });

  test('30 分鐘緩跌 3% 不觸發（5 分鐘視窗內跌幅不足）', () => {
    // 09:30 → 10:00 每分鐘 -0.1，共 -3 (~3%) 但任 5 分鐘窗內只 -0.5%
    const bars: MinuteBar[] = [];
    for (let i = 0; i <= 30; i++) {
      const hh = 9 + Math.floor((30 + i) / 60);
      const mm = (30 + i) % 60;
      const p = 100 - i * 0.1;
      bars.push(bar(hh, mm, p, p, p, p));
    }
    expect(detectGuardSignals(null, bars, longCtx(), NOW)
      .find(s => s.rule === 'rapid-drop')).toBeUndefined();
  });

  test('buffer 太淺（找不到 ≥5 分鐘前基準）skip', () => {
    const bars = [
      bar(9, 58, 100, 100, 96, 96),
      bar(9, 59, 96, 96, 95, 95),
      bar(10, 0, 95, 95, 94, 94),
    ];
    expect(detectGuardSignals(null, bars, longCtx(), NOW)
      .find(s => s.rule === 'rapid-drop')).toBeUndefined();
  });

  test('short 持倉 skip', () => {
    const bars = [
      bar(9, 55, 100, 100, 100, 100),
      bar(10, 0, 96, 96, 95, 95),
    ];
    const ctx = longCtx({ positionSide: 'short', entryHigh: 200 });
    expect(detectGuardSignals(null, bars, ctx, NOW)
      .find(s => s.rule === 'rapid-drop')).toBeUndefined();
  });
});

describe('scopeAllows', () => {
  test('scope 矩陣', () => {
    expect(scopeAllows('off', { isHolding: true, source: 'holding' })).toBe(false);
    expect(scopeAllows('holding', { isHolding: true, source: 'holding' })).toBe(true);
    expect(scopeAllows('holding', { isHolding: false, source: 'manual' })).toBe(false);
    expect(scopeAllows('holding_manual', { isHolding: false, source: 'manual' })).toBe(true);
    expect(scopeAllows('holding_manual', { isHolding: false, source: 'scan' })).toBe(false);
    // 缺 source fail-safe 視為 scan
    expect(scopeAllows('holding_manual', { isHolding: false })).toBe(false);
    expect(scopeAllows('all', { isHolding: false, source: 'scan' })).toBe(true);
  });
});

// ── dispatcher ────────────────────────────────────────────────────────────

function guardSig(over: Partial<GuardSignal> = {}): GuardSignal {
  return {
    rule: 'stop-loss-breach',
    symbol: '9999.TW', market: 'TW',
    ts: tsAt(10, 0), tfMin: 1, dedupScope: 'day',
    meta: { price: 92.5, stopLoss: 93, entryPrice: 100, positionSide: 'long' },
    caveat: 'minute-inference', isHolding: true, source: 'holding',
    ...over,
  };
}

function patternSig(over: Partial<Signal> = {}): Signal {
  return {
    rule: 'blowoff-bearish',
    symbol: '9999.TW', market: 'TW', ts: tsAt(10, 0), tfMin: 5,
    meta: {
      open: 100, high: 101, low: 94, close: 95, volume: 1000,
      volumeMultiplier: 2.3, pctChange: -5, bodyRatio: 0.7, ma20Deviation: 0,
    },
    caveat: 'minute-inference', isHolding: true, source: 'holding',
    ...over,
  };
}

describe('alertDispatcher — day-level dedup', () => {
  beforeEach(() => _resetDebounceForTest());

  test('dedupScope=day：同日同檔同規則第二次（不同 ts）也被 debounced', async () => {
    const r1 = await dispatch([guardSig({ ts: tsAt(10, 0) })], { logToDisk: false });
    const r2 = await dispatch([guardSig({ ts: tsAt(10, 30) })], { logToDisk: false });
    expect(r1.fired).toBe(1);
    expect(r2.fired).toBe(0);
    expect(r2.debounced).toBe(1);
  });

  test('不同規則的 day dedup 互不影響', async () => {
    const r = await dispatch([
      guardSig({ rule: 'stop-loss-breach' }),
      guardSig({ rule: 'pump-reversal', meta: { price: 100, dayHigh: 105, prevClose: 100, dayGainPct: 5, drawdownPct: 4.76 } }),
    ], { logToDisk: false });
    expect(r.fired).toBe(2);
  });

  test('bar 型（無 dedupScope）行為不變：不同 barTs 各自 fire', async () => {
    const r1 = await dispatch([patternSig({ ts: tsAt(10, 0) })], { logToDisk: false });
    const r2 = await dispatch([patternSig({ ts: tsAt(10, 5) })], { logToDisk: false });
    expect(r1.fired).toBe(1);
    expect(r2.fired).toBe(1);
  });

  test('瞬時推送失敗（fetch/http）不消耗 day dedup — 下一輪重試，成功後才消耗', async () => {
    // 第一輪：fetch timeout → key 放回
    mockSendNtfy.mockResolvedValueOnce({ ok: false, reason: 'fetch', error: 'timeout' });
    const r1 = await dispatch([guardSig()], { logToDisk: false });
    expect(r1.fired).toBe(1);
    expect(r1.notifyFail).toBe(1);
    // 第二輪：重試成功 → 這次才真正消耗
    mockSendNtfy.mockResolvedValueOnce({ ok: true, status: 200 });
    const r2 = await dispatch([guardSig()], { logToDisk: false });
    expect(r2.fired).toBe(1);
    expect(r2.notifyOk).toBe(1);
    // 第三輪：已消耗 → debounced
    const r3 = await dispatch([guardSig()], { logToDisk: false });
    expect(r3.debounced).toBe(1);
  });

  test('刻意關閉（disabled）視為已消耗 — 滅音期間同訊號只記一次', async () => {
    // 預設 mock 即 disabled
    const r1 = await dispatch([guardSig()], { logToDisk: false });
    const r2 = await dispatch([guardSig()], { logToDisk: false });
    expect(r1.fired).toBe(1);
    expect(r2.debounced).toBe(1);
  });
});

describe('alertDispatcher — decideNotify gate', () => {
  const OLD_BLOWOFF = process.env.BLOWOFF_NTFY_ENABLED;
  const OLD_MUTE = process.env.HOLDINGS_GUARD_NTFY_DISABLED;
  afterEach(() => {
    if (OLD_BLOWOFF == null) delete process.env.BLOWOFF_NTFY_ENABLED;
    else process.env.BLOWOFF_NTFY_ENABLED = OLD_BLOWOFF;
    if (OLD_MUTE == null) delete process.env.HOLDINGS_GUARD_NTFY_DISABLED;
    else process.env.HOLDINGS_GUARD_NTFY_DISABLED = OLD_MUTE;
  });
  beforeEach(() => {
    delete process.env.BLOWOFF_NTFY_ENABLED;
    delete process.env.HOLDINGS_GUARD_NTFY_DISABLED;
  });

  test('guard 規則：持倉推、非持倉不推（SCOPE 預設 holding）', () => {
    expect(decideNotify(guardSig())).toBe(true);
    expect(decideNotify(guardSig({ isHolding: false, source: 'scan' }))).toBe(false);
  });

  test('形態規則：BLOWOFF_NTFY_ENABLED 未設 → 持倉的出貨形態推、非持倉不推', () => {
    expect(decideNotify(patternSig())).toBe(true);                                     // 持倉 blowoff-bearish
    expect(decideNotify(patternSig({ isHolding: false, source: 'scan' }))).toBe(false); // 非持倉
    expect(decideNotify(patternSig({ rule: 'terminal-rally' }))).toBe(true);
    expect(decideNotify(patternSig({ rule: 'ma5-breakdown' }))).toBe(true);
  });

  test('blowoff-bullish 是買訊非保命 → 不在 PATTERN_RULES，不推', () => {
    expect(decideNotify(patternSig({ rule: 'blowoff-bullish' }))).toBe(false);
  });

  test('BLOWOFF_NTFY_ENABLED=true 舊全域語意：全池（含非持倉）都推', () => {
    process.env.BLOWOFF_NTFY_ENABLED = 'true';
    expect(decideNotify(patternSig({ isHolding: false, source: 'scan' }))).toBe(true);
    expect(decideNotify(patternSig({ rule: 'blowoff-bullish', isHolding: false, source: 'scan' }))).toBe(true);
  });

  test('HOLDINGS_GUARD_NTFY_DISABLED=true 緊急滅音：guard 路徑全不推', () => {
    process.env.HOLDINGS_GUARD_NTFY_DISABLED = 'true';
    expect(decideNotify(guardSig())).toBe(false);
    expect(decideNotify(patternSig())).toBe(false); // 持倉形態走 guard 路徑 → 一樣滅
    // 但舊全域開關不受 guard 滅音影響
    process.env.BLOWOFF_NTFY_ENABLED = 'true';
    expect(decideNotify(patternSig())).toBe(true);
  });
});
