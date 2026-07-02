/**
 * specScore 權重表（2026-06-12 A3，單一事實）
 *
 * 來源：使用者選股規格書 §四「總分評分模型」的 4 套類型權重，經回測證據裁剪：
 *   - 「大戶持股」剔除 — S 軌 3 年回測 3 版本全負 alpha（commit e16caaf 決議）
 *   - 「自訂指標(三色)」剔除 — 三色已是獨立掃描系統（leaderboard 台股前五全是三色），
 *     塞進加總會稀釋；要看三色去三色掃描 tab
 *   - 「國際消息」剔除 — 無結構化資料源（v1）
 *   剩餘維度保留規格書原始相對比例，計分時按「有資料的維度」重新歸一。
 *
 * 紅線：specScore 是【顯示層】欄位 — 不參與 pool 預設排序（仍是 computeFacetScores.total，
 * POOL_WEIGHTS 單一事實）、不參與任何選股 gate（鐵則 #5）。
 * 合約測試：__tests__/contracts/spec-score-isolation.test.ts
 */

export type SpecStockType = 'general' | 'memory' | 'ai_tech' | 'cyclical';

export const SPEC_STOCK_TYPE_LABEL: Record<SpecStockType, string> = {
  general: '一般股',
  memory: '記憶體股',
  ai_tech: 'AI/ASIC/CPO 題材股',
  cyclical: '景氣循環股',
};

/** 組合徽章顯示文案（merger.computeComboBadges 產生的 id → 中文）*/
export const COMBO_BADGE_LABEL: Record<string, string> = {
  inst_sync_buy: '外資+投信同步買',
  sync_buy_with_tech: '同步買+技術',
  full_house: '4面向全中',
};

/** specScore 維度（v1 可取得資料的集合） */
export type SpecDim =
  | 'market'      // 大盤環境（marketRegime）
  | 'theme'       // 題材階段（sectorRanking stage）
  | 'sector'      // 板塊強弱（sectorRanking 5 日排名 percentile）
  | 'overseas'    // 海外同業動能（TODO：B4 global-peers 落地後接上，v1 = null）
  | 'priceTrend'  // 產業報價趨勢（以海外記憶體同業動能 proxy，v1 = null）
  | 'technical'   // 技術面（pool facet）
  | 'chip'        // 籌碼面（pool facet）
  | 'fundamental' // 基本面（pool facet）
  | 'valuation'   // 估值（data/valuation 三情境上漲空間）
  | 'news';       // 消息熱度（pool youtube facet）

export const SPEC_DIM_LABEL: Record<SpecDim, string> = {
  market: '大盤',
  theme: '題材',
  sector: '板塊',
  overseas: '海外',
  priceTrend: '報價',
  technical: '技術',
  chip: '籌碼',
  fundamental: '基本',
  valuation: '估值',
  news: '消息',
};

/**
 * 各類型維度權重（規格書原始數字，裁剪後不重新湊 100 — 計分時對 covered 維度歸一）。
 * 規格書原表：一般股 技術15/籌碼15/題材12/大盤8/海外8/板塊8/基本8/估值5（裁剪 國際5/自訂8/大戶8）
 *   記憶體股 報價15/籌碼14/海外12/技術12/題材10/基本8/大盤6/估值4（裁剪 國際5/自訂6/大戶8）
 *   AI題材股 題材14/技術14/籌碼14/海外12/基本8/大盤6/估值6/消息3（裁剪 國際7/自訂8/大戶8）
 *   景氣循環 報價18/籌碼15/海外12/技術12/基本12/估值10/大盤8/消息5（裁剪 大戶8）
 */
export const SPEC_WEIGHTS: Record<SpecStockType, Partial<Record<SpecDim, number>>> = {
  general: {
    market: 8, theme: 12, overseas: 8, sector: 8,
    technical: 15, chip: 15, fundamental: 8, valuation: 5,
  },
  memory: {
    market: 6, theme: 10, overseas: 12, priceTrend: 15,
    technical: 12, chip: 14, fundamental: 8, valuation: 4,
  },
  ai_tech: {
    market: 6, theme: 14, overseas: 12,
    technical: 14, chip: 14, fundamental: 8, valuation: 6, news: 3,
  },
  cyclical: {
    market: 8, priceTrend: 18, overseas: 12,
    technical: 12, chip: 15, fundamental: 12, valuation: 10, news: 5,
  },
};
