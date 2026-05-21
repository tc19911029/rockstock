/**
 * 問朱老師 v2 schema — 8 大面向 + 5 燈號 + ABCDE 等級
 *
 * 取代 chart-digest 舊版 `{ verdict, reasoning[7] }` 結構。
 * 用 schemaVersion=2 narrow 前端切新 UI；舊 cache 自動失效。
 *
 * 5 燈號（lights）對應 5 大可量化面向，由 prefetch 用純規則機械算出 suggestedLights，
 * 朱老師可在 reasoning 段尾用 `（覆寫：原因）` 翻案。剩 3 個面向（消息、產業、治理）
 * 融入 news / theme reasoning，由朱老師描述性判斷。
 *
 * 同一份 ZhuLights/Grade 也餵掃描列表（每檔候選 row 算 ABCDE 標籤）。
 */

export type Light = 'green' | 'yellow' | 'red' | 'gray';
export type Grade = 'A' | 'B' | 'C' | 'D' | 'E';

export interface ZhuLights {
  technical: Light;
  chip: Light;
  fundamental: Light;
  theme: Light;
  valuation: Light;
}

/**
 * 8 段 reasoning section 對應書本邏輯
 *
 *   trend       頭頭高/低、起/中/末升段（→ technical light）
 *   kbar        母子線、孕育線、十字、缺口（→ technical light）
 *   visual      screenshot 看到的影線比例、頸線、量價對齊（→ technical light）
 *   chip        三大法人 + 融資融券 + 大戶 + 借券（→ chip light）
 *   fundamental EPS YoY / 營收 / 毛利率 / PER / PBR / 殖利率（→ fundamental light）
 *   news        法說 + 新聞 + 產業題材 + sectorPeers 共振（→ theme light）
 *   macro       大盤 + 美股/美債/匯率（純背景，不對應 light）
 *   action      停損、目標、覆寫說明（不對應 light）
 */
export type ReasoningSection =
  | 'trend' | 'kbar' | 'visual' | 'chip'
  | 'fundamental' | 'news' | 'macro' | 'action';

export interface ReasoningItem {
  section: ReasoningSection;
  /** 若朱老師覆寫了 suggestedLights[對應面向]，這裡放覆寫後的 light 並設 overridden=true */
  light?: Light;
  text: string;
  /** true = 朱老師根據書本判斷推翻 prefetch suggestedLights/Grade */
  overridden?: boolean;
}

export interface DigestResponse {
  /** schema 版本號，前端用來 narrow 新舊版 */
  schemaVersion: 2;
  /** A/B/C/D/E 等級（朱老師可覆寫 suggestedGrade） */
  grade: Grade;
  /** 一句話說明為何打這個 grade（30 字內） */
  gradeReason: string;
  /** 5 燈號最終結果（朱老師可覆寫 suggestedLights） */
  lights: ZhuLights;
  /** 固定 8 段，順序：trend → kbar → visual → chip → fundamental → news → macro → action */
  reasoning: ReasoningItem[];
  /** 一句話總結（30 字內） */
  overview: string;
  /** 快速結論：進場 / 持股 / 觀望 / 減碼 / 出場 */
  verdict: string;
  /** 一句話說為什麼下這個 verdict（30 字內） */
  verdictReason: string;
  /** 風險提醒（選擇性；技術/籌碼/基本面三者不同向時必填） */
  caveat?: string;
  /** server cache 命中標記 */
  cached?: boolean;
}

/** computeChartLights 輸入：chart 模式有 fundamentals/news/marketTrend prefetch */
export interface ChartLightsInput {
  sixCond?: number;                  // 0-6
  trendState?: '多頭' | '空頭' | '盤整' | string;
  closePrice?: number;
  ma20?: number | null;
  ma60?: number | null;
  longProhibitionsCount?: number;
  // 籌碼
  chipScore?: number;                // 0-100，from /api/chip
  consecutiveForeignBuy?: number;    // 連買天數
  consecutiveForeignSell?: number;   // 連賣天數
  marginUtilRate?: number;           // 融資使用率 %
  // 基本面（可能 null：資料缺）
  fundamentals?: {
    eps: number | null;
    epsYoY: number | null;
    revenueMoM: number | null;
    revenueYoY: number | null;
    per: number | null;
    pbr: number | null;
    dividendYield: number | null;
  } | null;
  // 題材：同產業共振檢查
  sectorPeers?: {
    sameIndustryCount: number;       // 同產業在 top10 的檔數
    selfRank: number | null;         // 自己在同產業內排第幾
  } | null;
}

/** computeScanLights 輸入：scan 列表只有候選 row 既有欄位（不打 API） */
export interface ScanLightsInput {
  sixCond: number;                       // 0-6
  trendState?: '多頭' | '空頭' | '盤整' | string;
  longProhibitionsCount?: number;
  chipScore?: number;
  consecutiveForeignBuy?: number;
  // sectorPeers 從 candidates 整批計算後注入
  sameIndustryCount?: number;
  selfRankInIndustry?: number | null;
}
