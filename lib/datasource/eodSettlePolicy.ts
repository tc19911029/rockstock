import type { SettleResult } from './eodSettle';

// 近期完整官方批次約 TWSE 1,360+ / TPEx 990+；門檻保留少量停牌與商品異動空間，
// 但不能讓半套官方表（舊門檻 800/500）被誤認為完整。
export const TW_MIN_TWSE_OFFICIAL_ROWS = 1300;
export const TW_MIN_TPEX_OFFICIAL_ROWS = 900;

interface TwOfficialReadinessInput {
  market: 'TW' | 'CN';
  targetDate: string;
  twseRows: number;
  tpexRows: number;
  now?: Date;
}

export interface TwOfficialReadiness {
  ready: boolean;
  defer: boolean;
  reason?: string;
}

/**
 * 台股 T+0 只有在 TWSE、TPEx 兩邊官方批次都到齊時才繼續。
 * 官方尚未發布完整資料就 fail closed，交給後續排程重試，不因時間晚了而放寬來源。
 */
export function assessTwOfficialReadiness({
  market,
  targetDate,
  twseRows,
  tpexRows,
  now = new Date(),
}: TwOfficialReadinessInput): TwOfficialReadiness {
  if (market !== 'TW') return { ready: true, defer: false };

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(part => part.type === type)?.value ?? '';
  const localDate = `${value('year')}-${value('month')}-${value('day')}`;

  const twseReady = twseRows >= TW_MIN_TWSE_OFFICIAL_ROWS;
  const tpexReady = tpexRows >= TW_MIN_TPEX_OFFICIAL_ROWS;
  const ready = twseReady && tpexReady;
  const defer = targetDate === localDate
    && !ready;

  return {
    ready,
    defer,
    reason: ready
      ? undefined
      : `官方批次未到齊（TWSE ${twseRows}/${TW_MIN_TWSE_OFFICIAL_ROWS}, `
        + `TPEx ${tpexRows}/${TW_MIN_TPEX_OFFICIAL_ROWS}）`,
  };
}

/**
 * TW fail-closed：正式 L1 只能由 TWSE／TPEx 官方錨寫入。
 * CN 暫無完整官方 bulk，維持既有多源／缺檔單源自癒政策。
 */
export function canWriteSettlement(
  result: SettleResult,
  market: 'TW' | 'CN',
  existingBad: boolean,
): boolean {
  if (!result.settled || result.status.startsWith('pending')) return false;
  if (market === 'TW') {
    return result.officialAnchor === true;
  }
  return result.status === 'settled-multi-source'
    || (result.status === 'settled-single-source' && existingBad);
}

/**
 * 只把「仍在當日官方交易母體、且最終快照未確認為停牌／無交易」的 pending
 * 視為真正的 active settlement failure。
 *
 * settle 會掃 data/candles 下的歷史檔，因此退市、停止交易與指數仍可能產生
 * pending；verify 則只驗證當日官方交易母體。若只用 nonTradingSymbols 做反向排除，
 * 根本未進 verify 母體的歷史殘留會被誤標成 activeWithoutOfficial。
 */
export function findConfirmedActivePendingSymbols(
  results: ReadonlyArray<Pick<SettleResult, 'symbol' | 'status'>>,
  canonicalSymbols: Iterable<string>,
  confirmedNonTradingSymbols: Iterable<string>,
): string[] {
  const canonical = new Set(canonicalSymbols);
  const nonTrading = new Set(confirmedNonTradingSymbols);
  return results
    .filter(result =>
      result.status.startsWith('pending')
      && canonical.has(result.symbol)
      && !nonTrading.has(result.symbol),
    )
    .map(result => result.symbol);
}
