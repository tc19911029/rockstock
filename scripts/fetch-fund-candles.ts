/**
 * 抓場外基金(.OF) 的「淨值歷史」當作 K 線數據，寫到 data/funds/{symbol}.json（與股票 L1 隔離）。
 *
 * 為什麼獨立放 data/funds/：基金沒有真正的 OHLC（一天只有一個單位淨值 NAV），
 * 用 O=H=L=C=NAV、volume=0 的退化 K 棒表示。若混進 data/candles/CN/ 會被
 * audit-l1-invariant / audit-volume-daily 等股票稽核誤判（量=0、振幅=0）。
 *
 * 來源：天天基金 pingzhongdata（一次回完整歷史 Data_netWorthTrend = 單位淨值序列）。
 * 用單位淨值(DWJZ) 而非累計淨值 —— 與持倉市值(份額×單位淨值) 同口徑、最新一根對得上 App。
 *
 * 自動掃描所有 profile 的 holdings-cn.json 找 .OF 代號（含「我的」）。
 *
 * 跑法：npx tsx scripts/fetch-fund-candles.ts
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import { isFundSymbol } from '@/lib/market/classify';
import type { Candle } from '@/types';

const FUNDS_DIR = path.join(process.cwd(), 'data', 'funds');

/** 從所有持倉檔收集 .OF 代號（去重）*/
async function collectFundSymbols(): Promise<string[]> {
  const files: string[] = [
    path.join(process.cwd(), 'data', 'portfolio', 'holdings-cn.json'),
  ];
  const profilesRoot = path.join(process.cwd(), 'data', 'portfolios');
  try {
    for (const id of await fs.readdir(profilesRoot)) {
      files.push(path.join(profilesRoot, id, 'holdings-cn.json'));
    }
  } catch { /* no profiles dir */ }

  const set = new Set<string>();
  for (const f of files) {
    try {
      const json = JSON.parse(await fs.readFile(f, 'utf-8')) as { holdings?: Array<{ symbol?: string }> };
      for (const h of json.holdings ?? []) {
        if (h.symbol && isFundSymbol(h.symbol)) set.add(h.symbol);
      }
    } catch { /* file missing / unreadable */ }
  }
  return [...set].sort();
}

/** 中國時區日期字串（NAV 的 x 是 UTC ms）*/
function cnDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

interface NavPoint { x: number; y: number }

async function fetchFundHistory(code: string): Promise<{ name: string; candles: Candle[] } | null> {
  const res = await fetch(`https://fund.eastmoney.com/pingzhongdata/${code}.js`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://fund.eastmoney.com/' },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) return null;
  const txt = await res.text();

  const name = (txt.match(/var fS_name\s*=\s*"([^"]+)"/) || [])[1] ?? code;
  const m = txt.match(/var Data_netWorthTrend\s*=\s*(\[.*?\]);/s);
  if (!m) return null;
  const arr = JSON.parse(m[1]) as NavPoint[];

  // 退化 K 棒：基金一日一個單位淨值，O=H=L=C=NAV、volume=0
  const byDate = new Map<string, Candle>();
  for (const p of arr) {
    const nav = Number(p.y);
    if (!(nav > 0)) continue;
    const date = cnDate(p.x);
    byDate.set(date, { date, open: nav, high: nav, low: nav, close: nav, volume: 0 });
  }
  const candles = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  return { name, candles };
}

async function main() {
  const symbols = await collectFundSymbols();
  if (symbols.length === 0) {
    console.log('沒有找到任何 .OF 基金持倉，無事可做。');
    return;
  }
  console.log(`找到 ${symbols.length} 檔基金：${symbols.join(', ')}`);
  await fs.mkdir(FUNDS_DIR, { recursive: true });

  for (const symbol of symbols) {
    const code = symbol.replace(/\.OF$/i, '');
    try {
      const hist = await fetchFundHistory(code);
      if (!hist || hist.candles.length === 0) {
        console.log(`  ✗ ${symbol} 無淨值歷史（來源回空）`);
        continue;
      }
      const last = hist.candles[hist.candles.length - 1];
      const file = {
        symbol,
        name: hist.name,
        lastDate: last.date,
        updatedAt: new Date().toISOString(),
        candles: hist.candles,
      };
      await atomicFsPut(path.join(FUNDS_DIR, `${symbol}.json`), JSON.stringify(file));
      console.log(`  ✓ ${symbol} ${hist.name}｜${hist.candles.length} 根｜${hist.candles[0].date} → ${last.date}（最新淨值 ${last.close}）`);
    } catch (e) {
      console.log(`  ✗ ${symbol} 失敗：${e instanceof Error ? e.message : String(e)}`);
    }
    await new Promise(r => setTimeout(r, 400)); // 客氣一點
  }
}

main().catch(e => { console.error(e); process.exit(1); });
