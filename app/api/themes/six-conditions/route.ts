/**
 * 題材成分股「六大進場條件 + 趨勢」批次判讀（2026-06-20）
 * GET /api/themes/six-conditions?market=TW&date=YYYY-MM-DD&codes=2330,2327,...
 *
 * 純顯示層：給 /sectors（題材分類）的個股卡片掛「六條件徽章」+「只看多頭」篩選用。
 * 不參與選股（鐵則 #5），六條件邏輯直接呼叫掃描器同一支 evaluateSixConditions
 * （單一事實 = lib/analysis/trendAnalysis + BASE_THRESHOLDS，不在 UI hard-code 任何門檻）。
 *
 * 為什麼不直接讀掃描結果：盤後 daily A session 只封存「過 minScore 門檻」的少數合格股，
 * 題材裡大多數成分股不在其中 → 改成即時用 L1 日K 逐檔判讀（記憶體快取 5 分鐘）。
 */
import { NextRequest } from 'next/server';
import { apiOk } from '@/lib/api/response';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { evaluateStockSignal, type StockSignal } from '@/lib/analysis/stockSignal';
import { globalCache } from '@/lib/datasource/MemoryCache';

export const runtime = 'nodejs';

const CACHE_TTL = 5 * 60 * 1000;
const CONCURRENCY = 12;
const MAX_CODES = 600;

export type SixCondItem = StockSignal;

async function evalOne(code: string, market: 'TW' | 'CN', date: string): Promise<SixCondItem | null> {
  const bare = code.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  const file = market === 'TW'
    ? ((await readCandleFile(`${bare}.TW`, 'TW')) ?? (await readCandleFile(`${bare}.TWO`, 'TW')))
    : (await readCandleFile(code, 'CN'));
  if (!file?.candles?.length) return null;
  return evaluateStockSignal(file.candles, date || undefined);
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const market = (sp.get('market') === 'CN' ? 'CN' : 'TW') as 'TW' | 'CN';
  const date = sp.get('date') ?? '';
  const codes = [...new Set((sp.get('codes') ?? '').split(',').map(c => c.trim()).filter(Boolean))].slice(0, MAX_CODES);
  if (codes.length === 0) return apiOk({ items: {} });

  const cacheKey = `six-cond:${market}:${date}:${[...codes].sort().join(',')}`;
  const cached = globalCache.get<Record<string, SixCondItem>>(cacheKey);
  if (cached) return apiOk({ items: cached });

  const items: Record<string, SixCondItem> = {};
  for (let i = 0; i < codes.length; i += CONCURRENCY) {
    const batch = codes.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (code) => {
      try {
        const r = await evalOne(code, market, date);
        if (r) items[code] = r;
      } catch { /* 單檔失敗略過 */ }
    }));
  }

  globalCache.set(cacheKey, items, CACHE_TTL);
  return apiOk({ items });
}
