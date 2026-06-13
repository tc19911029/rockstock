/**
 * 每日選股漏斗（2026-06-13）—— 把「大盤→板塊→三色強候選→過處置veto→∩六條件→進場時機」
 * 一次跑完，輸出可進場 / 觀察 / 被veto三層清單，省去在多個 tab 之間手動對照。
 *
 * 設計紅線（不重造輪子 / 不違鐵則）：
 *   - 三色強弱、combo 評級 = 直接讀 data/tw-sanse-scan/{date}.json 的 records（三色掃描單一事實）
 *   - 末升段 / 進場時機 = computeEntryState（lib/agents/entryGate.ts 單一事實，書本 no_chase 規則）
 *   - 處置 veto = getActiveDisposalSet（lib/market/attentionList.ts 單一事實）
 *   - 板塊熱度 = readSectorRanking（lib/themes/sectorRanking.ts）
 *   本腳本只「組合呈現」既有判定，不新增任何選股因子（鐵則 #5）。
 *
 * 回測依據（為何這樣排）：
 *   - 台股 unified leaderboard：三色系統獨佔前五（三組齊發⭐/點火 > 多因子相加）
 *   - 六條件∩三色：六條件當篩子（core）+ 三色紅觸發 d5 +0.31% 優於各自單獨
 *   - 末升段（乖離>15%+連長紅+暴量）= 最後一棒，no_chase 擋掉
 *
 * 用法：
 *   npx tsx scripts/daily-pick.ts [YYYY-MM-DD]   # 預設最近交易日
 *   npx tsx scripts/daily-pick.ts --json         # 機器可讀
 */
import fs from 'fs';
import path from 'path';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { getActiveDisposalSet } from '@/lib/market/attentionList';
import { readSectorRanking } from '@/lib/themes/sectorRanking';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { computeEntryState, entryStateLabel, type EntryState } from '@/lib/agents/entryGate';
import type { ResonanceRecord, SanSeScanResult } from '@/lib/cn-sanse/scan';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const focusMode = args.includes('--focus');   // 精簡：只吐 top1-3 + 持有/停損（回測依據版）
const dateArg = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
const date = dateArg ?? getLastTradingDay('TW');

function bare(symbol: string): string {
  return symbol.split('.')[0];
}

interface FunnelRow {
  code: string;
  name: string;
  industry: string;
  changePct: number;
  level: string | null;       // strict / medium / loose / null
  comboLabel: string;
  comboRank: number;
  trigger: boolean;
  sixCore: boolean;
  sixTotal: number;
  theme: string | null;       // 最熱所屬題材·階段
  entryState: EntryState;
  entryReason: string;
  deviationMa20: number | null;
  vetoed: boolean;
  price: number;              // 掃描日收盤（進場參考）
  signalLow: number | null;   // 掃描日(訊號紅K)最低 → 停損參考
  shortAttack: number;        // 三色短攻強度（回測驗證的排序鍵之一）
}

async function main(): Promise<void> {
  // ── 三色掃描（強弱 + combo + 六條件單一來源）──
  const scanPath = path.join(process.cwd(), 'data', 'tw-sanse-scan', `${date}.json`);
  if (!fs.existsSync(scanPath)) {
    console.error(`❌ 找不到三色掃描檔：${scanPath}（該日盤後 tw-sanse cron 未跑？）`);
    process.exit(1);
  }
  const scan: SanSeScanResult = JSON.parse(fs.readFileSync(scanPath, 'utf-8'));
  const records: ResonanceRecord[] = scan.records ?? [];

  // ── 處置 veto + 板塊熱度 ──
  const disposal = await getActiveDisposalSet(date);
  const sector = await readSectorRanking(date);
  const hotByCode = new Map<string, string>();
  const hotThemes: Array<{ theme: string; stage: string; avgD5: number | null }> = [];
  if (sector) {
    for (const t of sector.themes) {
      if (['主升段', '剛啟動', '高潮噴出'].includes(t.stage)) {
        for (const m of t.members) {
          if (!hotByCode.has(m.code)) hotByCode.set(m.code, `${t.theme}·${t.stage}`);
        }
      }
    }
    hotThemes.push(...sector.themes.slice(0, 5).map(t => ({ theme: t.theme, stage: t.stage, avgD5: t.avgD5 })));
  }

  // ── 逐檔組合 ──
  const rows: FunnelRow[] = [];
  for (const r of records) {
    const code = bare(r.symbol);
    const combo = r.report?.combo;
    const z = r.zhuSix;

    // 進場時機（末升段）— 讀 L1 算 computeEntryState；順便取訊號日(紅K)最低做停損
    let entryState: EntryState = 'watch';
    let entryReason = '';
    let deviationMa20: number | null = null;
    let signalLow: number | null = null;
    const file = (await readCandleFile(r.symbol, 'TW'))
      ?? (await readCandleFile(`${code}.TWO`, 'TW'))
      ?? (await readCandleFile(`${code}.TW`, 'TW'));
    if (file?.candles?.length) {
      const res = computeEntryState({ symbol: r.symbol, candles: file.candles });
      entryState = res.state;
      entryReason = res.reasons[0] ?? '';
      deviationMa20 = res.metrics.deviationMa20;
      const bar = file.candles.find(c => c.date === date) ?? file.candles[file.candles.length - 1];
      signalLow = bar?.low ?? null;
    }

    rows.push({
      code, name: r.name, industry: r.industry, changePct: r.changePct,
      level: r.report?.level ?? null,
      comboLabel: combo?.label ?? '—', comboRank: combo?.rank ?? 0, trigger: combo?.trigger ?? false,
      sixCore: z?.core ?? false, sixTotal: z?.total ?? 0,
      theme: hotByCode.get(code) ?? null,
      entryState, entryReason, deviationMa20,
      vetoed: disposal.has(code),
      price: r.price, signalLow, shortAttack: r.report?.scores?.shortAttack ?? 0,
    });
  }

  // ── 漏斗分層 ──
  // 強候選 = combo rank ≥ prime(4) 或三色嚴格級
  const strong = rows.filter(x => (x.comboRank >= 4 || x.level === 'strict'));
  const strongLive = strong.filter(x => !x.vetoed);
  const vetoedStrong = strong.filter(x => x.vetoed);

  // 排序：六條件核心優先 → combo rank → 漲幅
  const rank = (x: FunnelRow) => [x.sixCore ? 1 : 0, x.comboRank, x.changePct] as const;
  strongLive.sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    return rb[0] - ra[0] || rb[1] - ra[1] || rb[2] - ra[2];
  });

  // 三層動作清單
  const canEnter = strongLive.filter(x => x.entryState === 'can_enter');
  const watch = strongLive.filter(x => x.entryState === 'watch');
  const noChase = strongLive.filter(x => x.entryState === 'no_chase');

  if (asJson) {
    console.log(JSON.stringify({ date, hotThemes, canEnter, watch, noChase, vetoedStrong }, null, 2));
    return;
  }

  // ── 精簡模式（--focus）：回測依據版，只吐可執行的 1-3 檔 ──
  // backtest-rank-edge 證實：三色訊號池「依漲幅排序取 top1」d5 排序alpha +0.80%、
  // d20 +2.44%（六條件當排序鍵無效 +0.03%）。edge 集中在 top1、快速衰減，故只取 3 檔。
  // 勝率 42% < 基準 → 靠大贏家右尾，紀律(抱~20天讓贏家跑、跌破停損砍)決定生死。
  if (focusMode) {
    const byChg = [...strongLive].sort((a, b) => b.changePct - a.changePct).slice(0, 3);
    console.log(`\n════ daily-pick 精簡（${date}）｜依漲幅取 top3（回測 top1 排序alpha +0.8% d5 / +2.4% d20）════`);
    if (!byChg.length) { console.log('  今日無三色強候選（過 veto 後）。'); return; }
    byChg.forEach((x, i) => {
      // 停損：守訊號紅K最低，夾在 3%~7% 區間（書本 5-7%；一字漲停 low=收盤會算出 0% → 下限 3% 兜底）
      const floor7 = x.price * 0.93;  // 風險上限 7%
      const ceil3 = x.price * 0.97;   // 最小停損空間 3%
      const raw = x.signalLow ?? floor7;
      const stop = Math.max(floor7, Math.min(raw, ceil3));
      const stopPct = ((stop - x.price) / x.price) * 100;
      const tag = x.entryState === 'no_chase' ? '⚡末升段·高動能高波動' : x.entryState === 'can_enter' ? '低乖離·穩' : '時機中性';
      const th = x.theme ? `｜${x.theme}` : '';
      console.log(`\n  #${i + 1} ${x.code} ${x.name}（${x.industry.slice(0, 6)}）　漲 ${x.changePct >= 0 ? '+' : ''}${x.changePct.toFixed(1)}%　${x.comboLabel}${th}`);
      console.log(`     收盤 ${x.price}　${tag}　六條件 ${x.sixCore ? '核心✓' : ''}${x.sixTotal}/6`);
      console.log(`     進場：明日 13:25 掛市價（≈ 今收 ${x.price}）`);
      console.log(`     停損：${stop.toFixed(2)}（守訊號紅K低/-7%，距現 ${stopPct.toFixed(1)}%）— 跌破收盤就砍`);
      console.log(`     持有：~20 交易日讓動能走完；中途跌破停損或大量長黑先出`);
    });
    console.log(`\n  ⚠️ 勝率約 4 成、靠大贏家：3 檔分批、嚴守停損，賠的小賺的大才有那 +0.8% edge。`);
    console.log(`  ⚠️ edge 集中 top1，取超過 3 檔等於沒排序；扣交易成本後淨 edge 薄，紀律 > 選股。`);
    return;
  }

  // ── 報表 ──
  const fmt = (x: FunnelRow) => {
    const six = x.sixCore ? `核心✓${x.sixTotal}/6` : `${x.sixTotal}/6`;
    const dev = x.deviationMa20 != null ? `乖離${(x.deviationMa20 * 100).toFixed(0)}%` : '';
    const th = x.theme ?? '';
    return `  ${x.code} ${x.name.padEnd(6)} ${x.industry.slice(0, 6).padEnd(6)} ${x.changePct >= 0 ? '+' : ''}${x.changePct.toFixed(1)}%  `
      + `${x.comboLabel.padEnd(10)} 六條件${six.padEnd(9)} ${dev.padEnd(8)} ${th}`;
  };

  console.log(`\n════════ 每日選股漏斗　${date}（最新交易日）════════`);
  console.log(`三色掃描 ${scan.evaluated} 檔 → 強共振 ${scan.resonanceCounts?.strong ?? '?'} / 嚴格級 ${scan.counts?.strict ?? '?'}`);
  console.log(`處置中 ${disposal.size} 檔（已從候選剔除）`);

  if (hotThemes.length) {
    console.log(`\n── 資金最強板塊（5日排序）──`);
    for (const t of hotThemes) {
      const d5 = t.avgD5 != null ? `${t.avgD5 >= 0 ? '+' : ''}${t.avgD5.toFixed(1)}%` : '—';
      console.log(`  ${t.theme.padEnd(8)} [${t.stage}] 5日 ${d5}`);
    }
  }

  // ⚠️ 2026-06-13 回測修正（backtest-daily-pick）：在六條件∩三色 context 下，
  // 末升段(no_chase)股前瞻報酬反而最高(d5 +1.65% vs can_enter −0.63%)、動能持續，
  // 只是波動最大。所以下面不再把 can_enter 當「最該買」、no_chase 當「避開」——
  // 改成中性陳述（低乖離=穩但弱 / 末升段=強但險），由你按風險偏好挑。
  console.log(`\n🟢 低乖離·時機乾淨（can_enter，波動小但回測報酬偏弱）：${canEnter.length} 檔`);
  if (canEnter.length) canEnter.forEach(x => console.log(fmt(x)));
  else console.log('  （無）');

  console.log(`\n🟡 觀察（三色強·時機中性）：${watch.length} 檔`);
  watch.slice(0, 10).forEach(x => console.log(fmt(x)));

  console.log(`\n🔴 末升段·高動能（no_chase，回測前瞻報酬最高但波動/回檔最大 — 強勢續強，非「不可買」）：${noChase.length} 檔`);
  noChase.slice(0, 8).forEach(x => console.log(`${fmt(x)}　← ${x.entryReason}`));

  if (vetoedStrong.length) {
    console.log(`\n⛔ 被處置 veto 刷掉（本來會進候選）：${vetoedStrong.length} 檔`);
    vetoedStrong.slice(0, 8).forEach(x => console.log(`  ${x.code} ${x.name}（${x.industry.slice(0, 6)}）— 三色${x.level ?? x.comboLabel} 但處置中分盤交易不可追`));
  }

  console.log(`\n提醒：可進場清單 13:20 看、13:25 掛市價；守進場紅K最低 5-7% 停損。`);
  console.log(`三色評級高 ≠ 最該買 —— 乖離 >15% 的強股是末升段，等洗過再翻紅。\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
