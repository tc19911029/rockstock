/**
 * 動態清理 cn_stocklist.json 已下市股（2026-06-12，QA 提案 #1；取代四月的人工清單版）。
 *
 * 為什麼要 v2：四月版是 16 檔寫死清單，且 generate-cn-stocklist.ts 重生成會把殭屍代碼
 * 加回來（EastMoney clist 還掛著停牌殘價）。v2 動態偵測 + 寫 data/cn-delisted-removed.json
 * 留痕，生成器已改為讀此檔排除 → 重生成不復活。
 *
 * 判定（兩條同時成立才移除，保守）：
 *   1. L1 lastDate 落後今日 > 90 日曆日（長期無新 bar；無 L1 檔的不動）
 *   2. Tencent 即時報價判死（名稱空 / 無昨收與現價 / v_pv_none）→ 下市非短停
 *
 * 用法：npx tsx scripts/prune-cn-delisted-v2.ts [--dry]
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import path from 'path';

const DRY = process.argv.includes('--dry');
const ROOT = process.cwd();
const LIST = path.join(ROOT, 'data', 'cn_stocklist.json');
const REMOVED = path.join(ROOT, 'data', 'cn-delisted-removed.json');
const CUTOFF_DAYS = 90;

interface Stock { symbol: string; name: string; industry?: string }

function lastDateOf(symbol: string): string | null {
  const f = path.join(ROOT, 'data', 'candles', 'CN', `${symbol}.json`);
  if (!existsSync(f)) return null;
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    return j.lastDate ?? (j.candles?.length ? j.candles[j.candles.length - 1].date : null);
  } catch { return null; }
}

/** 騰訊最後報價日：qt.gtimg.cn 欄位 30 = YYYYMMDDHHMMSS。
 *  下市股殘檔仍會回昨收（連「太安退」都有），不能用價格判死 — 要看報價新鮮度。 */
async function tencentLastQuoteDate(symbol: string): Promise<string | null> {
  const code = symbol.replace(/\.(SS|SZ)$/, '');
  const pfx = symbol.endsWith('.SS') ? 'sh' : 'sz';
  try {
    const res = await fetch(`http://qt.gtimg.cn/q=${pfx}${code}`, { signal: AbortSignal.timeout(8000) });
    const text = Buffer.from(await res.arrayBuffer()).toString('latin1');
    if (text.includes('v_pv_none') || !text.includes('~')) return null;
    const fields = text.split('~');
    if (!(fields[1] ?? '').trim()) return null;
    const ts = (fields[30] ?? '').trim(); // YYYYMMDDHHMMSS 或 YYYY-MM-DD...
    const m = ts.match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  } catch {
    return 'ERR'; // 網路錯誤不可判死
  }
}

/** 騰訊 ifzq 日K最後一根日期（下市股 kline 為空或停在下市日，最權威的死活判定） */
async function tencentLastKlineDate(symbol: string): Promise<string | null> {
  const code = symbol.replace(/\.(SS|SZ)$/, '');
  const pfx = symbol.endsWith('.SS') ? 'sh' : 'sz';
  try {
    const res = await fetch(
      `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get?param=${pfx}${code},day,,,5,qfq`,
      { signal: AbortSignal.timeout(10000) },
    );
    const j = await res.json() as { data?: Record<string, { qfqday?: unknown[][]; day?: unknown[][] }> };
    const node = j.data?.[`${pfx}${code}`];
    const k = (node?.qfqday ?? node?.day ?? []) as Array<[string, ...unknown[]]>;
    if (!k.length) return null;
    return String(k[k.length - 1][0]);
  } catch {
    return 'ERR';
  }
}

async function main() {
  const raw = JSON.parse(readFileSync(LIST, 'utf8')) as { updatedAt: string; stocks: Stock[] };
  const today = new Date();
  const cutoff = new Date(today.getTime() - CUTOFF_DAYS * 86400_000).toISOString().slice(0, 10);
  // 候選 = 名稱帶「退」/ 無 L1 檔（每天 download 失敗的慢性戶）/ L1 lastDate 落後 > 90 天
  const candidates = raw.stocks.filter(s => {
    if (s.name.includes('退')) return true;
    const ld = lastDateOf(s.symbol);
    return ld === null || ld < cutoff;
  });
  console.log(`stocklist ${raw.stocks.length} 檔；候選 ${candidates.length} 檔（帶退字/無L1/lastDate<${cutoff}），對 Tencent 報價時間戳驗證中...`);

  const QUOTE_DEAD_CUTOFF = new Date(today.getTime() - 30 * 86400_000).toISOString().slice(0, 10);
  const removed: Array<Stock & { lastDate: string | null; removedAt: string; reason: string }> = [];
  const dataGaps: string[] = [];
  for (const s of candidates) {
    const ld = lastDateOf(s.symbol);
    if (s.name.includes('退')) {
      removed.push({ ...s, lastDate: ld, removedAt: today.toISOString().slice(0, 10), reason: '名稱帶退字' });
      continue;
    }
    const qd = await tencentLastQuoteDate(s.symbol);
    await new Promise(r => setTimeout(r, 120));
    if (qd === 'ERR') { dataGaps.push(`${s.symbol} ${s.name} (網路錯誤,保留)`); continue; }
    if (qd === null || qd < QUOTE_DEAD_CUTOFF) {
      removed.push({ ...s, lastDate: ld, removedAt: today.toISOString().slice(0, 10), reason: `騰訊末筆報價 ${qd ?? '無'}` });
      continue;
    }
    // 報價時間戳對遠古下市股不可靠（齊魯石化也顯示今日）→ 第二段：日K 最後一根日期才權威
    const kd = await tencentLastKlineDate(s.symbol);
    await new Promise(r => setTimeout(r, 150));
    if (kd === 'ERR') { dataGaps.push(`${s.symbol} ${s.name} (kline 網路錯誤,保留)`); continue; }
    if (kd === null || kd < QUOTE_DEAD_CUTOFF) {
      removed.push({ ...s, lastDate: ld, removedAt: today.toISOString().slice(0, 10), reason: `騰訊日K末根 ${kd ?? '無'}` });
    } else {
      dataGaps.push(`${s.symbol} ${s.name} (騰訊日K ${kd} 仍活、L1=${ld ?? '無'} → 真資料缺口待修)`);
    }
  }
  console.log(`確認下市/長停 ${removed.length} 檔；疑似資料缺口（保留待修） ${dataGaps.length} 檔`);
  removed.forEach(r => console.log(`  移除 ${r.symbol} ${r.name} (L1=${r.lastDate ?? '無'}, ${r.reason})`));
  dataGaps.forEach(k => console.log(`  ⚠ ${k}`));

  if (DRY) { console.log('[DRY] 不寫檔'); return; }
  if (removed.length === 0) { console.log('無可移除'); return; }

  copyFileSync(LIST, `${LIST}.bak-${today.toISOString().slice(0, 10)}`);
  const removedSet = new Set(removed.map(r => r.symbol));
  raw.stocks = raw.stocks.filter(s => !removedSet.has(s.symbol));
  writeFileSync(LIST, JSON.stringify(raw, null, 2));

  const prev: Array<{ symbol: string }> = existsSync(REMOVED) ? JSON.parse(readFileSync(REMOVED, 'utf8')) : [];
  const prevSet = new Set(prev.map(p => p.symbol));
  writeFileSync(REMOVED, JSON.stringify([...prev, ...removed.filter(r => !prevSet.has(r.symbol))], null, 2));
  console.log(`已移除 ${removed.length} → stocklist 剩 ${raw.stocks.length}；留痕 ${REMOVED}`);
}

main().catch(e => { console.error(e); process.exit(1); });
