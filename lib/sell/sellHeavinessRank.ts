/**
 * 賣訊「實證輕重」查表（2026-06-12，A3）。
 *
 * 資料來源：data/backtest/sell-heaviness.json（scripts/backtest-sell-heaviness.ts 產出）。
 * 回測結論（2026-06-10 2y 窗）：早期見頂 K 棒類最重；KD 高位死叉被宣告 severity 低估；
 * DEATH_CROSS（死亡交叉）/ 雙B死叉是落後反指（score ≈ 0 甚至為負）— 不該當即賣訊號。
 *
 * tier 門檻（heavinessScore 平均）：
 *   ≥ 0.35 heavy（出現該立刻處理）/ 0.15-0.35 mid / < 0.15 light（落後/噪音，顯示但降權）
 *
 * ⚠ 重跑 sell-heaviness 回測後本表自動跟著新 JSON 走，無需改碼；
 *   但若 signalType 命名變動要同步 ENGINE_TYPE_MAP。
 */
import { readFileSync, existsSync } from 'fs';
import path from 'path';

export type HeavinessTier = 'heavy' | 'mid' | 'light' | 'unknown';

export interface HeavinessEntry {
  signalType: string;
  label: string;
  score: number;       // heavinessScore 跨紀錄平均
  tier: HeavinessTier;
}

/** holdingsActionEngine / 其他引擎內部 type → sell-heaviness signalType 對照 */
const ENGINE_TYPE_MAP: Record<string, string> = {
  break_ma5_short: 'BREAK_MA5',
  break_ma10_mid: 'BREAK_MA10',
  break_ma20_long: 'BREAK_MA20',
  kd_death_cross: 'KD_DEATH_CROSS',
  death_cross: 'DEATH_CROSS',
};

let cache: Map<string, HeavinessEntry> | null = null;

function load(): Map<string, HeavinessEntry> {
  if (cache) return cache;
  const map = new Map<string, HeavinessEntry>();
  const f = path.join(process.cwd(), 'data', 'backtest', 'sell-heaviness.json');
  if (existsSync(f)) {
    try {
      const doc = JSON.parse(readFileSync(f, 'utf8')) as {
        signals?: Array<{ signalType: string; label: string; heavinessScore: number }>;
      };
      const grouped = new Map<string, { label: string; scores: number[] }>();
      for (const s of doc.signals ?? []) {
        if (!s.signalType || typeof s.heavinessScore !== 'number') continue;
        const g = grouped.get(s.signalType) ?? { label: s.label, scores: [] };
        g.scores.push(s.heavinessScore);
        grouped.set(s.signalType, g);
      }
      for (const [type, g] of grouped) {
        const score = g.scores.reduce((a, b) => a + b, 0) / g.scores.length;
        const tier: HeavinessTier = score >= 0.35 ? 'heavy' : score >= 0.15 ? 'mid' : 'light';
        map.set(type, { signalType: type, label: g.label, score, tier });
      }
    } catch { /* 壞檔 → 全部 unknown，不擋功能 */ }
  }
  cache = map;
  return map;
}

/** 查單一訊號的實證輕重；接受引擎內部 type 或 heaviness signalType */
export function empiricalHeaviness(type: string): HeavinessEntry {
  const map = load();
  const canonical = ENGINE_TYPE_MAP[type] ?? type;
  return map.get(canonical) ?? { signalType: canonical, label: type, score: 0, tier: 'unknown' };
}

/** tier → 顯示用 emoji（重=🔴 中=🟠 輕/落後=⚪） */
export function tierEmoji(tier: HeavinessTier): string {
  return tier === 'heavy' ? '🔴' : tier === 'mid' ? '🟠' : tier === 'light' ? '⚪' : '▫️';
}
