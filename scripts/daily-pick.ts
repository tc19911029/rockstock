/**
 * 每日選股漏斗（終端版）—— 邏輯單一事實在 lib/dailyPick/buildDailyPick.ts，
 * 本腳本只負責終端格式化。頁面 /daily-pick 與 /api/daily-pick 用同一份 lib。
 *
 * 用法：
 *   npx tsx scripts/daily-pick.ts [YYYY-MM-DD]   # 一般模式（分層清單）
 *   npx tsx scripts/daily-pick.ts --focus        # 精簡：依漲幅 top3 + 進場/停損/持有
 *   npx tsx scripts/daily-pick.ts --json         # 機器可讀
 */
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { buildDailyPick, type DailyPickRow } from '@/lib/dailyPick/buildDailyPick';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const focusMode = args.includes('--focus');
const dateArg = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
const date = dateArg ?? getLastTradingDay('TW');

function fmt(x: DailyPickRow): string {
  const six = x.sixCore ? `核心✓${x.sixTotal}/6` : `${x.sixTotal}/6`;
  const dev = x.deviationMa20 != null ? `乖離${(x.deviationMa20 * 100).toFixed(0)}%` : '';
  const th = x.theme ?? '';
  return `  ${x.code} ${x.name.padEnd(6)} ${x.industry.slice(0, 6).padEnd(6)} ${x.changePct >= 0 ? '+' : ''}${x.changePct.toFixed(1)}%  `
    + `${x.comboLabel.padEnd(10)} 六條件${six.padEnd(9)} ${dev.padEnd(8)} ${th}`;
}

async function main(): Promise<void> {
  const r = await buildDailyPick(date);
  if (asJson) { console.log(JSON.stringify(r, null, 2)); return; }
  if (!r.exists) {
    console.error(`❌ 找不到三色掃描檔 ${date}（盤後 tw-sanse cron 未跑？）`);
    process.exit(1);
  }

  // ── 精簡模式（回測依據版，只吐可執行的 1-3 檔）──
  if (focusMode) {
    console.log(`\n════ daily-pick 精簡（${date}）｜依漲幅取 top3（回測 top1 排序alpha +0.8% d5 / +2.4% d20）════`);
    if (!r.focus.length) { console.log('  今日無三色強候選（過 veto 後）。'); return; }
    r.focus.forEach((x, i) => {
      const tag = x.entryState === 'no_chase' ? '⚡末升段·高動能高波動' : x.entryState === 'can_enter' ? '低乖離·穩' : '時機中性';
      const th = x.theme ? `｜${x.theme}` : '';
      console.log(`\n  #${i + 1} ${x.code} ${x.name}（${x.industry.slice(0, 6)}）　漲 ${x.changePct >= 0 ? '+' : ''}${x.changePct.toFixed(1)}%　${x.comboLabel}${th}`);
      console.log(`     收盤 ${x.price}　${tag}　六條件 ${x.sixCore ? '核心✓' : ''}${x.sixTotal}/6`);
      console.log(`     進場：明日 13:25 掛市價（≈ 今收 ${x.price}）`);
      console.log(`     停損：${x.stop}（守訊號紅K低，夾 3-7%，距現 ${x.stopPct}%）— 跌破收盤就砍`);
      console.log(`     持有：~20 交易日讓動能走完；中途跌破停損或大量長黑先出`);
    });
    console.log(`\n  ⚠️ 勝率約 4 成、靠大贏家：3 檔分批、嚴守停損，賠的小賺的大才有那 +0.8% edge。`);
    console.log(`  ⚠️ edge 集中 top1，取超過 3 檔等於沒排序；扣交易成本後淨 edge 薄，紀律 > 選股。`);
    return;
  }

  // ── 一般模式（分層清單）──
  console.log(`\n════════ 每日選股漏斗　${date}（最新交易日）════════`);
  console.log(`三色掃描 ${r.scan?.evaluated} 檔 → 強共振 ${r.scan?.strong} / 嚴格級 ${r.scan?.strict}`);
  console.log(`處置中 ${r.disposalCount} 檔（已從候選剔除）`);

  if (r.hotThemes.length) {
    console.log(`\n── 資金最強板塊（5日排序）──`);
    for (const t of r.hotThemes) {
      const d5 = t.avgD5 != null ? `${t.avgD5 >= 0 ? '+' : ''}${t.avgD5.toFixed(1)}%` : '—';
      console.log(`  ${t.theme.padEnd(8)} [${t.stage}] 5日 ${d5}`);
    }
  }

  console.log(`\n🟢 低乖離·時機乾淨（can_enter，波動小但回測報酬偏弱）：${r.canEnter.length} 檔`);
  if (r.canEnter.length) r.canEnter.forEach(x => console.log(fmt(x)));
  else console.log('  （無）');

  console.log(`\n🟡 觀察（三色強·時機中性）：${r.watch.length} 檔`);
  r.watch.slice(0, 10).forEach(x => console.log(fmt(x)));

  console.log(`\n🔴 末升段·高動能（no_chase，回測報酬最高但波動最大 — 強勢續強，非「不可買」）：${r.noChase.length} 檔`);
  r.noChase.slice(0, 8).forEach(x => console.log(`${fmt(x)}　← ${x.entryReason}`));

  if (r.vetoedStrong.length) {
    console.log(`\n⛔ 被處置 veto 刷掉：${r.vetoedStrong.length} 檔`);
    r.vetoedStrong.slice(0, 8).forEach(x => console.log(`  ${x.code} ${x.name}（${x.industry.slice(0, 6)}）— 處置中分盤交易不可追`));
  }

  console.log(`\n提醒：可進場清單 13:20 看、13:25 掛市價；守進場紅K最低 5-7% 停損。`);
  console.log(`三色評級高 ≠ 最該買；勝率~4成靠大贏家，紀律(抱~20天讓贏家跑/砍輸家) > 選股。\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
