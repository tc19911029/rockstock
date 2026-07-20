/**
 * composeOperationSuggestion — 純函數組合「今日操作建議」一句話
 *
 * 輸入：decisions + portfolioReview + alertsToday + growthGap
 * 輸出：1-3 句中文字串
 *
 * 規則式組合（不打 LLM），保證快+一致：
 *   1. 進場：decisions 內 action=buy 的 top 1-2，附 sizeHint%
 *   2. 持股警示：portfolioReview 內 action ∈ {stop_loss, reduce, take_profit} 的 top 2
 *   3. 盤中警示：alertsToday 內 blowoff-bearish / terminal-rally 的 top 1
 *   4. 紀律提醒：附「13:20 前確認 K 棒收盤」（朱書原則）
 *   5. 全空 → 「無訊號、建議空手觀望」
 */

// 局部型別 — 只取需要的欄位，避免跨 module 強耦合
export interface DecisionRunForSuggestion {
  symbol: string;
  name?: string;
  decision: {
    action: 'buy' | 'watch' | 'skip';
    decisionPath: string;
    sizeHint: number;
    overview: string;
  } | null;
}

export type ReviewAction =
  | 'hold_strong'
  | 'hold_observe'
  | 'add'
  | 'reduce'
  | 'take_profit'
  | 'stop_loss'
  | 'no_add';

export interface PortfolioReviewForSuggestion {
  symbol: string;
  name?: string;
  action: ReviewAction;
  returnPct?: number;
  currentPrice?: number;
  keyPriceLevels?: { stopLossPrice?: number };
}

export type RealtimeRule =
  | 'blowoff-bearish'
  | 'blowoff-bullish'
  | 'terminal-rally'
  | 'ma5-breakdown'
  | 'stop-loss-breach'
  | 'pump-reversal'
  | 'rapid-drop';

export interface AlertForSuggestion {
  symbol: string;
  rule: RealtimeRule;
  firedAt: number;
  isHolding: boolean;
}

export interface GrowthGapForSuggestion {
  gapPct: number;             // (current - target) / target，負數 = 落後
  status: 'green' | 'yellow' | 'red';
}

export interface ComposeInput {
  decisions: DecisionRunForSuggestion[];
  portfolioReview: PortfolioReviewForSuggestion[];
  alertsToday: AlertForSuggestion[];
  growthGap?: GrowthGapForSuggestion | null;
  /**
   * 大盤 regime（課程 CH5-6 / 直播 2026-07-01「大盤不好是休息的」）。
   * 2026-07-20 第七輪補：本函式原本完全不看大盤 —— 空手觀望的判斷依據只有
   * 「候選池空不空」，大盤翻空時建議文案不會主動提降成數/休息，
   * 使用者只有在按下單試算時才會撞到 regimeExposureCap 的上限。
   * ⚠️ 老師原話是「也不是說一定不能做…你要做就把資金控管好」＝許可不是義務，
   * 所以這裡只做提示，**不加任何硬 gate**。
   */
  marketRegime?: '多頭' | '盤整' | '空頭' | null;
}

// ── 標籤對照 ─────────────────────────────────────────────────────────────────

const RULE_LABEL: Record<RealtimeRule, string> = {
  'blowoff-bearish': '爆量長黑',
  'blowoff-bullish': '爆量長紅',
  'terminal-rally':  '末升段',
  'ma5-breakdown':   'MA5 跌破',
  'stop-loss-breach': '跌破停損',
  'pump-reversal':   '拉高回落',
  'rapid-drop':      '急殺',
};

// 嚴重程度排序（越前面越嚴重）— 持倉保命訊號排最重（跌破停損 > 急殺 > 拉高回落）
const RULE_SEVERITY: Record<RealtimeRule, number> = {
  'stop-loss-breach': 6,
  'rapid-drop':      5,
  'pump-reversal':   4,
  'blowoff-bearish': 3,
  'terminal-rally':  2,
  'ma5-breakdown':   1,
  'blowoff-bullish': 0,
};

const REVIEW_LABEL: Record<ReviewAction, string> = {
  stop_loss:   '建議停損',
  reduce:      '建議減碼',
  take_profit: '建議停利',
  add:         '可加碼',
  hold_strong: '續抱',
  hold_observe:'觀察',
  no_add:      '不加碼',
};

const ALERT_REVIEW_ACTIONS: ReadonlySet<ReviewAction> = new Set([
  'stop_loss', 'reduce', 'take_profit',
]);

// ── 主函數 ───────────────────────────────────────────────────────────────────

export function composeOperationSuggestion(input: ComposeInput): string {
  const parts: string[] = [];

  // 1. 進場優先（buy 信號 top 2）
  const buys = input.decisions
    .filter((r) => r.decision?.action === 'buy')
    .slice(0, 2);
  if (buys.length > 0) {
    const phrase = buys
      .map((r) => {
        const label = r.name ?? r.symbol;
        const size = r.decision?.sizeHint ?? 0;
        return `${label}${size > 0 ? `(${size}%倉位)` : ''}`;
      })
      .join('、');
    parts.push(`今日進場：${phrase}`);
  }

  // 2. 持股警示（stop_loss / reduce / take_profit top 2，stop_loss 最優先）
  const sortedReviews = [...input.portfolioReview]
    .filter((r) => ALERT_REVIEW_ACTIONS.has(r.action))
    .sort((a, b) => {
      // stop_loss > reduce > take_profit
      const w = (x: ReviewAction) => x === 'stop_loss' ? 3 : x === 'reduce' ? 2 : 1;
      return w(b.action) - w(a.action);
    })
    .slice(0, 2);
  if (sortedReviews.length > 0) {
    const phrase = sortedReviews
      .map((r) => {
        const label = r.name ?? r.symbol;
        const ret = typeof r.returnPct === 'number' ? `(${r.returnPct >= 0 ? '+' : ''}${r.returnPct.toFixed(1)}%)` : '';
        return `${label}${ret}${REVIEW_LABEL[r.action]}`;
      })
      .join('、');
    parts.push(`持股注意：${phrase}`);
  }

  // 3. 盤中警示 — 取最嚴重 1 條
  const sortedAlerts = [...input.alertsToday]
    .sort((a, b) => {
      const s = RULE_SEVERITY[b.rule] - RULE_SEVERITY[a.rule];
      if (s !== 0) return s;
      return b.firedAt - a.firedAt;
    });
  const top = sortedAlerts.find((a) => RULE_SEVERITY[a.rule] >= 2); // bearish / terminal 才提
  if (top) {
    const time = formatHhmm(top.firedAt);
    parts.push(`盤中警示：${time} ${top.symbol} 出現「${RULE_LABEL[top.rule]}」${top.isHolding ? '（持股中）' : ''}`);
  }

  // 4. 沒有任何訊號 → 空手觀望
  if (parts.length === 0) {
    let base = '今日候選池無 ≥3 共識股、持股無重大警示，建議空手觀望';
    if (input.marketRegime === '空頭') {
      base += '；大盤空頭，課程：不操作也是一種策略，贏家大盤不好是休息的';
    }
    if (input.growthGap && input.growthGap.status === 'red') {
      base += `；進度落後目標 ${Math.abs(input.growthGap.gapPct).toFixed(1)}%（紅燈），避免衝動操作`;
    }
    return base;
  }

  // 5. 大盤 regime 資金成數提醒（課程 CH5-6 成數表；只提示不擋）
  //    多頭 8 成 / 盤整 5 成 / 空頭 3 成 — 與 positionSizer.regimeExposureCap 同一組數字。
  if (input.marketRegime === '空頭') {
    parts.push('大盤空頭：資金控管降到三成以內，做不好就趕快跑（課程紀律）');
  } else if (input.marketRegime === '盤整') {
    parts.push('大盤盤整：資金控管五成以內（課程紀律）');
  }

  // 6. 書本紀律提醒（朱書 1:20 看 / 1:25 掛市價）
  parts.push('下午 13:20 確認 K 棒收盤再動作（朱書紀律）');

  return parts.join('；');
}

// ── helpers ──────────────────────────────────────────────────────────────────

function formatHhmm(epochMs: number): string {
  const d = new Date(epochMs);
  // Taipei TZ
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return fmt.format(d);
}
