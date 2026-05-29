import 'dotenv/config';
import { loadStockBundles } from '@/lib/youtube/stockDataLoader';
import fs from 'node:fs';

async function main() {
  const codes = ['2330', '2308', '3090', '2317', '2484'];
  const bundles = await loadStockBundles(codes);
  const out: Record<string, any> = {};
  for (const b of bundles) {
    out[b.stock_code] = {
      industry: b.industry?.data?.industry_category ?? null,
      market_type: b.industry?.data?.market_type ?? null,
      governance: b.governance?.data ?? null,
      news_item_count: b.news?.data?.item_count ?? 0,
      news_recent_titles: b.news?.data?.recent_titles ?? null,
    };
  }
  console.log(JSON.stringify(out, null, 2));
  fs.writeFileSync('/tmp/extra-bundles.json', JSON.stringify(bundles, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
