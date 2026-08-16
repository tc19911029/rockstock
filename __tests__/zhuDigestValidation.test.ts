import { parseZhuDigest } from '@/lib/ai/zhuDigestValidation';
import type { DataCategory, ReasoningSection } from '@/lib/ai/zhuTypes';

const sections: ReasoningSection[] = [
  'trend', 'kbar', 'visual', 'chip', 'fundamental', 'news', 'macro', 'action',
];
const categories: DataCategory[] = [
  'technical', 'chip', 'fundamental', 'news',
  'macro', 'valuation', 'governance', 'industry',
];

function validDigest() {
  return {
    schemaVersion: 3,
    overview: '空頭背景中出現反轉突破',
    verdict: '觀望',
    verdictReason: '等待趨勢確認',
    caveat: null,
    reasoning: sections.map(section => ({ section, text: `${section} 具體分析 67.0 與 73.7` })),
    dataPoints: Array.from({ length: 32 }, (_, index) => ({
      category: categories[index % categories.length],
      label: `數值 ${index}`,
      value: String(index),
      source: 'question.recentCandles',
      asOf: index % 2 ? '2026-08-14' : null,
    })),
    timestamp: '2026-08-16T05:00:00.000Z',
  };
}

describe('parseZhuDigest', () => {
  test('接受完整 Codex v3 回覆並標記 generatedBy', () => {
    const parsed = parseZhuDigest(validDigest(), '2026-08-16T04:00:00.000Z');
    expect(parsed.generatedBy).toBe('codex');
    expect(parsed.reasoning.map(item => item.section)).toEqual(sections);
    expect(parsed.caveat).toBeUndefined();
    expect(parsed.dataPoints[0].asOf).toBeUndefined();
  });

  test('拒絕段落順序錯誤', () => {
    const digest = validDigest();
    [digest.reasoning[0], digest.reasoning[1]] = [digest.reasoning[1], digest.reasoning[0]];
    expect(() => parseZhuDigest(digest, '2026-08-16T04:00:00.000Z'))
      .toThrow('段落順序');
  });

  test('拒絕本次請求之前的殘留答案', () => {
    expect(() => parseZhuDigest(validDigest(), '2026-08-16T06:00:00.000Z'))
      .toThrow('回覆時間早於本次問題');
  });
});
