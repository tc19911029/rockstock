import type { IndustryTemplate, PeRange } from './types';

/**
 * 7 大產業合理 PE 區間（SOP 表 + 用戶範例）。
 * 景氣循環股要併看 PB；超高速成長股要警示題材溢價。
 *
 * 對應 SOP 表：
 *   記憶體/面板/航運/鋼鐵     5-10
 *   通路股                     10-15
 *   穩定成熟股                 15-25
 *   高階材料/CCL/PCB           25-50
 *   高成長 AI 半導體/ASIC      40-60
 *   超高速成長題材股           60+（警示）
 *   消費醫藥龍頭（陸股）        20-40
 *   國產替代+高成長半導體（陸股） 40-60
 */
export const INDUSTRY_PE_RANGE: Record<IndustryTemplate, PeRange> = {
  high_growth_asic: { pessimistic: 40, base: 50, optimistic: 60 },
  cyclical: { pessimistic: 5, base: 7, optimistic: 9 },
  distributor: { pessimistic: 10, base: 12, optimistic: 15 },
  stable_mature: { pessimistic: 15, base: 20, optimistic: 25 },
  advanced_material: { pessimistic: 25, base: 35, optimistic: 50 },
  consumer_pharma_leader: { pessimistic: 20, base: 30, optimistic: 40 },
  hype_extreme_growth: { pessimistic: 50, base: 70, optimistic: 100 },
  other: { pessimistic: 12, base: 18, optimistic: 25 },
};

/**
 * 由 FinMind/TWSE 回的 industry_category 字串 → 估值模板。
 * 找不到對應就回 'other'。
 */
const INDUSTRY_KEYWORDS: Array<{ template: IndustryTemplate; patterns: RegExp[] }> = [
  {
    template: 'high_growth_asic',
    patterns: [
      /設計服務/,
      /IC設計/,
      /asic/i,
      /半導體業/,
    ],
  },
  {
    template: 'cyclical',
    patterns: [
      /記憶體/,
      /面板/,
      /航運/,
      /鋼鐵/,
      /塑膠/,
      /橡膠/,
      /水泥/,
      /玻璃/,
      /造紙/,
      /石化/,
    ],
  },
  {
    template: 'distributor',
    patterns: [
      /通路/,
      /電子通路/,
      /貿易百貨/,
    ],
  },
  {
    template: 'advanced_material',
    patterns: [
      /電子零組件/,
      /電路板/,
      /CCL/,
      /PCB/,
      /先進材料/,
      /光電/,
    ],
  },
  {
    template: 'consumer_pharma_leader',
    patterns: [
      /生技醫療/,
      /醫藥/,
      /食品/,
      /消費/,
      /家用電器/,
      /白酒/,
      /中藥/,
    ],
  },
  {
    template: 'stable_mature',
    patterns: [
      /金融保險/,
      /銀行/,
      /保險/,
      /公用事業/,
      /電信/,
      /資訊服務/,
    ],
  },
];

export function detectIndustryTemplate(industryCategory: string | null | undefined): IndustryTemplate {
  if (!industryCategory) return 'other';
  for (const entry of INDUSTRY_KEYWORDS) {
    if (entry.patterns.some((p) => p.test(industryCategory))) {
      return entry.template;
    }
  }
  return 'other';
}

export function getReasonablePeRange(template: IndustryTemplate): PeRange {
  return INDUSTRY_PE_RANGE[template];
}

const TEMPLATE_LABEL: Record<IndustryTemplate, string> = {
  high_growth_asic: '高成長 ASIC / AI 半導體',
  cyclical: '景氣循環股',
  distributor: '通路股',
  stable_mature: '穩定成熟股',
  advanced_material: '高階材料 / PCB',
  consumer_pharma_leader: '消費 / 醫藥龍頭',
  hype_extreme_growth: '超高速成長題材股',
  other: '一般',
};

export function getTemplateLabel(template: IndustryTemplate): string {
  return TEMPLATE_LABEL[template];
}
