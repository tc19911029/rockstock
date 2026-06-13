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

    // 進場時機（末升段）— 讀 L1 算 computeEntryState
    let entryState: EntryState = 'watch';
    let entryReason = '';
    let deviationMa20: number | null = null;
    const file = (await readCandleFile(r.symbol, 'TW'))
      ?? (await readCandleFile(`${code}.TWO`, 'TW'))
      ?? (await readCandleFile(`${code}.TW`, 'TW'));
    if (file?.candles?.length) {
      const res = computeEntryState({ symbol: r.symbol, candles: file.candles });
      entryState = res.state;
      entryReason = res.reasons[0] ?? '';
      deviationMa20 = res.metrics.deviationMa20;
    }

    rows.push({
      code, name: r.name, industry: r.industry, changePct: r.changePct,
      level: r.report?.level ?? null,
      comboLabel: combo?.label ?? '—', comboRank: combo?.rank ?? 0, trigger: combo?.trigger ?? false,
      sixCore: z?.core ?? false, sixTotal: z?.total ?? 0,
      theme: hotByCode.get(code) ?? null,
      entryState, entryReason, deviationMa20,
      vetoed: disposal.has(code),
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

  console.log(`\n🟢 可進場（三色強 + 過veto + 時機 can_enter）：${canEnter.length} 檔`);
  if (canEnter.length) canEnter.forEach(x => console.log(fmt(x)));
  else console.log('  （無）—— 強候選的時機都還沒到，今天沒有乾淨的當下買點');

  console.log(`\n🟡 觀察（三色強但時機未到，等回測不破/翻 can_enter）：${watch.length} 檔`);
  watch.slice(0, 10).forEach(x => console.log(fmt(x)));

  console.log(`\n🔴 已漲多·不可追（末升段，看不追）：${noChase.length} 檔`);
  noChase.slice(0, 8).forEach(x => console.log(`${fmt(x)}　← ${x.entryReason}`));

  if (vetoedStrong.length) {
    console.log(`\n⛔ 被處置 veto 刷掉（本來會進候選）：${vetoedStrong.length} 檔`);
    vetoedStrong.slice(0, 8).forEach(x => console.log(`  ${x.code} ${x.name}（${x.industry.slice(0, 6)}）— 三色${x.level ?? x.comboLabel} 但處置中分盤交易不可追`));
  }

  console.log(`\n提醒：可進場清單 13:20 看、13:25 掛市價；守進場紅K最低 5-7% 停損。`);
  console.log(`三色評級高 ≠ 最該買 —— 乖離 >15% 的強股是末升段，等洗過再翻紅。\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
