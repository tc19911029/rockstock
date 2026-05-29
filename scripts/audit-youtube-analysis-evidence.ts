#!/usr/bin/env tsx
/**
 * Audit YouTube analysis stock_scoring 每一筆 factor_scores 是否有對應 factor_evidence 證據
 *
 * 用法：
 *   npx tsx scripts/audit-youtube-analysis-evidence.ts data/youtube/analysis/2026-05-25.json
 *
 * 規則：
 *   1. 若 factor_scores.{key} 存在且 != null
 *      → factor_evidence.{key}.data_provenance 必須是以下之一：
 *         - "internal_api"  (stock_data_bundles 拿到)
 *         - "web"           (WebFetch 抓的，必須有 sources[] 且每筆有 url + fetched_at + raw_quote)
 *         - "transcript"    (純從 transcript 抽，僅限 mention_heat / industry inferred via 共識)
 *         - "missing"       (明確缺料，此時 factor_score 必須是 50/default 或 null)
 *
 *   2. 若 data_provenance == "web" 但 sources[] 為空 → ❌ FAIL（疑似編造）
 *   3. 若 data_provenance 缺 → ❌ FAIL（每筆 score 都必須說明來源）
 *   4. 寬限：若 stock_scoring 完全沒 factor_evidence 欄位（舊版 entry）→ WARN 但不 FAIL
 *
 * Exit code:
 *   0 — all pass / warn-only
 *   1 — 有 FAIL（疑似編造或缺證據）
 */

import fs from 'node:fs';
import path from 'node:path';

interface FactorScores {
  [key: string]: number | null | undefined;
}

interface EvidenceSource {
  url?: string;
  fetched_at?: string;
  raw_quote?: string;
}

interface FactorEvidenceEntry {
  data_provenance?: 'internal_api' | 'web' | 'transcript' | 'missing';
  values?: Record<string, unknown>;
  sources?: EvidenceSource[];
  attempted?: string[];
}

interface FactorEvidence {
  [key: string]: FactorEvidenceEntry | undefined;
}

interface StockScoring {
  stock_code: string;
  stock_name?: string;
  factor_scores?: FactorScores;
  factor_evidence?: FactorEvidence;
  composite_score?: number;
  rating?: string;
}

interface AnalysisFile {
  date?: string;
  stock_scoring?: StockScoring[];
}

const FACTOR_KEYS = ['technical', 'chip', 'fundamental', 'news', 'mention_heat', 'industry', 'macro', 'valuation', 'governance'];
const DEFAULT_SCORE_FOR_MISSING = 50;
const VALID_PROVENANCE = new Set(['internal_api', 'web', 'transcript', 'missing']);

interface Issue {
  level: 'FAIL' | 'WARN';
  code: string;
  factor?: string;
  msg: string;
}

function auditStock(s: StockScoring): Issue[] {
  const issues: Issue[] = [];
  const evidence = s.factor_evidence ?? {};
  const scores = s.factor_scores ?? {};
  const hasEvidenceField = s.factor_evidence !== undefined;

  if (!hasEvidenceField) {
    // 舊版 entry，先 WARN 不 FAIL (升級期間寬限)
    issues.push({ level: 'WARN', code: s.stock_code, msg: '無 factor_evidence 欄位（升級前 entry）' });
    return issues;
  }

  for (const key of FACTOR_KEYS) {
    const score = scores[key];
    const ev = evidence[key];

    if (score === null || score === undefined) continue;

    if (!ev) {
      issues.push({
        level: 'FAIL',
        code: s.stock_code,
        factor: key,
        msg: `factor_scores.${key}=${score} 但 factor_evidence.${key} 缺漏`,
      });
      continue;
    }

    if (!ev.data_provenance) {
      issues.push({
        level: 'FAIL',
        code: s.stock_code,
        factor: key,
        msg: `factor_evidence.${key} 缺 data_provenance`,
      });
      continue;
    }

    if (!VALID_PROVENANCE.has(ev.data_provenance)) {
      issues.push({
        level: 'FAIL',
        code: s.stock_code,
        factor: key,
        msg: `data_provenance="${ev.data_provenance}" 不在 [internal_api, web, transcript, missing]`,
      });
      continue;
    }

    // web 必須有 sources[] 且每筆有 url + fetched_at + raw_quote
    if (ev.data_provenance === 'web') {
      if (!Array.isArray(ev.sources) || ev.sources.length === 0) {
        issues.push({
          level: 'FAIL',
          code: s.stock_code,
          factor: key,
          msg: `data_provenance=web 但 sources[] 為空 — 疑似編造`,
        });
        continue;
      }
      for (let i = 0; i < ev.sources.length; i++) {
        const src = ev.sources[i];
        if (!src.url || !src.fetched_at || !src.raw_quote) {
          issues.push({
            level: 'FAIL',
            code: s.stock_code,
            factor: key,
            msg: `sources[${i}] 缺 url/fetched_at/raw_quote — 不完整`,
          });
        }
      }
    }

    // missing 時 factor_score 不應該偏離 default
    if (ev.data_provenance === 'missing' && score !== DEFAULT_SCORE_FOR_MISSING && score !== null) {
      issues.push({
        level: 'WARN',
        code: s.stock_code,
        factor: key,
        msg: `data_provenance=missing 但 score=${score} (預期 ${DEFAULT_SCORE_FOR_MISSING})`,
      });
    }
  }

  return issues;
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('用法: tsx audit-youtube-analysis-evidence.ts <analysis.json>');
    process.exit(2);
  }

  const absPath = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  if (!fs.existsSync(absPath)) {
    console.error(`檔案不存在: ${absPath}`);
    process.exit(2);
  }

  const data: AnalysisFile = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
  const scoring = data.stock_scoring ?? [];

  if (scoring.length === 0) {
    console.log('（無 stock_scoring entries）');
    process.exit(0);
  }

  let failCount = 0;
  let warnCount = 0;
  const withEvidence: string[] = [];
  const withoutEvidence: string[] = [];

  for (const s of scoring) {
    const issues = auditStock(s);
    if (s.factor_evidence) withEvidence.push(s.stock_code);
    else withoutEvidence.push(s.stock_code);
    for (const iss of issues) {
      const factor = iss.factor ? `.${iss.factor}` : '';
      if (iss.level === 'FAIL') {
        console.log(`❌ FAIL [${iss.code}${factor}] ${iss.msg}`);
        failCount++;
      } else {
        if (iss.code !== 'WARN' && !iss.msg.includes('升級前 entry')) {
          console.log(`⚠️  WARN [${iss.code}${factor}] ${iss.msg}`);
        }
        warnCount++;
      }
    }
  }

  console.log(`\n=== Audit Report ${data.date ?? ''} ===`);
  console.log(`Total stock_scoring entries: ${scoring.length}`);
  console.log(`  ✅ 已附 factor_evidence: ${withEvidence.length} (${withEvidence.join(', ')})`);
  console.log(`  ⏳ 升級前 (無 evidence): ${withoutEvidence.length}`);
  console.log(`Issues: ${failCount} FAIL, ${warnCount} WARN`);

  if (failCount > 0) {
    console.log(`\n❌ AUDIT FAILED — 有 ${failCount} 筆疑似編造 / 缺證據，禁止發布`);
    process.exit(1);
  }
  console.log(`\n✅ AUDIT PASS — 所有附 evidence 的 entries 證據完整`);
  process.exit(0);
}

main();
