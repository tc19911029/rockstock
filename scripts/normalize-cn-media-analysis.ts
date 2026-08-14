#!/usr/bin/env npx tsx
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  computeCompositeScore,
  ratingFromScore,
  type FactorScores,
} from '@/lib/youtube/analysisStorage';
import type { CnMediaDailyAnalysis } from '@/lib/cn-media/analysisStorage';
import { loadCnStockMaster, lookupCnStock } from '@/lib/cn-media/stockMaster';

async function main() {
  const date = process.argv[2];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('usage: normalize-cn-media-analysis.ts YYYY-MM-DD');
  const file = path.join(process.cwd(), 'data', 'cn-media', 'analysis', `${date}.json`);
  const analysis = JSON.parse(await fs.readFile(file, 'utf-8')) as CnMediaDailyAnalysis;
  const master = await loadCnStockMaster();
  const byCode = new Map(master.map(entry => [entry.code, entry]));
  let corrected = 0;

  for (const mention of [...analysis.high_consensus_stocks, ...analysis.weak_signal_stocks]) {
    const match = lookupCnStock(mention.raw_query, master)
      ?? (mention.matched ? lookupCnStock(mention.matched.code, master) : null);
    if (!match) {
      mention.matched = null;
      mention.combined_confidence = 0;
      continue;
    }
    if (mention.matched?.code !== match.code || mention.matched?.name !== match.name) corrected++;
    mention.matched = match;
    mention.llm_confidence = clamp(mention.llm_confidence);
    mention.combined_confidence = Number((mention.llm_confidence * match.confidence).toFixed(3));
  }

  for (const scoring of analysis.stock_scoring) {
    const entry = byCode.get(scoring.stock_code);
    if (entry && scoring.stock_name !== entry.name) {
      scoring.stock_name = entry.name;
      corrected++;
    }
    scoring.composite_score = computeCompositeScore(scoring.factor_scores as FactorScores);
    scoring.rating = ratingFromScore(scoring.composite_score);
  }
  for (const summary of analysis.video_summaries) {
    summary.key_stocks = summary.key_stocks.flatMap(stock => {
      const entry = byCode.get(stock.code);
      return entry ? [{ code: entry.code, name: entry.name }] : [];
    });
  }

  await fs.writeFile(file, `${JSON.stringify(analysis, null, 2)}\n`, 'utf-8');
  console.log(`normalize cn-media ${date}: corrected=${corrected}`);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
