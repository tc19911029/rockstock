#!/usr/bin/env tsx
/**
 * 把 stock_scoring 中沒有 factor_evidence 的 entries 用 question.json bundle 自動補上
 *
 * 來源：/tmp/rockstock-youtube/{date}-question.json 的 stock_data_bundles[]
 * 規則：bundle 內每個面向的 data 真的有值 → internal_api evidence；data null → missing
 *
 * 用法：tsx scripts/patch-bundle-evidence.ts <analysis.json> <question.json>
 */
import fs from 'node:fs';

const [, , analysisPath, questionPath] = process.argv;
if (!analysisPath || !questionPath) {
  console.error('用法：tsx patch-bundle-evidence.ts <analysis.json> <question.json>');
  process.exit(2);
}

const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf-8'));
const question = JSON.parse(fs.readFileSync(questionPath, 'utf-8'));

const bundleMap: Record<string, any> = {};
for (const b of question.stock_data_bundles ?? []) {
  bundleMap[b.stock_code] = b;
}

const macroSource = (question.macro?.source ?? '').split(' | ')[0];
const macroFetchedAt = question.macro?.fetched_at ?? '';
const taiexAboveMa20 = question.macro?.data?.taiex?.above_ma20_pct;
const marketRegime = question.macro?.data?.market_regime;

const sharedMacro = {
  data_provenance: 'internal_api',
  values: { market_regime: marketRegime, taiex_above_ma20_pct: taiexAboveMa20 },
  sources: [{
    url: macroSource,
    fetched_at: macroFetchedAt,
    raw_quote: `market_regime=${marketRegime}, taiex above_ma20_pct=${taiexAboveMa20}`,
  }],
};

let patched = 0;
let skipped = 0;

for (const s of analysis.stock_scoring ?? []) {
  if (s.factor_evidence) { skipped++; continue; }

  const bundle = bundleMap[s.stock_code];
  const ev: Record<string, any> = {};

  if (bundle) {
    // technical
    const td = bundle.technical?.data;
    if (td?.last_candle?.close != null || td?.trend_summary?.change_pct_1d != null) {
      ev.technical = {
        data_provenance: 'internal_api',
        values: {
          close: td.last_candle?.close,
          change_pct_1d: td.trend_summary?.change_pct_1d,
          change_pct_20d: td.trend_summary?.change_pct_20d,
          above_ma20_pct: td.trend_summary?.above_ma20_pct,
        },
        sources: [{
          url: bundle.technical.source,
          fetched_at: bundle.technical.fetched_at,
          raw_quote: `close=${td.last_candle?.close}, change_pct_1d=${td.trend_summary?.change_pct_1d}%, above_ma20_pct=${td.trend_summary?.above_ma20_pct}%, change_pct_20d=${td.trend_summary?.change_pct_20d}%`,
        }],
      };
    } else {
      ev.technical = { data_provenance: 'missing', attempted: ['internal_api'] };
    }

    // chip
    const cd = bundle.chip?.data;
    if (cd && (cd.foreign_net != null || cd.trust_net != null)) {
      ev.chip = {
        data_provenance: 'internal_api',
        values: {
          foreign_net: cd.foreign_net,
          trust_net: cd.trust_net,
          dealer_net: cd.dealer_net,
          total_inst_net: cd.total_inst_net,
          margin_balance: cd.margin_balance,
          chip_score: cd.chip_score,
          chip_grade: cd.chip_grade,
        },
        sources: [{
          url: bundle.chip.source,
          fetched_at: bundle.chip.fetched_at,
          raw_quote: `foreign_net=${cd.foreign_net} trust_net=${cd.trust_net} dealer_net=${cd.dealer_net}, chip_grade=${cd.chip_grade}`,
        }],
      };
    } else {
      ev.chip = { data_provenance: 'missing', attempted: ['internal_api'] };
    }

    // fundamental
    const fd = bundle.fundamental?.data;
    if (fd?.eps_recent_4q != null || fd?.per != null) {
      ev.fundamental = {
        data_provenance: 'internal_api',
        values: {
          eps_recent_4q: fd.eps_recent_4q,
          eps_yoy: fd.eps_yoy,
          per: fd.per,
          pbr: fd.pbr,
          gross_margin_pct: fd.gross_margin_pct,
          net_margin_pct: fd.net_margin_pct,
          revenue_yoy: fd.revenue_latest_month?.yoy,
          dividend_yield_pct: fd.dividend_yield_pct,
        },
        sources: [{
          url: bundle.fundamental.source,
          fetched_at: bundle.fundamental.fetched_at,
          raw_quote: `EPS_4Q=${fd.eps_recent_4q} EPS_YoY=${fd.eps_yoy}% PER=${fd.per} PBR=${fd.pbr} gross_margin=${fd.gross_margin_pct}% revenue_YoY=${fd.revenue_latest_month?.yoy}%`,
        }],
      };
    } else {
      ev.fundamental = { data_provenance: 'missing', attempted: ['internal_api'] };
    }

    // news
    const nd = bundle.news?.data;
    if (nd?.item_count > 0) {
      ev.news = {
        data_provenance: 'internal_api',
        values: { item_count: nd.item_count, overall_score: nd.sentiment?.overall_score },
        sources: [{
          url: bundle.news.source,
          fetched_at: bundle.news.fetched_at,
          raw_quote: `${nd.item_count} news items, sentiment=${nd.sentiment?.overall_score}`,
        }],
      };
    } else {
      ev.news = { data_provenance: 'missing', attempted: ['internal_api'] };
    }

    // industry
    if (bundle.industry?.data?.industry_category) {
      ev.industry = {
        data_provenance: 'internal_api',
        values: { category: bundle.industry.data.industry_category, market_type: bundle.industry.data.market_type },
        sources: [{
          url: bundle.industry.source,
          fetched_at: bundle.industry.fetched_at,
          raw_quote: `industry_category=${bundle.industry.data.industry_category}`,
        }],
      };
    } else {
      ev.industry = { data_provenance: 'missing', attempted: ['internal_api'] };
    }

    // governance
    if (bundle.governance?.data) {
      const gd = bundle.governance.data;
      ev.governance = {
        data_provenance: 'internal_api',
        values: {
          foreign_ownership_pct: gd.foreign_ownership_pct,
          foreign_ownership_pct_4w_ago: gd.foreign_ownership_pct_4w_ago,
          foreign_ownership_delta_4w: gd.foreign_ownership_delta_4w,
          data_date: gd.data_date,
        },
        sources: [{
          url: bundle.governance.source,
          fetched_at: bundle.governance.fetched_at,
          raw_quote: `foreign_ownership=${gd.foreign_ownership_pct}% delta_4w=${gd.foreign_ownership_delta_4w}pp (data_date=${gd.data_date})`,
        }],
      };
    } else {
      ev.governance = { data_provenance: 'missing', attempted: ['internal_api'] };
    }

    // valuation 衍生自 fundamental
    if (fd?.per != null) {
      ev.valuation = {
        data_provenance: 'internal_api',
        values: { per: fd.per, pbr: fd.pbr, dividend_yield_pct: fd.dividend_yield_pct, eps_yoy: fd.eps_yoy },
        sources: [{
          url: bundle.fundamental.source,
          fetched_at: bundle.fundamental.fetched_at,
          raw_quote: `PER=${fd.per} PBR=${fd.pbr} dividend_yield=${fd.dividend_yield_pct}%`,
        }],
      };
    } else {
      ev.valuation = { data_provenance: 'missing', attempted: ['internal_api'] };
    }
  } else {
    // 沒 bundle — 標 missing 待後續 WebFetch 補
    for (const k of ['technical', 'chip', 'fundamental', 'news', 'industry', 'governance', 'valuation']) {
      ev[k] = { data_provenance: 'missing', attempted: ['internal_api'] };
    }
  }

  // 共用 macro + mention_heat
  ev.macro = sharedMacro;
  ev.mention_heat = {
    data_provenance: 'transcript',
    values: { note: 'cross-show mention count, see high_consensus_stocks / weak_signal_stocks' },
    sources: [{
      url: `${analysisPath}#mentions`,
      fetched_at: analysis.generated_at,
      raw_quote: `${s.stock_code} ${s.stock_name} 跨節目 mention 統計來自 high_consensus_stocks + weak_signal_stocks 陣列`,
    }],
  };

  s.factor_evidence = ev;
  patched++;
}

fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2) + '\n');
console.log(`patched ${patched} entries, skipped ${skipped} (already had evidence)`);
