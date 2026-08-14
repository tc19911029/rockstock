#!/usr/bin/env npx tsx
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { computeCompositeScore, ratingFromScore } from '@/lib/youtube/analysisStorage';
import type { CnMediaDailyAnalysis, CnMediaMention } from '@/lib/cn-media/analysisStorage';
import { loadCnStockMaster } from '@/lib/cn-media/stockMaster';

const FACTORS = [
  'technical', 'chip_narrative', 'fundamental', 'news', 'mention_heat',
  'industry', 'macro', 'valuation', 'governance',
] as const;

async function main() {
  const date = process.argv[2];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('usage: audit-cn-media-analysis.ts YYYY-MM-DD');
  const root = process.cwd();
  const analysisFile = path.join(root, 'data', 'cn-media', 'analysis', `${date}.json`);
  const questionFile = path.join(process.env.TMPDIR || '/tmp', 'rockstock-cn-media', `${date}-question.json`);
  const [analysisRaw, questionRaw, master] = await Promise.all([
    fs.readFile(analysisFile, 'utf-8'), fs.readFile(questionFile, 'utf-8'), loadCnStockMaster(),
  ]);
  const analysis = JSON.parse(analysisRaw) as CnMediaDailyAnalysis;
  const question = JSON.parse(questionRaw) as { videos?: Array<{ video_id: string; transcript_text: string }> };
  const transcriptByVideo = new Map((question.videos ?? []).map(video => [video.video_id, compact(video.transcript_text)]));
  const masterByCode = new Map(master.map(entry => [entry.code, entry]));
  const failures: string[] = [];
  const warnings: string[] = [];
  const mentions = [...analysis.high_consensus_stocks, ...analysis.weak_signal_stocks];

  if (analysis.date !== date) failures.push(`analysis.date=${analysis.date}`);
  if (analysis.stats.videos_analyzed !== (question.videos ?? []).length) {
    failures.push(`videos_analyzed=${analysis.stats.videos_analyzed}, question=${(question.videos ?? []).length}`);
  }
  for (const mention of mentions) auditMention(mention, transcriptByVideo, masterByCode, failures, warnings);

  const highByCode = new Map<string, CnMediaMention[]>();
  for (const mention of analysis.high_consensus_stocks) {
    if (!mention.matched) continue;
    highByCode.set(mention.matched.code, [...(highByCode.get(mention.matched.code) ?? []), mention]);
  }
  for (const [code, group] of highByCode) {
    const sources = new Set(group.map(item => item.source_id));
    const directions = new Set(group.map(item => direction(item.sentiment)).filter(Boolean));
    if (sources.size < 2 || directions.size !== 1) {
      failures.push(`high consensus ${code}: sources=${sources.size}, directions=${[...directions].join(',')}`);
    }
  }

  for (const scoring of analysis.stock_scoring) {
    const entry = masterByCode.get(scoring.stock_code);
    if (!entry || entry.name !== scoring.stock_name) failures.push(`scoring code/name mismatch ${scoring.stock_code}/${scoring.stock_name}`);
    for (const factor of FACTORS) {
      const score = scoring.factor_scores[factor];
      const evidence = scoring.factor_evidence?.[factor];
      if (!Number.isFinite(score) || score < 0 || score > 100) failures.push(`${scoring.stock_code}.${factor} invalid score`);
      if (!evidence) failures.push(`${scoring.stock_code}.${factor} missing evidence`);
      else if (evidence.data_provenance === 'missing' && score !== 50) failures.push(`${scoring.stock_code}.${factor} missing must score 50`);
    }
    const expected = computeCompositeScore(scoring.factor_scores);
    if (Math.abs(expected - scoring.composite_score) > 0.05) failures.push(`${scoring.stock_code} composite ${scoring.composite_score} != ${expected}`);
    if (ratingFromScore(expected) !== scoring.rating) failures.push(`${scoring.stock_code} rating ${scoring.rating} invalid`);
  }

  const unique = new Set(mentions.flatMap(mention => mention.matched ? [mention.matched.code] : []));
  if (analysis.stats.unique_stocks_total !== unique.size) failures.push(`unique_stocks_total=${analysis.stats.unique_stocks_total}, actual=${unique.size}`);
  if (analysis.stats.high_consensus_count !== highByCode.size) failures.push(`high_consensus_count=${analysis.stats.high_consensus_count}, actual=${highByCode.size}`);

  for (const warning of warnings) console.warn(`WARN ${warning}`);
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.log(`audit cn-media ${date}: ${failures.length} FAIL, ${warnings.length} WARN, ${mentions.length} mentions`);
  if (failures.length) process.exit(1);
}

function auditMention(
  mention: CnMediaMention,
  transcriptByVideo: Map<string, string>,
  masterByCode: Map<string, { name: string }>,
  failures: string[],
  warnings: string[],
) {
  if (!mention.matched) {
    warnings.push(`${mention.video_id} unmatched ${mention.raw_query}`);
    return;
  }
  const entry = masterByCode.get(mention.matched.code);
  if (!entry || entry.name !== mention.matched.name) failures.push(`mention code/name mismatch ${mention.matched.code}/${mention.matched.name}`);
  const transcript = transcriptByVideo.get(mention.video_id);
  if (!transcript) {
    failures.push(`unknown video_id ${mention.video_id}`);
    return;
  }
  const raw = compact(mention.raw_query);
  const context = compact(mention.context);
  const grounded = (raw.length >= 2 && transcript.includes(raw))
    || (context.length >= 8 && transcript.includes(context.slice(0, Math.min(24, context.length))))
    || transcript.includes(mention.matched.code)
    || transcript.includes(compact(mention.matched.name));
  if (!grounded) failures.push(`ungrounded ${mention.video_id} ${mention.raw_query}`);
}

function compact(value: string): string {
  return String(value ?? '').replace(/[\s，。！？、：；,.!?;:"'“”‘’（）()\[\]]+/g, '');
}

function direction(sentiment: string): 'bullish' | 'bearish' | null {
  if (sentiment === 'bullish') return 'bullish';
  if (sentiment === 'bearish' || sentiment === 'risk_warning') return 'bearish';
  return null;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
