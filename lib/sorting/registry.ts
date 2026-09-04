/**
 * 全站排序「中央清單」— 單一事實來源（2026-06-15）
 *
 * 問題背景：同一種排序（特別是「買進後賺賠」那組：隔開/1日/5日/10日/20日/最高/最低）
 * 散在 15+ 個面板各寫一份，連 id 都有 3 種寫法（fwdD5 / d5Return / d5）、label 與
 * 預設方向也各自為政。這個檔案把 7 大家族的每個排序選項「名字、預設方向、缺值排最後、
 * 說明 tip」集中定義一次。
 *
 * 分工：
 *  - 這裡（registry）：排序選項的 metadata（label / family / 預設方向 / 缺值處理 / tip）。
 *  - sortEngine.ts：實際排序演算法（缺值排最後 + 升降序 + 穩定），全站一份。
 *  - components/shared/SortControl.tsx：共用排序 UI（pills），label 從這裡取。
 *  - 各面板：只提供 accessor（id → 該列的可比較值），因為各面板的列型別不同。
 *
 * 保留的特例（這些是回測過的決議，不可在統一時被抹平）：
 *  - score.cnBuy「應買(低分在前)」defaultDir='asc' — 陸股 hard_score 是反指標（記憶 cn_agents_buy_sort_default）。
 *  - score.sanseCombo「應買」 — 三色 buyScore 評級綜合分，accessor 走既有 buyScore。
 *  - mkt.change「漲幅」 — 掃描面板走 panelSortCompare 的明確三層比較器（漲幅→六條件→MA20斜率）。
 *  - fwd.maxLoss「漲跌·最低」defaultDir='asc' — 最低（最慘）排前面。
 */

export type SortFamily =
  | 'forward' // 買進後賺賠（前瞻報酬）
  | 'market' // 今天盤面
  | 'score' // 選股總分
  | 'sanse' // 三色細項
  | 'heat' // 人氣熱度
  | 'teacher' // 老師榜
  | 'trust'; // 可信度 / 避雷

export type SortDir = 'asc' | 'desc';

export interface SortOptionDef {
  /** 全站唯一 id（canonical），例：'fwd.d5' */
  id: string;
  /** 繁中顯示名，例：'漲跌·5日' */
  label: string;
  family: SortFamily;
  /** 第一次點選時的方向。數值大→小用 'desc'；越低越優先（反指標/最慘）用 'asc' */
  defaultDir: SortDir;
  /** 缺值（null/undefined）是否永遠排最後（不受升降序影響）。前瞻報酬類一律 true */
  missingLast: boolean;
  /** 滑鼠移上去的白話說明 */
  tip?: string;
}

export const FAMILY_LABEL: Record<SortFamily, string> = {
  forward: '訊號後／買進後',
  market: '今天盤面',
  score: '選股總分',
  sanse: '三色細項',
  heat: '人氣熱度',
  teacher: '老師榜',
  trust: '可信度 / 避雷',
};

/** 7 大家族所有排序選項的單一事實。key = canonical id。 */
export const SORT_OPTIONS: Record<string, SortOptionDef> = {
  // ── 1. 買進後賺賠（前瞻報酬）── 全站重複最嚴重，缺值一律排最後 ──────────────
  'fwd.open': { id: 'fwd.open', label: '漲跌·開盤缺口', family: 'forward', defaultDir: 'desc', missingLast: true, tip: '訊號日收盤到隔日開盤的跳空幅度；這不是買進後報酬' },
  'fwd.d1': { id: 'fwd.d1', label: '漲跌·1日', family: 'forward', defaultDir: 'desc', missingLast: true, tip: '隔日開盤可成交後，第 1 個交易日收盤報酬' },
  'fwd.d5': { id: 'fwd.d5', label: '漲跌·5日', family: 'forward', defaultDir: 'desc', missingLast: true, tip: '隔日開盤可成交後，第 5 個交易日收盤報酬' },
  'fwd.d10': { id: 'fwd.d10', label: '漲跌·10日', family: 'forward', defaultDir: 'desc', missingLast: true, tip: '隔日開盤可成交後，第 10 個交易日收盤報酬' },
  'fwd.d20': { id: 'fwd.d20', label: '漲跌·20日', family: 'forward', defaultDir: 'desc', missingLast: true, tip: '隔日開盤可成交後，第 20 個交易日收盤報酬' },
  'fwd.maxGain': { id: 'fwd.maxGain', label: '漲跌·最高', family: 'forward', defaultDir: 'desc', missingLast: true, tip: '隔日開盤可成交後 20 個交易日內最高報酬' },
  'fwd.maxLoss': { id: 'fwd.maxLoss', label: '漲跌·最低', family: 'forward', defaultDir: 'asc', missingLast: true, tip: '隔日開盤可成交後 20 個交易日內最低報酬（最慘排前面）' },
  'fwd.hold': { id: 'fwd.hold', label: '漲跌·持有至今', family: 'forward', defaultDir: 'desc', missingLast: true, tip: '提及日進場、持有到今天的漲跌幅' },

  // ── 2. 今天盤面 ──────────────────────────────────────────────────────────
  'mkt.turnover': { id: 'mkt.turnover', label: '成交額', family: 'market', defaultDir: 'desc', missingLast: false, tip: '當日成交金額大的排前面（回測 A 級組合多靠此排序勝出）' },
  'mkt.change': { id: 'mkt.change', label: '漲幅', family: 'market', defaultDir: 'desc', missingLast: false, tip: '當日漲跌幅 %（同分再比六條件與 MA20 斜率）' },
  'mkt.price': { id: 'mkt.price', label: '股價', family: 'market', defaultDir: 'desc', missingLast: false, tip: '當前股價高低' },
  'mkt.boards': { id: 'mkt.boards', label: '連板', family: 'market', defaultDir: 'desc', missingLast: false, tip: '連續漲停板數（同板數比成交額）' },
  'mkt.turnoverRate': { id: 'mkt.turnoverRate', label: '換手率', family: 'market', defaultDir: 'desc', missingLast: false, tip: '成交量 ÷ 流通股數' },
  'mkt.volumeRatio': { id: 'mkt.volumeRatio', label: '量比', family: 'market', defaultDir: 'desc', missingLast: false, tip: '當日量相對近期均量' },
  'mkt.amplitude': { id: 'mkt.amplitude', label: '振幅', family: 'market', defaultDir: 'desc', missingLast: false, tip: '當日最高最低的振幅' },

  // ── 3. 選股總分（各策略各一種，集中定義）────────────────────────────────
  'score.sixCond': { id: 'score.sixCond', label: '六條件', family: 'score', defaultDir: 'desc', missingLast: false, tip: '朱家泓五步法六條件總分（次鍵：漲幅）' },
  'score.shortSixCond': { id: 'score.shortSixCond', label: '做空六條件', family: 'score', defaultDir: 'desc', missingLast: true, tip: '做空六條件總分，高分在前' },
  'score.deviation': { id: 'score.deviation', label: 'MA20乖離', family: 'score', defaultDir: 'asc', missingLast: true, tip: 'R 機械軌：做多找負乖離極端（低在前），做空找正乖離極端（高在前）' },
  'score.smartMoney': { id: 'score.smartMoney', label: '20日集中度', family: 'score', defaultDir: 'desc', missingLast: true, tip: 'W 大戶偷買：主力分點 20 日集中度高在前' },
  'score.instDip': { id: 'score.instDip', label: '法人逆勢買', family: 'score', defaultDir: 'desc', missingLast: true, tip: 'X 法人接刀：法人 5 日淨買超張數高在前' },
  'score.instSteal': { id: 'score.instSteal', label: '法人連買', family: 'score', defaultDir: 'desc', missingLast: true, tip: 'Y 法人偷買：先比連買天數，再比 5 日集中度' },
  'score.surge': { id: 'score.surge', label: '飆股潛力', family: 'score', defaultDir: 'desc', missingLast: false, tip: '飆股潛力分' },
  'score.composite': { id: 'score.composite', label: '綜合評分', family: 'score', defaultDir: 'desc', missingLast: false, tip: '回測綜合評分' },
  'score.netReturn': { id: 'score.netReturn', label: '淨報酬', family: 'score', defaultDir: 'desc', missingLast: false, tip: '回測淨報酬' },
  'score.histWinRate': { id: 'score.histWinRate', label: '歷史勝率', family: 'score', defaultDir: 'desc', missingLast: false, tip: '歷史回測勝率' },
  'score.grade': { id: 'score.grade', label: '等級', family: 'score', defaultDir: 'desc', missingLast: false, tip: '依目前面板的等級順序，高等級在前' },
  'score.poolTotal': { id: 'score.poolTotal', label: '加權總分', family: 'score', defaultDir: 'desc', missingLast: false, tip: '候選池 4 面向加權總分（技術/籌碼/基本/消息）' },
  'score.sanseCombo': { id: 'score.sanseCombo', label: '應買', family: 'score', defaultDir: 'desc', missingLast: false, tip: '三色使用順序評級綜合分：嚴格全共振／紅當前提＋觸發優先，再比較共振與短攻' },
  'score.cnBuy': { id: 'score.cnBuy', label: '應買', family: 'score', defaultDir: 'asc', missingLast: false, tip: '陸股 hard_score 是反指標，分數低的反而較值得操作（回測驗證）→ 預設低分在前' },
  'score.cnTotal': { id: 'score.cnTotal', label: '分數', family: 'score', defaultDir: 'desc', missingLast: false, tip: '陸股 hard_score 總分（高在前；注意是反指標，僅作對照）' },

  // ── 4. 三色細項 ──────────────────────────────────────────────────────────
  'sanse.shortAttack': { id: 'sanse.shortAttack', label: '短攻', family: 'sanse', defaultDir: 'desc', missingLast: false, tip: '短線上攻（游資資金）分數' },
  'sanse.midStrength': { id: 'sanse.midStrength', label: '中強', family: 'sanse', defaultDir: 'desc', missingLast: false, tip: '中線強度（主力資金）分數' },
  'sanse.midControl': { id: 'sanse.midControl', label: '中控', family: 'sanse', defaultDir: 'desc', missingLast: false, tip: '中線控盤（主力狀態）分數' },
  'sanse.shortOversold': { id: 'sanse.shortOversold', label: '超短跌', family: 'sanse', defaultDir: 'desc', missingLast: false, tip: '短線超跌分數' },
  'sanse.expGain3': { id: 'sanse.expGain3', label: '期望漲幅·3日', family: 'sanse', defaultDir: 'desc', missingLast: true, tip: '同型態歷史 3 日期望漲幅（Bayesian 平滑）' },
  'sanse.expGain5': { id: 'sanse.expGain5', label: '期望漲幅·5日', family: 'sanse', defaultDir: 'desc', missingLast: true, tip: '同型態歷史 5 日期望漲幅（Bayesian 平滑）' },
  'sanse.expGain10': { id: 'sanse.expGain10', label: '期望漲幅·10日', family: 'sanse', defaultDir: 'desc', missingLast: true, tip: '同型態歷史 10 日期望漲幅（Bayesian 平滑）' },

  // ── 5. 人氣熱度 ──────────────────────────────────────────────────────────
  'heat.theme': { id: 'heat.theme', label: '今日市場題材熱度', family: 'heat', defaultDir: 'desc', missingLast: true, tip: '台股按可重疊市場題材今日平均漲幅排序；陸股按概念板塊今日漲幅排序。僅供盤面觀察，不作買賣訊號。' },
  'heat.youtube': { id: 'heat.youtube', label: 'YouTube 提及', family: 'heat', defaultDir: 'desc', missingLast: true, tip: '依近 30 天 YouTube 節目提及次數排序（未提及排最後）' },
  'heat.sector': { id: 'heat.sector', label: '板塊強弱', family: 'heat', defaultDir: 'desc', missingLast: true, tip: '所屬板塊近 5 日平均報酬' },

  // ── 6. 老師榜 ────────────────────────────────────────────────────────────
  'teacher.accuracy': { id: 'teacher.accuracy', label: '準度', family: 'teacher', defaultDir: 'desc', missingLast: true, tip: '老師/節目歷史 D5 勝率（樣本需足夠）' },
  'teacher.payoff': { id: 'teacher.payoff', label: '賺賠比', family: 'teacher', defaultDir: 'desc', missingLast: true, tip: 'D20 平均賺 ÷ |平均賠|' },
  'teacher.excess': { id: 'teacher.excess', label: '超額', family: 'teacher', defaultDir: 'desc', missingLast: true, tip: 'D20 超額報酬（vs 大盤）' },
  'teacher.mentions': { id: 'teacher.mentions', label: '提及次數', family: 'teacher', defaultDir: 'desc', missingLast: false, tip: '提及/推薦次數' },
  'teacher.rating': { id: 'teacher.rating', label: '評級', family: 'teacher', defaultDir: 'desc', missingLast: false, tip: 'A > B > C > D > 未評' },
  'teacher.scored': { id: 'teacher.scored', label: '有效樣本', family: 'teacher', defaultDir: 'desc', missingLast: false, tip: '可結算的有效樣本數' },

  // ── 7. 可信度 / 避雷 ─────────────────────────────────────────────────────
  'trust.edge': { id: 'trust.edge', label: '誠實 edge', family: 'trust', defaultDir: 'desc', missingLast: true, tip: '扣成本/比大盤後的誠實淨 edge 分級' },
  'trust.achievement': { id: 'trust.achievement', label: '達成度', family: 'trust', defaultDir: 'desc', missingLast: true, tip: '與目標價的進度' },
  'trust.upside': { id: 'trust.upside', label: '上漲潛力', family: 'trust', defaultDir: 'desc', missingLast: true, tip: '距目標價的上漲空間' },
  'trust.stage': { id: 'trust.stage', label: '型態階段', family: 'trust', defaultDir: 'asc', missingLast: false, tip: '已觸發／進場等較優先階段排前面' },
  'trust.days': { id: 'trust.days', label: '持有天數', family: 'trust', defaultDir: 'desc', missingLast: false, tip: '已持有/追蹤天數' },
  'trust.confirmed': { id: 'trust.confirmed', label: '進場確認', family: 'trust', defaultDir: 'desc', missingLast: false, tip: '✅進場 > ⏸不進 > 未知' },
};

/**
 * 「共用區」排序選項 — 每一頁的排序列前面都放這一段、同順序，做到視覺統一（2026-06-15 使用者要求）。
 *
 * 用法：各面板 `options={[...這裡能用的共用 id, '|', ...該頁專屬]}`。
 * 注意：不是每頁都有全部資料（例：候選池/多代理/YouTube/法人報告沒有成交額·漲幅·股價；
 * 打板沒有前瞻報酬）。為了「不要有按了沒反應的死按鈕」，各面板只放自己有資料的共用 id
 * （用 SUPPORTED 過濾），但**順序一律照這裡**，所以共用的部分每頁長一樣、排同位置。
 */
export const UNIVERSAL_SORT_OPTIONS: readonly string[] = [
  'mkt.turnover', 'mkt.change', 'mkt.price',
  'fwd.open', 'fwd.d1', 'fwd.d5', 'fwd.d10', 'fwd.d20', 'fwd.maxGain', 'fwd.maxLoss',
];

/** 依面板支援的 id 過濾共用區，順序照 UNIVERSAL_SORT_OPTIONS。 */
export function universalOptionsFor(supported: Iterable<string>): string[] {
  const set = supported instanceof Set ? supported : new Set(supported);
  return UNIVERSAL_SORT_OPTIONS.filter((id) => set.has(id));
}

/** 取得排序選項定義；未知 id 拋錯（合約測試與開發期防呆）。 */
export function sortOption(id: string): SortOptionDef {
  const def = SORT_OPTIONS[id];
  if (!def) throw new Error(`[sorting] 未知排序 id: ${id}（請先在 lib/sorting/registry.ts 註冊）`);
  return def;
}

/** 是否為已註冊的排序 id。 */
export function isSortId(id: string): id is keyof typeof SORT_OPTIONS {
  return id in SORT_OPTIONS;
}
