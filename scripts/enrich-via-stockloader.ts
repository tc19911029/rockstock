#!/usr/bin/env tsx
/**
 * 對 stock_scoring 內所有 data_provenance="missing" 的 cells，
 * 用 stockDataLoader.loadStockBundles 自動補（FinMind / internal API 完整 chain）。
 *
 * 用法：tsx scripts/enrich-via-stockloader.ts data/youtube/analysis/{date}.json
 *
 * 跟 enrich-missing-evidence.ts 差別：
 * - enrich-missing-evidence: 只打 /api/chip + /api/fundamentals + /api/stock，不含 FinMind / industry / governance
 * - enrich-via-stockloader: 完整 8 維 (technical/chip/fund/news/industry/governance + macro)，能補 industry + governance
 */
import 'dotenv/config';
import { loadStockBundles } from '@/lib/youtube/stockDataLoader';
import fs from 'node:fs';

const DEFAULT_SCORE = 50;
const FACTOR_KEYS = ['technical', 'chip', 'fundamental', 'news', 'industry', 'governance', 'valuation'];

const WEIGHTS: Record<string, number> = {
  technical: 25, chip: 18, fundamental: 15, news: 12, mention_heat: 10, industry: 10, macro: 5, valuation: 3, governance: 2,
};

function calcComposite(scores: Record<string, number>): number {
  let w = 0;
  for (const k of Object.keys(WEIGHTS)) w += WEIGHTS[k] * (scores[k] ?? DEFAULT_SCORE);
  return Math.round(w / 100 * 10) / 10;
}

function calcRating(c: number): string {
  if (c >= 75) return 'A';
  if (c >= 60) return 'B';
  if (c >= 45) return 'C';
  return 'D';
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('用法：tsx enrich-via-stockloader.ts <analysis.json>');
    process.exit(2);
  }
  const analysis = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const fetchedAt = new Date().toISOString();

  // 找出有 missing cells 的 stock codes
  const codes: string[] = [];
  for (const s of analysis.stock_scoring ?? []) {
    if (!s.factor_evidence) continue;
    const hasMissing = FACTOR_KEYS.some(k => s.factor_evidence[k]?.data_provenance === 'missing');
    if (hasMissing) codes.push(s.stock_code);
  }
  console.log(`Loading bundles for ${codes.length} stocks with missing cells...`);

  // 分批處理對抗 FinMind rate limit (每分鐘 ~60 reqs；每檔 8 fetches → 一批 5 檔 ≈ 40 reqs)
  const BATCH_SIZE = 5;
  const BATCH_DELAY_MS = 70_000; // 等 70 秒讓 rate limit 重置
  const bundleMap: Record<string, any> = {};
  for (let i = 0; i < codes.length; i += BATCH_SIZE) {
    const batch = codes.slice(i, i + BATCH_SIZE);
    console.log(`  batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.join(',')}`);
    const bundles = await loadStockBundles(batch, 2);
    for (const b of bundles) bundleMap[b.stock_code] = b;
    if (i + BATCH_SIZE < codes.length) {
      console.log(`  sleeping ${BATCH_DELAY_MS / 1000}s for rate limit cooldown...`);
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  let totalEnriched = 0;
  let totalDowngraded = 0;

  for (const s of analysis.stock_scoring ?? []) {
    if (!s.factor_evidence) continue;
    const bundle = bundleMap[s.stock_code];
    if (!bundle) continue;

    const enriched: string[] = [];
    const downgraded: string[] = [];

    // technical
    if (s.factor_evidence.technical?.data_provenance === 'missing' && bundle.technical?.data?.trend_summary) {
      const t = bundle.technical.data;
      s.factor_evidence.technical = {
        data_provenance: 'internal_api',
        values: {
          close: t.last_candle?.close,
          change_pct_1d: t.trend_summary?.change_pct_1d,
          change_pct_20d: t.trend_summary?.change_pct_20d,
          above_ma20_pct: t.trend_summary?.above_ma20_pct,
        },
        sources: [{
          url: bundle.technical.source,
          fetched_at: bundle.technical.fetched_at,
          raw_quote: `close=${t.last_candle?.close} change_pct_1d=${t.trend_summary?.change_pct_1d}% above_ma20=${t.trend_summary?.above_ma20_pct}%`,
        }],
      };
      enriched.push('technical');
    }

    // chip
    if (s.factor_evidence.chip?.data_provenance === 'missing' && bundle.chip?.data && (bundle.chip.data.foreign_net != null || bundle.chip.data.trust_net != null)) {
      const c = bundle.chip.data;
      s.factor_evidence.chip = {
        data_provenance: 'internal_api',
        values: { foreign_net: c.foreign_net, trust_net: c.trust_net, dealer_net: c.dealer_net, chip_grade: c.chip_grade, chip_signal: c.chip_signal },
        sources: [{
          url: bundle.chip.source,
          fetched_at: bundle.chip.fetched_at,
          raw_quote: `foreign_net=${c.foreign_net} trust_net=${c.trust_net} dealer_net=${c.dealer_net} chip_grade=${c.chip_grade}`,
        }],
      };
      enriched.push('chip');
    }

    // fundamental + valuation
    if (s.factor_evidence.fundamental?.data_provenance === 'missing' && bundle.fundamental?.data?.per != null) {
      const f = bundle.fundamental.data;
      s.factor_evidence.fundamental = {
        data_provenance: 'internal_api',
        values: { eps_recent_4q: f.eps_recent_4q, eps_yoy: f.eps_yoy, per: f.per, pbr: f.pbr, gross_margin_pct: f.gross_margin_pct, revenue_yoy: f.revenue_latest_month?.yoy },
        sources: [{
          url: bundle.fundamental.source,
          fetched_at: bundle.fundamental.fetched_at,
          raw_quote: `EPS_4Q=${f.eps_recent_4q} PER=${f.per} PBR=${f.pbr} eps_yoy=${f.eps_yoy}%`,
        }],
      };
      enriched.push('fundamental');

      if (s.factor_evidence.valuation?.data_provenance === 'missing') {
        s.factor_evidence.valuation = {
          data_provenance: 'internal_api',
          values: { per: f.per, pbr: f.pbr, dividend_yield_pct: f.dividend_yield_pct },
          sources: [{ url: bundle.fundamental.source, fetched_at: bundle.fundamental.fetched_at, raw_quote: `PER=${f.per} PBR=${f.pbr} yield=${f.dividend_yield_pct}%` }],
        };
        enriched.push('valuation');
      }
    }

    // news
    if (s.factor_evidence.news?.data_provenance === 'missing' && bundle.news?.data?.item_count > 0) {
      const n = bundle.news.data;
      s.factor_evidence.news = {
        data_provenance: 'internal_api',
        values: { item_count: n.item_count, overall_score: n.sentiment?.overall_score, recent_titles: n.recent_titles },
        sources: [{ url: bundle.news.source, fetched_at: bundle.news.fetched_at, raw_quote: `${n.item_count} items, sentiment=${n.sentiment?.overall_score}` }],
      };
      enriched.push('news');
    }

    // industry
    if (s.factor_evidence.industry?.data_provenance === 'missing' && bundle.industry?.data?.industry_category) {
      const i = bundle.industry.data;
      s.factor_evidence.industry = {
        data_provenance: 'internal_api',
        values: { category: i.industry_category, market_type: i.market_type },
        sources: [{ url: bundle.industry.source, fetched_at: bundle.industry.fetched_at, raw_quote: `industry_category=${i.industry_category} market_type=${i.market_type}` }],
      };
      enriched.push('industry');
    }

    // governance
    if (s.factor_evidence.governance?.data_provenance === 'missing' && bundle.governance?.data?.foreign_ownership_pct != null) {
      const g = bundle.governance.data;
      s.factor_evidence.governance = {
        data_provenance: 'internal_api',
        values: { foreign_ownership_pct: g.foreign_ownership_pct, foreign_ownership_pct_4w_ago: g.foreign_ownership_pct_4w_ago, foreign_ownership_delta_4w: g.foreign_ownership_delta_4w, data_date: g.data_date },
        sources: [{ url: bundle.governance.source, fetched_at: bundle.governance.fetched_at, raw_quote: `foreign_ownership=${g.foreign_ownership_pct}% delta_4w=${g.foreign_ownership_delta_4w}pp (data_date=${g.data_date})` }],
      };
      enriched.push('governance');
    }

    // 仍 missing 的，score 降到 50
    for (const f of FACTOR_KEYS) {
      if (s.factor_evidence[f]?.data_provenance === 'missing' && s.factor_scores[f] !== DEFAULT_SCORE && s.factor_scores[f] != null) {
        s.factor_scores[f] = DEFAULT_SCORE;
        downgraded.push(f);
      }
    }

    if (enriched.length === 0 && downgraded.length === 0) continue;

    const oldComp = s.composite_score;
    s.composite_score = calcComposite(s.factor_scores);
    s.rating = calcRating(s.composite_score);
    console.log(`[${s.stock_code} ${s.stock_name}] enriched=[${enriched.join(',')}] downgraded=[${downgraded.join(',')}] composite ${oldComp}→${s.composite_score} (${s.rating})`);
    totalEnriched += enriched.length;
    totalDowngraded += downgraded.length;
  }

  // 重算 rating_distribution
  const dist: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
  for (const s of analysis.stock_scoring ?? []) dist[s.rating ?? 'D']++;
  if (analysis.stats) analysis.stats.rating_distribution = dist;

  fs.writeFileSync(file, JSON.stringify(analysis, null, 2) + '\n');
  console.log(`\nDone. ${totalEnriched} factors enriched, ${totalDowngraded} downgraded. Final dist:`, dist);
}

main().catch(e => { console.error(e); process.exit(1); });
