import { z } from 'zod';
import type { DigestResponse, ReasoningSection } from './zhuTypes';

const SECTION_ORDER: ReasoningSection[] = [
  'trend', 'kbar', 'visual', 'chip', 'fundamental', 'news', 'macro', 'action',
];

const dataPointSchema = z.object({
  category: z.enum([
    'technical', 'chip', 'fundamental', 'news',
    'macro', 'valuation', 'governance', 'industry',
  ]),
  label: z.string().min(1),
  value: z.string().min(1),
  source: z.string().min(1),
  asOf: z.string().nullable().optional(),
}).strict();

const rawDigestSchema = z.object({
  schemaVersion: z.literal(3),
  overview: z.string().min(1),
  verdict: z.enum(['進場', '持股', '觀望', '減碼', '出場']),
  verdictReason: z.string().min(1),
  caveat: z.string().nullable().optional(),
  reasoning: z.array(z.object({
    section: z.enum(SECTION_ORDER),
    text: z.string().min(1),
  }).strict()).length(8),
  dataPoints: z.array(dataPointSchema).min(30),
  timestamp: z.string().min(1),
}).strict();

/** 驗證 Codex 結構化輸出並移除 JSON schema 為 nullable 而產生的 null。 */
export function parseZhuDigest(value: unknown, requestTimestamp: string): DigestResponse {
  const parsed = rawDigestSchema.parse(value);
  const sections = parsed.reasoning.map(item => item.section);
  if (sections.some((section, index) => section !== SECTION_ORDER[index])) {
    throw new Error('Codex 分析段落順序不完整');
  }

  const answerMs = Date.parse(parsed.timestamp);
  const requestMs = Date.parse(requestTimestamp);
  if (!Number.isFinite(answerMs) || !Number.isFinite(requestMs) || answerMs < requestMs) {
    throw new Error('Codex 回覆時間早於本次問題');
  }

  return {
    schemaVersion: 3,
    overview: parsed.overview,
    verdict: parsed.verdict,
    verdictReason: parsed.verdictReason,
    caveat: parsed.caveat ?? undefined,
    reasoning: parsed.reasoning,
    dataPoints: parsed.dataPoints.map(point => ({
      ...point,
      asOf: point.asOf ?? undefined,
    })),
    timestamp: parsed.timestamp,
    generatedBy: 'codex',
  };
}
