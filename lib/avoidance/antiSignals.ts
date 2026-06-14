/**
 * 統計型反指標目錄（A3）— 「現在什麼別碰」的單一事實。
 *
 * 來源：2 年回測 + 49-agent 對抗驗證的最穩健結論——**反指標比正向訊號可信**。
 * 這裡只收「模式型 / 事件型」反指標（統計上穩健、跨期一致），給「避雷清單」與教學用。
 *
 * ⚠️ 邊界（不可違反）：**價量型避雷（高檔長上影 / 爆量長黑 / 爆量收弱）回測證實「反向」**
 *    —— 帶這些旗標的股報酬反而更好（[[avoidance_layer_price_signals_reverse]]）。
 *    所以價量型**不收進反指標、更不可當硬排除**。本目錄與「硬剔除」無關，只做標示/教學。
 *
 * 純模組（無 IO），client / route / script 任意 import。
 */

export type AntiSeverity = 'high' | 'medium';
export type AntiMarket = 'TW' | 'CN' | 'both';

export interface AntiSignalDef {
  id: string;
  title: string;          // 白話「別碰」描述
  market: AntiMarket;
  severity: AntiSeverity;
  evidence: string;       // 回測證據（誠實附樣本/視窗 caveat）
  /** 觸發條件（人類可讀；evalAntiSignals 用對應欄位判定）。 */
  rule: string;
}

/** 反指標目錄（單一事實）。改動需有回測證據、並更新合約測試。 */
export const ANTI_SIGNALS: readonly AntiSignalDef[] = [
  {
    id: 'cn_daban_hot_phase',
    title: '陸股「熱階段」追漲停 / 打板',
    market: 'CN',
    severity: 'high',
    evidence: '打板×主升/分歧/高潮 d5 超額 −1.2~−1.7%（n 數千，四段行情一致）；唯「修復」階段不虧。經典追高接刀。',
    rule: '情緒階段 ∈ {主升, 分歧, 高潮} 且 為當日漲停/打板候選',
  },
  {
    id: 'cn_hardscore_high',
    title: '陸股 hard_score 爆高（尤其漲停結構子分高）',
    market: 'CN',
    severity: 'high',
    evidence: 'hard_score 最高 5 檔隔日進場 d20 超額中位 −9%、勝率 ~30%；分數五分位單調，越高分越爛。元兇=追漲停結構子分。',
    rule: 'hardScoreTotal 高分（top 五分位）或 limitStructure 子分高',
  },
  {
    id: 'cn_tier_c',
    title: '陸股 tier C / ST / 退市風險股',
    market: 'CN',
    severity: 'high',
    evidence: 'tier C cohort d5 −1.59%、超額 −2.07%、勝率 39%。股本身質量差，「避開」方向正確。',
    rule: 'hardScoreTier === C 或 ST/退市名單',
  },
  {
    id: 'broker_bullish',
    title: '法人券商報告「看多 / 調升目標價」的熱股',
    market: 'both',
    severity: 'medium',
    evidence: 'broker_bullish d5 −8.82%、勝率 0%（n=31，小樣本、方向參考）。多為已漲多的熱股回顧，報告出來常是末段。',
    rule: '個股近期有法人報告看多 / 調升評等（當資訊看，不當買訊）',
  },
  {
    id: 'youtube_raw_bullish',
    title: 'YouTube 老師「只看有沒有講」的原始看多（無 9 維評級）',
    market: 'both',
    severity: 'medium',
    evidence: 'youtube 原始 bullish d5 −2.47% vs 過 A/B 評級 +2.29%（差 +4.8pp）。看評級不要看「有沒有被提到」。',
    rule: '個股被 YouTube 提及但未過 A/B 評級（raw mention only）',
  },
] as const;

/** evalAntiSignals 輸入：能拿到多少填多少（皆 optional，缺的不判）。 */
export interface AntiSignalContext {
  market?: AntiMarket;
  cnEmotionPhase?: string;        // '主升'|'分歧'|'高潮'|'修復'|… （cn-agents cycle）
  isLimitUpChase?: boolean;       // 當日漲停/打板候選
  hardScoreTopQuintile?: boolean; // hard_score 居最高五分位
  hardScoreTier?: 'A' | 'B' | 'C';
  isST?: boolean;                 // ST / 退市風險
  brokerBullish?: boolean;        // 近期法人報告看多/調升
  youtubeRawBullishNoRating?: boolean; // YouTube 提及但無 A/B 評級
}

export interface AntiSignalHit {
  id: string;
  title: string;
  severity: AntiSeverity;
  why: string;
}

const HOT_PHASES = new Set(['主升', '分歧', '高潮']);

/** 依現有 context 判定命中的反指標（缺資料的條款自動略過，不誤報）。 */
export function evalAntiSignals(ctx: AntiSignalContext): AntiSignalHit[] {
  const hits: AntiSignalHit[] = [];
  const byId = (id: string) => ANTI_SIGNALS.find((s) => s.id === id)!;
  const push = (id: string, why: string) => {
    const d = byId(id);
    hits.push({ id: d.id, title: d.title, severity: d.severity, why });
  };

  if (ctx.cnEmotionPhase && HOT_PHASES.has(ctx.cnEmotionPhase) && ctx.isLimitUpChase) {
    push('cn_daban_hot_phase', `情緒階段「${ctx.cnEmotionPhase}」追漲停 — 回測系統性虧`);
  }
  if (ctx.hardScoreTopQuintile) {
    push('cn_hardscore_high', 'hard_score 居最高五分位 — 越高分事後越弱');
  }
  if (ctx.hardScoreTier === 'C' || ctx.isST) {
    push('cn_tier_c', ctx.isST ? 'ST / 退市風險' : 'hard_score tier C');
  }
  if (ctx.brokerBullish) {
    push('broker_bullish', '法人報告看多 — 本窗口為反指標（當資訊看）');
  }
  if (ctx.youtubeRawBullishNoRating) {
    push('youtube_raw_bullish', '只被提到、未過 A/B 評級 — 原始看多是反指標');
  }
  return hits;
}

/** 給 UI 教學卡用：價量型「假避雷」明確排除說明（回測反向）。 */
export const PRICE_VOLUME_NOT_AVOID_NOTE =
  '注意：高檔長上影、爆量長黑、爆量收弱這類「價量危險訊號」回測證實「反而報酬更好」（高關注/洗盤後再攻），' +
  '所以它們不是避雷、更不可當作不買的理由。真正該避的是上面這幾種「模式型/事件型」反指標。';
