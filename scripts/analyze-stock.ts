/**
 * 單檔股票完整分析 — 4 面向 + EntryGate + Risk + Decision
 *
 * 用法:
 *   npx tsx scripts/analyze-stock.ts 6770
 *   npx tsx scripts/analyze-stock.ts 6770 --date 2026-05-26
 *
 * 14 條 audit 規則程式化(見 memory/feedback_stock_analysis_audit.md):
 *   A1 type 註解單位 / A2 FinMind 欄位不望文生義 / A3 L2 用 lastSeenCumVol
 *   A4 yahoo 1m 漏記秒級 / B1 import 既有 entryGate / B2 不重新發明六條件
 *   C1 L2 today 納入 / C2 重讀 L1 / C3 對照玩股網
 *   D1 既有 API / D2 scanner verdict / D3 套既有規則
 *   E1 財報全 type 穿透 / E2 TDCC 多層 / F1 transcript 逐字 / F2 進場 vs 出場
 *
 * 不打 Anthropic SDK,純資料 fetch + 計算。
 */
import fs from 'fs';
import path from 'path';
import { computeEntryState, entryStateLabel } from '@/lib/agents/entryGate';
import type { Candle } from '@/types';

const REPO = process.cwd();
const FINMIND_API = 'https://api.finmindtrade.com/api/v4/data';
const LOCAL_API = 'http://localhost:3000';

function loadFinmindToken(): string {
  const envPath = path.join(REPO, '.env.local');
  if (!fs.existsSync(envPath)) return '';
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const m = line.match(/^FINMIND_API_TOKEN\s*=\s*(.+)$/);
    if (m) return m[1].replace(/['"]/g, '').trim();
  }
  return '';
}

function todayTaipei(): string {
  const now = new Date();
  const tz = new Date(now.getTime() + 8 * 3600 * 1000);
  return tz.toISOString().slice(0, 10);
}

function loadStockName(symbol: string): string {
  const p = path.join(REPO, 'data/youtube/stock-master.json');
  if (!fs.existsSync(p)) return symbol;
  const d = JSON.parse(fs.readFileSync(p, 'utf-8')) as { entries: Array<{ code: string; name: string }> };
  return d.entries.find(e => e.code === symbol)?.name ?? symbol;
}

type Market = 'TW' | 'CN';

// 從 symbol 推斷市場:純 4 位數字 = TW;6 位或含 .SS/.SZ = CN
function detectMarket(symbol: string): { market: Market; pureCode: string; suffix: string } {
  if (/^\d{6}$|\.(SS|SZ)$/i.test(symbol)) {
    const pureCode = symbol.replace(/\.(SS|SZ)$/i, '');
    // 6 開頭 = 上交所 .SS、其他 = 深交所 .SZ(粗略)
    const suffix = pureCode.startsWith('6') ? 'SS' : 'SZ';
    return { market: 'CN', pureCode, suffix };
  }
  return { market: 'TW', pureCode: symbol.replace(/\.TW$/, ''), suffix: 'TW' };
}

// 粗略 sentiment:keyword count(正/負/中性詞彙)
const BULLISH_WORDS = ['漲停', '亮燈', '買超', '便宜', '加碼', '強', '買進', '進場', '創新高', '突破'];
const BEARISH_WORDS = ['弱', '差', '賣', '批評', '降評', '套', '冷漠', '跌停', '殺', '泡沫', '崩'];
function sentimentScore(text: string): { bullish: number; bearish: number; net: number } {
  let bullish = 0, bearish = 0;
  for (const w of BULLISH_WORDS) bullish += (text.match(new RegExp(w, 'g')) ?? []).length;
  for (const w of BEARISH_WORDS) bearish += (text.match(new RegExp(w, 'g')) ?? []).length;
  return { bullish, bearish, net: bullish - bearish };
}

const sma = (arr: number[], end: number, n: number): number | null =>
  end < n - 1 ? null : arr.slice(end - n + 1, end + 1).reduce((s, x) => s + x, 0) / n;

// ─────────────────────────────────────────────────────────────
// Fetchers
// ─────────────────────────────────────────────────────────────

interface L1File { lastDate: string; candles: Candle[]; }
function readL1(pureCode: string, market: Market, suffix: string): { l1: L1File; actualSuffix: string } {
  // TW 先試 .TW,找不到 fallback .TWO(上櫃);CN 用傳入 suffix
  const candidates = market === 'TW' ? ['TW', 'TWO'] : [suffix];
  for (const s of candidates) {
    const p = path.join(REPO, `data/candles/${market}/${pureCode}.${s}.json`);
    if (fs.existsSync(p)) {
      return { l1: JSON.parse(fs.readFileSync(p, 'utf-8')), actualSuffix: s };
    }
  }
  throw new Error(`L1 not found: tried ${candidates.map(s => `${pureCode}.${s}.json`).join(', ')} under data/candles/${market}/`);
}

interface L2Today { cumVol: number; high: number; low: number; close: number; firstOpen: number; barCount: number; }
function readL2(pureCode: string, date: string, suffix: string): L2Today | null {
  const p = path.join(REPO, `data/realtime/${date}/${pureCode}.${suffix}.json`);
  if (!fs.existsSync(p)) return null;
  const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
  const bars = d.bars as Array<{ open: number; high: number; low: number; close: number; volume: number }>;
  if (!bars?.length) return null;
  return {
    cumVol: d.lastSeenCumVol ?? 0,  // A3: 用 root.lastSeenCumVol 不 sum bars
    high: Math.max(...bars.map(b => b.high)),  // A4 caveat: 可能漏記秒級
    low: Math.min(...bars.filter(b => b.low > 0).map(b => b.low)),
    close: bars[bars.length - 1].close,
    firstOpen: bars[0].open,
    barCount: bars.length,
  };
}

async function tryFetchJSON<T = unknown>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch { return null; }
}

interface ChipResp {
  chipScore?: number; chipGrade?: string; chipSignal?: string; chipDetail?: string;
  foreignBuy?: number; trustBuy?: number; dealerBuy?: number; totalInstitutional?: number;
  largeHolderPct?: number; largeHolderChange?: number;
  holder100Pct?: number; holder200Pct?: number; holder400Pct?: number;
  holder400To600Pct?: number; holder600To800Pct?: number; holder800To1000Pct?: number;
  structureBuilding?: boolean;
  trustNetBuy30d?: number; trustNetBuy60d?: number; trustNetBuy90d?: number;
  trustMomentumStage?: string;
}

interface FundamentalsResp {
  ok?: boolean;
  data?: {
    eps?: number; epsYoY?: number; grossMargin?: number; netMargin?: number;
    per?: number; pbr?: number; dividendYield?: number;
    revenueLatest?: number; revenueMoM?: number; revenueYoY?: number;
  };
}

async function fetchScannerVerdict(date: string, pureCode: string, market: Market): Promise<{ inPool: boolean; resultCount: number; marketTrend: string; sessionFile?: string }> {
  const files = fs.readdirSync(path.join(REPO, 'data'))
    .filter(f => f.startsWith(`scan-${market}-long-daily-${date}-`))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(REPO, 'data', f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) return { inPool: false, resultCount: 0, marketTrend: 'unknown' };
  const latest = files[0].name;
  const d = JSON.parse(fs.readFileSync(path.join(REPO, 'data', latest), 'utf-8'));
  const inPool = d.results?.some((r: { symbol: string }) => r.symbol.startsWith(pureCode)) ?? false;
  return { inPool, resultCount: d.resultCount ?? d.results?.length ?? 0, marketTrend: d.marketTrend ?? '?', sessionFile: latest };
}

// CN 籌碼:直接讀 flow file(無 API)
interface CnFlowDay { date: string; mainNet: number; superLargeNet: number; largeNet: number; mediumNet: number; smallNet: number; }
function readCnFlow(pureCode: string): { lastDate: string; data: CnFlowDay[] } | null {
  const p = path.join(REPO, `data/chips/CN/flow/${pureCode}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

// E1: 穿透 FinMind 全 type 自算本業營業利益
interface FinmindFinancial {
  Revenue?: number; GrossProfit?: number; OperatingExpenses?: number;
  OperatingIncome?: number; NetIncome?: number; PreTaxIncome?: number;
  EPS?: number; OTHNOE?: number; Equity?: number;
}
async function fetchFinmindFinancials(token: string, code: string, date: string): Promise<Record<string, FinmindFinancial>> {
  const start = `${parseInt(date.slice(0, 4)) - 2}-01-01`;
  const url = `${FINMIND_API}?dataset=TaiwanStockFinancialStatements&data_id=${code}&start_date=${start}&end_date=${date}&token=${encodeURIComponent(token)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const j = await r.json() as { data?: Array<{ date: string; type: string; value: number }> };
  const byDate: Record<string, FinmindFinancial> = {};
  for (const row of j.data ?? []) {
    if (!byDate[row.date]) byDate[row.date] = {};
    (byDate[row.date] as Record<string, number>)[row.type] = row.value;
  }
  return byDate;
}

function computeRealOperatingIncome(q: FinmindFinancial): {
  realOpIncome: number | null; gpMinusOpEx: number | null; reportedOpIncome: number | null;
  nonOpItem: number | null; epsBackedByNonOp: boolean;
} {
  const gp = q.GrossProfit ?? null;
  const opex = q.OperatingExpenses ?? null;
  const real = gp != null && opex != null ? gp - opex : null;
  const reported = q.OperatingIncome ?? null;
  // E1: 若 reported >> gp - opex,代表業外被塞進來
  const epsBackedByNonOp = real != null && reported != null && Math.abs(reported - real) > Math.max(Math.abs(real), 1) * 0.5;
  return {
    realOpIncome: real,
    gpMinusOpEx: real,
    reportedOpIncome: reported,
    nonOpItem: q.OTHNOE ?? null,
    epsBackedByNonOp,
  };
}

// A2: 自算 YoY/MoM,不直接讀 FinMind 的 revenue_year/revenue_month 欄位
async function fetchRevenueSeries(token: string, code: string, date: string): Promise<Array<{ date: string; rev: number; yoy: number | null; mom: number | null }>> {
  const start = `${parseInt(date.slice(0, 4)) - 2}-01-01`;
  const url = `${FINMIND_API}?dataset=TaiwanStockMonthRevenue&data_id=${code}&start_date=${start}&end_date=${date}&token=${encodeURIComponent(token)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const j = await r.json() as { data?: Array<{ date: string; revenue: number }> };
  const rows = (j.data ?? []).sort((a, b) => a.date.localeCompare(b.date));
  return rows.map((r, i) => {
    const rev = r.revenue / 1_000_000;  // 元 → 百萬
    const prev = i > 0 ? rows[i - 1].revenue / 1_000_000 : null;
    const mom = prev ? ((rev - prev) / prev) * 100 : null;
    const [y, m] = r.date.split('-');
    const lyDate = `${parseInt(y) - 1}-${m}-01`;
    const ly = rows.find(x => x.date === lyDate);
    const yoy = ly ? ((rev - ly.revenue / 1_000_000) / (ly.revenue / 1_000_000)) * 100 : null;
    return { date: r.date, rev, yoy, mom };
  });
}

// F1: grep YouTube transcripts(過去 N 天)
function grepYouTubeMentions(symbol: string, name: string, daysBack = 7): Array<{ file: string; lines: string[] }> {
  const root = path.join(REPO, 'data/youtube/transcripts');
  if (!fs.existsSync(root)) return [];
  const days = fs.readdirSync(root)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort((a, b) => b.localeCompare(a))
    .slice(0, daysBack);
  const out: Array<{ file: string; lines: string[] }> = [];
  for (const day of days) {
    const dayDir = path.join(root, day);
    if (!fs.statSync(dayDir).isDirectory()) continue;
    for (const f of fs.readdirSync(dayDir)) {
      const full = path.join(dayDir, f);
      try {
        const t = JSON.parse(fs.readFileSync(full, 'utf-8'));
        const text = t.text || (t.cues ?? []).map((c: { text?: string }) => c.text ?? '').join(' ');
        if (!text) continue;
        const re = new RegExp(`[\\s\\S]{0,80}(${symbol}|${name})[\\s\\S]{0,150}`, 'g');
        const matches = [...text.matchAll(re)].map(m => m[0].replace(/\s+/g, ' ').trim()).slice(0, 3);
        if (matches.length) out.push({ file: `${day}/${f.replace('.json', '')}`, lines: matches });
      } catch { /* ignore */ }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const symbol = args[0];
  if (!symbol) {
    console.error('Usage: npx tsx scripts/analyze-stock.ts <symbol> [--date YYYY-MM-DD]');
    process.exit(1);
  }
  const dateIdx = args.indexOf('--date');
  const date = dateIdx >= 0 ? args[dateIdx + 1] : todayTaipei();

  let { market, pureCode, suffix } = detectMarket(symbol);
  const name = market === 'TW' ? loadStockName(pureCode) : pureCode;  // CN 無 stock-master
  console.log(`\n========================================`);
  console.log(`${pureCode} ${name} [${market}] 一鍵分析 → date=${date}`);
  console.log(`========================================\n`);

  // ── 1. L1 重讀 (C2)
  const { l1, actualSuffix } = readL1(pureCode, market, suffix);
  suffix = actualSuffix;  // 用實際找到的後綴(TW 可能 fallback 成 TWO)
  const candles = l1.candles;
  const N = candles.length;
  const last = N - 1;
  console.log(`【L1】lastDate=${l1.lastDate} N=${N} last bar=${candles[last].date} close=${candles[last].close}`);

  // ── 2. MA + 乖離 (B2: 用標準 SMA;書本既有判定可在後續加 import)
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const todayClose = closes[last];

  const ma = {
    ma5: sma(closes, last, 5)!,
    ma10: sma(closes, last, 10)!,
    ma20: sma(closes, last, 20)!,
    ma60: sma(closes, last, 60)!,
  };
  const deviation = {
    ma5: ((todayClose - ma.ma5) / ma.ma5) * 100,
    ma10: ((todayClose - ma.ma10) / ma.ma10) * 100,
    ma20: ((todayClose - ma.ma20) / ma.ma20) * 100,
    ma60: ((todayClose - ma.ma60) / ma.ma60) * 100,
  };
  const maGap5_10 = Math.abs((ma.ma5 - ma.ma10) / ma.ma10) * 100;  // G1
  const maTrend = ma.ma5 > ma.ma10 && ma.ma10 > ma.ma20 && ma.ma20 > ma.ma60
    ? '多頭排列'
    : maGap5_10 < 1
      ? '糾結(MA5 與 MA10 差 <1%)'
      : ma.ma5 < ma.ma10 && ma.ma10 < ma.ma20
        ? '空頭排列'
        : '混合';

  // ── 3. KD-9 (B1: Lane stochastic 2/3:1/3 遞推)
  let K = 50, D = 50;
  for (let i = 8; i < N; i++) {
    const hh = Math.max(...highs.slice(i - 8, i + 1));
    const ll = Math.min(...lows.slice(i - 8, i + 1));
    const rsv = hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100;
    K = (2 / 3) * K + (1 / 3) * rsv;
    D = (2 / 3) * D + (1 / 3) * K;
  }
  const kd = { K, D };

  // ── 4. 量比
  const avgVol5 = sma(volumes, last - 1, 5)!;
  const avgVol20 = sma(volumes, last - 1, 20)!;
  const volRatio5 = volumes[last] / avgVol5;
  const volRatio20 = volumes[last] / avgVol20;

  // ── 5. EntryGate (B1: import 既有 lib)
  const gate = computeEntryState({ symbol: `${symbol}.TW`, candles });

  console.log(`\n【技術面】`);
  console.log(`  收 ${todayClose} / O ${candles[last].open} / H ${candles[last].high} / L ${candles[last].low} / V ${volumes[last]} 張`);
  console.log(`  MA5=${ma.ma5.toFixed(2)} MA10=${ma.ma10.toFixed(2)} MA20=${ma.ma20.toFixed(2)} MA60=${ma.ma60.toFixed(2)}  → ${maTrend}`);
  console.log(`  距 MA5 ${deviation.ma5.toFixed(2)}% / 月線乖離 ${deviation.ma20.toFixed(2)}% / 季線乖離 ${deviation.ma60.toFixed(2)}%`);
  console.log(`  KD-9: K=${kd.K.toFixed(2)} D=${kd.D.toFixed(2)} ${kd.K > kd.D ? '(K>D 黃金交叉)' : '(K<D 死亡交叉)'} ${kd.K > 80 ? '⚠️ 超買' : kd.K < 20 ? '⚠️ 超賣' : ''}`);
  console.log(`  量比: 前 5 日均 ${volRatio5.toFixed(2)}x / 前 20 日均 ${volRatio20.toFixed(2)}x`);
  console.log(`  EntryGate: ${entryStateLabel(gate.state)} (${gate.state})`);
  console.log(`    reasons: ${gate.reasons.join(' / ')}`);

  // ── 6. L2 today (C1: 即時)
  const l2 = readL2(pureCode, date, suffix);
  console.log(`\n【L2 today=${date}】`);
  if (l2) {
    console.log(`  bars=${l2.barCount} cumVol=${l2.cumVol} 張 / O ${l2.firstOpen} H ${l2.high} L ${l2.low} C ${l2.close}`);
    if (l2.close !== todayClose) {
      console.log(`  ⚠️ L2 last close (${l2.close}) ≠ L1 today close (${todayClose}),取其一(L1 為準若 L1 已含當日)`);
    }
  } else {
    console.log(`  (無 L2 資料,可能非交易日或當日尚未生成)`);
  }

  // ── 7. Chip (D1) — TW 走 /api/chip,CN 直接讀 flow file
  let chip: ChipResp | null = null;
  if (market === 'TW') {
    console.log(`\n【籌碼面 /api/chip】`);
    chip = await tryFetchJSON<ChipResp>(`${LOCAL_API}/api/chip?symbol=${pureCode}&market=TW`);
  } else {
    console.log(`\n【籌碼面 — CN flow data(無 chip API)】`);
    const flow = readCnFlow(pureCode);
    if (flow && flow.data.length) {
      const recent = flow.data.slice(-5);
      console.log(`  近 5 日主力資金流(單位:股)`);
      for (const f of recent) {
        const tag = f.mainNet > 0 ? '🟢' : '🔴';
        console.log(`    ${tag} ${f.date}  主力 ${(f.mainNet/10000).toFixed(0)}萬  超大單 ${(f.superLargeNet/10000).toFixed(0)}萬  大單 ${(f.largeNet/10000).toFixed(0)}萬  中單 ${(f.mediumNet/10000).toFixed(0)}萬  小單 ${(f.smallNet/10000).toFixed(0)}萬`);
      }
      const latest = flow.data[flow.data.length - 1];
      console.log(`  最新主力動向: ${latest.mainNet > 0 ? '進場 ✓' : '出場 ✗'}(mainNet=${latest.mainNet}股)`);
    } else {
      console.log(`  ⚠️ 無 CN flow 資料 (data/chips/CN/flow/${pureCode}.json 不存在)`);
    }
  }
  if (chip) {
    console.log(`  chipScore: ${chip.chipScore} (${chip.chipGrade} 級) — ${chip.chipSignal}`);
    console.log(`  ${chip.chipDetail}`);
    console.log(`  外資 ${chip.foreignBuy} / 投信 ${chip.trustBuy} / 自營 ${chip.dealerBuy} 張`);
    console.log(`  投信動向: 30d=${chip.trustNetBuy30d} 60d=${chip.trustNetBuy60d} 90d=${chip.trustNetBuy90d} stage=${chip.trustMomentumStage}`);
    // E2: TDCC 多層
    console.log(`  大戶分層: 100+ ${chip.holder100Pct ?? 'n/a'}% / 200+ ${chip.holder200Pct ?? 'n/a'}% / 400+ ${chip.holder400Pct}% / 1000+ ${chip.largeHolderPct}% (週變 ${chip.largeHolderChange != null ? (chip.largeHolderChange > 0 ? '+' : '') + chip.largeHolderChange + 'pp' : 'n/a'})`);
    console.log(`  細分: 400-600 ${chip.holder400To600Pct ?? 'n/a'}% / 600-800 ${chip.holder600To800Pct ?? 'n/a'}% / 800-1000 ${chip.holder800To1000Pct ?? 'n/a'}%`);
    console.log(`  structureBuilding: ${chip.structureBuilding}`);
  } else {
    console.log(`  ⚠️ /api/chip 無回應,dev server 可能未啟動`);
  }

  // ── 8. Fundamentals API + FinMind 全 type 穿透 (D1 + E1) — 僅 TW
  console.log(`\n【基本面】`);
  if (market === 'CN') {
    console.log(`  ⚠️ rockstock 未整合陸股基本面源(FinMind 僅台股)`);
    console.log(`  → 手動查雪球 https://xueqiu.com/S/SH${pureCode} 或東方財富 https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/Index?type=web&code=SH${pureCode}`);
  }
  const fundBase = market === 'TW' ? await tryFetchJSON<FundamentalsResp>(`${LOCAL_API}/api/fundamentals/${pureCode}`) : null;
  if (fundBase?.ok && fundBase.data) {
    const f = fundBase.data;
    console.log(`  EPS=${f.eps} / 月營收=${f.revenueLatest ? (f.revenueLatest / 1_000_000).toFixed(0) : '?'}M`);
    console.log(`  月營收 MoM=${f.revenueMoM?.toFixed(2)}% / YoY=${f.revenueYoY?.toFixed(2)}%`);
    console.log(`  毛利率=${f.grossMargin?.toFixed(2)}% / 淨利率=${f.netMargin?.toFixed(2)}% (⚠️ 淨利率 >100% 代表業外撐起)`);
    console.log(`  PER=${f.per} PBR=${f.pbr} 殖利率=${f.dividendYield}%`);
    // D3: 強成長 PER 放寬
    const revYoY = f.revenueYoY ?? 0;
    const strongGrowth = revYoY > 30;
    const perThreshold = strongGrowth ? 80 : 50;
    if (f.per && f.per > 0) {
      const perBucket = f.per <= 10 ? '便宜' : f.per <= 20 ? '合理偏低' : f.per <= 30 ? '合理' : f.per <= perThreshold ? `偏高${strongGrowth ? '(強成長放寬)' : ''}` : '昂貴';
      console.log(`  PER 評級: ${perBucket} (門檻 ${perThreshold},strongGrowth=${strongGrowth})`);
    }
  }
  // E1: FinMind 全 type 穿透,自算本業營業利益(僅 TW)
  const token = market === 'TW' ? loadFinmindToken() : '';
  if (token) {
    const finRaw = await fetchFinmindFinancials(token, symbol, date);
    const quarters = Object.keys(finRaw).sort();
    const latestQ = quarters[quarters.length - 1];
    if (latestQ) {
      const real = computeRealOperatingIncome(finRaw[latestQ]);
      console.log(`\n  【最新季 ${latestQ} 穿透】`);
      console.log(`    Revenue=${(finRaw[latestQ].Revenue! / 1e8).toFixed(2)} 億`);
      console.log(`    GrossProfit=${(finRaw[latestQ].GrossProfit! / 1e8).toFixed(2)} 億`);
      console.log(`    OperatingExpenses=${(finRaw[latestQ].OperatingExpenses! / 1e8).toFixed(2)} 億`);
      console.log(`    真本業營業利益 (GP - OpEx) = ${real.gpMinusOpEx != null ? (real.gpMinusOpEx / 1e8).toFixed(2) + ' 億' : 'n/a'}`);
      console.log(`    FinMind reported OperatingIncome = ${real.reportedOpIncome != null ? (real.reportedOpIncome / 1e8).toFixed(2) + ' 億' : 'n/a'}`);
      console.log(`    OTHNOE (其他項業外) = ${real.nonOpItem != null ? (real.nonOpItem / 1e8).toFixed(2) + ' 億' : 'n/a'}`);
      if (real.epsBackedByNonOp) {
        console.log(`    ⚠️ EPS 主要由業外撐起,本業 ${real.gpMinusOpEx! < 0 ? '虧損' : '利潤遠小於 reported'} — 成長動能未經本業驗證`);
      }
    }
    // 月營收 13 個月
    const revSeries = await fetchRevenueSeries(token, pureCode, date);
    console.log(`\n  【月營收近 6 個月】`);
    for (const r of revSeries.slice(-6)) {
      console.log(`    ${r.date}  ${r.rev.toFixed(0)}M  MoM=${r.mom != null ? (r.mom > 0 ? '+' : '') + r.mom.toFixed(2) + '%' : 'n/a'}  YoY=${r.yoy != null ? (r.yoy > 0 ? '+' : '') + r.yoy.toFixed(2) + '%' : 'n/a'}`);
    }
  } else {
    console.log(`  ⚠️ FINMIND_API_TOKEN 未設定,跳過全 type 穿透`);
  }

  // ── 9. Scanner verdict (D2)
  console.log(`\n【Scanner ${date} daily session (${market})】`);
  const sv = await fetchScannerVerdict(date, pureCode, market);
  console.log(`  session: ${sv.sessionFile ?? '(none)'}`);
  console.log(`  resultCount=${sv.resultCount} marketTrend=${sv.marketTrend} ${pureCode} inPool=${sv.inPool ? '✓' : '✗ (掃描器擋下)'}`);

  // ── 10. YouTube transcripts (F1) — 僅 TW(台股節目不討論陸股)
  if (market === 'CN') {
    console.log(`\n【消息面 — 跳過】CN 不適用台股 YouTube transcripts`);
    console.log(`  → 手動查新浪財經 / 東方財富 / 雪球評論`);
  }
  console.log(`\n【消息面 — YouTube 多 transcript 過去 7 天】(name="${name}")`);
  const mentions = market === 'TW' ? grepYouTubeMentions(pureCode, name, 7) : [];
  console.log(`  找到 ${mentions.length} 支 transcript 提到`);
  let totalBullish = 0, totalBearish = 0;
  for (const m of mentions.slice(0, 10)) {
    const text = m.lines.join(' ');
    const sent = sentimentScore(text);
    totalBullish += sent.bullish;
    totalBearish += sent.bearish;
    const tag = sent.net > 1 ? '🟢' : sent.net < -1 ? '🔴' : '⚪';
    console.log(`  ${tag} ${m.file}  (bull=${sent.bullish} bear=${sent.bearish})`);
    for (const line of m.lines) console.log(`    ${line.slice(0, 200)}`);
  }
  const newsNet = totalBullish - totalBearish;
  console.log(`\n  消息面 sentiment 合計: 正面詞 ${totalBullish} / 負面詞 ${totalBearish} / net=${newsNet}`);

  // ── 10b. 軋空壓力分析（lib/squeeze）─────────────────────────
  console.log(`\n【軋空壓力分析 lib/squeeze】`);
  try {
    const { analyzeSqueeze } = await import('@/lib/squeeze/analyzeSqueeze');
    const sq = await analyzeSqueeze(symbol, date);
    const c = sq.shortCosts.combined;
    console.log(`  資料完整度: margin=${sq.dataCompleteness.marginDays}d / sbl=${sq.dataCompleteness.sblDays}d / price=${sq.dataCompleteness.priceDays}d`);
    console.log(`  收盤 ${sq.close.toFixed(2)} / 融券餘額 ${sq.shortBalance.toLocaleString()} 張 (Δ5d ${sq.shortBalanceChange5d >= 0 ? '+' : ''}${sq.shortBalanceChange5d}) / 借券 ${sq.lendingBalance.toLocaleString()} 張 (Δ5d ${sq.lendingBalanceChange5d >= 0 ? '+' : ''}${sq.lendingBalanceChange5d})`);
    const fmt = (v: number | null) => v === null ? '—' : v.toFixed(2);
    console.log(`  綜合空方成本: 5d=${fmt(c.d5)} / 10d=${fmt(c.d10)} / 20d=${fmt(c.d20)} / 60d=${fmt(c.d60)}`);
    console.log(`  融券成本:     5d=${fmt(sq.shortCosts.margin.d5)} / 10d=${fmt(sq.shortCosts.margin.d10)} / 20d=${fmt(sq.shortCosts.margin.d20)} / 60d=${fmt(sq.shortCosts.margin.d60)}`);
    console.log(`  借券成本:     5d=${fmt(sq.shortCosts.sbl.d5)} / 10d=${fmt(sq.shortCosts.sbl.d10)} / 20d=${fmt(sq.shortCosts.sbl.d20)} / 60d=${fmt(sq.shortCosts.sbl.d60)}`);
    console.log(`  追繳壓力價: ${fmt(sq.marginCallPrice)} (距當前 ${sq.distanceToMarginCallPct !== null ? (sq.distanceToMarginCallPct >= 0 ? '+' : '') + sq.distanceToMarginCallPct.toFixed(1) + '%' : '—'})`);
    console.log(`  分數 ${sq.score.total}/100 (${sq.score.levelLabel}) — 空累${sq.score.shortAccumulation} 不破底${sq.score.priceFloorRising} 站上成本${sq.score.aboveShortCost} 回補壓力${sq.score.marginCallPressure} 量價突破${sq.score.breakoutVolume}`);
    console.log(`  解讀:`);
    for (const line of sq.interpretation.split('\n')) console.log(`    ${line}`);
  } catch (err) {
    console.log(`  ⚠️ 軋空分析失敗: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── 11. 4 verdict 整合
  console.log(`\n═══════════════════════════════════════`);
  console.log(`【最終整合 — 不加權平均、規則式】`);
  console.log(`═══════════════════════════════════════`);

  // Technical
  const techVerdict = gate.state === 'no_chase' ? 'fail' : gate.state === 'can_enter' ? 'pass' : 'watch';

  // Chip
  const chipVerdict = (chip?.chipScore ?? 0) >= 70 ? 'pass' : (chip?.chipScore ?? 0) >= 50 ? 'watch' : 'fail';

  // Fundamental: 本業虧損 → watch,即使 YoY 好;否則看 revYoY
  let fundVerdict: 'pass' | 'watch' | 'fail' = 'watch';
  let fundReason = '';
  if (token) {
    const finRaw = await fetchFinmindFinancials(token, pureCode, date);
    const quarters = Object.keys(finRaw).sort();
    const latestQ = quarters[quarters.length - 1];
    if (latestQ) {
      const real = computeRealOperatingIncome(finRaw[latestQ]);
      const revYoY = fundBase?.data?.revenueYoY ?? 0;
      if (real.gpMinusOpEx != null && real.gpMinusOpEx < 0) {
        fundVerdict = 'watch';
        fundReason = `本業虧 ${(real.gpMinusOpEx / 1e8).toFixed(1)} 億,EPS 業外撐(成長未經本業驗證)`;
      } else if (revYoY > 10 && (fundBase?.data?.eps ?? 0) > 0) {
        fundVerdict = 'pass';
        fundReason = `revYoY +${revYoY.toFixed(1)}% + 本業正`;
      } else if (revYoY < 0) {
        fundVerdict = 'fail';
        fundReason = `revYoY ${revYoY.toFixed(1)}% 衰退`;
      } else {
        fundReason = `revYoY ${revYoY.toFixed(1)}%,本業 ${real.gpMinusOpEx != null ? (real.gpMinusOpEx / 1e8).toFixed(1) + ' 億' : 'n/a'}`;
      }
    }
  } else if (market === 'CN') {
    fundReason = '(陸股未整合源,手動查雪球/東方財富)';
  } else {
    fundReason = '(無 FinMind token,無法穿透)';
  }

  // News: mention 數 + sentiment net
  let newsVerdict: 'pass' | 'watch' | 'fail' = 'watch';
  let newsReason = '';
  if (mentions.length === 0) {
    newsVerdict = 'fail';
    newsReason = '近 7 日無提及';
  } else if (mentions.length >= 5 && newsNet >= 3) {
    newsVerdict = 'pass';
    newsReason = `${mentions.length} 支提及 + 正面 ${newsNet}`;
  } else if (newsNet <= -3) {
    newsVerdict = 'fail';
    newsReason = `${mentions.length} 支提及但負面 ${newsNet}`;
  } else {
    newsReason = `${mentions.length} 支提及 net=${newsNet}(中性/混合)`;
  }

  // Risk
  const riskVerdict = gate.state === 'no_chase' || !sv.inPool ? 'red' : gate.state === 'watch' ? 'yellow' : 'green';

  console.log(`\n  Technical:   ${techVerdict}  (EntryGate=${gate.state})`);
  console.log(`  Chip:        ${chipVerdict}  (chipScore=${chip?.chipScore ?? '?'})`);
  console.log(`  Fundamental: ${fundVerdict}  (${fundReason})`);
  console.log(`  News:        ${newsVerdict}  (${newsReason})`);
  console.log(`  Risk:        ${riskVerdict}  (no_chase=${gate.state === 'no_chase'}, scannerInPool=${sv.inPool})`);

  let action: 'buy' | 'watch' | 'skip' = 'watch';
  let decisionPath = 'default_watch';
  if (techVerdict === 'fail') { action = 'skip'; decisionPath = 'technical_fail'; }
  else if (riskVerdict === 'red') { action = 'skip'; decisionPath = 'risk_red'; }
  else if (techVerdict === 'pass' && riskVerdict === 'green') { action = 'buy'; decisionPath = 'buy_signal'; }
  else if (techVerdict === 'pass' && riskVerdict === 'yellow') { action = 'watch'; decisionPath = 'risk_yellow_watch'; }
  else if (techVerdict === 'watch') { action = 'watch'; decisionPath = 'technical_watch'; }

  console.log(`\n  → Decision: ${action.toUpperCase()} (decisionPath=${decisionPath})`);

  // ── 12. C3: 對照玩股網
  console.log(`\n【⚠️ Sanity check】請對照玩股網確認:`);
  console.log(`  https://www.wantgoo.com/stock/${symbol}/technical-chart`);
  console.log(`  比對 MA5/10/20/60、K9/D9、量、收盤 — 差 > 0.1 表示有 bug`);
  console.log(``);
}

main().catch(e => { console.error(e); process.exit(1); });
