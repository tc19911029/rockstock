/**
 * 來源歸因回測（2026-06-12，B7 提案）— 量「哪個資訊來源點名的股票真的有前瞻報酬」。
 *
 * 來源（全部讀現成歷史檔，不重掃）：
 *   youtube_bullish   — data/youtube/analysis/{d}.json high_consensus_stocks（sentiment=bullish）
 *   youtube_rating_AB — 同上 stock_scoring rating ∈ {A,B}
 *   broker_bullish    — data/broker/reports/{d}.json stocks（sentiment=bullish/positive 或 rating_action=upgrade）
 *   broker_mention    — 同上全部具名提及（含 mentioned_only）
 *   pool_src_*        — data/agents/pool/TW/{d}.json candidates 按 source 出席歸因
 *   pool_3plus        — 池子 sourceCount ≥3 高共識
 *
 * 量測：與生產排行榜同一把尺 metricsFromLocalCandles（隔日開盤進場）d1/d5/d20，
 * 並對 ^TWII 同窗報酬算超額。樣本天數有限（pool 自 05-18、youtube 自 05-2x），
 * 結論當方向參考，別當統計定論 — 報告內強制印 n。
 *
 * 用法：npx tsx scripts/backtest-source-attribution.ts
 * 輸出：data/backtest-output/source-attribution-{today}.md + console 摘要
 *
 * 注意：純研究腳本。不改選股規則（技術面才是進場依據，鐵則不動）—
 * 這份報告只決定「早上先看哪個 tab」。
 */
import fs from 'fs';
import path from 'path';
import { metricsFromLocalCandles, type RawCandle } from '@/lib/backtest/unifiedLeaderboard';

const ROOT = path.join(process.cwd(), 'data');
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());

// ── K 線載入（cache） ─────────────────────────────────────────────────────────
const candleCache = new Map<string, RawCandle[] | null>();
function loadCandles(symbol: string): RawCandle[] | null {
  if (candleCache.has(symbol)) return candleCache.get(symbol)!;
  let out: RawCandle[] | null = null;
  for (const cand of [symbol, symbol.replace(/\.TW$/, '.TWO')]) {
    const f = path.join(ROOT, 'candles', 'TW', `${cand}.json`);
    if (fs.existsSync(f)) {
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        out = (Array.isArray(j) ? j : j.candles) as RawCandle[];
        break;
      } catch { /* 壞檔跳過 */ }
    }
  }
  candleCache.set(symbol, out);
  return out;
}

interface Pick { date: string; symbol: string }
interface Stat { n: number; d1: number[]; d5: number[]; d20: number[]; e1: number[]; e5: number[]; e20: number[] }

const sources = new Map<string, Pick[]>();
function addPick(source: string, date: string, code: string | null | undefined, suffix = '.TW') {
  if (!code || !/^\d{4,6}[A-Z]?$/.test(code)) return;
  const arr = sources.get(source) ?? [];
  arr.push({ date, symbol: code.includes('.') ? code : `${code}${suffix}` });
  sources.set(source, arr);
}

// ── 1. YouTube ────────────────────────────────────────────────────────────────
const ytDir = path.join(ROOT, 'youtube', 'analysis');
for (const f of fs.existsSync(ytDir) ? fs.readdirSync(ytDir) : []) {
  const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
  if (!m) continue;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ytDir, f), 'utf8'));
    const seen = new Set<string>();
    for (const s of j.high_consensus_stocks ?? []) {
      const code = s.matched?.code;
      if (s.sentiment === 'bullish' && code && !seen.has(code)) {
        seen.add(code);
        addPick('youtube_bullish', m[1], code);
      }
    }
    for (const sc of j.stock_scoring ?? []) {
      if (sc.rating === 'A' || sc.rating === 'B') addPick('youtube_rating_AB', m[1], sc.stock_code);
    }
  } catch { /* skip 壞檔 */ }
}

// ── 2. 法人報告 ─────────────────────────────────────────────────────────────
const brDir = path.join(ROOT, 'broker', 'reports');
for (const f of fs.existsSync(brDir) ? fs.readdirSync(brDir) : []) {
  const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
  if (!m) continue;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(brDir, f), 'utf8'));
    const seen = new Set<string>();
    for (const r of j.reports ?? []) {
      for (const s of r.stocks ?? []) {
        const code = s.matched?.code;
        if (!code || s.market !== 'TW' || seen.has(code)) continue;
        seen.add(code);
        addPick('broker_mention', m[1], code);
        const bullish = s.sentiment === 'bullish' || s.sentiment === 'positive' ||
          s.rating_action === 'upgrade' || /買進|增持|優於大盤|Buy/i.test(s.rating ?? s.rating_raw ?? '');
        if (bullish) addPick('broker_bullish', m[1], code);
      }
    }
  } catch { /* skip */ }
}

// ── 3. 候選池（per-source 出席歸因 + 高共識）────────────────────────────────
const poolDir = path.join(ROOT, 'agents', 'pool', 'TW');
for (const f of fs.existsSync(poolDir) ? fs.readdirSync(poolDir) : []) {
  const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
  if (!m) continue;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(poolDir, f), 'utf8'));
    for (const c of j.candidates ?? []) {
      const code = (c.symbol ?? '').replace(/\.(TW|TWO)$/, '');
      const srcs = c.sources ?? {};
      const present = Object.keys(srcs).filter(k => srcs[k] != null);
      for (const k of present) addPick(`pool_src_${k}`, m[1], code);
      if (present.length >= 3) addPick('pool_3plus', m[1], code);
    }
  } catch { /* skip */ }
}

// ── 量測 ─────────────────────────────────────────────────────────────────────
const index = loadCandles('^TWII');
const idxDateMap = new Map<string, number>();
(index ?? []).forEach((c, i) => idxDateMap.set(c.date, i));

function indexMetric(date: string): { d1: number | null; d5: number | null; d20: number | null } | null {
  if (!index) return null;
  const i = idxDateMap.get(date);
  if (i == null) return null;
  const r = metricsFromLocalCandles(index, i);
  return r ? { d1: r.m.d1, d5: r.m.d5, d20: r.m.d20 } : null;
}

const stats = new Map<string, Stat>();
for (const [src, picks] of sources) {
  const st: Stat = { n: 0, d1: [], d5: [], d20: [], e1: [], e5: [], e20: [] };
  for (const p of picks) {
    const candles = loadCandles(p.symbol);
    if (!candles) continue;
    const i = candles.findIndex(c => c.date === p.date);
    if (i < 0) continue;
    const r = metricsFromLocalCandles(candles, i);
    if (!r) continue;
    st.n++;
    const bm = indexMetric(p.date);
    for (const [h, eh] of [['d1', 'e1'], ['d5', 'e5'], ['d20', 'e20']] as const) {
      const v = r.m[h];
      if (v != null) {
        st[h].push(v);
        const b = bm?.[h];
        if (b != null) st[eh].push(v - b);
      }
    }
  }
  stats.set(src, st);
}

const avg = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const win = (a: number[]) => a.length ? a.filter(x => x > 0).length / a.length * 100 : null;
const fmt = (x: number | null, suffix = '%') => x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}${suffix}`;

const lines: string[] = [];
lines.push(`# 來源歸因回測 — ${today}`);
lines.push('');
lines.push('進場基準=點名日的隔日開盤（與生產排行榜同尺）；超額=同窗 ^TWII 報酬差。');
lines.push('⚠ 歷史檔起點：pool 2026-05-18、youtube 2026-05 下旬、broker 2026-06 — **樣本少，方向參考**。');
lines.push('');
lines.push('| 來源 | n | d1 | d5 | d20 | d5勝率 | d5超額 | d20超額 |');
lines.push('|---|---|---|---|---|---|---|---|');
const order = [...stats.entries()].sort((a, b) => (avg(b[1].e5) ?? -99) - (avg(a[1].e5) ?? -99));
for (const [src, st] of order) {
  lines.push(`| ${src} | ${st.n} | ${fmt(avg(st.d1))} | ${fmt(avg(st.d5))} | ${fmt(avg(st.d20))} | ${fmt(win(st.d5), '%')} | ${fmt(avg(st.e5))} | ${fmt(avg(st.e20))} |`);
}
lines.push('');
lines.push('解讀：d5 超額為正且 n 夠大的來源值得每天優先看；負超額來源當娛樂。');
lines.push('本報告不改任何選股規則（技術面才是進場依據）。');

const outDir = path.join(ROOT, 'backtest-output');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `source-attribution-${today}.md`);
fs.writeFileSync(outPath, lines.join('\n'));
console.log(lines.join('\n'));
console.log(`\n已寫入 ${outPath}`);
