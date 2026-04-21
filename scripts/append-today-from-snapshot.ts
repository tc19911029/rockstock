/**
 * 全市場當日 K 棒 append 腳本（快速版，取代 download-l1-only）
 *
 * 策略：用單一 API 一次拿全市場即時報價（mis.twse / EastMoney），把今日 1 筆
 * append 到既有 L1，不重抓歷史。TW/CN 各一個 HTTP 請求，5 秒完成全市場。
 *
 * 用途：收盤後 L1 補今日，EODHD 配額耗盡時救急用。
 * 限制：必須 L1 已有 lastDate ≥ T-5，否則會跳過（僅 append，不補歷史 gap）。
 *
 * 用法：
 *   npx tsx scripts/append-today-from-snapshot.ts --market TW
 *   npx tsx scripts/append-today-from-snapshot.ts --market CN
 *   npx tsx scripts/append-today-from-snapshot.ts          # 兩個都跑
 */

import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';
import { readCandleFile } from '../lib/datasource/CandleStorageAdapter';
import { writeIntradaySnapshot, type IntradaySnapshot } from '../lib/datasource/IntradayCache';
import { TaiwanScanner } from '../lib/scanner/TaiwanScanner';
import { ChinaScanner } from '../lib/scanner/ChinaScanner';

function getTodayDate(market: 'TW' | 'CN'): string {
  const tz = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
  return new Date().toLocaleString('sv-SE', { timeZone: tz }).split(' ')[0];
}

async function fetchTWQuotes(): Promise<Map<string, { open: number; high: number; low: number; close: number; volume: number }>> {
  const { getTWSERealtimeIntraday } = await import('../lib/datasource/TWSERealtime');
  const raw = await getTWSERealtimeIntraday();
  const out = new Map<string, { open: number; high: number; low: number; close: number; volume: number }>();
  for (const [code, q] of raw) {
    if (q.close > 0) {
      out.set(code, { open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume });
    }
  }
  return out;
}

async function fetchCNQuotes(): Promise<Map<string, { open: number; high: number; low: number; close: number; volume: number }>> {
  const out = new Map<string, { open: number; high: number; low: number; close: number; volume: number }>();

  // 優先試 EastMoney
  try {
    const { getEastMoneyRealtime } = await import('../lib/datasource/EastMoneyRealtime');
    const raw = await getEastMoneyRealtime();
    for (const [code, q] of raw) {
      if (q.close > 0) {
        // EastMoneyRealtime 已統一以「張」(= 手) 回傳；L1 CN 也存「張」，直接用
        out.set(code, { open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume });
      }
    }
    if (out.size > 500) return out;
  } catch (err) {
    console.warn('   EastMoney 失敗，試 Tencent:', (err as Error).message?.slice(0, 80));
  }

  // Fallback: Tencent（需股票清單）
  try {
    const { ChinaScanner } = await import('../lib/scanner/ChinaScanner');
    const scanner = new ChinaScanner();
    const stocks = await scanner.getStockList();
    const symbols = stocks.map(s => s.symbol);
    const { getTencentRealtime } = await import('../lib/datasource/TencentRealtime');
    const tcMap = await getTencentRealtime(symbols);
    for (const [symbol, q] of tcMap) {
      const code = symbol.replace(/\.(SS|SZ)$/i, '');
      if (q.close > 0) {
        // TencentRealtime 已統一以「張」(= 手) 回傳；L1 CN 也存「張」，直接用
        out.set(code, { open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume });
      }
    }
  } catch (err) {
    console.warn('   Tencent fallback 也失敗:', (err as Error).message?.slice(0, 80));
  }

  return out;
}

async function appendMarket(market: 'TW' | 'CN'): Promise<void> {
  const date = getTodayDate(market);

  // 非交易日守門：週末/假日跑這腳本會把「最後交易日」的盤後資料
  // 標記為「今天」寫入 L2，走圖前端以為今天有 K 棒但其實重複了
  const { isTradingDay } = await import('../lib/utils/tradingDay');
  if (!isTradingDay(date, market)) {
    console.log(`\n⏭️  [${market}] ${date} 非交易日，跳過`);
    return;
  }

  console.log(`\n📡 [${market}] 抓全市場即時報價 (${date})...`);
  const t0 = Date.now();
  const quotes = market === 'TW' ? await fetchTWQuotes() : await fetchCNQuotes();
  console.log(`   拿到 ${quotes.size} 支報價 (${Date.now() - t0}ms)`);

  if (quotes.size === 0) {
    console.warn('   ⚠️  0 筆報價，跳過');
    return;
  }

  // 順手寫 L2 快照（讓 UI badge 不再顯示「L2 missing」）
  try {
    const snapshot: IntradaySnapshot = {
      market, date,
      updatedAt: new Date().toISOString(),
      quotes: Array.from(quotes.entries()).map(([code, q]) => ({
        symbol: code, name: '',
        open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume,
        prevClose: q.close, changePercent: 0,
      })),
      count: quotes.size,
    };
    await writeIntradaySnapshot(snapshot);
    console.log(`   📸 L2 快照已寫 ${quotes.size} 筆 → data/intraday-${market}-${date}.json`);
  } catch (err) {
    console.warn('   ⚠️  L2 快照寫入失敗:', (err as Error).message?.slice(0, 80));
  }

  const scanner = market === 'TW' ? new TaiwanScanner() : new ChinaScanner();
  const stocks = await scanner.getStockList();

  let appended = 0;
  let already = 0;
  let noL1 = 0;
  let noQuote = 0;

  const CONCURRENCY = 50;
  for (let i = 0; i < stocks.length; i += CONCURRENCY) {
    const batch = stocks.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(async ({ symbol }) => {
      const code = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
      const existing = await readCandleFile(symbol, market);
      if (!existing) { noL1++; return; }
      if (existing.lastDate >= date) { already++; return; }
      const q = quotes.get(code);
      if (!q) { noQuote++; return; }
      await saveLocalCandles(symbol, market, [
        ...existing.candles,
        { date, open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume },
      ]);
      appended++;
    }));
    const progress = Math.min(100, Math.round(((i + CONCURRENCY) / stocks.length) * 100));
    process.stdout.write(`\r   處理進度: ${progress}%`);
  }

  console.log(`\n   ✅ ${market} append=${appended} already=${already} noL1=${noL1} noQuote=${noQuote}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const markets: ('TW' | 'CN')[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--market' && i + 1 < args.length) {
      const m = args[i + 1].toUpperCase() as 'TW' | 'CN';
      if (m === 'TW' || m === 'CN') markets.push(m);
      i++;
    }
  }
  const targets: ('TW' | 'CN')[] = markets.length > 0 ? markets : ['TW', 'CN'];
  for (const m of targets) {
    try { await appendMarket(m); } catch (err) { console.error(`[${m}] 失敗:`, err); }
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
