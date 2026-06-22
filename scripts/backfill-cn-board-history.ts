/**
 * 回補陸股板塊歷史（漲幅 + 主力淨流入）→ data/cn-agents/board-history.json
 *
 * 為什麼：板塊卡的 10/20 日空白，是因為我們每天存的板塊快照只回到功能上線日（2026-06-12）。
 * 板塊在東財是指數（90.BKxxxx）有完整歷史 K 線，本腳本直接抓回補，computeBoardWindows 會 merge 進去。
 *
 * 東財 push2 時段性 TLS reset/拒連 → 本腳本「自動重試」：每板塊重試 + 整輪重跑失敗者，
 * 直到成功率夠高或超時（預設 40 分鐘）。每輪寫盤一次（部分進度不丟）。背景跑、跑完看 log。
 *
 *   npx tsx scripts/backfill-cn-board-history.ts [--lmt 30] [--max-min 40]
 */
import path from 'path';
import { promises as fs } from 'fs';
import { readBoardsDay, listBoardsDates } from '@/lib/cn-agents/storage';
import { fetchBoardKline, fetchBoardFlow } from '@/lib/cn-agents/datasource/emBoardHistory';

const OUT = path.join(process.cwd(), 'data/cn-agents/board-history.json');
const arg = (k: string, d: number) => { const i = process.argv.indexOf(k); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const LMT = arg('--lmt', 30);
const MAX_MS = arg('--max-min', 40) * 60_000;
const CONCURRENCY = 6;

type Series = { date: string; pct: number; mainNet: number | null }[];
interface BoardHistFile { generatedAt: string; lmt: number; boards: Record<string, Series> }

async function loadExisting(): Promise<BoardHistFile> {
  try { return JSON.parse(await fs.readFile(OUT, 'utf8')); } catch { return { generatedAt: '', lmt: LMT, boards: {} }; }
}
async function save(f: BoardHistFile) {
  f.generatedAt = new Date().toISOString();
  await fs.writeFile(OUT, JSON.stringify(f));
}

/** 抓單板塊 K + flow，merge by date（升冪）。失敗 throw。 */
async function fetchOne(code: string): Promise<Series> {
  const [k, fl] = await Promise.all([fetchBoardKline(code, LMT), fetchBoardFlow(code, LMT)]);
  if (k.length === 0) throw new Error('empty kline');
  const flowBy = new Map(fl.map((x) => [x.date, x.mainNet]));
  return k.map((x) => ({ date: x.date, pct: x.pct, mainNet: flowBy.get(x.date) ?? null }));
}

async function mapPool<T>(items: string[], limit: number, fn: (c: string) => Promise<T>) {
  const ok: string[] = []; const fail: string[] = [];
  let cursor = 0;
  const out = new Map<string, T>();
  async function worker() {
    for (;;) {
      const i = cursor++; if (i >= items.length) return;
      const code = items[i];
      try { out.set(code, await fn(code)); ok.push(code); }
      catch { fail.push(code); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return { out, ok, fail };
}

async function main() {
  const dates = await listBoardsDates();
  if (dates.length === 0) { console.log('無板塊快照，無法取得板塊清單'); return; }
  const today = await readBoardsDay(dates[dates.length - 1]);
  if (!today) { console.log('讀不到最新板塊檔'); return; }
  const codes = [...today.concepts, ...today.industries].map((b) => b.code);
  console.log(`板塊清單 ${codes.length} 個（concepts ${today.concepts.length} + industries ${today.industries.length}）`);

  const file = await loadExisting();
  const start = Date.now();
  let pending = codes.filter((c) => !(file.boards[c]?.length)); // 已抓過的跳過（可續跑）
  let round = 0;
  while (pending.length > 0 && Date.now() - start < MAX_MS) {
    round++;
    const { out, ok, fail } = await mapPool(pending, CONCURRENCY, fetchOne);
    for (const [code, series] of out) file.boards[code] = series;
    await save(file);
    const done = codes.length - codes.filter((c) => !(file.boards[c]?.length)).length;
    console.log(`第 ${round} 輪：成功 ${ok.length} / 失敗 ${fail.length}｜累計 ${done}/${codes.length}｜${((Date.now() - start) / 1000).toFixed(0)}s`);
    pending = fail;
    if (pending.length > 0) await new Promise((r) => setTimeout(r, 15_000)); // 失敗者退避 15s 再戰
  }

  const done = codes.length - codes.filter((c) => !(file.boards[c]?.length)).length;
  console.log(`完成：${done}/${codes.length} 個板塊有歷史；${pending.length} 個仍失敗（東財擋）。寫入 ${OUT}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
