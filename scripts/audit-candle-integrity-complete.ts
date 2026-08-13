/**
 * 全市場 L1 K 棒結構完整性稽核（純讀取）。
 *
 * 檢查每一個 TW/CN JSON：可解析、symbol metadata、日期格式/排序/重複/未來日、
 * OHLCV 有限且自洽、lastDate/sealedDate、完全複製前一日，以及最新台股成交檔位。
 * 歷史台股可能是拆分調整價，故只對「各檔最新一根」套交易檔位，不誤報調整後舊 K。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isTwEtf, isTwIndex, isValidTwTick } from '../lib/datasource/twTick';

type Market = 'TW' | 'CN';
type Candle = { date: string; open: number; high: number; low: number; close: number; volume: number };
type Issue = { market: Market; symbol: string; kind: string; date?: string; detail: string };

const ROOT = process.cwd();
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const OUT = path.join(ROOT, 'data', 'reports', `candle-integrity-complete-${TODAY}.json`);
const REPAIR_METADATA = process.argv.includes('--repair-metadata');

function finite(n: unknown): n is number { return typeof n === 'number' && Number.isFinite(n); }

async function main() {
  const issues: Issue[] = [];
  const warnings: Issue[] = [];
  const summary = { files: 0, bars: 0, parseErrors: 0, invalidOhlcv: 0, duplicateDates: 0, unsortedDates: 0, metadataErrors: 0, futureDates: 0, duplicateBars: 0, latestTwInvalidTicks: 0 };

  for (const market of ['TW', 'CN'] as const) {
    const dir = path.join(ROOT, 'data', 'candles', market);
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json')).sort();
    for (const name of files) {
      const symbol = name.slice(0, -5);
      summary.files++;
      let parsed: { symbol?: string; lastDate?: string; sealedDate?: string; updatedAt?: string; candles?: Candle[] };
      try { parsed = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')); }
      catch (e) {
        summary.parseErrors++;
        issues.push({ market, symbol, kind: 'parse-error', detail: e instanceof Error ? e.message : String(e) });
        continue;
      }
      if (parsed.symbol && parsed.symbol !== symbol) {
        summary.metadataErrors++;
        issues.push({ market, symbol, kind: 'symbol-mismatch', detail: `payload=${parsed.symbol}` });
      }
      const bars = parsed.candles;
      if (!Array.isArray(bars)) {
        summary.parseErrors++;
        issues.push({ market, symbol, kind: 'candles-not-array', detail: typeof bars });
        continue;
      }
      summary.bars += bars.length;
      const seen = new Set<string>();
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        const date = String(b?.date ?? '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > TODAY) {
          if (date > TODAY) summary.futureDates++;
          else summary.invalidOhlcv++;
          issues.push({ market, symbol, kind: date > TODAY ? 'future-date' : 'invalid-date', date, detail: `index=${i}` });
        }
        if (seen.has(date)) {
          summary.duplicateDates++;
          issues.push({ market, symbol, kind: 'duplicate-date', date, detail: `index=${i}` });
        }
        seen.add(date);
        if (i > 0 && date <= String(bars[i - 1].date)) {
          summary.unsortedDates++;
          issues.push({ market, symbol, kind: 'unsorted-date', date, detail: `prev=${bars[i - 1].date}` });
        }
        const nums = [b?.open, b?.high, b?.low, b?.close, b?.volume];
        const valid = nums.every(finite) && b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0
          && b.volume >= 0 && b.low <= b.open && b.open <= b.high && b.low <= b.close && b.close <= b.high;
        if (!valid) {
          summary.invalidOhlcv++;
          issues.push({ market, symbol, kind: 'invalid-ohlcv', date, detail: `O=${b?.open} H=${b?.high} L=${b?.low} C=${b?.close} V=${b?.volume}` });
        }
        if (i > 0) {
          const p = bars[i - 1];
          const range = b.low > 0 ? (b.high - b.low) / b.low : 0;
          if (b.open === p.open && b.high === p.high && b.low === p.low && b.close === p.close && b.volume === p.volume
            && b.volume > 0 && b.high > b.low && range >= 0.01) {
            summary.duplicateBars++;
            warnings.push({ market, symbol, kind: 'duplicate-prev-bar-candidate', date, detail: `prev=${p.date}` });
          }
        }
      }
      const lastDate = bars.at(-1)?.date;
      if (bars.length > 0 && parsed.lastDate !== lastDate) {
        summary.metadataErrors++;
        issues.push({ market, symbol, kind: 'last-date-mismatch', detail: `meta=${parsed.lastDate} actual=${lastDate}` });
      }
      if (parsed.sealedDate && lastDate && parsed.sealedDate > lastDate) {
        summary.metadataErrors++;
        issues.push({ market, symbol, kind: 'sealed-after-last', detail: `sealed=${parsed.sealedDate} last=${lastDate}` });
        if (REPAIR_METADATA) {
          parsed.sealedDate = lastDate;
          parsed.updatedAt = new Date().toISOString();
          await fs.writeFile(path.join(dir, name), JSON.stringify(parsed));
        }
      }
      if (market === 'TW' && bars.length && !isTwIndex(symbol)) {
        const last = bars.at(-1)!;
        const invalid = ['open', 'high', 'low', 'close'].filter(k => !isValidTwTick(last[k as keyof Candle] as number, isTwEtf(symbol)));
        if (invalid.length) {
          summary.latestTwInvalidTicks++;
          issues.push({ market, symbol, kind: 'latest-invalid-tick', date: last.date, detail: invalid.map(k => `${k}=${last[k as keyof Candle]}`).join(' ') });
        }
      }
    }
  }

  const result = { generatedAt: new Date().toISOString(), today: TODAY, repairMetadata: REPAIR_METADATA, summary, issueCount: issues.length, warningCount: warnings.length, issues, warnings };
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ generatedAt: result.generatedAt, ...summary, issueCount: issues.length, report: OUT }, null, 2));
  if (issues.length) process.exitCode = 2;
}

main().catch(e => { console.error(e); process.exit(1); });
