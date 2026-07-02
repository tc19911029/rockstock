/**
 * 情緒週期當「擇時」訊號驗證 — 現有 cycle.stage 能不能預測「大盤之後漲跌」。
 *
 * 對每個交易日取 cycle.stage（data/cn-agents/breadth/{date}.json）+ 上證(000001.SS)的
 * 前瞻 d5/d20 報酬（close-to-close），按階段聚合，train(舊60%)/test(新40%) 分半。
 * 若冰點/修復 >> 高潮/退潮 → 情緒週期是有效擇時（這才是這套系統的真 edge）。
 * 每日一觀測（無偽複製問題）。
 *
 * 用法：npx tsx scripts/research-cn-timing.ts
 */
import fs from 'fs';
import path from 'path';

const BDIR = path.join(process.cwd(), 'data', 'cn-agents', 'breadth');
const IDX = path.join(process.cwd(), 'data', 'candles', 'CN', '000001.SS.json');
const STAGE_CN: Record<string, string> = { frozen: '冰點', repair: '修復', launch: '啟動', main_rise: '主升', climax: '高潮', divergence: '分歧', retreat: '退潮', crash: '殺跌' };

const idx = JSON.parse(fs.readFileSync(IDX, 'utf8')).candles as Array<{ date: string; close: number }>;
const idxClose = idx.map((c) => c.close);
const idxAt = new Map(idx.map((c, i) => [c.date, i]));
const fwd = (date: string, n: number): number | null => {
  const i = idxAt.get(date); if (i == null) return null; const j = i + n; if (j >= idxClose.length) return null;
  return +(((idxClose[j] - idxClose[i]) / idxClose[i]) * 100).toFixed(2);
};

const days: Array<{ date: string; stage: string; d5: number | null; d20: number | null }> = [];
for (const f of fs.readdirSync(BDIR).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x))) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(BDIR, f), 'utf8'));
    const stage = j.cycle?.stage; const date = j.date; if (!stage || !date) continue;
    days.push({ date, stage, d5: fwd(date, 5), d20: fwd(date, 20) });
  } catch { /* skip */ }
}
days.sort((a, b) => (a.date < b.date ? -1 : 1));
const cut = days[Math.floor(days.length * 0.6)]?.date ?? '2025-09-01';

const med = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const avg = (a: number[]) => (a.length ? a.reduce((x, v) => x + v, 0) / a.length : null);
const pct = (v: number | null) => (v == null ? ' — ' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);
const win = (a: number[]) => (a.length ? Math.round(a.filter((v) => v > 0).length / a.length * 100) : 0);

console.log(`交易日 ${days.length}、範圍 ${days[0]?.date}~${days[days.length - 1]?.date}、cut=${cut}\n`);
console.log('情緒階段 → 上證前瞻報酬（每日一觀測；冰點/修復應 > 高潮/退潮）');
const order = ['frozen', 'repair', 'launch', 'main_rise', 'divergence', 'climax', 'retreat', 'crash'];
for (const st of order) {
  const all = days.filter((d) => d.stage === st);
  if (!all.length) continue;
  const sub = (test: boolean) => all.filter((d) => (d.date >= cut) === test);
  const cell = (rows: typeof days, k: 'd5' | 'd20') => rows.map((r) => r[k]).filter((v): v is number => v != null);
  const tr = sub(false), te = sub(true);
  console.log(`【${STAGE_CN[st] ?? st}】n=${all.length}`);
  console.log(`   d20  train 中${pct(med(cell(tr, 'd20')))}/勝${win(cell(tr, 'd20'))}%  test 中${pct(med(cell(te, 'd20')))}/勝${win(cell(te, 'd20'))}%  全期均${pct(avg(cell(all, 'd20')))}`);
}
// 全市場基準
const base = days.map((d) => d.d20).filter((v): v is number => v != null);
console.log(`\n【全期上證 d20 基準】中${pct(med(base))}/均${pct(avg(base))}/勝${win(base)}%`);
