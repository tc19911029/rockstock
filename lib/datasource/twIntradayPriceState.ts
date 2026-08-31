/**
 * 台股盤中顯示價狀態機。
 *
 * MIS 的 z 只代表這一批回應能否確認最近成交價，不能把單次 z='-' 直接改成委託簿中價。
 * 前兩次沿用最後一筆真實成交；連續第三次仍無成交價時才顯示雙邊委買／委賣中價。
 */

export type TwIntradayPriceKind = 'actual' | 'last_actual' | 'indicative' | 'unavailable';

export interface TwIntradayPriceObservation {
  close: number;
  previousClose?: number;
  indicativePrice?: number;
  isActualTrade?: boolean;
  updatedAt?: string;
}

export interface TwIntradayPreviousPriceState {
  close: number;
  isActualTrade?: boolean;
  priceKind?: TwIntradayPriceKind;
  lastActualPrice?: number;
  lastActualAt?: string;
  consecutiveMissingActual?: number;
}

export interface TwIntradayResolvedPriceState {
  close: number;
  isActualTrade: boolean;
  priceKind: TwIntradayPriceKind;
  lastActualPrice?: number;
  lastActualAt?: string;
  consecutiveMissingActual: number;
  observedAt?: string;
}

const positive = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * 只在「這一檔確實收到本輪 MIS row」時呼叫。
 * 整批失敗／row 缺失時，呼叫端必須原樣保留 previous，不能增加 missing 計數。
 */
export function resolveTwIntradayPriceState(
  observation: TwIntradayPriceObservation,
  previous?: TwIntradayPreviousPriceState,
): TwIntradayResolvedPriceState {
  const observedActual = observation.isActualTrade !== false && positive(observation.close);
  if (observedActual) {
    return {
      close: observation.close,
      isActualTrade: true,
      priceKind: 'actual',
      lastActualPrice: observation.close,
      lastActualAt: observation.updatedAt,
      consecutiveMissingActual: 0,
      observedAt: observation.updatedAt,
    };
  }

  const lastActualPrice = positive(previous?.lastActualPrice)
    ? previous.lastActualPrice
    : previous?.isActualTrade !== false && positive(previous?.close)
      ? previous.close
      : positive(observation.previousClose)
        ? observation.previousClose
        : undefined;
  const lastActualAt = previous?.lastActualAt;

  // 舊版快照的 false 已代表系統先前觀察過無成交價；視為至少連續兩次，
  // 避免部署後把已經長時間無 z 的股票重新等待三輪。
  const previousMissing = previous?.consecutiveMissingActual
    ?? (previous?.isActualTrade === false ? 2 : 0);
  const consecutiveMissingActual = previousMissing + 1;

  if (consecutiveMissingActual >= 3 && positive(observation.indicativePrice)) {
    return {
      close: observation.indicativePrice,
      isActualTrade: false,
      priceKind: 'indicative',
      lastActualPrice,
      lastActualAt,
      consecutiveMissingActual,
      observedAt: observation.updatedAt,
    };
  }

  if (positive(lastActualPrice)) {
    return {
      close: lastActualPrice,
      isActualTrade: true,
      priceKind: 'last_actual',
      lastActualPrice,
      lastActualAt,
      consecutiveMissingActual,
      observedAt: observation.updatedAt,
    };
  }

  return {
    close: 0,
    isActualTrade: false,
    priceKind: 'unavailable',
    consecutiveMissingActual,
    observedAt: observation.updatedAt,
  };
}
