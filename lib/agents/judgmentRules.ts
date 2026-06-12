/**
 * Chip / Fundamental / News Agent 判讀規則清單（2026-06-12 A1）
 *
 * 性質 = 「描述性判讀指引」，給對話中的 skill（/multi-agent-decide）在 reasoning
 * 引用對應 ruleId 用 — 跟 technicalAgent 的 bookRulesRef 同位階，但來源不是書本，
 * 是使用者的選股規格書（2026-06-12）經回測證據修正後的版本。
 *
 * 紅線：
 *   - 這份清單【不參與程式計分】，不接 scoring.ts、不接任何 gate（鐵則 #5）
 *   - 已被回測反駁的方向必須帶 ⚠️ caveat，skill 引用時不可拿來當 pass 主因：
 *     · 大戶持股：S 軌 3 年回測 3 版本全負 alpha（20d −4.11%/−1.50%/−2.91%），已棄置
 *     · 法人/節目看多：來源歸因樣本窗 broker_bullish d5 超額 −4.63%（勝率 0%）、
 *       youtube_bullish −3.39% — 「看多熱度」在樣本窗是反指標
 *   - 改這份清單不需要跑回測（純描述），但「升級成計分」必須先過
 *     scripts/backtest-unified-leaderboard.ts 變體驗證（見計畫 Phase 6）
 */

export interface JudgmentRule {
  /** c-XX / f-XX / n-XX */
  id: string;
  label: string;
  /** 判讀方向與注意事項（含證據 caveat） */
  guidance: string;
}

/** 籌碼面判讀（規格書 agent 8 同步買矩陣 + 融資券 + 借券當沖 + agent 9 大戶，經證據修正） */
export const CHIP_JUDGMENT_RULES: JudgmentRule[] = [
  { id: 'c-01', label: '外資+投信同步買', guidance: '兩者同日淨買超且連續多日 → 籌碼面最強組合。⚠️ 來源歸因樣本窗顯示法人看多非正向指標，只可描述事實，不可單獨作為 pass 主因。' },
  { id: 'c-02', label: '外資投信分歧', guidance: '一買一賣 → 看誰主導（張數量級）與股價反應；外資買投信賣且股價弱 = 警示。' },
  { id: 'c-03', label: '法人買但股價不漲', guidance: '明處買暗處賣（陳威良觀點），連續多日出現 → 警示，不是低接理由。' },
  { id: 'c-04', label: '連買天數與占成交量比', guidance: '連買 ≥3 日且單日買超占成交量比高（>10%）→ 控盤度高；占比低的連買參考價值低。' },
  { id: 'c-05', label: '股價漲＋融資減', guidance: '籌碼從散戶轉法人/大戶 → 健康上漲。' },
  { id: 'c-06', label: '融資暴增', guidance: '融資餘額短期暴增（如 5 日 >20%）→ 散戶追高，回檔賣壓重 → 警示。' },
  { id: 'c-07', label: '股價跌＋融資增', guidance: '散戶逆勢接刀 → 套牢風險，續跌時有斷頭壓力。' },
  { id: 'c-08', label: '券資比高＋股價強', guidance: '軋空可能；配合融券回補觀察。' },
  { id: 'c-09', label: '借券賣出暴增', guidance: '放空部位增加 → 警示；但若股價持續強，反成軋空燃料。' },
  { id: 'c-10', label: '當沖比過高', guidance: '當沖占比 >40% → 投機資金主導、隔日賣壓 → 警示。' },
  { id: 'c-11', label: '大戶持股增減', guidance: '⚠️ 僅描述事實供人工判讀。S 軌 3 年回測 3 版本全負 alpha（最強訊號 20d −4.11%）已棄置 — 不可作為 verdict 依據，籌碼集中常是主力 distribute 而非建倉。' },
];

/** 基本面判讀（規格書 agent 10 的 12 條規則） */
export const FUNDAMENTAL_JUDGMENT_RULES: JudgmentRule[] = [
  { id: 'f-01', label: '月營收 YoY 成長', guidance: '年增率為主要動能指標；連續多月加速 → 強。' },
  { id: 'f-02', label: '月營收 MoM 成長', guidance: '月增率需排除季節性（對比去年同期的 MoM 型態）。' },
  { id: 'f-03', label: '累計營收 YoY', guidance: '平滑單月波動，確認全年趨勢。' },
  { id: 'f-04', label: 'EPS 成長', guidance: '季增/年增皆看；EPS 是估值錨。' },
  { id: 'f-05', label: '毛利率上升', guidance: '產品組合改善或漲價 → 品質最高的成長。' },
  { id: 'f-06', label: '營益率/淨利率上升', guidance: '營運槓桿發揮；與毛利率背離時找費用面原因。' },
  { id: 'f-07', label: '營收成長但毛利率下滑', guidance: '殺價搶單疑慮 → 中性偏負，需確認是否策略性。' },
  { id: 'f-08', label: '營收成長但 EPS 沒跟上', guidance: '業外侵蝕或股本稀釋 → 扣分方向，找原因。' },
  { id: 'f-09', label: '存貨大增', guidance: '跌價損失風險 → 警示；備貨型產業（缺貨漲價前）例外，需說明依據。' },
  { id: 'f-10', label: '應收帳款大增', guidance: '塞貨/收款風險 → 警示，特別是營收同步衝高時。' },
  { id: 'f-11', label: '股本膨脹', guidance: '增資/GDR/私募/可轉債 → 稀釋風險；進行中的案件看 dilution 事件資料。' },
  { id: 'f-12', label: '負債比/現金流惡化', guidance: '營運現金流連續為負或負債比陡升 → 警示。' },
];

/** 消息面判讀（規格書 agent 12 節目熱度 + agent 13 事件風險，經證據修正） */
export const NEWS_JUDGMENT_RULES: JudgmentRule[] = [
  { id: 'n-01', label: '多節目同日提及', guidance: '跨節目共識 = 關注度高。⚠️ youtube_bullish 樣本窗 d5 超額 −3.39% — 提及≠買進訊號，描述熱度即可。' },
  { id: 'n-02', label: '高命中率老師提及', guidance: '老師歷史命中率（/youtube/teachers 排行）可作可信度參考；低命中率老師的吹捧反而是雜訊。' },
  { id: 'n-03', label: '提前講 vs 漲完才講', guidance: '提及時股價尚未動 → 資訊價值高；已大漲後才提及 → 落後吹捧，警示。' },
  { id: 'n-04', label: '節目過熱', guidance: '多節目同時吹捧 + 股價高檔 → 散戶關注度見頂警示；極端時應反映到 Risk yellow。' },
  { id: 'n-05', label: '重大事件臨近', guidance: '法說/財報/除權息 T-3 內 → 事件風險（Risk red 域，本 agent 標註即可）。' },
  { id: 'n-06', label: 'GDR/增資/可轉債進行中', guidance: '稀釋與折價定價壓力 → 警示；定價日前外資常有套利賣壓。' },
  { id: 'n-07', label: '處置股/注意股', guidance: '處置 = 分盤交易制度層排除（Risk red 域）；注意 = 警示。' },
  { id: 'n-08', label: '券商報告評等', guidance: '晨報/法人報告提及與目標價。⚠️ broker_bullish 樣本窗 d5 超額 −4.63%、勝率 0% — 引用需保守，目標價當參考座標而非依據。' },
];
