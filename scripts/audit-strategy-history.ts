import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadStrategyReadiness } from '@/lib/health/strategyReadiness';
import { collectStrategyGaps, repairEndpoint, type StrategyAudit } from '@/lib/health/strategyAudit';
import { strategyCatchupDates } from '@/lib/scanner/strategyCatchup';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { getActiveStrategyServer } from '@/lib/strategy/activeStrategyServer';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { isCompleteMarketIndexCandle } from '@/lib/datasource/marketIndexQuality';
import { assertL1Coverage } from '@/lib/scanner/coverageGuard';

async function main() {
  const market = process.argv[2];
  if (market !== 'TW' && market !== 'CN') throw new Error('usage: audit-strategy-history.ts TW|CN [--repair]');
  const dir = path.join(process.cwd(), 'data/reports/strategy-audit');
  await fs.mkdir(dir, { recursive: true });
  const lock = path.join(dir, `${market}.lock`);
  // A crashed process must not permanently disable future audits.
  let handle;
  try { handle = await fs.open(lock, 'wx'); }
  catch {
    const recovery = `${lock}.recovery`;
    await fs.mkdir(recovery); // Serialize stale-owner checks so one recovery cannot unlink another's new lock.
    try {
      const pid = Number(await fs.readFile(lock, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid audit lock: ${lock}`);
      try { process.kill(pid, 0); throw new Error(`Audit already running: ${pid}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      await fs.unlink(lock);
      handle = await fs.open(lock, 'wx');
    } finally { await fs.rmdir(recovery); }
  }
  try {
    await handle.writeFile(String(process.pid));
    const file = path.join(dir, `${market}.json`);
    const previous: StrategyAudit | null = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
    const endDate = getLastTradingDay(market);
    const strategy = await getActiveStrategyServer();
    const days = [];
    for (const date of strategyCatchupDates(market, endDate, 22)) days.push(await loadStrategyReadiness(market, date, strategy.id));
    const report: StrategyAudit = { market, endDate, checkedAt: new Date().toISOString(), status: 'checking', days,
      gaps: collectStrategyGaps(days, previous?.gaps) };
    const save = async () => {
      report.checkedAt = new Date().toISOString();
      await fs.writeFile(`${file}.tmp`, JSON.stringify(report, null, 2));
      await fs.rename(`${file}.tmp`, file);
    };
    await save();
    if (process.argv.includes('--repair')) {
      const secret = (await fs.readFile(path.join(os.homedir(), '.config/rockstock/cron-secret'), 'utf8')).trim();
      const attempted = new Set<string>();
      for (const gap of [...report.gaps].sort((a, b) => b.date.localeCompare(a.date) || a.key.localeCompare(b.key))) {
        const endpoint = repairEndpoint(market, gap, endDate);
        if (!endpoint) {
          gap.state = 'blocked'; gap.detail = gap.key === 'V' ? '缺當時基本面快照，禁止使用最新公告回填' : '需驗證歷史來源與相依資料後重播';
          continue;
        }
        const coverage = await assertL1Coverage(market, gap.date);
        if (!coverage.ok) { gap.state = 'blocked'; gap.detail = coverage.reason; continue; }
        if (market === 'TW') {
          const missingIndexes: string[] = [];
          for (const symbol of ['^TWII', '^TWOII']) {
            const data = await readCandleFile(symbol, market);
            if (!isCompleteMarketIndexCandle(data?.candles.find(c => c.date === gap.date))) missingIndexes.push(symbol);
          }
          if (missingIndexes.length) {
            gap.state = 'blocked'; gap.detail = `目標日指數缺失或 OHLCV 不完整：${missingIndexes.join(', ')}`; continue;
          }
        }
        if (attempted.has(endpoint)) continue;
        // A must be complete before the bullish batch consumes its Step 1 pool.
        if (endpoint.includes('track=bullish')) {
          const ready = await loadStrategyReadiness(market, gap.date, strategy.id);
          if (ready.artifacts.some(a => a.key.startsWith('A-') && !a.ready)) {
            gap.state = 'blocked'; gap.detail = 'A 預選池尚未完成'; continue;
          }
        }
        attempted.add(endpoint);
        const group = report.gaps.filter(g => repairEndpoint(market, g, endDate) === endpoint);
        for (let attempt = 0; attempt < 2; attempt++) {
          group.forEach(g => { g.state = 'running'; g.attempts++; });
          await save();
          let retryable = true;
          try {
            const response = await fetch(`http://localhost:3000${endpoint}`, {
              headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(300_000),
            });
            retryable = response.status === 429 || response.status >= 500;
            const body = await response.json();
            if (!response.ok || body.ok !== true) throw new Error(`HTTP ${response.status}: ${body.error ?? 'unsuccessful response'}`);
            break;
          } catch (error) {
            group.forEach(g => { g.state = 'failed'; g.detail = String(error).slice(0, 600); });
            await save();
            if (!retryable || attempt === 1) break;
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
        }
        // HTTP 200 is not proof: independently reload the expected artifacts.
        const recheck = await loadStrategyReadiness(market, gap.date, strategy.id);
        report.days = report.days.map(d => d.date === gap.date ? recheck : d);
        group.forEach(g => {
          if (recheck.artifacts.some(a => a.key === g.key && !a.ready) && g.state === 'running') {
            g.state = 'failed'; g.detail = 'endpoint returned but required artifact remains incomplete';
          }
        });
        await save();
      }
    }
    report.gaps = report.gaps.filter(g => report.days.some(d => d.date === g.date && d.artifacts.some(a => a.key === g.key && !a.ready)));
    report.status = report.gaps.length ? 'partial' : 'ready';
    await save();
    console.log(JSON.stringify({ market, endDate, status: report.status, gaps: report.gaps, report: file }, null, 2));
    if (report.gaps.length) process.exitCode = 1;
  } finally { await handle.close(); await fs.unlink(lock); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
