import type { SettleResult } from './eodSettle';
import type { IntradayQuote, IntradaySnapshot } from './IntradayCache';

// 近期完整官方批次約 TWSE 1,360+ / TPEx 990+；門檻保留少量停牌與商品異動空間，
// 但不能讓半套官方表（舊門檻 800/500）被誤認為完整。
export const TW_MIN_TWSE_OFFICIAL_ROWS = 1300;
export const TW_MIN_TPEX_OFFICIAL_ROWS = 900;
const TW_MIN_NEAR_CLOSE_SNAPSHOT_ROWS = 1500;

/**
 * 收盤官方表是當日實際有交易的最新母體；把它合併進既有 L1 檔名清單，避免新上市／
 * 新代號因為尚未有 candles 檔而永遠不會進入 eod-settle。
 *
 * 既有檔案仍完整保留，因為其中包含當日零成交、暫停交易與指數等官方收盤表不會列出的標的。
 */
export function mergeTwSettlementSymbols(
  existingSymbols: Iterable<string>,
  twseCodes: Iterable<string>,
  tpexCodes: Iterable<string>,
): string[] {
  const merged = new Set(existingSymbols);
  for (const code of twseCodes) {
    if (/^[1-9]\d{3}$/.test(code)) merged.add(`${code}.TW`);
  }
  for (const code of tpexCodes) {
    if (/^[1-9]\d{3,4}$/.test(code)) merged.add(`${code}.TWO`);
  }
  return [...merged];
}

/** 同一交易日、同一失敗原因只推播一次；狀態恢復後再失敗或原因改變時才重新告警。 */
export function shouldNotifySettlementFailure(
  previous: { status: string; reason?: string } | null,
  reason: string,
): boolean {
  return previous?.status !== 'failed' || previous.reason !== reason;
}

function isTwConfirmedNoTradeQuote(quote: IntradayQuote): boolean {
  return quote.volume === 0
    && (quote.priceKind === 'last_actual'
      || quote.priceKind === 'indicative'
      || quote.priceKind === 'unavailable'
      || quote.isActualTrade === false);
}

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
  if (result.status === 'skipped-already-correct') return false;
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

/**
 * 官方日線完整到齊時，「官方表沒有該代號」代表當日沒有可封存的成交 K。
 *
 * 仍要求一份 13:25 後的完整 L2 快照明確顯示零量／非實際成交，避免只因官方表
 * 單檔解析異常就把真正漏抓誤判成無成交。之所以允許 13:25 而非只收 13:30 後：
 * TWSE MIS 在收盤後可能整批回空；完整官方日線的缺席已排除收盤撮合成交，近收盤
 * L2 只負責交叉證明該檔全天確實維持零量。
 */
export function findTwOfficialNoTradeSymbols({
  targetDate,
  officialReady,
  results,
  canonicalSymbols,
  snapshot,
}: {
  targetDate: string;
  officialReady: boolean;
  results: ReadonlyArray<Pick<SettleResult, 'symbol' | 'status'>>;
  canonicalSymbols: Iterable<string>;
  snapshot: Pick<IntradaySnapshot, 'date' | 'updatedAt' | 'count' | 'quotes'> | null;
}): string[] {
  if (!officialReady || !snapshot || snapshot.date !== targetDate) return [];
  if (snapshot.count < TW_MIN_NEAR_CLOSE_SNAPSHOT_ROWS) return [];

  const updatedAt = new Date(snapshot.updatedAt);
  if (Number.isNaN(updatedAt.getTime())) return [];
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(updatedAt);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(part => part.type === type)?.value ?? '';
  const localDate = `${value('year')}-${value('month')}-${value('day')}`;
  const localMinute = Number(value('hour')) * 60 + Number(value('minute'));
  if (localDate !== targetDate || localMinute < 13 * 60 + 25) return [];

  const canonical = new Set(canonicalSymbols);
  const quotes = new Map(snapshot.quotes.map(quote => [quote.symbol, quote]));
  return results
    .filter(result => {
      if (result.status !== 'pending-no-vendor-data' || !canonical.has(result.symbol)) return false;
      const code = result.symbol.replace(/\.(TW|TWO)$/i, '');
      const quote = quotes.get(code);
      return quote ? isTwConfirmedNoTradeQuote(quote) : false;
    })
    .map(result => result.symbol);
}
