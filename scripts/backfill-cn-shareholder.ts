/**
 * 回填陸股股东户数（籌碼集中度）歷史 — 一次性把全主板宇宙的逐季戶數撈下來存檔。
 *
 * 為什麼：股东户数（HOLDER_NUM_RATIO 負=戶數減少=籌碼集中）= 陸股對標台股「集保散戶集中度」，
 * 程式現只 on-demand 抓最近 8 期、不持久化。要回測它有沒有 edge 需先存歷史。
 *
 * 資料源：lib/datasource/EastMoneyShareholderCount.ts（EastMoney datacenter RPT_HOLDERNUM_DET，
 * 季報頻率、自帶 noticeDate 公告日 → 回測用公告日進場才不前視）。
 * 宇宙：lib/scanner/cnStocks.ts CN_STOCKS（3062 檔滬深主板）。
 * 存檔：data/chips/CN/shareholder/{code}.json（鏡像既有 data/chips/CN/flow/{code}.json）。
 *
 * 用法：
 *   npx tsx scripts/backfill-cn-shareholder.ts                 # 全量，已存在跳過
 *   npx tsx scripts/backfill-cn-shareholder.ts --limit-stocks 10   # 先小樣本驗 shape
 *   npx tsx scripts/backfill-cn-shareholder.ts --periods 20    # 每檔撈 20 期（~5 年）
 *   npx tsx scripts/backfill-cn-shareholder.ts --force         # 無視既有重抓
 *   npx tsx scripts/backfill-cn-shareholder.ts --retry-empty   # 只重抓「先前抓到空」的檔（疑似被限流）
 */
import { promises as fs } from 'fs';
import path from 'path';
import { CN_STOCKS } from '@/lib/scanner/cnStocks';
import { fetchShareholderCount, type ShareholderCountQuarter } from '@/lib/datasource/EastMoneyShareholderCount';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';

const OUT_DIR = path.join(process.cwd(), 'data', 'chips', 'CN', 'shareholder');

interface ShareholderFile {
  code: string;
  symbol: string;
  fetchedAt: string;
  quarters: ShareholderCountQuarter[];
}

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const numArg = (name: string, def: number): number => {
  const i = argv.indexOf(name);
  if (i < 0 || i + 1 >= argv.length) return def;
  const n = parseInt(argv[i + 1], 10);
  return Number.isFinite(n) ? n : def;
};

const PERIODS = numArg('--periods', 16);          // 季數（~4 年）
const LIMIT_STOCKS = numArg('--limit-stocks', 0); // 0 = 全部
const CONCURRENCY = numArg('--concurrency', 4);
const SLEEP_MS = numArg('--sleep', 250);
const FORCE = flag('--force');
const RETRY_EMPTY = flag('--retry-empty');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 讀既有檔判斷是否該跳過：--force 一律重抓；--retry-empty 只重抓空檔；預設非空就跳。 */
async function shouldSkip(code: string): Promise<boolean> {
  if (FORCE) return false;
  try {
    const raw = JSON.parse(await fs.readFile(path.join(OUT_DIR, `${code}.json`), 'utf-8')) as ShareholderFile;
    const isEmpty = !raw.quarters || raw.quarters.length === 0;
    if (RETRY_EMPTY) return !isEmpty;   // retry-empty 模式：非空才跳
    return !isEmpty ? true : false;     // 預設：非空跳、空的重抓（可能上次被限流）
  } catch {
    return false; // 沒檔 → 抓
  }
}

/** 撈一檔；空結果重試（限流/HTML 會回空）。回傳期數陣列（可能為空＝真的沒資料）。 */
async function fetchWithRetry(code: string): Promise<ShareholderCountQuarter[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const q = await fetchShareholderCount(code, PERIODS);
    if (q.length > 0) return q;
    await sleep(300 * (attempt + 1)); // 退避後重試（區分真空 vs 限流）
  }
  return [];
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const universe = LIMIT_STOCKS > 0 ? CN_STOCKS.slice(0, LIMIT_STOCKS) : CN_STOCKS;
  console.log(`股东户数回填：宇宙 ${universe.length} 檔、每檔 ${PERIODS} 期、並發 ${CONCURRENCY}` +
    `${FORCE ? '、--force 重抓' : RETRY_EMPTY ? '、--retry-empty 只補空檔' : '、已存在跳過'}`);

  const now = new Date().toISOString();
  let cursor = 0;
  const stat = { written: 0, skipped: 0, empty: 0, totalQuarters: 0, withRatio: 0 };

  async function worker() {
    while (cursor < universe.length) {
      const i = cursor++;
      const { symbol } = universe[i];
      const code = symbol.split('.')[0];
      if (await shouldSkip(code)) { stat.skipped++; continue; }

      const quarters = await fetchWithRetry(code);
      const file: ShareholderFile = { code, symbol, fetchedAt: now, quarters };
      await atomicFsPut(path.join(OUT_DIR, `${code}.json`), JSON.stringify(file));
      stat.written++;
      if (quarters.length === 0) stat.empty++;
      stat.totalQuarters += quarters.length;
      stat.withRatio += quarters.filter((q) => q.holderNumRatio != null && q.noticeDate != null).length;

      if (stat.written % 200 === 0) {
        const done = stat.written + stat.skipped;
        console.log(`  ..${done}/${universe.length}（寫 ${stat.written} 跳 ${stat.skipped} 空 ${stat.empty}）`);
      }
      await sleep(SLEEP_MS);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, () => worker()));

  console.log('\n=== 完成 ===');
  console.log(`寫入 ${stat.written}、跳過 ${stat.skipped}、抓到空 ${stat.empty}`);
  console.log(`總期數 ${stat.totalQuarters}、可回測期數（有 ratio+公告日） ${stat.withRatio}`);
  const emptyRate = stat.written > 0 ? (stat.empty / stat.written) * 100 : 0;
  if (emptyRate > 20) {
    console.log(`⚠️ 空檔率 ${emptyRate.toFixed(0)}% 偏高 — 可能被 EastMoney 限流，建議稍後 --retry-empty 重跑補空。`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
