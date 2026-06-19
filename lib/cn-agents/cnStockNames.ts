/**
 * 陸股代號 → 中文名 對照（顯示層補名用）— 2026-06-19
 *
 * 東財人氣榜（hotness）的 emRank 有些 entry name=null（fetchEastMoneyStockList 清單
 * 不含 ST/創業板/科創板，見 eodPipeline 檔頭），UI 只能顯示裸代號很難讀。這裡把兩份
 * 本地清單合併成 code→name map 補上：
 *   data/cn_stocklist.json            主板 ~3144（{ stocks:[{symbol,name,industry}] }）
 *   data/cn-agents/_backfill-meta/growth-boards.json  創業/科創 ~2052（{ chiNext, star }）
 *
 * 純讀本地檔、記憶體快取（名稱近乎不變，prod 重啟才重載）。檔缺 → 該來源跳過（補不到的
 * 維持裸代號，不比現況差）。
 */

let cache: Map<string, string> | null = null;

export async function getCnNameMap(): Promise<Map<string, string>> {
  if (cache) return cache;
  const m = new Map<string, string>();
  const { promises: fs } = await import('fs');
  const path = await import('path');
  const root = process.cwd();

  const add = (symbol: unknown, name: unknown) => {
    if (typeof symbol === 'string' && typeof name === 'string' && name) {
      m.set(symbol.split('.')[0], name);
    }
  };

  try {
    const raw = await fs.readFile(path.join(root, 'data', 'cn_stocklist.json'), 'utf-8');
    const j = JSON.parse(raw) as { stocks?: Array<{ symbol?: string; name?: string }> };
    for (const s of j.stocks ?? []) add(s?.symbol, s?.name);
  } catch { /* 主板清單缺 → 跳過 */ }

  try {
    const raw = await fs.readFile(path.join(root, 'data', 'cn-agents', '_backfill-meta', 'growth-boards.json'), 'utf-8');
    const j = JSON.parse(raw) as { chiNext?: Array<{ symbol?: string; name?: string }>; star?: Array<{ symbol?: string; name?: string }> };
    for (const arr of [j.chiNext, j.star]) for (const s of arr ?? []) add(s?.symbol, s?.name);
  } catch { /* 成長板清單缺 → 跳過 */ }

  cache = m;
  return m;
}
