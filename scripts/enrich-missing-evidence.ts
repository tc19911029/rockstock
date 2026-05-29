#!/usr/bin/env tsx
/**
 * 對 stock_scoring 中 data_provenance="missing" 的 cells 嘗試補資料：
 *   1. 試 internal API (/api/chip, /api/fundamentals/[code], /api/stock?symbol=[code])
 *   2. 抓到 → 改 evidence 為 internal_api + 附完整 sources
 *   3. 抓不到 → 保留 missing 並把對應 factor_score 降到 50 default（不編造）
 *
 * 對 valuation 衍生自 fundamental: 若 fund 拿到 → valuation 也拿到
 *
 * 用法：tsx scripts/enrich-missing-evidence.ts <analysis.json>
 */
import fs from 'node:fs';

const DEFAULT_SCORE = 50;
const FACTOR_KEYS = ['technical', 'chip', 'fundamental', 'news', 'industry', 'governance', 'valuation'];

async function fetchJson(url: string): Promise<any> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const json = await r.json();
    return json.ok === false ? null : json;
  } catch {
    return null;
  }
}

async function enrichOne(code: string) {
  const [chip, fund, stock] = await Promise.all([
    fetchJson(`http://localhost:3000/api/chip?symbol=${code}`),
    fetchJson(`http://localhost:3000/api/fundamentals/${code}`),
    fetchJson(`http://localhost:3000/api/stock?symbol=${code}&interval=1d&period=3mo`),
  ]);
  return {
    chip: chip?.data ?? null,
    fund: fund?.data ?? null,
    stock: stock?.data ?? stock ?? null,
  };
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('用法：tsx enrich-missing-evidence.ts <analysis.json>');
    process.exit(2);
  }

  const analysis = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const fetchedAt = new Date().toISOString();

  let totalEnriched = 0;
  let totalDowngraded = 0;
  let stocksProcessed = 0;

  for (const s of analysis.stock_scoring ?? []) {
    if (!s.factor_evidence) continue;

    const missingFactors = FACTOR_KEYS.filter(k => s.factor_evidence[k]?.data_provenance === 'missing');
    if (missingFactors.length === 0) continue;

    stocksProcessed++;
    process.stdout.write(`[${s.stock_code} ${s.stock_name}] missing=${missingFactors.length} `);

    const fetched = await enrichOne(s.stock_code);
    const enrichedFactors: string[] = [];
    const downgradedFactors: string[] = [];

    // technical
    if (s.factor_evidence.technical?.data_provenance === 'missing' && fetched.stock?.candles?.length > 0) {
      const last = fetched.stock.candles[fetched.stock.candles.length - 1];
      const prev20 = fetched.stock.candles.slice(-21, -1);
      const ma20 = prev20.length > 0 ? prev20.reduce((a: number, b: any) => a + b.close, 0) / prev20.length : null;
      const change20d = fetched.stock.candles.length > 20
        ? (last.close / fetched.stock.candles[fetched.stock.candles.length - 21].close - 1) * 100
        : null;
      s.factor_evidence.technical = {
        data_provenance: 'internal_api',
        values: {
          close: last.close,
          change_pct_1d: ((last.close / fetched.stock.candles[fetched.stock.candles.length - 2].close - 1) * 100),
          change_pct_20d: change20d,
          above_ma20_pct: ma20 ? ((last.close / ma20 - 1) * 100) : null,
        },
        sources: [{
          url: `http://localhost:3000/api/stock?symbol=${s.stock_code}&interval=1d&period=3mo`,
          fetched_at: fetchedAt,
          raw_quote: `last close=${last.close} (date=${last.date}), ${fetched.stock.candles.length} candles in window`,
        }],
      };
      enrichedFactors.push('technical');
    }

    // chip
    if (s.factor_evidence.chip?.data_provenance === 'missing' && fetched.chip && (fetched.chip.foreignBuy != null || fetched.chip.trustBuy != null)) {
      s.factor_evidence.chip = {
        data_provenance: 'internal_api',
        values: {
          foreign_net: fetched.chip.foreignBuy,
          trust_net: fetched.chip.trustBuy,
          dealer_net: fetched.chip.dealerBuy,
          chip_score: fetched.chip.chipScore,
          chip_grade: fetched.chip.chipGrade,
          chip_signal: fetched.chip.chipSignal,
        },
        sources: [{
          url: `http://localhost:3000/api/chip?symbol=${s.stock_code}`,
          fetched_at: fetchedAt,
          raw_quote: `foreignBuy=${fetched.chip.foreignBuy} trustBuy=${fetched.chip.trustBuy} dealerBuy=${fetched.chip.dealerBuy} chipScore=${fetched.chip.chipScore}`,
        }],
      };
      enrichedFactors.push('chip');
    }

    // fundamental + valuation 衍生
    if (s.factor_evidence.fundamental?.data_provenance === 'missing' && fetched.fund && (fetched.fund.eps != null || fetched.fund.per != null)) {
      s.factor_evidence.fundamental = {
        data_provenance: 'internal_api',
        values: {
          eps: fetched.fund.eps,
          eps_yoy: fetched.fund.epsYoY,
          per: fetched.fund.per,
          pbr: fetched.fund.pbr,
          gross_margin: fetched.fund.grossMargin,
          revenue_yoy: fetched.fund.revenueYoY,
          dividend_yield: fetched.fund.dividendYield,
        },
        sources: [{
          url: `http://localhost:3000/api/fundamentals/${s.stock_code}`,
          fetched_at: fetchedAt,
          raw_quote: `EPS=${fetched.fund.eps} PER=${fetched.fund.per} PBR=${fetched.fund.pbr} revenue_YoY=${fetched.fund.revenueYoY?.toFixed?.(2)}%`,
        }],
      };
      enrichedFactors.push('fundamental');

      // valuation
      if (s.factor_evidence.valuation?.data_provenance === 'missing') {
        s.factor_evidence.valuation = {
          data_provenance: 'internal_api',
          values: { per: fetched.fund.per, pbr: fetched.fund.pbr, dividend_yield: fetched.fund.dividendYield },
          sources: [{
            url: `http://localhost:3000/api/fundamentals/${s.stock_code}`,
            fetched_at: fetchedAt,
            raw_quote: `PER=${fetched.fund.per} PBR=${fetched.fund.pbr} yield=${fetched.fund.dividendYield}%`,
          }],
        };
        enrichedFactors.push('valuation');
      }
    }

    // 對 enriched 過的 factor，保留 score 不動（有真資料支持）
    // 對仍 missing 的，把 score 降到 default 50
    for (const f of FACTOR_KEYS) {
      if (s.factor_evidence[f]?.data_provenance === 'missing' && s.factor_scores[f] != null && s.factor_scores[f] !== DEFAULT_SCORE) {
        s.factor_scores[f] = DEFAULT_SCORE;
        downgradedFactors.push(f);
      }
    }

    // 重算 composite
    const weights: Record<string, number> = {
      technical: 25, chip: 18, fundamental: 15, news: 12, mention_heat: 10, industry: 10, macro: 5, valuation: 3, governance: 2,
    };
    let weighted = 0;
    for (const k of Object.keys(weights)) {
      weighted += weights[k] * (s.factor_scores[k] ?? DEFAULT_SCORE);
    }
    const newComposite = Math.round((weighted / 100) * 10) / 10;
    const oldComposite = s.composite_score;
    s.composite_score = newComposite;

    // rating 重判
    if (newComposite >= 75) s.rating = 'A';
    else if (newComposite >= 60) s.rating = 'B';
    else if (newComposite >= 45) s.rating = 'C';
    else s.rating = 'D';

    totalEnriched += enrichedFactors.length;
    totalDowngraded += downgradedFactors.length;
    console.log(`enriched=[${enrichedFactors.join(',')}] downgraded=[${downgradedFactors.join(',')}] composite ${oldComposite}→${newComposite} (${s.rating})`);
  }

  fs.writeFileSync(file, JSON.stringify(analysis, null, 2) + '\n');
  console.log(`\nDone. ${stocksProcessed} stocks processed, ${totalEnriched} factors enriched, ${totalDowngraded} downgraded to default 50`);
}

main().catch(e => { console.error(e); process.exit(1); });
