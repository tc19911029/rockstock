/**
 * Y軌（法人偷買）資料健康自動稽核 — 每日跑，發現「掃描真正用的池子」資料不齊就警告。
 *
 * 為什麼存在（2026-06-19）：法人偷買掃不出股，挖出 5 層 silent 洞 —
 *   ①broker cron 抓錯名單 ②inst 無每日排程 ③集中度逐檔抓失敗 ④集中度並發 silent drop
 *   ⑤turnover 索引污染→warming 灌錯池子。共通點＝資料看似在、其實對「掃描真正的池子」不齊，
 *   且無人警告。本稽核就是補這個：檢查掃描真正用的 computeTurnoverRankAsOfDate 池子，
 *   broker/inst/集中度三者覆蓋率 + 索引健康（2330 在前、.TWO 比例正常）。低於門檻 → webhook 警告 + exit 1。
 *
 * 用法：npx tsx scripts/audit-y-track-coverage.ts [--date YYYY-MM-DD]
 * cron：launchd com.rockstock.y-track-audit 平日 18:30（Y軌掃描 18:11 之後）。
 */
import { promises as fs } from 'fs';
import path from 'path';
import { config } from 'dotenv';

config({ path: '.env.local' }); // 讀旗標（launchd npx tsx 不自動載）

const THRESHOLD = 0.95; // 覆蓋率低於 95% → 警告
// FinMind Sponsor 失效時 = 集中度改走 broker(Yahoo 前15大)。此時不查 finmind-branch，
// 集中度覆蓋直接看 broker（同一份資料源），避免對「已改用替代來源」誤報紅燈。
const NO_FINMIND = process.env.INSTSTEAL_NO_FINMIND === '1';
const BROKER_DIR = path.join(process.cwd(), 'data/chips/TW/broker');
const INST_DIR = path.join(process.cwd(), 'data/chips/TW/inst');
const CONC_DIR = path.join(process.cwd(), 'data/chips/TW/finmind-branch');

async function hasDate(dir: string, code: string, date: string): Promise<boolean> {
  try {
    const j = JSON.parse(await fs.readFile(path.join(dir, `${code}.json`), 'utf8'));
    return (j.data || []).some((d: { date: string }) => d.date === date);
  } catch { return false; }
}
async function hasConc(code: string, date: string): Promise<boolean> {
  try {
    const j = JSON.parse(await fs.readFile(path.join(CONC_DIR, `${code}.json`), 'utf8'));
    return !!j[date] && Object.keys(j[date].net || {}).length > 0;
  } catch { return false; }
}

const CONFIRM_FLAG = path.join(process.cwd(), 'data', '.y-track-audit-confirm-once');

async function alert(text: string): Promise<void> {
  const { config } = await import('dotenv');
  config({ path: '.env.local' });
  const { sendNtfy } = await import('@/lib/notify/ntfy');
  const r = await sendNtfy({ title: '🚨 Y軌資料不齊', message: text, tags: ['rotating_light'], priority: 5 });
  console.error('ntfy 推播:', r);
  // 備用：若有設 HEALTH_ALERT_WEBHOOK_URL 也一併發
  const url = process.env.HEALTH_ALERT_WEBHOOK_URL;
  if (url) {
    try {
      await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, level: 'red', dateKey: new Date().toISOString().slice(0, 10), markets: ['TW'] }) });
    } catch { /* ignore */ }
  }
}

/** 成功時：只有「一次性確認旗標」存在才推播（消耗後刪除）→ 不每天吵。 */
async function confirmOnceIfFlagged(text: string): Promise<void> {
  try {
    await fs.access(CONFIRM_FLAG);
  } catch { return; } // 無旗標 → 安靜
  const { config } = await import('dotenv');
  config({ path: '.env.local' });
  const { sendNtfy } = await import('@/lib/notify/ntfy');
  await sendNtfy({ title: '✅ Y軌資料齊全', message: text, tags: ['white_check_mark'], priority: 3 });
  await fs.unlink(CONFIRM_FLAG).catch(() => { /* ignore */ });
}

async function main() {
  const { TaiwanScanner } = await import('@/lib/scanner/TaiwanScanner');
  const { computeTurnoverRankAsOfDate } = await import('@/lib/scanner/TurnoverRank');
  const dateArg = process.argv.includes('--date') ? process.argv[process.argv.indexOf('--date') + 1] : null;
  // 查「最後一個完整結算交易日」= 倒數第 2 個交易日。
  // 為何不查最新交易日：集中度走 bulk parquet、隔天才產出 → 查當天必假性不齊。倒數第2日三者都齊備。
  const twii = JSON.parse(await fs.readFile(path.join(process.cwd(), 'data/candles/TW/^TWII.json'), 'utf8'));
  const tdays: string[] = (twii.candles || []).map((c: { date: string }) => c.date);
  const date = dateArg ?? tdays[tdays.length - 2];

  const sc = new TaiwanScanner();
  const all = await sc.getStockList();
  const rank = await computeTurnoverRankAsOfDate('TW', all, date, 500);
  const pool = Array.from(rank.keys());
  const codes = pool.map(s => s.split('.')[0]);

  // 索引健康
  const two = pool.filter(s => s.endsWith('.TWO')).length;
  const has2330 = pool.includes('2330.TW');
  const indexBad = !has2330 || two < 80 || two > 280;

  let b = 0, i = 0, c = 0;
  for (const code of codes) {
    if (await hasDate(BROKER_DIR, code, date)) b++;
    if (await hasDate(INST_DIR, code, date)) i++;
    if (!NO_FINMIND && await hasConc(code, date)) c++;
  }
  const n = codes.length;
  const bPct = b / n, iPct = i / n, cPct = c / n;
  // NO_FINMIND：集中度走 broker（前15大淨額÷量），覆蓋率＝broker 覆蓋率
  const concPct = NO_FINMIND ? bPct : cPct;
  const concLabel = NO_FINMIND ? '集中度(走broker)' : '集中度';

  console.log(`Y軌池子覆蓋率 @${date}（即時前${n}）：`);
  console.log(`  主力分點 ${b}/${n} (${(bPct * 100).toFixed(0)}%)`);
  console.log(`  法人     ${i}/${n} (${(iPct * 100).toFixed(0)}%)`);
  console.log(`  ${concLabel}   ${NO_FINMIND ? b : c}/${n} (${(concPct * 100).toFixed(0)}%)`);
  console.log(`  索引健康：2330在前500=${has2330}，.TWO=${two}（正常80~280）`);

  const problems: string[] = [];
  if (indexBad) problems.push(`turnover索引異常(2330在前=${has2330}, .TWO=${two})`);
  if (bPct < THRESHOLD) problems.push(`主力分點覆蓋 ${(bPct * 100).toFixed(0)}%`);
  if (iPct < THRESHOLD) problems.push(`法人覆蓋 ${(iPct * 100).toFixed(0)}%`);
  if (concPct < THRESHOLD) problems.push(`${concLabel}覆蓋 ${(concPct * 100).toFixed(0)}%`);

  if (problems.length) {
    const text = `🚨 Y軌資料不齊 @${date}：${problems.join('；')} — 法人偷買掃描會 silent 漏股。修：npx tsx scripts/backfill-inst-top500.ts + node scripts/run-broker-bulk.ts`;
    console.error('\n' + text);
    await alert(text);
    process.exit(1);
  }
  const okText = `Y軌資料齊全 @${date}：主力分點/法人/${concLabel} 各 ${(bPct * 100).toFixed(0)}/${(iPct * 100).toFixed(0)}/${(concPct * 100).toFixed(0)}%，索引健康（2330在前、.TWO ${two}）。即時掃描池子完整覆蓋。`;
  console.log('\n✅ ' + okText);
  await confirmOnceIfFlagged(okText);
}
main().catch(e => { console.error(e); process.exit(1); });
