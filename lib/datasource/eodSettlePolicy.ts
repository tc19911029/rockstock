import type { SettleResult } from './eodSettle';

export const TW_MIN_TWSE_OFFICIAL_ROWS = 800;
export const TW_MIN_TPEX_OFFICIAL_ROWS = 500;
export const TW_OFFICIAL_DEFER_CUTOFF_MINUTES = 16 * 60;

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
 * 台股 T+0 第一輪只在 TWSE、TPEx 兩邊官方批次都到齊時才繼續。
 * 16:00 後仍允許進入多來源 reconciliation，但寫入政策仍要求官方錨或兩個獨立來源。
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
  const localMinutes = Number(value('hour')) * 60 + Number(value('minute'));

  const twseReady = twseRows >= TW_MIN_TWSE_OFFICIAL_ROWS;
  const tpexReady = tpexRows >= TW_MIN_TPEX_OFFICIAL_ROWS;
  const ready = twseReady && tpexReady;
  const defer = targetDate === localDate
    && localMinutes < TW_OFFICIAL_DEFER_CUTOFF_MINUTES
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
 * TW fail-closed：正式 L1 只能由官方錨，或至少兩個「不含 L1-existing」的獨立來源背書。
 * CN 暫無完整官方 bulk，維持既有多源／缺檔單源自癒政策。
 */
export function canWriteSettlement(
  result: SettleResult,
  market: 'TW' | 'CN',
  existingBad: boolean,
): boolean {
  if (!result.settled || result.status.startsWith('pending')) return false;
  if (market === 'TW') {
    return result.officialAnchor === true || (result.independentAgree ?? 0) >= 2;
  }
  return result.status === 'settled-multi-source'
    || (result.status === 'settled-single-source' && existingBad);
}
