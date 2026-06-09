/**
 * 修復 2026-06-08 全市場 L1 壞封存：盤後 append-from-snapshot 把 stale L2(凍在 09:27 盤前
 * 集合競價的「單點平棒」O=H=L=C)當成收盤封進 L1。用「現在已刷新成真實收盤的 L2 快照」覆蓋
 * 那些平棒（等同 append-from-snapshot 本該寫入的值，量單位一致）。
 *
 *   只動「最後一根 == TARGET 且 O=H=L=C 平棒」的檔；正常根不碰。
 *   L2 對應股仍是平棒 / 無資料 / 漲跌幅 sanity 超界 → skip（留給後續 download 重抓）。
 *
 * 用法：npx tsx scripts/repair-cn-0608-flat-seal.ts          # dry-run（只報告）
 *       APPLY=1 npx tsx scripts/repair-cn-0608-flat-seal.ts  # 實際寫入
 *       ONLY=600487.SS APPLY=1 npx tsx scripts/repair-cn-0608-flat-seal.ts  # 單檔測試
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { saveLocalCandles } from '@/lib/datasource/LocalCandleStore';
import type { Candle } from '@/types';

const TARGET = '2026-06-08';
const MARKET = (process.env.MARKET || 'CN') as 'CN' | 'TW';
const DIR = `data/candles/${MARKET}`;
const INDEX_SYM = MARKET === 'CN' ? '000001.SS' : '^TWII';
const SUFFIX_RE = MARKET === 'CN' ? /\.(SS|SZ)$/i : /\.(TW|TWO)$/i;
const APPLY = process.env.APPLY === '1';
const ONLY = process.env.ONLY || '';

type L2Q = { symbol: string; open: number; high: number; low: number; close: number; volume: number };
const isFlat = (o: number, h: number, l: number, c: number) => o === h && h === l && l === c;

async function main() {
  const snap = JSON.parse(readFileSync(`data/intraday-${MARKET}-${TARGET}.json`, 'utf8')) as { updatedAt: string; quotes: L2Q[] };
  const l2 = new Map<string, L2Q>();
  for (const q of snap.quotes ?? []) l2.set(q.symbol.split('.')[0], q); // 一律用裸碼當 key（CN 本就裸碼、TW 可能帶 suffix）
  console.log(`[${MARKET}] L2 快照 updatedAt=${snap.updatedAt}，${l2.size} 檔`);

  const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));
  let bad = 0, fixed = 0, skipNoL2 = 0, skipL2Flat = 0, skipSanity = 0;
  const samples: string[] = [];

  for (const f of files) {
    const symbol = f.replace('.json', '');
    if (ONLY && symbol !== ONLY) continue;
    if (symbol === INDEX_SYM) continue; // 指數另外處理（其 0608 本就非平棒）
    let data: { candles?: Candle[] };
    try { data = JSON.parse(readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
    const candles = data.candles;
    if (!Array.isArray(candles) || candles.length < 2) continue;
    const lastIdx = candles.length - 1;
    const last = candles[lastIdx];
    if (last.date !== TARGET || !isFlat(last.open, last.high, last.low, last.close)) continue; // 只修 TARGET 平棒
    bad++;

    const code = symbol.replace(SUFFIX_RE, '');
    const q = l2.get(code);
    if (!q || !(q.close > 0)) { skipNoL2++; continue; }
    // L2 與 L1 OHLC 完全相同 → 無需動（合法漲停/停牌平棒，或已正確）。
    // 注意：不可用「L2 是平棒就跳過」——漲停鎖死股 L2 也是平棒，但其值才是真實收盤（例 2321 L1=13.475 vs L2=13.65）。
    if (q.open === last.open && q.high === last.high && q.low === last.low && q.close === last.close) { skipL2Flat++; continue; }
    const prev = candles[lastIdx - 1];
    if (prev?.close > 0 && Math.abs((q.close - prev.close) / prev.close) > 0.22) { skipSanity++; continue; }

    if (samples.length < 8) samples.push(`${symbol} C${last.close}→${q.close}`);
    if (APPLY) {
      const next = candles.slice(0, lastIdx);
      next.push({ date: TARGET, open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume });
      await saveLocalCandles(symbol, MARKET, next);
    }
    fixed++;
  }

  console.log(`\n${APPLY ? '【已寫入】' : '【DRY-RUN，未寫入】'}`);
  console.log(`壞平棒檔(最後一根=${TARGET} 且 O=H=L=C): ${bad}`);
  console.log(`可修(L2 有真實 OHLC + sanity 過): ${fixed}`);
  console.log(`skip — L2 無此股: ${skipNoL2} | L2 仍平棒: ${skipL2Flat} | 漲跌幅 sanity 超界: ${skipSanity}`);
  console.log(`樣本: ${samples.join('  ')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
