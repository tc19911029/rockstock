/**
 * broker-bulk 的 node 包裝 — 讓 launchd 走 node（有桌面 TCC 權限）再叫 python，
 * 避免 launchd 直跑 /usr/bin/python3 被 macOS 擋桌面存取（Operation not permitted）。
 * 同 youtube whisper cron 的「node server spawn python 子程序繼承權限」先例。
 *
 * 跑兩件（都走同一份 bulk parquet）：
 *   1. fetch_broker_bulk.py        → 主力分點 netDifference/集中度（broker JSON，W/Y 軌 + chipcost）
 *   2. populate_conc_cache_bulk.py → computeConc5Map 的快取（finmind-branch）。
 *      ★ 關鍵：每晚把「昨天及以前」的集中度快取灌滿 → 隔天即時掃描(18:11)只需抓「今天」這一天
 *        （~500次而非整窗~5500次）→ FinMind 3-並發閘扛得住 → 不再 silent 丟掉池內合格股。
 *
 * 用法：npx tsx scripts/run-broker-bulk.ts [--days N]
 */
import { spawnSync } from 'child_process';
import path from 'path';

const root = process.cwd();
const args = process.argv.slice(2);
const daysIdx = args.indexOf('--days');
const days = daysIdx >= 0 ? args[daysIdx + 1] : '3';

function run(script: string, scriptArgs: string[]): number {
  const r = spawnSync('/usr/bin/python3', [path.join(root, 'scripts', script), ...scriptArgs], {
    cwd: root, stdio: 'inherit',
  });
  return r.status ?? 1;
}

async function main() {
  // 0) 先用「當前 L1」重建 turnover 索引 → warming 才會對到「掃描真正用的池子」。
  //    病史：索引曾被污染(OTC單位汙染把上櫃灌前面、擠掉2330)→ warming 灌錯池子→掃描silent漏。
  //    重建是 idempotent + 有 degenerate guard；掃描自己走 computeTurnoverRankAsOfDate(永遠對)，
  //    這裡只是讓 warming 對齊它。失敗不阻斷後續(沿用既有索引)。
  try {
    const { buildTurnoverRank } = await import('@/lib/scanner/TurnoverRank');
    const { TaiwanScanner } = await import('@/lib/scanner/TaiwanScanner');
    const all = await new TaiwanScanner().getStockList();
    const idx = await buildTurnoverRank('TW', all, 500);
    console.log(`[run-broker-bulk] turnover 索引重建 date=${idx.date} 前3=${idx.symbols.slice(0, 3).join(',')}`);
  } catch (e) {
    console.warn('[run-broker-bulk] 索引重建失敗(沿用既有):', e instanceof Error ? e.message : e);
  }

  // 1) 主力分點（前500）  2) 集中度快取（前500，computeConc5Map 讀的那份）
  const s1 = run('fetch_broker_bulk.py', ['--days', days, '--top500']);
  const s2 = run('populate_conc_cache_bulk.py', ['--days', days]);
  process.exit(s1 || s2);
}

main();
