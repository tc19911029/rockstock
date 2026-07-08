/**
 * ETF 體檢 — 課程 CH12「ETF 專家課程」落地（顯示層／教學層）
 *
 * 為什麼存在：CH12 教「總報酬率＝資本利得＋股息」、四大誤區、篩選要點、2026 建議配置。
 * 其中「誤區三：成分股高度重疊」是唯一能用 rockstock 現有持股快照「算出真數字」的避雷點
 * （北極星＝賺多賠少，避雷最可信）。其餘（填息力、內扣費用率、收益平準金、週轉率）
 * rockstock 目前無資料源，一律做成「觀察指標」教學卡，不編造數值。
 *
 * ⚠️ 純顯示／教學層：不進選股鏈路、不加分、不違反基本要求 #5、#6。
 * 課程權威原文照抄進常數，不自創門檻。
 */
import type { ETFHolding } from './types';

// ────────────────────────────────────────────────────────────────────────────
// 一、成分股重疊度（誤區三，可從現有持股快照計算的真數字）
// ────────────────────────────────────────────────────────────────────────────

export interface ETFHoldingsInput {
  etfCode: string;
  etfName: string;
  holdings: ETFHolding[];
  disclosureDate: string;
}

/** 一檔個股「被幾檔 ETF 前 N 大持有」的集中度 */
export interface SharedHoldingEntry {
  symbol: string;
  name: string;
  /** 前 N 大持有這檔的 ETF 代號 */
  etfCodes: string[];
  /** 被幾檔 ETF 前 N 大持有 */
  count: number;
  /** 這些 ETF 對該股的加總權重 %（衡量「集體重壓」程度） */
  totalWeight: number;
  /** 平均權重 % */
  avgWeight: number;
}

/** 兩檔 ETF 前 N 大成分股的重疊 */
export interface OverlapPair {
  aCode: string;
  aName: string;
  bCode: string;
  bName: string;
  /** 前 N 大共同持有的檔數 */
  sharedCount: number;
  /** 重疊度 % = sharedCount / effectiveN（effectiveN = min(前N, 兩邊實際檔數)） */
  overlapPct: number;
  /** 共同持有的個股名（依 A 的權重排序） */
  sharedNames: string[];
}

/** 取一檔 ETF 前 N 大持股（依權重 desc；權重相同保持原序） */
function topHoldings(holdings: ETFHolding[], topN: number): ETFHolding[] {
  return [...holdings]
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, topN);
}

/**
 * 個股集中榜：哪些個股被最多檔 ETF 的前 N 大同時持有。
 * 直接對應誤區三「買 5 支不同 ETF 以為分散，其實前十大重疊 → 單一產業回檔集體重挫」。
 */
export function computeSharedHoldings(
  inputs: ETFHoldingsInput[],
  topN = 10,
): SharedHoldingEntry[] {
  const bySymbol = new Map<string, { name: string; codes: string[]; weights: number[] }>();
  for (const etf of inputs) {
    for (const h of topHoldings(etf.holdings, topN)) {
      const key = h.symbol;
      const cur = bySymbol.get(key) ?? { name: h.name, codes: [], weights: [] };
      // 名稱優先用中文（純數字代號常有本地化名）；已存在就保留
      if (!cur.name && h.name) cur.name = h.name;
      cur.codes.push(etf.etfCode);
      cur.weights.push(h.weight ?? 0);
      bySymbol.set(key, cur);
    }
  }
  const out: SharedHoldingEntry[] = [];
  for (const [symbol, v] of bySymbol) {
    const totalWeight = v.weights.reduce((s, w) => s + w, 0);
    out.push({
      symbol,
      name: v.name || symbol,
      etfCodes: v.codes,
      count: v.codes.length,
      totalWeight: +totalWeight.toFixed(2),
      avgWeight: +(totalWeight / v.codes.length).toFixed(2),
    });
  }
  // 被越多 ETF 持有排越前；同數量看加總權重
  return out.sort((a, b) => b.count - a.count || b.totalWeight - a.totalWeight);
}

/**
 * 兩兩 ETF 前 N 大重疊度。回傳依重疊度 desc 排序。
 * minOverlapPct：只回傳達門檻的配對（預設 0 = 全部）。
 */
export function computeOverlapPairs(
  inputs: ETFHoldingsInput[],
  topN = 10,
  minOverlapPct = 0,
): OverlapPair[] {
  const tops = inputs.map((etf) => ({
    ...etf,
    top: topHoldings(etf.holdings, topN),
    topSet: new Set(topHoldings(etf.holdings, topN).map((h) => h.symbol)),
  }));

  const pairs: OverlapPair[] = [];
  for (let i = 0; i < tops.length; i++) {
    for (let j = i + 1; j < tops.length; j++) {
      const A = tops[i];
      const B = tops[j];
      const effectiveN = Math.min(topN, A.top.length, B.top.length);
      if (effectiveN === 0) continue;
      // 共同持股依 A 的權重排序呈現
      const sharedHoldings = A.top.filter((h) => B.topSet.has(h.symbol));
      const sharedCount = sharedHoldings.length;
      const overlapPct = +((sharedCount / effectiveN) * 100).toFixed(1);
      if (overlapPct < minOverlapPct) continue;
      pairs.push({
        aCode: A.etfCode,
        aName: A.etfName,
        bCode: B.etfCode,
        bName: B.etfName,
        sharedCount,
        overlapPct,
        sharedNames: sharedHoldings.map((h) => h.name || h.symbol),
      });
    }
  }
  return pairs.sort((a, b) => b.overlapPct - a.overlapPct || b.sharedCount - a.sharedCount);
}

/** 重疊度分級（課程口徑：70%+ 屬高度重疊，等於沒分散） */
export type OverlapLevel = 'high' | 'medium' | 'low';
export function overlapLevel(pct: number): OverlapLevel {
  if (pct >= 70) return 'high';
  if (pct >= 40) return 'medium';
  return 'low';
}

// ────────────────────────────────────────────────────────────────────────────
// 二、課程教學／觀察指標（原文照抄，無資料源者不編造數值）
// ────────────────────────────────────────────────────────────────────────────

/** 12-2 ETF 四大誤區 */
export interface Pitfall {
  id: string;
  title: string;
  myth: string;
  truth: string;
  checks: string[];
}

export const ETF_FOUR_PITFALLS: Pitfall[] = [
  {
    id: 'yield-trap',
    title: '誤區一：配息率越高越好',
    myth: '以為配息 10% 就是賺 10%。',
    truth: 'ETF 若無法填息，配息只是「左手換右手」。',
    checks: [
      '檢查「收益平準金」的佔比，是否過度動用本金來配息。',
      '關注「填息天數」，而非僅看配息金額。',
      '配息後股價遲遲回不到除息前淨值，領到的可能是自己的本金。',
    ],
  },
  {
    id: 'size-safety',
    title: '誤區二：規模大就是安全？',
    myth: 'ETF 有幾千億規模，絕對不會倒，隨便買都安全。',
    truth: '規模過大存在「流動性與績效鈍化」風險——像大象轉身，換股時買貴賣低、追蹤誤差擴大，報酬落後指數。',
    checks: [
      '規模急遽膨脹後，績效是否開始「跟不上指數」。',
      '偏好規模適中（約數百億）且交易量活躍的標的。',
    ],
  },
  {
    id: 'overlap',
    title: '誤區三：成分股「高度重疊」，風險沒分散',
    myth: '買了 5 支不同的高股息 ETF，以為很分散。',
    truth: '高股息 ETF 選股邏輯趨同、過度集中特定成熟產業，前十大成分股重疊度可能高達 70% 以上。',
    checks: [
      '單一產業回檔時，高度重疊的 ETF 會集體重挫，完全失去分散功能。',
      '用下方「成分股重疊度」實際檢查手中／候選 ETF 的前十大是否雷同。',
    ],
  },
  {
    id: 'turnover-cost',
    title: '誤區四：忽視「換股成本」，內耗啃食本金',
    myth: 'ETF 換股越快，越能跟上市場熱點。',
    truth: '頻繁換股會產生高額交易稅與手續費，這些通通扣在淨值裡。',
    checks: [
      '注意「週轉率」過高的 ETF，內扣費用可能比想像中驚人。',
    ],
  },
];

/** 12-3 篩選 ETF 要點 */
export const ETF_SCREENING_POINTS: Array<{ title: string; detail: string }> = [
  { title: '從「過去配多少」轉向「未來賺多少」', detail: '只有公司持續賺錢，高配息才不是曇花一現。' },
  { title: '嚴查「填息力」而非「配息頻率」', detail: '配息頻率（月配／季配）只是心理安慰，「填息率」才是資產有無成長的硬指標。' },
  { title: '內扣成本的「隱形天花板」', detail: '2026 高競爭環境下，總費用率（管理費＋保管費＋交易手續費）若超過 0.8% 便屬偏高；長期投資中，微小差距決定最終拿回多少利潤。' },
];

/** 12-3 2026 建議配置（課程參考標的，非投資建議、純教學顯示） */
export interface AllocationTier {
  tier: string;
  weightPct: number;
  goal: string;
  risk: string;
  tickers: string[];
  strategy: string;
}

export const ETF_ALLOCATION_2026: AllocationTier[] = [
  {
    tier: '核心配置',
    weightPct: 50,
    goal: '市值型 ETF',
    risk: '中',
    tickers: ['0050', '006208', '00922'],
    strategy: '市值型標的含息報酬率穩定領先；0050／006208 鎖定台股龍頭；00922 加入企業轉型權重。',
  },
  {
    tier: '衛星配置',
    weightPct: 30,
    goal: '高息型 ETF',
    risk: '中低',
    tickers: ['00713', '00878', '00919'],
    strategy: '00713 低波動、空頭表現佳；00878 週轉率與配息最平衡；00919 填息能力優異、能博取更高股息。',
  },
  {
    tier: '攻擊配置',
    weightPct: 20,
    goal: '主動式／產業型 ETF',
    risk: '中高',
    tickers: ['主動式ETF', '00830'],
    strategy: '2026 進入主動式 ETF 戰場，專業經理人應對產業輪動；00830 鎖定半導體上游。',
  },
];

/** 12-4 主動式 ETF 五大優勢 */
export const ACTIVE_ETF_ADVANTAGES: Array<{ title: string; detail: string }> = [
  { title: '破解「成分股僵化」的束縛', detail: '經理人隨時監控，成分股基本面轉壞可立即汰弱留強，不須死守指數規則。' },
  { title: '應對「AI 產業大分化」時代', detail: '2026 AI 進入實質獲利考驗期，經理人透過實地訪查與深度研究，過濾有題材無獲利的泡沫股。' },
  { title: '解決「大象轉身難」的交易成本', detail: '採分批進場或擇時操作，避免在特定日期與數千億資金擠門縫，降低追蹤誤差。' },
  { title: '空頭市場的「防禦性操作」', detail: '被動型必須滿水位持股；主動式可調整現金比率或選防禦性價值股避險。' },
  { title: '追求「超額報酬」的機會', detail: '大盤漲勢增加時加碼、減緩時調整持股，發掘未被指數納入的黑馬股，爭取 Alpha。' },
];

/** 12-5 主動式 ETF 挑選標準 */
export const ACTIVE_ETF_SELECTION_CRITERIA: Array<{ title: string; detail: string }> = [
  { title: '投信品牌', detail: '優先選擇在台股共同基金領域有長期優異績效的投信（如國泰、元大、富邦、復華、統一等）。' },
  { title: '經理人歷史', detail: '主動式 ETF 的靈魂是經理人，觀察他過去幾年的操作績效。' },
  { title: '透明度', detail: '雖是主動式，也要觀察公告的持股方向是否符合其標榜的策略。' },
];
