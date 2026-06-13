/**
 * 每日選股漏斗 —— 單一事實（2026-06-13）
 *
 * 把「三色強候選 → 過處置veto → 進場時機 → 依漲幅排序」一次組好，
 * 給三個消費端共用：scripts/daily-pick.ts（終端）、/api/daily-pick（API）、/daily-pick（頁面）。
 *
 * 只「組合呈現」既有判定，不新增選股因子（鐵則 #5）：
 *   - 三色強弱/combo = data/tw-sanse-scan/{date}.json（三色掃描單一事實）
 *   - 進場時機/末升段 = computeEntryState（lib/agents/entryGate.ts）
 *   - 處置 veto = getActiveDisposalSet（lib/market/attentionList.ts）
 *   - 板塊熱度 = readSectorRanking（lib/themes/sectorRanking.ts）
 *
 * 排序依據（backtest-rank-edge 2026-06-13，無未來偏誤、2 年 31381 訊號）：
 *   三色訊號池「依當日漲幅取 top1」d5 排序alpha +0.80% / d20 +2.44%（六條件當排序鍵無效）。
 *   edge 集中 top1、快速衰減 → focus 只取 3 檔；勝率 42% 靠大贏家右尾 → 紀律 > 選股。
 */
import fs from 'fs';
import path from 'path';
import { getActiveDisposalSet } from '@/lib/market/attentionList';
import { readSectorRanking } from '@/lib/themes/sectorRanking';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { computeEntryState, type EntryState } from '@/lib/agents/entryGate';
import type { ResonanceRecord, SanSeScanResult } from '@/lib/cn-sanse/scan';

export interface DailyPickRow {
  code: string;
  name: string;
  industry: string;
  changePct: number;
  level: string | null;
  comboLabel: string;
  comboRank: number;
  trigger: boolean;
  sixCore: boolean;
  sixTotal: number;
  theme: string | null;
  entryState: EntryState;
  entryReason: string;
  deviationMa20: number | null;
  vetoed: boolean;
  price: number;
  signalLow: number | null;
  shortAttack: number;
}

export interface FocusPick extends DailyPickRow {
  /** 建議停損價（守訊號紅K低，夾 3-7%）*/
  stop: number;
  stopPct: number;
}

export interface DailyPickResult {
  date: string;
  exists: boolean;
  scan: { evaluated: number; strong: number; strict: number } | null;
  disposalCount: number;
  hotThemes: Array<{ theme: string; stage: string; avgD5: number | null }>;
  focus: FocusPick[];          // 依漲幅 top3（可執行）
  canEnter: DailyPickRow[];
  watch: DailyPickRow[];
  noChase: DailyPickRow[];
  vetoedStrong: DailyPickRow[];
}

const bare = (symbol: string) => symbol.split('.')[0];

/** 停損：守訊號紅K最低，夾在 3%~7%（一字漲停 low=收盤 → 下限 3% 兜底）*/
export function computeStop(price: number, signalLow: number | null): { stop: number; stopPct: number } {
  const floor7 = price * 0.93;
  const ceil3 = price * 0.97;
  const raw = signalLow ?? floor7;
  const stop = Math.max(floor7, Math.min(raw, ceil3));
  return { stop: +stop.toFixed(2), stopPct: +(((stop - price) / price) * 100).toFixed(1) };
}

export async function buildDailyPick(date: string): Promise<DailyPickResult> {
  const scanPath = path.join(process.cwd(), 'data', 'tw-sanse-scan', `${date}.json`);
  if (!fs.existsSync(scanPath)) {
    return {
      date, exists: false, scan: null, disposalCount: 0, hotThemes: [],
      focus: [], canEnter: [], watch: [], noChase: [], vetoedStrong: [],
    };
  }
  const scan: SanSeScanResult = JSON.parse(fs.readFileSync(scanPath, 'utf-8'));
  const records: ResonanceRecord[] = scan.records ?? [];

  const disposal = await getActiveDisposalSet(date);
  const sector = await readSectorRanking(date);
  const hotByCode = new Map<string, string>();
  const hotThemes: DailyPickResult['hotThemes'] = [];
  if (sector) {
    for (const t of sector.themes) {
      if (['主升段', '剛啟動', '高潮噴出'].includes(t.stage)) {
        for (const m of t.members) if (!hotByCode.has(m.code)) hotByCode.set(m.code, `${t.theme}·${t.stage}`);
      }
    }
    hotThemes.push(...sector.themes.slice(0, 5).map(t => ({ theme: t.theme, stage: t.stage, avgD5: t.avgD5 })));
  }

  const rows: DailyPickRow[] = [];
  for (const r of records) {
    const code = bare(r.symbol);
    const combo = r.report?.combo;
    const z = r.zhuSix;

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

  const strong = rows.filter(x => x.comboRank >= 4 || x.level === 'strict');
  const strongLive = strong.filter(x => !x.vetoed);
  const vetoedStrong = strong.filter(x => x.vetoed);

  // focus：依當日漲幅取 top3（backtest-rank-edge 驗證的排序鍵）
  const focus: FocusPick[] = [...strongLive]
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, 3)
    .map(x => ({ ...x, ...computeStop(x.price, x.signalLow) }));

  // 分層清單（一般模式用）— 排序：漲幅 desc（與 focus 一致，evidence-based）
  const byChg = (a: DailyPickRow, b: DailyPickRow) => b.changePct - a.changePct;
  const sorted = [...strongLive].sort(byChg);

  return {
    date, exists: true,
    scan: { evaluated: scan.evaluated ?? 0, strong: scan.resonanceCounts?.strong ?? 0, strict: scan.counts?.strict ?? 0 },
    disposalCount: disposal.size,
    hotThemes,
    focus,
    canEnter: sorted.filter(x => x.entryState === 'can_enter'),
    watch: sorted.filter(x => x.entryState === 'watch'),
    noChase: sorted.filter(x => x.entryState === 'no_chase'),
    vetoedStrong,
  };
}
