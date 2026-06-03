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
      // ⚠️ 不再放 /半導體業/ blanket：TWSE/FinMind 對所有半導體股都只回「半導體業」，
      // 底下不分 DRAM/成熟代工/封測/IC設計，一律 → PE 50 會把循環/成熟股的合理價灌爆
      // （威剛合理價 5596 vs 現價 462、+1111%、還被拱成補漲第 1）。半導體細分改走
      // SEMI_SYMBOL_TEMPLATE symbol 級白名單；未列入者落回 'other'(中性 PE)。
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

/**
 * 半導體細分白名單（symbol 級覆寫，2026-06-03）
 *
 * TWSE industry_category 對所有半導體股一律回「半導體業」，無法分 DRAM/代工/封測/IC設計。
 * 過去 /半導體業/ → high_growth_asic(PE 40/50/60) 把記憶體模組(威剛)、DRAM(南亞科)、成熟代工
 * (聯電)、封測/測試(日月光/京元/頎邦) 全灌成 PE 50 → 合理價爆炸、補漲排名污染。
 *
 * 改用精準白名單分流：只有真·高成長（晶圓代工龍頭 / IC 設計 / ASIC / 矽智財 IP）走
 * high_growth_asic；DRAM/記憶體 → cyclical(PE 5-9，併看 PB)；成熟代工/封測/測試 →
 * stable_mature(PE 15-25)。未列入的半導體股落回 'other'(中性 PE 12/18/25)，不再預設高成長。
 * 代號均比對 stock-master.json 確認。要加新股先查代號再加。
 */
export const SEMI_SYMBOL_TEMPLATE: Record<string, IndustryTemplate> = {
  // 真·高成長：晶圓代工龍頭 / IC 設計 / ASIC / IP
  '2330': 'high_growth_asic', // 台積電
  '2454': 'high_growth_asic', // 聯發科
  '3661': 'high_growth_asic', // 世芯-KY (ASIC)
  '3443': 'high_growth_asic', // 創意 (ASIC)
  '6643': 'high_growth_asic', // M31 (矽智財 IP)
  '3529': 'high_growth_asic', // 力旺 (矽智財 IP)
  '3035': 'high_growth_asic', // 智原 (ASIC/IP)
  '6533': 'high_growth_asic', // 晶心科 (CPU IP)
  '4966': 'high_growth_asic', // 譜瑞-KY (高速傳輸 IC)
  '5274': 'high_growth_asic', // 信驊 (BMC IC)
  // DRAM / 記憶體 / 模組 → 景氣循環
  '2408': 'cyclical', // 南亞科 (DRAM)
  '3260': 'cyclical', // 威剛 (DRAM 模組)
  '2344': 'cyclical', // 華邦電 (DRAM/NOR)
  '8299': 'cyclical', // 群聯 (NAND 控制/模組)
  '2337': 'cyclical', // 旺宏 (NOR/NAND)
  '4967': 'cyclical', // 十銓 (記憶體模組)
  // 成熟代工 / 封測 / 測試 → 穩定成熟
  '2303': 'stable_mature', // 聯電 (成熟代工)
  '3711': 'stable_mature', // 日月光投控 (封測)
  '2449': 'stable_mature', // 京元電子 (測試)
  '6147': 'stable_mature', // 頎邦 (封測)
  '3105': 'stable_mature', // 穩懋 (GaAs 代工)
  '6239': 'stable_mature', // 力成 (封測)
  '8150': 'stable_mature', // 南茂 (封測)
  '2329': 'stable_mature', // 華泰 (封測)
};

export function detectIndustryTemplate(
  industryCategory: string | null | undefined,
  symbol?: string | null,
): IndustryTemplate {
  // symbol 級覆寫優先（半導體細分白名單）
  if (symbol) {
    const bare = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    const override = SEMI_SYMBOL_TEMPLATE[bare];
    if (override) return override;
  }
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
