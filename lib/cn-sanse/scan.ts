// ============================================================
// 三色資金 — 全市場掃描（陸股 / A股）。Server-only（讀本地檔）。
// ============================================================
import * as fs from 'fs/promises';
import * as path from 'path';
import type { Candle } from '@/types';
import { getLocalCandleDir } from '@/lib/datasource/LocalCandleStore';
import { computeSanSe, evalLatest, type SanSeLevel } from './selectors';
import { evalSignals, type StockSignals } from './signals';
import { computeResonance, type Resonance } from './resonance';

const INDEX_SYMBOL = '000001.SS'; // 上證綜指，作為相對強弱基準
const MIN_BARS = 250;

export interface SanSeHit {
  symbol: string;
  name: string;
  industry: string;
  price: number;
  changePct: number;
  shortAttack: number;
  midStrength: number;
  midControl: number;
  kongPan: number;
  shortOversold: number;
}

/** 共振紀錄：入選∪有指標買點的股票，含策略歸屬 + 指標買賣點 + 共振計分（給前端 + 回測） */
export interface ResonanceRecord extends StockSignals, Resonance {
  symbol: string;
  name: string;
  industry: string;
  price: number;      // 掃描當日收盤
  changePct: number;
  strategies: SanSeLevel[]; // [] = 觀察區（未入選）
}

export interface ResonanceCounts {
  strong: number; medium: number; weak: number; observe: number; conflict: number;
}

export interface SanSeScanResult {
  lastDate: string;
  scannedAt: string;
  evaluated: number;
  staleSkipped: number;
  counts: Record<SanSeLevel, number>;
  results: Record<SanSeLevel, SanSeHit[]>;
  records: ResonanceRecord[];       // 共振紀錄（入選∪指標買點）
  resonanceCounts: ResonanceCounts;
}

interface StockEntry { symbol: string; name: string; industry?: string }

/** 板塊 / ST 排除：創業板(30x) + 科創(688) + 北交/老三板(8/4) + ST 股名。 */
function isExcluded(symbol: string, name: string): boolean {
  const code = symbol.split('.')[0];
  if (/^(30|688|8|4)/.test(code)) return true;          // 創業板 / 科創 / 北交
  if (name.includes('ST') || name.startsWith('*') || name.startsWith('S')) return true; // ST/*ST/S*ST
  if (name.includes('退')) return true;                  // 退市整理
  return false;
}

async function readCandles(dir: string, symbol: string): Promise<Candle[] | null> {
  try {
    const raw = await fs.readFile(path.join(dir, `${symbol}.json`), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data?.candles) ? (data.candles as Candle[]) : null;
  } catch {
    return null;
  }
}

/**
 * 全市場掃描。
 * @param opts.asOfDate 若給定（YYYY-MM-DD），把所有 K 線截斷到 ≤ 該日重算（歷史回補用）；
 *                      不給則用最新交易日（即時掃）。
 */
export async function scanSanSe(opts?: { asOfDate?: string }): Promise<SanSeScanResult> {
  const root = process.cwd();
  const dir = getLocalCandleDir('CN');
  const asOf = opts?.asOfDate;
  const truncate = (cs: Candle[] | null): Candle[] | null =>
    cs && asOf ? cs.filter((c) => c.date <= asOf) : cs;

  // 股票清單
  const listRaw = await fs.readFile(path.join(root, 'data/cn_stocklist.json'), 'utf8');
  const seen = new Set<string>();
  const stocks: StockEntry[] = (JSON.parse(listRaw).stocks ?? []).filter((s: StockEntry) => {
    if (isExcluded(s.symbol, s.name)) return false;
    if (seen.has(s.symbol)) return false; // 清單有同代號重複（不同產業分類），去重
    seen.add(s.symbol);
    return true;
  });

  // 大盤指數 → date→close map（asOf 時截斷到該日）
  const idxCandles = truncate(await readCandles(dir, INDEX_SYMBOL));
  if (!idxCandles || idxCandles.length === 0) throw new Error(`找不到大盤指數 ${INDEX_SYMBOL} 的本地K線`);
  const idxMap = new Map<string, number>(idxCandles.map((c) => [c.date, c.close]));
  const lastDate = idxCandles[idxCandles.length - 1]?.date ?? '';

  const results: Record<SanSeLevel, SanSeHit[]> = { strict: [], medium: [], loose: [] };
  const records: ResonanceRecord[] = [];
  let evaluated = 0;
  let staleSkipped = 0;

  const BATCH = 100;
  for (let i = 0; i < stocks.length; i += BATCH) {
    const batch = stocks.slice(i, i + BATCH);
    const loaded = await Promise.all(batch.map((s) => readCandles(dir, s.symbol)));

    batch.forEach((s, k) => {
      const candles = truncate(loaded[k]);
      if (!candles || candles.length < MIN_BARS) return;
      // 資料新鮮度：最後一根必須是該掃描日（asOf 或最新），否則是停牌/退市殭屍股，不納入選股
      if (candles[candles.length - 1].date !== lastDate) { staleSkipped++; return; }
      evaluated++;

      // 對齊指數收盤（前向填補；開頭缺口留 NaN，MA/SUM 已具 NaN 韌性）
      let last = NaN;
      const indexClose = candles.map((c) => {
        const v = idxMap.get(c.date);
        if (v != null) last = v;
        return last;
      });

      const series = computeSanSe(candles, indexClose);
      const prevClose = candles[candles.length - 2]?.close;
      const lastClose = candles[candles.length - 1]?.close ?? 0;
      const changePct = prevClose ? +(((lastClose - prevClose) / prevClose) * 100).toFixed(2) : 0;

      const strategies: SanSeLevel[] = [];
      (['strict', 'medium', 'loose'] as SanSeLevel[]).forEach((lv) => {
        const r = evalLatest(series, lv);
        if (r.hit) {
          strategies.push(lv);
          results[lv].push({
            symbol: s.symbol,
            name: s.name,
            industry: s.industry ?? '',
            price: lastClose,
            changePct,
            shortAttack: r.shortAttack,
            midStrength: r.midStrength,
            midControl: r.midControl,
            kongPan: r.kongPan,
            shortOversold: r.shortOversold,
          });
        }
      });

      // 共振紀錄：入選 ∪ 有指標買點（雙B 或 捕撈）→ 才收（過濾無訊號的大宗，檔案不爆）
      const sig = evalSignals(candles, indexClose, series);
      if (strategies.length > 0 || sig.doubleBBuy || sig.catchBuy) {
        const res = computeResonance(strategies, sig);
        records.push({
          symbol: s.symbol, name: s.name, industry: s.industry ?? '',
          price: lastClose, changePct, strategies, ...sig, ...res,
        });
      }
    });
  }

  // 排序：短线上攻強者在前
  (['strict', 'medium', 'loose'] as SanSeLevel[]).forEach((lv) =>
    results[lv].sort((a, b) => b.shortAttack - a.shortAttack),
  );
  // 共振紀錄排序：共振數高→短線上攻強
  records.sort((a, b) => b.resonanceCount - a.resonanceCount || b.shortAttack - a.shortAttack);

  const resonanceCounts: ResonanceCounts = {
    strong: records.filter((r) => r.resonanceLevel === 'strong').length,
    medium: records.filter((r) => r.resonanceLevel === 'medium').length,
    weak: records.filter((r) => r.resonanceLevel === 'weak').length,
    observe: records.filter((r) => r.resonanceLevel === 'observe').length,
    conflict: records.filter((r) => r.conflict).length,
  };

  return {
    lastDate,
    scannedAt: new Date().toISOString(),
    evaluated,
    staleSkipped,
    counts: { strict: results.strict.length, medium: results.medium.length, loose: results.loose.length },
    results,
    records,
    resonanceCounts,
  };
}
