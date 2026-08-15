type ConcentrationFetchInput = {
  sideTab: string;
  activeBuyMethod: string;
  ticker: string;
};

/**
 * 精算集中度的 API 很慢，只在使用者真的會看到／使用該資料時請求。
 * 一般訊號判讀仍使用已載入的基礎籌碼資料，不需要等待這支 API。
 */
export function shouldFetchExactConcentration({
  sideTab,
  activeBuyMethod,
  ticker,
}: ConcentrationFetchInput): boolean {
  const needsExactData = sideTab === 'chip' || activeBuyMethod === 'Y';
  const isTaiwanStock = /^\d{4,5}(\.(TW|TWO))?$/i.test(ticker);
  return needsExactData && isTaiwanStock;
}
