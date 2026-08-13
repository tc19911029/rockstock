import { promises as fs } from 'node:fs';
import path from 'node:path';

type MasterMarket = 'TWSE' | 'TPEx';
type MasterEntry = { code: string; market: MasterMarket };

let masterPromise: Promise<Map<string, MasterMarket>> | null = null;

function suffixForMarket(market: MasterMarket): '.TW' | '.TWO' {
  return market === 'TWSE' ? '.TW' : '.TWO';
}

export function expectedTwSymbolFromEntries(symbol: string, entries: MasterEntry[]): string | null {
  const m = symbol.toUpperCase().match(/^(.+)\.(TW|TWO)$/);
  if (!m) return null;
  const entry = entries.find(e => e.code === m[1]);
  return entry ? `${entry.code}${suffixForMarket(entry.market)}` : null;
}

async function loadLocalMarketMap(): Promise<Map<string, MasterMarket>> {
  const file = path.join(process.cwd(), 'data', 'youtube', 'stock-master.json');
  const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { entries?: MasterEntry[] };
  const map = new Map<string, MasterMarket>();
  for (const entry of raw.entries ?? []) {
    if (entry?.code && (entry.market === 'TWSE' || entry.market === 'TPEx')) {
      map.set(entry.code, entry.market);
    }
  }
  return map;
}

/**
 * 依交易所主檔判定台股 canonical suffix。未知代號回 null（不臆測、不阻擋新股）。
 * 故意只讀本地已保存主檔：K 棒寫入邊界不應在數千檔併發時觸發網路 refresh。
 */
export async function expectedTwSymbol(symbol: string): Promise<string | null> {
  const m = symbol.toUpperCase().match(/^(.+)\.(TW|TWO)$/);
  if (!m) return null;
  masterPromise ??= loadLocalMarketMap().catch(err => {
    masterPromise = null;
    throw err;
  });
  try {
    const market = (await masterPromise).get(m[1]);
    return market ? `${m[1]}${suffixForMarket(market)}` : null;
  } catch {
    return null;
  }
}
