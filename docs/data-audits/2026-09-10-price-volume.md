# Price and volume audit — 2026-09-10

## Scope and result

- CN daily candles: all locally covered dates from 2021-01-01 through 2026-09-09, split into twelve bounded source requests.
- TW daily candles: 2026-01-01 through 2026-09-09, plus a structural check over every locally stored TW candle.
- Final structural check: 5,210,183 CN candles and 2,228,326 TW candles have no non-finite values, negative volume, invalid OHLC bounds, duplicate dates, or out-of-order dates.

## CN verification

Tencent's unadjusted `day` series was the primary reference. Every differing bar was checked against Sina's daily series before it was written. Price agreement tolerance was 0.01 and volume agreement tolerance was 100 shares.

- 5,210,183 source bars checked.
- 2,950,688 confirmed mixed-basis or missing bars repaired: 2,356,569 corrected and 594,119 added.
- Post-write reread and a fresh Tencent comparison returned zero mismatches and zero request failures in all twelve periods.
- A source can return no history for delisted, not-yet-listed, or unsupported symbols. Those symbol-periods were left unchanged; counts by half-year are retained in the temporary machine audit under `/tmp/rockstock-data-refresh-20260909`.

## TW verification

TWSE and TPEx official daily tables were the primary reference. Individual monthly tables were used for the exact per-security volume where available because the TPEx all-market daily table and individual history differ in odd-lot coverage.

- 83,908 bars repaired for 2026 YTD: 83,795 corrected and 113 added.
- All reachable post-write official comparisons have zero price mismatches and zero missing bars.
- 20 TPEx volume-only rows whose individual monthly table returned no row were preserved rather than guessed. Their local and daily-table differences are small, and the unresolved rows remain recorded in the two TW repair reports.
- TWSE's individual endpoint returned HTTP 428 for part of the audit. The official daily table was used for those rows after 6,000 successfully retrieved TWSE bars showed complete agreement between the daily and individual official price/volume values.

## Corporate actions

Raw OHLCV remains stored as actually traded. Charts and technical indicators use a separate in-memory series for an action only when the prior close agrees with an official TWSE/TPEx announcement. The adjustment covers stock distributions, capital reductions, and par-value changes; pre-event OHLC uses the official reference-price ratio and pre-event volume uses the official share ratio.

Thirteen 2026 events with price changes above 25% were verified and retained as deterministic local fallbacks. This includes 6669 on 2026-09-02: previous close 7,800, official reference 2,614.99, and 2.9828 post-event shares per pre-event share. New events still query the official exchange endpoints.

Large discontinuities without a matching corporate-action announcement remain raw and continue to trigger the existing continuity guard. Known examples are listing or market-transfer boundaries such as 7855 on 2026-08-11; no synthetic ratio is applied.
