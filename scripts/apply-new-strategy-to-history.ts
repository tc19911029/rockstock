/**
 * 套用新策略到歷史 L4 scan sessions
 *
 * 新策略（2026-04-17 落地）：
 *   1. 前 500 成交額過濾（過濾 session.results）
 *   2. 次排序改為漲幅（取代共振+高勝率）
 *
 * 本腳本只改寫 post_close session（official 結果），intraday 快照不動。
 * 每個日期按當下的 top500 計算（模擬回測情境），不是用今天的 top500 套全部。
 *
 * 用法：
 *   npx tsx scripts/apply-new-strategy-to-history.ts
 *   npx tsx scripts/apply-new-strategy-to-history.ts --market TW
 *   npx tsx scripts/apply-new-strategy-to-history.ts --dry-run
 */

import { config } from 'dotenv';
import { existsSync } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import type { ScanSession, MarketId, ScanDirection } from '../lib/scanner/types';
import { TaiwanScanner } from '../lib/scanner/TaiwanScanner';
import { ChinaScanner } from '../lib/scanner/ChinaScanner';
import { computeTurnoverRankAsOfDate } from '../lib/scanner/TurnoverRank';

type MtfMode = 'daily' | 'mtf';

interface ScanFile {
  localName: string;
  market: MarketId;
  direction: ScanDirection;
  mtfMode: MtfMode;
  date: string;
  fullPath: string;
}

const DATA_DIR = path.join(process.cwd(), 'data');

// ── 列出本地所有 post_close L4 session 檔 ────────────────────────────────

async function listPostCloseSessions(
  markets: MarketId[],
): Promise<ScanFile[]> {
  const files: ScanFile[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(DATA_DIR);
  } catch {
    return [];
  }

  for (const name of entries) {
    // 只抓 post_close 檔，跳過 intraday 快照
    // 格式：scan-{market}-{direction}-{mtfMode}-{YYYY-MM-DD}.json
    const m = name.match(/^scan-(TW|CN)-(long|short)-(daily|mtf)-(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m) continue;

    const market = m[1] as MarketId;
    if (!markets.includes(market)) continue;

    files.push({
      localName: name,
      market,
      direction: m[2] as ScanDirection,
      mtfMode: m[3] as MtfMode,
      date: m[4],
      fullPath: path.join(DATA_DIR, name),
    });
  }

  return files;
}

// ── 套用新策略到單一 session ───────────────────────────────────────────────

function applyNewStrategy(
  session: ScanSession,
  top500: Set<string>,
): { filtered: number; resorted: number; before: number } {
  const before = session.results.length;

  // 1. 前 500 過濾
  const filtered = session.results.filter(r => top500.has(r.symbol));
  const filterOut = before - filtered.length;

  // 2. 新排序：score → changePercent
  filtered.sort((a, b) =>
    (b.sixConditionsScore ?? 0) - (a.sixConditionsScore ?? 0) ||
    b.changePercent - a.changePercent
  );

  session.results = filtered;
  session.resultCount = filtered.length;

  return { filtered: filterOut, resorted: filtered.length, before };
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const markets: MarketId[] = [];
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--market' && args[i + 1]) {
      const m = args[i + 1].toUpperCase();
      if (m === 'TW' || m === 'CN') markets.push(m);
      i++;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }

  const targetMarkets = markets.length > 0 ? markets : (['TW', 'CN'] as MarketId[]);

  console.log(`\n🔄 套用新策略到歷史 L4 — ${new Date().toISOString()}`);
  console.log(`   市場: ${targetMarkets.join(', ')}`);
  if (dryRun) console.log(`   🟡 DRY RUN（不實際寫檔）`);

  // Step 1: 列出所有 L4 post_close session
  const sessions = await listPostCloseSessions(targetMarkets);
  if (sessions.length === 0) {
    console.log(`\n⚠️  找不到任何 L4 session（資料夾 ${DATA_DIR}）`);
    return;
  }

  // 以 (market, date) 為 key 分組，同組共用 top500
  const dateMap = new Map<string, ScanFile[]>();
  for (const f of sessions) {
    const key = `${f.market}|${f.date}`;
    if (!dateMap.has(key)) dateMap.set(key, []);
    dateMap.get(key)!.push(f);
  }

  console.log(`   找到 ${sessions.length} 個 session，${dateMap.size} 個 (market, date) 組合`);

  // Step 2: 每個 (market, date) 算一次 top500，套用到所有相關 session
  const stockCache = new Map<MarketId, { symbol: string }[]>();

  let totalFiles = 0;
  let totalFilteredOut = 0;
  let totalAfter = 0;

  for (const [key, groupFiles] of dateMap) {
    const [market, date] = key.split('|') as [MarketId, string];

    // 取股票清單（每市場只取一次）
    if (!stockCache.has(market)) {
      const scanner = market === 'CN' ? new ChinaScanner() : new TaiwanScanner();
      stockCache.set(market, await scanner.getStockList());
    }
    const stocks = stockCache.get(market)!;

    console.log(`\n📊 [${market} ${date}] 計算當日 top500...`);
    const top500 = await computeTurnoverRankAsOfDate(market, stocks, date, 500);
    console.log(`   top500 size=${top500.size}, 套用到 ${groupFiles.length} 個 session`);

    for (const f of groupFiles) {
      try {
        const raw = await fs.readFile(f.fullPath, 'utf-8');
        const session: ScanSession = JSON.parse(raw);

        const { filtered, resorted, before } = applyNewStrategy(session, top500);
        totalFiles++;
        totalFilteredOut += filtered;
        totalAfter += resorted;

        console.log(`   ✅ ${f.localName}: ${before} → ${resorted}（過濾 ${filtered}）`);

        if (!dryRun) {
          await fs.writeFile(f.fullPath, JSON.stringify(session));
        }
      } catch (err) {
        console.error(`   ❌ ${f.localName}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  console.log(`\n🎉 完成`);
  console.log(`   處理 session: ${totalFiles}`);
  console.log(`   總過濾掉（非 top500）: ${totalFilteredOut}`);
  console.log(`   總保留: ${totalAfter}`);
  if (dryRun) console.log(`   ⚠️  DRY RUN — 檔案未實際修改`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
