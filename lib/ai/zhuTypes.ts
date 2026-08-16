/**
 * 問朱老師 v3 schema — 8 段細緻分析 + 30+ 筆 dataPoints
 *
 * v3 設計重點：
 *   - **拔掉 v2 的量化打分**（ABCDE grade、5 燈號 lights）— 用戶要的是質性深度分析，不是機械評等
 *   - **強化「主動取數」** — 朱老師要按 8 大面向逐條 WebSearch 把實際數字撈出來
 *   - **dataPoints array** 讓用戶看到朱老師到底找到了多少數字（目標 30+ 筆）
 *   - reasoning 維持 8 段（trend / kbar / visual / chip / fundamental / news / macro / action），
 *     但每段強制引用 ≥ 2 個具體數字
 *
 * 舊 v2 的 Light/Grade/ZhuLights/ChartLightsInput/ScanLightsInput 已全拔。
 */

/**
 * 8 段 reasoning section 對應書本邏輯 + 8 大面向
 *
 *   trend       頭頭高/低、起/中/末升段
 *   kbar        母子線、孕育線、十字、缺口、MA 排列、量價
 *   visual      screenshot 看到的影線比例、頸線、量價對齊（純圖看出來的）
 *   chip        三大法人 + 融資融券 + 大戶 + 借券
 *   fundamental EPS YoY / 營收 / 毛利率 / ROE / 負債比
 *   news        法說 + 新聞 + 產業題材 + sectorPeers 共振 + 券商目標價
 *   macro       大盤 + 美股/美債/匯率/利率
 *   action      停損、目標、操作建議
 */
export type ReasoningSection =
  | 'trend' | 'kbar' | 'visual' | 'chip'
  | 'fundamental' | 'news' | 'macro' | 'action';

/**
 * dataPoints 的 8 種分類 — 對應 8 大面向，前端按此分組顯示
 */
export type DataCategory =
  | 'technical' | 'chip' | 'fundamental' | 'news'
  | 'macro' | 'valuation' | 'governance' | 'industry';

/**
 * 朱老師找到的單筆數值
 *
 * 範例：
 *   { category: 'chip', label: '外資 5 日累計買賣超', value: '+12,400 張',
 *     source: 'prefetch.institutional', asOf: '2026-05-21' }
 *   { category: 'macro', label: '美國 10 年期殖利率', value: '4.32%',
 *     source: 'WebSearch: investing.com 5/21', asOf: '2026-05-21' }
 *   { category: 'governance', label: '董監質押比', value: 'WebSearch 無結果',
 *     source: 'WebSearch 無結果' }
 */
export interface DataPoint {
  category: DataCategory;
  label: string;
  /** 保留單位的字串，例：「+12,400 張」「PER 18.5」「4.32%」 */
  value: string;
  /** 'prefetch.X' / 'WebSearch: <site> <date>' / 'WebSearch 無結果' */
  source: string;
  /** ISO date 或日期描述：「2026-05-21」「2026Q1」「近 1 週」 */
  asOf?: string;
}

export interface ReasoningItem {
  section: ReasoningSection;
  /** 強制要件：≥ 2 個具體數字，每個數字後括號標時間/來源 */
  text: string;
}

export interface DigestResponse {
  /** schema 版本號，前端用來 narrow 新舊版（v3 = 拔 ABCDE 後的版本） */
  schemaVersion: 3;
  /** 一句話總結（30 字內） */
  overview: string;
  /** 快速結論：進場 / 持股 / 觀望 / 減碼 / 出場 */
  verdict: string;
  /** 一句話說為什麼下這個 verdict（30 字內） */
  verdictReason: string;
  /** 風險提醒（選擇性） */
  caveat?: string;
  /** 固定 8 段，順序：trend → kbar → visual → chip → fundamental → news → macro → action */
  reasoning: ReasoningItem[];
  /** 朱老師找到的所有具體數值，目標 30+ 筆（contract 門檻 10 筆） */
  dataPoints: DataPoint[];
  /** server cache 命中標記 */
  cached?: boolean;
  /** 分析完成時間；新 Codex 流程會填入。 */
  timestamp?: string;
  /** 避免把舊 Claude localStorage 結果誤標成 Codex。 */
  generatedBy?: 'codex';
}
