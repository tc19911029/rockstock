#!/usr/bin/env npx tsx
/**
 * backfill-cn-gem-star.ts — 把科創板(688)/創業板(30x) 補進陸股掃描宇宙。
 *
 * 為什麼要這支：兩個板塊一直被排除（cnStocks.ts 不收 + eastMoneyApi / scan.ts 過濾），
 * 所以 data/candles/CN 一根日K都沒有。光開閘沒用，掃出來會是空的 → 先把日K補進 L1。
 *
 * 範圍（使用者決議「只補能進 top800 的量」）：各板塊按成交額(f6)由高到低取前 TOP_N 檔
 * （預設 400），這些才有機會擠進掃描的 top-800 粗篩；冷門薄量股不補、省一半下載。
 *
 * 來源：東方財富 clist 取清單（科創 m:1+t:23 / 創業 m:0+t:80，已按 f6 排序）；
 *      日K走騰訊 qfq（與 download-l1-tencent-cn.ts 同一路、台灣 IP 可連、無 key）。
 *
 * 產出：
 *   1. data/candles/CN/{code}.{SS|SZ}.json  ← 日K（與主板同檔格式）
 *   2. lib/scanner/cnStocksGemStar.ts        ← 成功下載的清單（掃描宇宙 import 用）
 *
 * 用法：
 *   npx tsx scripts/backfill-cn-gem-star.ts            # 各 400 檔
 *   npx tsx scripts/backfill-cn-gem-star.ts --top 600  # 各 600 檔
 *   npx tsx scripts/backfill-cn-gem-star.ts --force     # 已有檔也重抓
 */
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import path from 'path';

const argTop = process.argv.indexOf('--top');
const TOP_N = argTop >= 0 ? parseInt(process.argv[argTop + 1], 10) || 400 : 400;
const FORCE = process.argv.includes('--force');
const BATCH = 10;
const DATA_ROOT = path.join(process.cwd(), 'data', 'candles', 'CN');
const OUT_LIST = path.join(process.cwd(), 'lib', 'scanner', 'cnStocksGemStar.ts');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Candle { date: string; open: number; high: number; low: number; close: number; volume: number }
interface Entry { symbol: string; name: string; industry?: string; board: 'star' | 'chinext'; turnover: number }

const todayStr = () => new Date().toISOString().split('T')[0];

/** fetch + 重試（騰訊/東財 IPv6 偶發 socket reset，不該讓整批掛掉）。 */
async function fetchRetry(url: string, init: RequestInit, tries = 8): Promise<Response> {
  let lastErr: unknown;
  for (let t = 0; t < tries; t++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(500 * (t + 1));
  }
  throw lastErr;
}

/** 從東財 clist 取某板塊（fs）前 topN 檔（已按 f6 成交額排序），濾掉 ST/退市/無效碼。 */
async function fetchBoardList(fs: string, suffix: '.SS' | '.SZ', board: 'star' | 'chinext'): Promise<Entry[]> {
  const out: Entry[] = [];
  const pageSize = 100;
  let page = 1;
  while (out.length < TOP_N && page <= 30) {
    const url =
      'https://push2.eastmoney.com/api/qt/clist/get?' +
      `pn=${page}&pz=${pageSize}&po=1&np=1&fltt=2&invt=2&fid=f6` +
      `&fs=${encodeURIComponent(fs)}&fields=f12,f14,f3,f6,f100`;
    const res = await fetchRetry(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' },
      signal: AbortSignal.timeout(15000),
    });
    const json = (await res.json()) as { data?: { diff?: Array<{ f12: string; f14: string; f6: number; f100?: string }> } };
    const items = json?.data?.diff ?? [];
    if (items.length === 0) break;
    for (const it of items) {
      const code = it.f12;
      if (!/^\d{6}$/.test(code)) continue;
      if (/ST|退市|退/.test(it.f14)) continue;
      const industry = typeof it.f100 === 'string' && it.f100 !== '-' ? it.f100 : undefined;
      const name = it.f14 && it.f14 !== '-' ? it.f14 : code;
      out.push({ symbol: `${code}${suffix}`, name, industry, board, turnover: it.f6 ?? 0 });
      if (out.length >= TOP_N) break;
    }
    if (items.length < pageSize) break;
    page++;
  }
  return out;
}

function toTencentSymbol(symbol: string): string {
  const m = symbol.match(/^(\d{6})\.(SS|SZ)$/i);
  if (!m) return '';
  return (m[2].toUpperCase() === 'SS' ? 'sh' : 'sz') + m[1];
}

async function fetchTencent(symbol: string): Promise<Candle[]> {
  const start = new Date();
  start.setFullYear(start.getFullYear() - 3); // ~3 年 → 足夠 midControl SUM(VOL,480)≈507 根深歷史
  const startStr = start.toISOString().split('T')[0];
  const ten = toTencentSymbol(symbol);
  const url = `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get?param=${ten},day,${startStr},${todayStr()},800,qfq`;
  const res = await fetchRetry(url, { signal: AbortSignal.timeout(15000) });
  const json = (await res.json()) as { data?: Record<string, { day?: unknown[][]; qfqday?: unknown[][] }> };
  const data = json?.data?.[ten]?.qfqday || json?.data?.[ten]?.day || [];
  if (!Array.isArray(data) || data.length === 0) return [];
  return data
    .map((row) => ({
      date: String(row[0]),
      open: parseFloat(String(row[1])),
      close: parseFloat(String(row[2])),
      high: parseFloat(String(row[3])),
      low: parseFloat(String(row[4])),
      volume: Math.round(parseFloat(String(row[5]))), // 騰訊 raw 量（單位不一致：科創常為股、創業/主板為手）→ 由 f6 校準
    }))
    .filter((c) => c.open > 0);
}

/**
 * 量單位校準：騰訊對科創(.SS)回「股」、創業/主板回「手」，同端點不一致（陸股量單位地雷）。
 * 用清單帶回的 f6 成交額（元，ground truth）反推倍率，把整條序列正規化成「股」（對齊主板 L1
 * 與 EOD 快照 append 的 f5×100）。倍率只可能是 1（已是股）或 100（手→股）；缺 f6 預設 ×100。
 */
function calibrateToShares(candles: Candle[], emTurnoverYuan: number): Candle[] {
  if (candles.length === 0) return candles;
  const last = candles[candles.length - 1];
  const rawTurnover = (last.close || 0) * (last.volume || 0);
  let mult = 100; // 預設手→股
  if (emTurnoverYuan > 0 && rawTurnover > 0) {
    // 在 {1, 100} 中選讓 close×vol 最接近 f6 的倍率（單位誤差是 100 倍、自然波動 <5 倍，可靠區分）
    const err = (m: number) => Math.abs(Math.log((rawTurnover * m) / emTurnoverYuan));
    mult = err(1) <= err(100) ? 1 : 100;
  }
  if (mult === 1) return candles;
  return candles.map((c) => ({ ...c, volume: Math.round(c.volume * mult) }));
}

function writeCandleFile(symbol: string, candles: Candle[]): void {
  const file = path.join(DATA_ROOT, `${symbol}.json`);
  const envelope = {
    symbol,
    lastDate: candles[candles.length - 1]?.date ?? '',
    updatedAt: new Date().toISOString(),
    candles,
  };
  writeFileSync(file, JSON.stringify(envelope));
}

async function main() {
  if (!existsSync(DATA_ROOT)) mkdirSync(DATA_ROOT, { recursive: true });
  console.log(`[gem-star] 取清單：科創 + 創業 各前 ${TOP_N} 檔（成交額排序）…`);
  const [star, chinext] = await Promise.all([
    fetchBoardList('m:1+t:23', '.SS', 'star'),
    fetchBoardList('m:0+t:80', '.SZ', 'chinext'),
  ]);
  const list = [...star, ...chinext];
  console.log(`[gem-star] 科創 ${star.length} + 創業 ${chinext.length} = ${list.length} 檔`);

  let ok = 0, fail = 0, skip = 0;
  const done: Entry[] = [];
  const t0 = Date.now();

  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (e) => {
        const file = path.join(DATA_ROOT, `${e.symbol}.json`);
        if (!FORCE && existsSync(file)) {
          // 已有檔 → 視為齊全（daily catchup 會接手更新），收進清單即可
          try {
            const cs = JSON.parse(readFileSync(file, 'utf8')).candles;
            if (Array.isArray(cs) && cs.length >= 250) return { e, status: 'skip' as const };
          } catch { /* 壞檔重抓 */ }
        }
        const raw = await fetchTencent(e.symbol);
        if (raw.length < 250) throw new Error(`bars=${raw.length}`);
        const candles = calibrateToShares(raw, e.turnover);
        writeCandleFile(e.symbol, candles);
        return { e, status: 'ok' as const };
      }),
    );
    results.forEach((r, k) => {
      if (r.status === 'fulfilled') {
        done.push(batch[k]);
        if (r.value.status === 'ok') ok++; else skip++;
      } else {
        fail++;
        console.warn(`  ✗ ${batch[k].symbol} ${batch[k].name}: ${r.reason}`);
      }
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`[gem-star] ${Math.min(i + BATCH, list.length)}/${list.length}  ok=${ok} skip=${skip} fail=${fail}  ${elapsed}s`);
    await sleep(300);
  }

  // 產出掃描宇宙清單（只收成功下載 / 已有K線的，確保 universe 內每檔都讀得到日K）
  done.sort((a, b) => a.symbol.localeCompare(b.symbol));
  const rows = done
    .map((e) => `  { symbol: '${e.symbol}', name: ${JSON.stringify(e.name)}, industry: ${JSON.stringify(e.industry ?? '')}, board: '${e.board}' },`)
    .join('\n');
  const header =
    `// Auto-generated by scripts/backfill-cn-gem-star.ts\n` +
    `// 科創板(688) + 創業板(30x) 掃描宇宙 — 各板塊成交額前 ${TOP_N} 檔（能進 top-800 粗篩的量）。\n` +
    `// 板塊敏感：漲停 20%（getLimitMovePct）、前端掛科創/創業徽章（cnBoard）。\n` +
    `// Generated: ${todayStr()}  Total: ${done.length}\n\n` +
    `import type { StockEntry } from './MarketScanner';\n\n` +
    `export interface GemStarEntry extends StockEntry { board: 'star' | 'chinext' }\n\n` +
    `export const CN_STOCKS_GEM_STAR: GemStarEntry[] = [\n`;
  writeFileSync(OUT_LIST, header + rows + '\n];\n');

  console.log(`\n[gem-star] 完成：日K ok=${ok} skip=${skip} fail=${fail}；清單寫入 ${done.length} 檔 → ${OUT_LIST}`);
}

main().catch((e) => {
  console.error('[gem-star] 失敗：', e);
  process.exit(1);
});
