import { PROFIT_TARGET_PRICE_MULT } from '@/lib/analysis/bookThresholds';
import type { V12Letter } from '@/lib/analysis/v12Signals';
import { getOperationMA, type OperationMode } from '@/lib/sell/v12Operation';
import type { NarrativeAction, NarrativeEventCategory } from '@/lib/narrative/types';
import type { SignalEvaluationPhase } from './signalEvaluationPhase';

export interface SignalPanelActionPlan {
  readonly label: string;
  readonly detail: string;
  readonly tone: 'danger' | 'warning' | 'positive' | 'neutral';
}

export function resolveSignalPanelOperatingMA(
  letter: V12Letter,
  operationMode: OperationMode = 'short',
) {
  return getOperationMA(letter, operationMode);
}

export function resolveHoldingProfitTarget(
  costPrice: number,
  entryPatternTarget?: number | null,
): { price: number; source: 'entry-pattern' | 'rule' } {
  if (entryPatternTarget != null && Number.isFinite(entryPatternTarget) && entryPatternTarget > 0) {
    return { price: entryPatternTarget, source: 'entry-pattern' };
  }
  return { price: costPrice * PROFIT_TARGET_PRICE_MULT, source: 'rule' };
}

export function resolveSignalPanelActionPlan({
  action,
  primaryCategory,
  hasPosition,
  close,
  operatingMA,
  operatingMAValue,
  confirmation,
  decisiveReason,
  evaluationPhase = 'closed',
}: {
  action: NarrativeAction;
  primaryCategory: NarrativeEventCategory;
  hasPosition: boolean;
  close: number;
  operatingMA?: string | null;
  operatingMAValue?: number | null;
  confirmation: string;
  decisiveReason?: string | null;
  evaluationPhase?: SignalEvaluationPhase;
}): SignalPanelActionPlan {
  const line = operatingMA && operatingMAValue != null
    ? `${operatingMA} ${operatingMAValue.toFixed(2)}`
    : null;

  if (action === 'exit') {
    // 不得用「持倉操作均線」代替真正的出場原因：跌破前低／頂部型態等硬訊號
    // 也可能在現價仍高於 MA5 時成立。缺明確原因時寧可顯示通用文案，不捏造 MA5 觸發。
    const trigger = decisiveReason ?? '硬出場規則目前成立';
    if (evaluationPhase === 'intraday') {
      return {
        label: '盤中預警：出場條件目前成立',
        detail: `${trigger}；盤中日 K 尚未定稿，系統會隨每次即時報價重新計算。若條件解除，預警會自動消失；收盤後才確認。`,
        tone: 'warning',
      };
    }
    return {
      label: '今日動作：全數出場',
      detail: `${trigger}；依既定紀律處理，今日不加碼。`,
      tone: 'danger',
    };
  }

  if (action === 'reduce' && primaryCategory === 'risk') {
    return {
      label: '今日動作：續抱警戒、不加碼',
      detail: line
        ? `目前尚未觸發操作均線出場；後續收盤跌破 ${line} 時全數出場。`
        : '目前先保留既有部位；若硬出場訊號成立即全數出場。',
      tone: 'warning',
    };
  }

  if (action === 'reduce') {
    if (evaluationPhase === 'intraday') {
      return {
        label: '盤中預警：減碼條件目前成立',
        detail: '盤中日 K 尚未定稿，系統會隨每次即時報價重新計算；條件解除時預警會自動消失，收盤後才確認。',
        tone: 'warning',
      };
    }
    return {
      label: '今日動作：先減碼 1/3',
      detail: line
        ? `轉弱訊號成立；剩餘部位守 ${line}，今日不加碼。`
        : '轉弱訊號成立；先降低曝險，剩餘部位等待下一個硬出場條件。',
      tone: 'warning',
    };
  }

  if (action === 'hold' && hasPosition) {
    if (evaluationPhase === 'intraday') {
      return {
        label: '盤中狀態：續抱觀察',
        detail: line
          ? `現價 ${close.toFixed(2)} 目前守住 ${line}，該均線出場條件未成立；系統會隨即時報價持續重算，收盤後才定案。`
          : '目前沒有出場條件；系統會隨即時報價持續重算，收盤後才定案。',
        tone: 'positive',
      };
    }
    return {
      label: '今日動作：續抱',
      detail: line
        ? `既有部位續抱並守 ${line}；是否加碼必須另做進場評估。`
        : '尚無出場條件；既有部位續抱，是否加碼另做進場評估。',
      tone: 'positive',
    };
  }

  if (action === 'avoid-entry') {
    const nextCheck = confirmation
      .replace(/^目前維持空手[；，。\s]*/, '')
      .replace(/[。；\s]+$/, '');
    const noPendingOrder = nextCheck.includes('不預掛進場單') ? '' : '；不預掛進場單';
    return {
      label: '今日動作：維持空手',
      detail: `${nextCheck}${noPendingOrder}。`,
      tone: 'danger',
    };
  }

  if (action === 'evaluate-entry') {
    return {
      label: '今日動作：只進入風險評估',
      detail: `${confirmation} 尚未完成停損與報酬風險檢查前，不直接進場。`,
      tone: 'positive',
    };
  }

  return {
    label: '今日動作：保持觀望',
    detail: confirmation,
    tone: 'neutral',
  };
}

export function resolvePartialExitDisplay({
  ended,
  endDate,
  endWhy,
  currentAction,
}: {
  ended: boolean;
  endDate?: string | null;
  endWhy?: string | null;
  currentAction: string;
}): { title: string; prefix: string; text: string; historical: boolean } {
  if (ended) {
    return {
      title: '歷史策略分歧 · 賠少模式',
      prefix: '歷史對照',
      text: `分批模型已於 ${endDate ?? '—'} 建議全出${endWhy ? `（${endWhy}）` : ''}；你目前仍持有，後續分批模擬不再適用。`,
      historical: true,
    };
  }
  return {
    title: '分批出場 · 賠少模式',
    prefix: '今日',
    text: currentAction,
    historical: false,
  };
}
