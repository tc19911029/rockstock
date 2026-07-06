/**
 * 合約：B 買法（回後買上漲）面板 ↔ detector 逐關一致
 *
 * 防再犯（2026-07-06 001309.SZ 實例）：面板 ②「站回 MA5」的 pass 曾綁整個
 * detector 結果，量比不足時 ② 被連坐標紅並誤顯示「未出現站回」。
 *
 * 本合約鎖三件事：
 *   1. explainPullbackBuy（全評估）.ok ⟺ explainPullbackBuy（early-exit）.ok
 *      ⟺ detectPullbackBuy() !== null — 判定單一事實，兩種走法不可分岔
 *   2. 面板條目（buildPullbackBuyConditions）逐條 = 對應 gate 的 pass/detail，
 *      allPass = 全 gate 過 — UI 不可自己重算
 *   3. 單一 gate 失敗不得污染其他 gate 顯示（量比不足時「站回」仍 ✓）
 */
import { describe, it, expect } from '@jest/globals';
import { detectPullbackBuy, explainPullbackBuy } from '@/lib/analysis/highWinPositions';
import type { PullbackBuyGateKey } from '@/lib/analysis/highWinPositions';
import { buildPullbackBuyConditions } from '@/lib/analysis/pullbackBuyConditions';
import { computeIndicators } from '@/lib/indicators';
import type { Candle } from '@/types';
import fixture from '../fixtures/candles/6412-B-pullback-buy-2026-05-11.json';

const GATE_KEYS: PullbackBuyGateKey[] = [
  'trend', 'reclaimHold', 'noBreakLow', 'redBody',
  'volume', 'breakPrevHigh', 'freshSignal', 'pullbackDepth',
];

function gateMap(candles: ReturnType<typeof computeIndicators>, idx: number) {
  const ex = explainPullbackBuy(candles, idx);
  return { ex, byKey: new Map(ex.gates.map(g => [g.key, g])) };
}

describe('pullback-panel-parity（B 買法面板 ↔ detector 合約）', () => {
  const fixtureCandles = computeIndicators(fixture.candles as Candle[]);
  const lastIdx = fixtureCandles.length - 1;

  it('真實 fixture 全過：explain.ok = detect 非 null = 面板 allPass，8 gate 全 ✓', () => {
    const { ex } = gateMap(fixtureCandles, lastIdx);
    expect(ex.dataReady).toBe(true);
    expect(ex.ok).toBe(true);
    expect(ex.gates.map(g => g.key).sort()).toEqual([...GATE_KEYS].sort());
    expect(ex.gates.every(g => g.pass)).toBe(true);
    expect(detectPullbackBuy(fixtureCandles, lastIdx)).not.toBeNull();

    const { conditions, allPass } = buildPullbackBuyConditions(fixtureCandles, lastIdx);
    expect(allPass).toBe(true);
    expect(conditions).toHaveLength(GATE_KEYS.length);
    conditions.forEach(c => expect(c.pass).toBe(true));
  });

  it('量比不足只紅量比那條：「站回」仍 ✓、不得顯示「未出現站回」（001309 回歸）', () => {
    // 把 fixture 最後一根的量壓到 前日×1.0（< 1.3 門檻），其餘不動
    const mutated: Candle[] = (fixture.candles as Candle[]).map(c => ({ ...c }));
    mutated[mutated.length - 1].volume = Math.floor(mutated[mutated.length - 2].volume * 1.0);
    const candles = computeIndicators(mutated);
    const idx = candles.length - 1;

    expect(detectPullbackBuy(candles, idx)).toBeNull();
    const { ex, byKey } = gateMap(candles, idx);
    expect(ex.ok).toBe(false);
    expect(byKey.get('volume')!.pass).toBe(false);
    // 站回 gate 必須維持 ✓，且文案不可誤稱「未出現站回」
    expect(byKey.get('reclaimHold')!.pass).toBe(true);
    expect(byKey.get('reclaimHold')!.detail).not.toContain('未出現');

    const { conditions, allPass } = buildPullbackBuyConditions(candles, idx);
    expect(allPass).toBe(false);
    const reclaimItem = conditions.find(c => c.name.includes('站回 MA5'))!;
    const volumeItem = conditions.find(c => c.name.includes('量比'))!;
    expect(reclaimItem.pass).toBe(true);
    expect(reclaimItem.detail).not.toContain('未出現');
    expect(volumeItem.pass).toBe(false);
  });

  it('一路收在 MA5 上（沒有「回」）：站回 gate ✗ 且文案為「未出現站回」', () => {
    const rows: Candle[] = [];
    let close = 100;
    for (let i = 0; i < 60; i++) {
      const open = close;
      close = close * 1.01;
      rows.push({
        date: `2026-01-01T${String(i).padStart(2, '0')}`, // 僅需唯一字串
        open,
        high: close * 1.005,
        low: open * 0.995,
        close,
        volume: 1_000_000,
      });
    }
    const candles = computeIndicators(rows);
    const idx = candles.length - 1;

    const { byKey } = gateMap(candles, idx);
    expect(byKey.get('reclaimHold')!.pass).toBe(false);
    expect(byKey.get('reclaimHold')!.detail).toContain('未出現');
    expect(detectPullbackBuy(candles, idx)).toBeNull();
  });

  it('fuzz parity：任意行情下 detect 非 null ⟺ explain（全評估）.ok', () => {
    // 種子式 LCG，決定性可重現
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    for (let s = 0; s < 25; s++) {
      const rows: Candle[] = [];
      let close = 50 + rand() * 100;
      for (let i = 0; i < 90; i++) {
        const open = close * (1 + (rand() - 0.5) * 0.03);
        close = open * (1 + (rand() - 0.45) * 0.06); // 略偏多讓多頭段出現
        const high = Math.max(open, close) * (1 + rand() * 0.02);
        const low = Math.min(open, close) * (1 - rand() * 0.02);
        rows.push({
          date: `s${s}-${i}`,
          open, high, low, close,
          volume: Math.floor(500_000 + rand() * 2_000_000),
        });
      }
      const candles = computeIndicators(rows);
      for (let idx = 21; idx < candles.length; idx++) {
        const detected = detectPullbackBuy(candles, idx) !== null;
        const full = explainPullbackBuy(candles, idx);
        const early = explainPullbackBuy(candles, idx, { earlyExit: true });
        expect(full.ok).toBe(detected);
        expect(early.ok).toBe(detected);
        // 面板 allPass 也必須同判
        expect(buildPullbackBuyConditions(candles, idx).allPass).toBe(detected);
        // 全評估模式下 gates 必須完整 8 條（dataReady 時）
        if (full.dataReady) expect(full.gates).toHaveLength(GATE_KEYS.length);
      }
    }
  });
});
