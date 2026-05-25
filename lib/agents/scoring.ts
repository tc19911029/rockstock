/**
 * 評分引擎 — 4 大面 0-100 分 + 燈號 + 信心程度 + A-E 等級
 *
 * 設計原則（plan §設計原則）：
 *   1. 評分公式寫在這裡，**不靠 LLM 自評** — Claude 在 answer 內附 raw signals
 *      程式 server-side（orchestrator.persistAgentAnswer）算 scoreBlock 灌進去
 *   2. data_missing 重新加權 — 缺值的 signal 不參與分母，其他 signal 權重等比放大
 *   3. scoringVersion 標記公式版本，未來調權重不破舊資料
 *   4. assignGrade 是規則 + 分數混合 — 純加權平均會讓「Technical fail」被高 chip/news 救起來
 *
 * Note on TDCC 大戶分層：plan §設計原則 第 5 點，100/200/400/1000 分層
 * 只當「資料判讀」(UI 顯示 + reasoning 引用)，不參與 chip 評分權重。
 * 已驗證 3 年 backtest alpha=-4.11%（memory: s_track_holder_accumulation_failed）
 */

import type {
  AgentScoreBlock,
  DataStatus,
  GradeBlock,
  GradeInput,
  ScoreConfidence,
  ScoreLight,
  ScoredAgentId,
  SignalSpec,
  SignalValue,
  StockGrade,
  SuitableFor,
} from './scoringTypes';
import { AGENT_WEIGHTS, SCORING_VERSION } from './scoringTypes';

// ────────────────────────────────────────────────────────────────────────────
// 燈號映射
// ────────────────────────────────────────────────────────────────────────────

export function scoreToLight(score: number): ScoreLight {
  if (score >= 80) return 'green';
  if (score >= 60) return 'yellow_green';
  if (score >= 40) return 'yellow';
  if (score >= 20) return 'orange_red';
  return 'red';
}

/** 燈號的中文標籤（給 UI / log 用）*/
export const LIGHT_LABELS: Record<ScoreLight, string> = {
  green: '綠燈',
  yellow_green: '黃綠',
  yellow: '黃燈',
  orange_red: '橘紅',
  red: '紅燈',
};

// ────────────────────────────────────────────────────────────────────────────
// 各面向 signal 權重表（plan §1.3）
//
// 加總每個 agent 應為 1.0；缺值時動態重新加權
// ────────────────────────────────────────────────────────────────────────────

/**
 * 技術面 signals — 6 個非 penalty + 2 個 penalty
 *
 * 非 penalty weight 加總 = 1.00(plan §1.3 數字 normalize 後);penalty weight 為扣分強度
 */
export const TECHNICAL_SIGNAL_SPECS: SignalSpec[] = [
  { key: 'trendDirection',   label: '日 K 趨勢方向',   weight: 0.20, core: true },
  { key: 'maAlignment',      label: '均線多排向上',    weight: 0.13 },
  { key: 'volumePrice',      label: '量價配合',        weight: 0.12 },
  { key: 'sixConditionsMet', label: '六條件達成數',    weight: 0.25, core: true },
  { key: 'mtfAlignment',     label: 'MTF 多時框一致',  weight: 0.15 },
  { key: 'indicators',       label: 'KD/MACD 輔助',    weight: 0.15 },
  { key: 'longProhibitions', label: '戒律觸犯',        weight: 0.15, penalty: true },
  { key: 'eliminations',     label: '淘汰法 R1-R11',   weight: 0.10, penalty: true },
];

/**
 * 籌碼資金面 signals — 9 個非 penalty + 1 個 penalty
 *
 * 整合 ETF / 投信動向 / 大戶分層(plan §3.3 合進單一面板,不獨立 Agent)
 * 非 penalty 加總 = 1.00
 */
export const CHIP_SIGNAL_SPECS: SignalSpec[] = [
  { key: 'institutionalNet',  label: '三大法人買賣超',  weight: 0.22, core: true },
  { key: 'trustMomentum',     label: '投信動向 stage',  weight: 0.17 },
  { key: 'etfConsensus',      label: '主動式 ETF 共識', weight: 0.11 },
  { key: 'largeHolderTrend',  label: '大戶分層趨勢',    weight: 0.11 },
  { key: 'retailRatio',       label: '散戶占比變化',    weight: 0.05 },
  { key: 'marginBalance',     label: '融資餘額/增減',   weight: 0.11 },
  { key: 'shortLending',      label: '借券賣出',        weight: 0.05 },
  { key: 'dayTradeRatio',     label: '當沖比率',        weight: 0.06 },
  { key: 'concentration',     label: '籌碼集中 / 主力分點', weight: 0.12 },
  { key: 'squeezeRisk',       label: '軋空 / 斷頭風險', weight: 0.10, penalty: true },
];

/** 基本估值面 signals */
export const FUNDAMENTAL_SIGNAL_SPECS: SignalSpec[] = [
  { key: 'revenueYoY',        label: '月營收 YoY',      weight: 0.15, core: true },
  { key: 'epsYoY',            label: 'EPS YoY',         weight: 0.15 },
  { key: 'grossMarginTrend',  label: '毛利率趨勢',      weight: 0.10 },
  { key: 'operatingMargin',   label: '營業利益率',      weight: 0.05 },
  { key: 'roe',               label: 'ROE',             weight: 0.10 },
  { key: 'cashFlow',          label: '現金流 / 自由現金流', weight: 0.05 },
  { key: 'perVsHistorical',   label: '本益比 vs 歷史',  weight: 0.15 },
  { key: 'pbrVsHistorical',   label: 'PB vs 歷史',      weight: 0.10 },
  { key: 'peg',               label: 'PEG',             weight: 0.05 },
  { key: 'dividendYield',     label: '股利殖利率',      weight: 0.05 },
  { key: 'industryComparison', label: '同業估值比較',   weight: 0.05 },
];

/**
 * 消息題材面 signals — 9 個非 penalty + 1 個 penalty
 *
 * 非 penalty 加總 = 1.00
 */
export const NEWS_SIGNAL_SPECS: SignalSpec[] = [
  { key: 'youtubeConsensus',  label: 'YouTube 跨節目共識', weight: 0.26, core: true },
  { key: 'youtubeMentionHeat', label: 'YouTube 提及熱度',  weight: 0.11 },
  { key: 'newsSentiment',     label: '新聞情緒',        weight: 0.11 },
  { key: 'newsRecentCount',   label: '新聞數量 7d',     weight: 0.05 },
  { key: 'materialAnnouncement', label: '重大訊息',     weight: 0.11 },
  { key: 'earningsCall',      label: '法說會 / 簡報',   weight: 0.05 },
  { key: 'brokerTarget',      label: '券商目標價變化',  weight: 0.11 },
  { key: 'industryTheme',     label: '產業題材標籤',    weight: 0.15 },
  { key: 'sectorResonance',   label: '同族群共振',      weight: 0.05 },
  { key: 'overheatedNews',    label: '利多出盡風險',    weight: 0.05, penalty: true },
];

/** 4 大面 signal specs 查詢表 */
export const SIGNAL_SPECS_BY_AGENT: Record<ScoredAgentId, SignalSpec[]> = {
  technical: TECHNICAL_SIGNAL_SPECS,
  chip: CHIP_SIGNAL_SPECS,
  fundamental: FUNDAMENTAL_SIGNAL_SPECS,
  news: NEWS_SIGNAL_SPECS,
};

// ────────────────────────────────────────────────────────────────────────────
// 單一 signal 的 0-100 個別分數計算（程式用，LLM 寫的 score 會被覆蓋）
//
// 規則：
//   - 一般 signal: 用 LLM 在 answer 寫的 score（0-100）— LLM 已根據書本規則評分
//   - penalty signal: 觸發時往下扣（direction='bearish' → 視 score 為扣分強度）
//   - 缺值 (value === null): 跳過該 signal，重新加權其他
//
// 注意：LLM 在 answer 內已被要求填 score（0-100）+ direction，程式只負責「加權整合」與「penalty 處理」
// ────────────────────────────────────────────────────────────────────────────

/**
 * 計算單一 agent 的 0-100 分（程式核心）
 *
 * 演算法：
 *   1. 篩選 value !== null 的 signal（有資料）
 *   2. 累積有資料的 weight 總和 (availableWeight)
 *   3. 正向 signal: score × weight / availableWeight 加進總分
 *   4. penalty signal: 觸發時往下扣（bearish + score>50 → 扣 weight × score）
 *   5. clamp 0-100
 */
export function computeAgentScore(
  agentId: ScoredAgentId,
  signals: Record<string, SignalValue>,
): { score: number; dataStatus: DataStatus; confidence: ScoreConfidence } {
  const specs = SIGNAL_SPECS_BY_AGENT[agentId];

  let positiveAccum = 0;
  let availableWeight = 0;
  let penaltyAccum = 0;
  const available: string[] = [];
  const missing: string[] = [];

  for (const spec of specs) {
    const sig = signals[spec.key];
    const hasValue = sig && sig.value !== null && sig.value !== undefined;
    if (!hasValue) {
      missing.push(spec.key);
      continue;
    }
    available.push(spec.key);

    if (spec.penalty) {
      // 扣分項：bearish + score>0 才扣（score 為扣分強度）
      if (sig.direction === 'bearish') {
        penaltyAccum += spec.weight * clamp(sig.score, 0, 100);
      }
      // 不算進 availableWeight — penalty 不是「合理加權的分子」
    } else {
      availableWeight += spec.weight;
      positiveAccum += spec.weight * clamp(sig.score, 0, 100);
    }
  }

  // 正向分數：按可用 weight 重新歸一化
  const baseScore = availableWeight > 0 ? positiveAccum / availableWeight : 0;
  const finalScore = clamp(Math.round(baseScore - penaltyAccum), 0, 100);

  // 信心程度：看「正向 signal 覆蓋率」（penalty 不算分母）
  const totalNonPenaltyWeight = specs
    .filter((s) => !s.penalty)
    .reduce((a, s) => a + s.weight, 0);
  const coverage = totalNonPenaltyWeight > 0 ? availableWeight / totalNonPenaltyWeight : 0;
  const confidence: ScoreConfidence =
    coverage >= 0.8 ? 'high'
    : coverage >= 0.5 ? 'medium'
    : 'low';

  const dataStatus: DataStatus = {
    available,
    missing,
    partialReason: missing.length > 0
      ? `${missing.length} 個 signal 缺值（${missing.slice(0, 3).join('、')}${missing.length > 3 ? '…' : ''}）`
      : undefined,
  };

  return { score: finalScore, dataStatus, confidence };
}

/**
 * 組裝 AgentScoreBlock — orchestrator 在 persistAgentAnswer 時呼叫
 */
export function buildAgentScoreBlock(
  agentId: ScoredAgentId,
  signals: Record<string, SignalValue>,
): AgentScoreBlock {
  const { score, dataStatus, confidence } = computeAgentScore(agentId, signals);
  return {
    scoringVersion: SCORING_VERSION,
    score,
    light: scoreToLight(score),
    confidence,
    signals,
    dataStatus,
  };
}

/**
 * 是否所有「核心 signal」都缺值（→ verdict='fail' 替代）
 */
export function allCoreSignalsMissing(
  agentId: ScoredAgentId,
  signals: Record<string, SignalValue>,
): boolean {
  const specs = SIGNAL_SPECS_BY_AGENT[agentId];
  const coreSpecs = specs.filter((s) => s.core);
  if (coreSpecs.length === 0) return false;
  return coreSpecs.every((s) => {
    const sig = signals[s.key];
    return !sig || sig.value === null || sig.value === undefined;
  });
}

// ────────────────────────────────────────────────────────────────────────────
// 總分 + A-E grade 計算
// ────────────────────────────────────────────────────────────────────────────

/**
 * 計算 4 面加權總分（缺面向時重新加權）
 */
export function computeTotalScore(input: GradeInput): number {
  const blocks: Array<{ id: ScoredAgentId; score: number }> = [];
  for (const id of ['technical', 'chip', 'fundamental', 'news'] as ScoredAgentId[]) {
    const b = input[id];
    if (b) blocks.push({ id, score: b.score });
  }
  if (blocks.length === 0) return 0;
  const availableWeight = blocks.reduce((a, b) => a + AGENT_WEIGHTS[b.id], 0);
  const weighted = blocks.reduce((a, b) => a + AGENT_WEIGHTS[b.id] * b.score, 0);
  return clamp(Math.round(weighted / availableWeight), 0, 100);
}

/**
 * 規則 + 分數混合判斷 A-E（plan §2.2）
 *
 * 紅線:
 *   - risk='red' → 一律 E
 *   - technical.light='red' → 一律 E
 *   - totalScore<50 → 一律 E
 */
export function assignGrade(input: GradeInput): GradeBlock {
  const total = computeTotalScore(input);
  const t = input.technical;
  const c = input.chip;
  const f = input.fundamental;
  const n = input.news;

  const grade = pickGrade(total, t, c, f, n, input.riskVerdict);
  const reason = buildGradeReason(grade, total, t, c, f, n, input.riskVerdict);
  const suitableFor = pickSuitableFor(grade, t, f);

  return {
    scoringVersion: SCORING_VERSION,
    totalScore: total,
    grade,
    gradeReason: reason,
    suitableFor,
  };
}

function pickGrade(
  total: number,
  t: AgentScoreBlock | null,
  c: AgentScoreBlock | null,
  f: AgentScoreBlock | null,
  n: AgentScoreBlock | null,
  risk: GradeInput['riskVerdict'],
): StockGrade {
  // E 級：硬條件
  if (risk === 'red') return 'E';
  if (t?.light === 'red') return 'E';
  if (total < 50) return 'E';

  // A 級：四面都夠強 + 無風險
  if (
    total >= 80
    && t && (t.light === 'green' || t.light === 'yellow_green')
    && c && (c.light === 'green' || c.light === 'yellow_green')
    && f && f.light !== 'red' && f.light !== 'orange_red'
    && n && n.light !== 'red' && n.light !== 'orange_red'
    && risk !== 'yellow'  // yellow 也降為 B
  ) {
    return 'A';
  }

  // D 級：news + technical 高分但 chip 紅 / fundamental 紅 →「高風險追高股」
  const newsHigh = n && (n.light === 'green' || n.light === 'yellow_green');
  const techHigh = t && (t.light === 'green' || t.light === 'yellow_green');
  const chipBad = c && (c.light === 'red' || c.light === 'orange_red');
  const fundBad = f && (f.light === 'red' || f.light === 'orange_red');
  if (newsHigh && techHigh && (chipBad || fundBad)) {
    return 'D';
  }

  // B 級：總分 ≥ 65 + 技術 / 籌碼不弱
  // 註:t.light !== 'red' 由 E 級早 return 保證(narrow 後 always true),這裡只需擋 orange_red
  if (
    total >= 65
    && t && t.light !== 'orange_red'
    && c && c.light !== 'red' && c.light !== 'orange_red'
  ) {
    return 'B';
  }

  // C 級:總分 50-64,公司條件不差但技術/籌碼未轉強
  if (total >= 50 && total < 65) {
    return 'C';
  }

  // C 級 fallback:總分 ≥ 65 但條件不夠 B 也歸 C(例如 fundamental red)
  return 'C';
}

function buildGradeReason(
  grade: StockGrade,
  total: number,
  t: AgentScoreBlock | null,
  c: AgentScoreBlock | null,
  f: AgentScoreBlock | null,
  n: AgentScoreBlock | null,
  risk: GradeInput['riskVerdict'],
): string {
  const lights = [
    t ? `技術${LIGHT_LABELS[t.light]}` : '技術—',
    c ? `籌碼${LIGHT_LABELS[c.light]}` : '籌碼—',
    f ? `基本${LIGHT_LABELS[f.light]}` : '基本—',
    n ? `消息${LIGHT_LABELS[n.light]}` : '消息—',
  ].join('、');
  const riskTag = risk === 'red' ? '、風控紅燈' : risk === 'yellow' ? '、風控黃燈' : '';

  switch (grade) {
    case 'A':
      return `總分 ${total}（${lights}${riskTag}）— 四面皆強，優先觀察、等買點`;
    case 'B':
      return `總分 ${total}（${lights}${riskTag}）— 主要面向偏多但有瑕疵，短線或波段候選`;
    case 'C':
      return `總分 ${total}（${lights}${riskTag}）— 條件不差但未到位，列觀察名單`;
    case 'D':
      return `總分 ${total}（${lights}${riskTag}）— 題材熱但籌碼/基本面不支援，高風險追高`;
    case 'E':
      return `總分 ${total}（${lights}${riskTag}）— ${risk === 'red' ? '風控紅燈' : t?.light === 'red' ? '技術面崩壞' : '整體偏弱'}，避開`;
  }
}

function pickSuitableFor(
  grade: StockGrade,
  t: AgentScoreBlock | null,
  f: AgentScoreBlock | null,
): SuitableFor {
  if (grade === 'E') return 'avoid';
  if (grade === 'D') return 'observe_only';
  if (grade === 'C') return 'observe_only';
  // A / B
  const techStrong = t && (t.light === 'green' || t.light === 'yellow_green');
  const fundStrong = f && (f.light === 'green' || f.light === 'yellow_green');
  if (grade === 'A' && fundStrong && techStrong) return 'swing';
  if (grade === 'B' && techStrong) return 'short_term';
  if (fundStrong) return 'long_term';
  return 'swing';
}

// ────────────────────────────────────────────────────────────────────────────
// Derived signal helpers — 可從現有 raw 資料推算,不需新資料源
//
// 用途:
//   - skill prompt 內附公式給 LLM 對照
//   - 契約測試 sanity check 算式穩定性
//   - 未來若 enrich 流程要 auto-fill derived signal,可在此擴充
// ────────────────────────────────────────────────────────────────────────────

/**
 * PEG = PER ÷ EPS 成長率(%)
 *
 * 解讀:
 *   - PEG ≤ 1.0  → 90 分(成長被低估)
 *   - 1.0-1.5    → 70 分(合理)
 *   - 1.5-2.0    → 50 分
 *   - > 2.0      → 30 分(成長相對偏貴)
 *   - epsYoY ≤ 0 → null(衰退期不適用 PEG)
 *
 * @param per           本益比(倍)
 * @param epsYoYpct     EPS 年增率(百分比,如 18 代表 +18%)
 * @returns score 0-100 或 null(資料不足/不適用)
 */
export function derivePEG(per: number | null, epsYoYpct: number | null): {
  ratio: number | null;
  score: number | null;
} {
  if (per === null || epsYoYpct === null || epsYoYpct <= 0) {
    return { ratio: null, score: null };
  }
  const ratio = per / epsYoYpct;
  let score: number;
  if (ratio <= 1.0) score = 90;
  else if (ratio <= 1.5) score = 70;
  else if (ratio <= 2.0) score = 50;
  else score = 30;
  return { ratio, score };
}

/**
 * 軋空風險 — 由券資比(融券餘額 / 融資餘額)推算
 *
 * 朱家泓書本 p.135:券資比 > 30% 軋空候選、> 50% 強烈警示
 * 在 v1 評分系統內 `squeezeRisk` 是 penalty signal,direction=bearish 時觸發扣分
 *
 * 解讀:
 *   - ratio < 10%  → score=0、direction=neutral(無軋空訊號)
 *   - 10-30%       → score=30、direction=neutral(微弱)
 *   - 30-50%       → score=60、direction=bearish(候選)
 *   - ≥ 50%        → score=90、direction=bearish(強烈警示)
 *
 * @param marginBalance 融資餘額(張)
 * @param shortBalance  融券餘額(張)
 */
export function deriveSqueezeRisk(
  marginBalance: number | null,
  shortBalance: number | null,
): {
  resvRatio: number | null;
  score: number;
  direction: 'bullish' | 'bearish' | 'neutral';
} {
  if (marginBalance === null || shortBalance === null || marginBalance <= 0) {
    return { resvRatio: null, score: 0, direction: 'neutral' };
  }
  const ratio = (shortBalance / marginBalance) * 100;
  if (ratio >= 50) return { resvRatio: ratio, score: 90, direction: 'bearish' };
  if (ratio >= 30) return { resvRatio: ratio, score: 60, direction: 'bearish' };
  if (ratio >= 10) return { resvRatio: ratio, score: 30, direction: 'neutral' };
  return { resvRatio: ratio, score: 0, direction: 'neutral' };
}

/**
 * ROE 由 FinMind 免費層的 NetIncome + Equity 推算(若無 ROE 直接欄位)
 *
 * 公式:ROE = 稅後淨利 ÷ 平均股東權益 × 100%
 *
 * @param netIncome     稅後淨利(任意單位,只要與 equity 同單位)
 * @param equity        股東權益(同上)
 */
export function deriveROE(netIncome: number | null, equity: number | null): {
  roePct: number | null;
  score: number | null;
} {
  if (netIncome === null || equity === null || equity <= 0) {
    return { roePct: null, score: null };
  }
  const roePct = (netIncome / equity) * 100;
  let score: number;
  if (roePct >= 20) score = 100;
  else if (roePct >= 15) score = 85;
  else if (roePct >= 10) score = 65;
  else if (roePct >= 5) score = 50;
  else if (roePct >= 0) score = 35;
  else score = 15;
  return { roePct, score };
}

/**
 * 自由現金流 = 營業現金流 - 資本支出
 *
 * @param operatingCashFlow  營業活動現金流(任意單位)
 * @param capex              資本支出(同上;通常為正數)
 */
export function deriveFreeCashFlow(
  operatingCashFlow: number | null,
  capex: number | null,
): {
  fcf: number | null;
  score: number | null;
  direction: 'bullish' | 'bearish' | 'neutral';
} {
  if (operatingCashFlow === null || capex === null) {
    return { fcf: null, score: null, direction: 'neutral' };
  }
  const fcf = operatingCashFlow - Math.abs(capex);
  if (fcf > 0 && operatingCashFlow > 0) {
    // 正且穩定 — 取 fcf / operatingCashFlow ratio 給分
    const margin = fcf / operatingCashFlow;
    let score: number;
    if (margin >= 0.5) score = 90;
    else if (margin >= 0.3) score = 75;
    else if (margin >= 0.1) score = 60;
    else score = 50;
    return { fcf, score, direction: 'bullish' };
  }
  if (fcf > 0) return { fcf, score: 55, direction: 'bullish' };  // 轉正
  return { fcf, score: 30, direction: 'bearish' };  // 負
}

// ────────────────────────────────────────────────────────────────────────────
// helper
// ────────────────────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
