import { CN_STOCKS } from '@/lib/scanner/cnStocks';
import { CN_STOCKS_GEM_STAR } from '@/lib/scanner/cnStocksGemStar';
import type { CnExchange, CnStockMasterEntry, CnStockMatch } from './types';

const SAFE_ALIASES: Record<string, string> = {
  '茅台': '600519',
  '宁王': '300750',
  '寧王': '300750',
  '中芯': '688981',
  '药明': '603259',
  '耀明康德': '603259',
  '药门康德': '603259',
  '九州药业': '603456',
  '哈药': '600664',
  '哈耀': '600664',
  '百花': '600721',
  '比亚迪': '002594',
  '比亞迪': '002594',
  '寒武纪': '688256',
  '寒武紀': '688256',
  '工业富联': '601138',
  '工業富聯': '601138',
  // 財經口語與 Whisper 常見、且可唯一對應的錯字／簡稱。
  '风华': '000636',
  '中期续创': '300308',
  '中期创': '300308',
  '新一胜': '300502',
  '盛宏科技': '300476',
  '云南者液': '002428',
  '利通': '603629',
  '逆通电子': '603629',
  '虐通电子': '603629',
  '网速科技': '300017',
  '洪景科技': '301396',
  '红景科技': '301396',
  '安季食品': '603696',
  '爱立家居': '603221',
  '传制教育': '003032',
  '船只教育': '003032',
  '高增民报': '002827',
  '高之民报': '002827',
  '一名食品': '605179',
  '医民食品': '605179',
  '移民食品': '605179',
  '通顶互联': '002491',
  '通顶护年': '002491',
  '长飞': '601869',
  '风火通信': '600498',
  '亨通光线': '600487',
  '航电股份': '603618',
  '洪景': '301396',
  '红景': '301396',
  '秦安': '603758',
  '俊轮': '002031',
  '成地相将': '603887',
  '红薄': '002229',
  '红博': '002229',
  '神广': '002400',
  '引力': '603598',
  '天鱼': '002354',
  '云塞': '600602',
  '利欧': '002131',
  '新网锐节': '002396',
  '华琴': '603296',
  '掌月': '603533',
  '景望电子': '603228',
  '蓝标': '300058',
  '贡金': '603118',
  '数据档': '603881',
};

let cached: CnStockMasterEntry[] | null = null;

function normalizeName(value: string): string {
  return value.replace(/[\s　]+/g, '').replace(/Ａ/g, 'A').trim();
}
function exchangeOf(symbol: string): CnExchange {
  if (symbol.endsWith('.BJ')) return 'BSE';
  return symbol.endsWith('.SS') ? 'SSE' : 'SZSE';
}

export async function loadCnStockMaster(): Promise<CnStockMasterEntry[]> {
  if (cached) return cached;
  const entries = new Map<string, CnStockMasterEntry>();
  for (const stock of [...CN_STOCKS, ...CN_STOCKS_GEM_STAR]) {
    const code = stock.symbol.split('.')[0];
    const name = normalizeName(stock.name);
    entries.set(code, {
      code,
      symbol: stock.symbol,
      name,
      exchange: exchangeOf(stock.symbol),
      industry: stock.industry ?? null,
      aliases: [],
    });
  }

  // data/cn_stocklist.json 的 industry 比早期靜態主檔完整；只補欄位，不讓缺檔阻斷。
  try {
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');
    const raw = JSON.parse(await fs.readFile(path.join(process.cwd(), 'data', 'cn_stocklist.json'), 'utf-8')) as {
      stocks?: Array<{ symbol?: string; name?: string; industry?: string }>;
    };
    for (const stock of raw.stocks ?? []) {
      if (!stock.symbol || !stock.name) continue;
      const code = stock.symbol.split('.')[0];
      const existing = entries.get(code);
      const importedName = normalizeName(stock.name);
      // 即時清單偶爾帶 XD／XR／DR 除權息前綴且截短公司名；正式靜態名稱更可靠。
      const name = existing && /^(?:XD|XR|DR)/i.test(importedName)
        ? existing.name
        : importedName;
      entries.set(code, {
        code,
        symbol: stock.symbol,
        name,
        exchange: exchangeOf(stock.symbol),
        industry: stock.industry || existing?.industry || null,
        aliases: existing?.aliases ?? [],
      });
    }
  } catch { /* 靜態 TypeScript 主檔仍可用 */ }

  for (const [alias, code] of Object.entries(SAFE_ALIASES)) {
    const entry = entries.get(code);
    if (entry && alias !== entry.name && !entry.aliases.includes(alias)) entry.aliases.push(alias);
  }
  cached = [...entries.values()].sort((a, b) => a.code.localeCompare(b.code));
  return cached;
}

export function lookupCnStock(query: string, master: CnStockMasterEntry[]): CnStockMatch | null {
  const q = normalizeName(query);
  if (!q) return null;
  const byCode = new Map(master.map(entry => [entry.code, entry]));
  if (/^\d{6}$/.test(q)) {
    const entry = byCode.get(q);
    return entry ? toMatch(entry, 1, 'exact_code') : null;
  }
  const aliasCode = SAFE_ALIASES[q];
  if (aliasCode) {
    const entry = byCode.get(aliasCode);
    return entry ? toMatch(entry, 0.9, 'alias') : null;
  }
  const exact = master.find(entry => entry.name === q || entry.aliases.includes(q));
  if (exact) return toMatch(exact, exact.name === q ? 0.95 : 0.9, exact.name === q ? 'exact_name' : 'alias');
  if (q.length < 2) return null;
  const prefix = master.filter(entry => entry.name.startsWith(q) || entry.aliases.some(alias => alias.startsWith(q)));
  if (prefix.length === 1) return toMatch(prefix[0], 0.8, 'fuzzy_substring');
  const substring = master.filter(entry => entry.name.includes(q) || entry.aliases.some(alias => alias.includes(q)));
  return substring.length === 1 ? toMatch(substring[0], 0.6, 'fuzzy_substring') : null;
}

export function collectCnStockCandidates(
  texts: string[],
  master: CnStockMasterEntry[],
  max = 120,
): CnStockMasterEntry[] {
  const joined = normalizeName(texts.join('\n'));
  const hitCodes = new Set<string>();
  for (const match of joined.matchAll(/(?<!\d)(\d{6})(?!\d)/g)) {
    hitCodes.add(match[1]);
  }
  for (const entry of master) {
    if (entry.name.length >= 3 && joined.includes(entry.name)) hitCodes.add(entry.code);
    else if (entry.aliases.some(alias => alias.length >= 2 && joined.includes(alias))) hitCodes.add(entry.code);
    if (hitCodes.size >= max) break;
  }
  const byCode = new Map(master.map(entry => [entry.code, entry]));
  return [...hitCodes].map(code => byCode.get(code)).filter((entry): entry is CnStockMasterEntry => Boolean(entry));
}

function toMatch(
  entry: CnStockMasterEntry,
  confidence: number,
  matchVia: CnStockMatch['match_via'],
): CnStockMatch {
  return {
    code: entry.code,
    symbol: entry.symbol,
    name: entry.name,
    market: entry.exchange,
    confidence,
    match_via: matchVia,
  };
}
