/**
 * 由賣訊輕重回測 JSON 產出「前端用」的精簡查表（committed source）。
 *
 *   data/backtest/sell-heaviness.json（scope=uptrend，持股情境）
 *     → lib/analysis/sellHeavinessTable.ts（per market×signalType 的 tier/alpha/可信度/評語）
 *
 * 訊號面板（三色 SanSeSignalsPanel / 書本 SixConditionsPanel）import 這支顯示輕重徽章，
 * 讓使用者一眼判斷「這個賣訊該不該立刻動作」。回測更新後重跑本腳本即可刷新。
 *
 * 用法：npx tsx scripts/gen-sell-heaviness-table.ts
 */

import fs from 'fs';
import path from 'path';
import type { SellHeavinessDoc, SignalStat } from '@/lib/backtest/sellHeavinessTypes';

type Tier = 'heavy' | 'medium' | 'light' | 'lagging' | 'noisy';

const SRC = path.join(process.cwd(), 'data', 'backtest', 'sell-heaviness.json');
const OUT = path.join(process.cwd(), 'lib', 'analysis', 'sellHeavinessTable.ts');

/** 統計可信 = 顯著且樣本足。不可信的 alpha 不論多負都不該當「重」呈現。 */
function isReliable(s: SignalStat): boolean {
  return s.significant && s.firings >= 100;
}

/**
 * 顯示分級。先看可信度（不可信 → noisy，避免小樣本噪音被當成重訊號），
 * 可信者再用 worst-of-{d5,d10,d20} 收斂 alpha 分級（worst > -0.1 = 沒有任何 horizon
 * 真的轉弱 → lagging/落後）。
 */
function tierOf(s: SignalStat): Tier {
  if (!isReliable(s)) return 'noisy';
  const worst = s.worstFwdAlphaShrunk;
  if (worst <= -0.6) return 'heavy';
  if (worst <= -0.25) return 'medium';
  if (worst <= -0.1) return 'light';
  return 'lagging';
}

function noteOf(s: SignalStat, tier: Tier): string {
  let note: string;
  if (tier === 'noisy') {
    note = s.firings < 100
      ? '樣本太少，參考性低（別據此單獨動作）'
      : '本市場無顯著 edge：訊號後與同儕無明顯差異，別單獨據此動作';
  }
  else if (tier === 'lagging') note = '落後/反指：破線時行情多已走完，平均反而略強同儕';
  else if (tier === 'heavy') note = '實測偏重，訊號後明顯弱於同儕';
  else if (tier === 'medium') note = '中等：會輸同儕但非急殺';
  else note = '偏輕：慢慢輸同儕、非急殺';
  if (tier !== 'noisy') {
    if (s.severityVerdict === 'underrated') note += '；手寫嚴重度偏低（值得更當心）';
    else if (s.severityVerdict === 'overrated') note += '；手寫嚴重度偏高';
    if (!s.stable) note += '；半窗不夠穩定';
  }
  return note;
}

interface Entry {
  tier: Tier;
  alphaD5: number; alphaD10: number; alphaD20: number; worst: number;
  firings: number; reliable: boolean; significant: boolean; stable: boolean;
  declaredSeverity: SignalStat['declaredSeverity'];
  verdict: SignalStat['severityVerdict'];
  family: SignalStat['family'];
  label: string;
  note: string;
}

function main(): void {
  const doc = JSON.parse(fs.readFileSync(SRC, 'utf-8')) as SellHeavinessDoc;
  const out: Record<'TW' | 'CN', Record<string, Entry>> = { TW: {}, CN: {} };

  for (const s of doc.signals) {
    if (s.scope !== 'uptrend') continue;             // 持股情境 = 面板的相關情境
    const tier = tierOf(s);
    out[s.market][s.signalType] = {
      tier,
      alphaD5: s.byHorizon.d5.alphaShrunkPct,
      alphaD10: s.byHorizon.d10.alphaShrunkPct,
      alphaD20: s.byHorizon.d20.alphaShrunkPct,
      worst: s.worstFwdAlphaShrunk,
      firings: s.firings,
      reliable: s.significant && s.firings >= 100,
      significant: s.significant,
      stable: s.stable,
      declaredSeverity: s.declaredSeverity,
      verdict: s.severityVerdict,
      family: s.family,
      label: s.label,
      note: noteOf(s, tier),
    };
  }

  // 穩定 key 排序 → 乾淨 diff
  const sortKeys = (o: Record<string, Entry>) =>
    Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  const stable = { TW: sortKeys(out.TW), CN: sortKeys(out.CN) };

  const header = `// ⚠️ 自動產生，請勿手改。來源：data/backtest/sell-heaviness.json（scope=uptrend）
// 重跑：npx tsx scripts/gen-sell-heaviness-table.ts
// 賣訊輕重：訊號觸發後相對「同日同儕宇宙」的前瞻 alpha（越負＝越重）；分級用 worst-of-{d5,d10,d20}。
// 視窗：${doc.window.start} ~ ${doc.window.end}（${doc.window.label}）。判決為本視窗本市場特定。

export type SellTier = 'heavy' | 'medium' | 'light' | 'lagging' | 'noisy';

export interface SellHeavinessEntry {
  tier: SellTier;
  alphaD5: number; alphaD10: number; alphaD20: number; worst: number;
  firings: number;
  reliable: boolean;        // 統計顯著且樣本足
  significant: boolean;
  stable: boolean;
  declaredSeverity: 'high' | 'medium' | 'low' | null;
  verdict: 'agree' | 'overrated' | 'underrated' | 'n/a';
  family: 'book' | 'sanse' | 'combo';
  label: string;
  note: string;
}

export const SELL_HEAVINESS_WINDOW = ${JSON.stringify({ start: doc.window.start, end: doc.window.end, label: doc.window.label })} as const;

export const SELL_HEAVINESS: Record<'TW' | 'CN', Record<string, SellHeavinessEntry>> = ${JSON.stringify(stable, null, 2)};

/** 查某市場某賣訊（id = 三色 b_dead… 或書本 DEATH_CROSS…）的輕重；查不到回 null。 */
export function lookupSellHeaviness(
  market: 'TW' | 'CN' | 'other' | undefined,
  signalId: string,
): SellHeavinessEntry | null {
  if (market !== 'TW' && market !== 'CN') return null;
  return SELL_HEAVINESS[market][signalId] ?? null;
}
`;

  fs.writeFileSync(OUT, header);
  const nTw = Object.keys(stable.TW).length;
  const nCn = Object.keys(stable.CN).length;
  console.log(`✓ 寫出 ${path.relative(process.cwd(), OUT)}（TW ${nTw} 訊號 / CN ${nCn} 訊號）`);
}

main();
