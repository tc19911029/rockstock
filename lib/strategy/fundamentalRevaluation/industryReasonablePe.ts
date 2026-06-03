/**
 * 擴充產業合理 PE — 補陸股「國產替代/存儲復甦」模板（2026-05-27）
 *
 * lib/valuation/industryTemplate.ts 已有 7 大模板（高成長 ASIC / 景氣循環 / 通路 / 穩定成熟 /
 * 高階材料 / 消費醫藥 / 超高速成長），對台股夠用但對陸股需要補：
 *
 *   cn_domestic_substitution — 國產替代高成長半導體（DRAM/MCU/EDA/設備），合理 PE 40-60
 *   cn_storage_recovery      — 存儲復甦（兆易創新 case），合理 PE 30-55
 *   cn_consumer_pharma_top   — 陸股消費/醫藥龍頭（白酒/中藥/家電），合理 PE 20-40（已有相當模板，補名稱對應）
 *
 * 對於陸股，industryCategory 字串通常是「半導體」「光學光電子」「電力設備」等 → 用 keyword 對應。
 *
 * 注意：本檔輸出「擴充版」detectIndustryTemplate，原 lib/valuation 的 detectIndustryTemplate
 * 仍可使用作為 TW 預設；陸股 pipeline 走擴充版。
 */

import type { IndustryTemplate, PeRange } from '@/lib/valuation/types';
import {
  INDUSTRY_PE_RANGE,
  detectIndustryTemplate as detectTwTemplate,
  getReasonablePeRange,
  getTemplateLabel,
} from '@/lib/valuation/industryTemplate';

/**
 * 陸股關鍵字 → IndustryTemplate（沿用既有 IndustryTemplate enum，避免 type 爆炸）
 *
 * 陸股「國產替代半導體」對應 IndustryTemplate.high_growth_asic（40-60 範圍剛好）
 * 陸股「存儲復甦」也用 high_growth_asic（30-55 vs 40-60 接近）
 * 陸股「白酒/家電龍頭」對應 consumer_pharma_leader
 * 陸股「煤炭/有色」對應 cyclical
 * 陸股「銀行保險」對應 stable_mature
 */
const CN_INDUSTRY_KEYWORDS: Array<{ template: IndustryTemplate; patterns: RegExp[] }> = [
  {
    template: 'high_growth_asic',
    patterns: [
      /半導體/,
      /集成電路/,
      /芯片/,
      /存儲/,
      /光刻/,
      /設備/,
      /EDA/i,
    ],
  },
  {
    template: 'consumer_pharma_leader',
    patterns: [
      /白酒/,
      /中藥/,
      /生物製品/,
      /醫療器械/,
      /家用電器/,
      /調味發酵品/,
      /休閒食品/,
    ],
  },
  {
    template: 'cyclical',
    patterns: [
      /煤炭/,
      /有色金屬/,
      /鋼鐵/,
      /石油石化/,
      /農化製品/,
      /玻璃/,
      /水泥/,
      /造紙/,
      /工程機械/,
    ],
  },
  {
    template: 'stable_mature',
    patterns: [
      /銀行/,
      /保險/,
      /券商/,
      /證券/,
      /電力/,
      /燃氣/,
      /電信/,
      /公用事業/,
    ],
  },
  {
    template: 'advanced_material',
    patterns: [
      /PCB/i,
      /印製電路板/,
      /CCL/i,
      /電子化學品/,
      /光學光電子/,
      /鋰電/,
    ],
  },
  {
    template: 'distributor',
    patterns: [
      /商業貿易/,
      /電子元器件分銷/,
    ],
  },
  {
    template: 'hype_extreme_growth',
    patterns: [
      /元宇宙/,
      /虛擬數字/,
      /概念/,
    ],
  },
];

/**
 * 偵測產業模板（市場感知）
 *
 * TW：走 lib/valuation/industryTemplate.ts 既有邏輯
 * CN：走擴充的 CN_INDUSTRY_KEYWORDS，找不到再 fallback 給 TW 邏輯
 */
export function detectIndustryTemplateFor(
  market: 'TW' | 'CN',
  industryCategory: string | null | undefined,
  symbol?: string | null,
): IndustryTemplate {
  if (market === 'CN') {
    // 註：CN 仍走 keyword（/半導體/ /存儲/ → high_growth_asic）。CN 半導體細分白名單尚未建，
    //     若 CN 出現同款灌爆需另建 CN 版 SEMI_SYMBOL_TEMPLATE。
    if (industryCategory) {
      for (const entry of CN_INDUSTRY_KEYWORDS) {
        if (entry.patterns.some((p) => p.test(industryCategory))) {
          return entry.template;
        }
      }
    }
    // CN 但沒命中 CN keywords → 試一次 TW 邏輯（symbol 覆寫 + 產業名稱重疊如「電子零組件」）
    return detectTwTemplate(industryCategory, symbol);
  }
  return detectTwTemplate(industryCategory, symbol);
}

/** 直接拿 peRange（語義 alias，保留 valuation/industryTemplate 既有 API） */
export function getReasonablePe(template: IndustryTemplate): PeRange {
  return getReasonablePeRange(template);
}

export { INDUSTRY_PE_RANGE, getTemplateLabel };
