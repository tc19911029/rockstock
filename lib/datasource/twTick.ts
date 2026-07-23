/**
 * 台股價格檔位（tick size）工具 — TWSE 上市 / TPEx 上櫃。
 *
 * 真實成交價必落在檔位網格上。次檔位值（如個股 100-500 區間出現 158.75）代表「中間價 / 盤中
 * 快照值」，不是真實收盤 — 多半來自 EOD 封存時 FinMind 被 402 熔斷缺席、落到 Yahoo/EODHD 的
 * mid-quote。settle 用此工具：優先挑檔位合法的 vendor 收盤；殘值 snap 到最近檔位，保證 L1 永不
 * 寫入偽價。
 *
 * ⚠️ ETF/ETN（代號 00 開頭，如 0050 / 00878 / 00980A）檔位比個股細，必須分開判：
 *   ETF：  P<50 → 0.01 | P≥50 → 0.05
 *   個股：  P<10 → 0.01 | 10≤P<50 → 0.05 | 50≤P<100 → 0.1 | 100≤P<500 → 0.5 | 500≤P<1000 → 1 | P≥1000 → 5
 * （沒分會把 0050 的 100.95 這種合法 ETF 價誤判成次檔位，連鎖錯誤 snap。）
 */

/** 代號是否為 ETF/ETN（00 開頭）→ 套用較細的 ETF 檔位表。 */
export function isTwEtf(symbol: string): boolean {
  return /^00/.test(symbol.replace(/\.(TW|TWO)$/i, ''));
}

/**
 * 代號是否為指數（^TWII 等）→ **完全不套檔位規則**。
 *
 * 指數是加權平均出來的計算值，不是撮合成交價，任何小數都合法。2026-07-23 抓到的 bug：
 * ^TWII 走 TW settle 路徑時被當成「股價 ≥1000 → 檔位 5 元」，44,825.78 被 snap 成 44,825、
 * 44,513.75 被 snap 成 44,515（四價全變成 5 的倍數）。指數必須跳過整段守衛。
 */
export function isTwIndex(symbol: string): boolean {
  return symbol.startsWith('^');
}

export function twTickSize(price: number, isEtf = false): number {
  if (isEtf) return price < 50 ? 0.01 : 0.05;
  if (price < 10) return 0.01;
  if (price < 50) return 0.05;
  if (price < 100) return 0.1;
  if (price < 500) return 0.5;
  if (price < 1000) return 1;
  return 5;
}

const EPS = 1e-4; // 遠小於最小檔位 0.01 的一半，足以吸收浮點誤差、又能判出 0.05/0.25 級的次檔位偏差

/** price 是否落在合法檔位網格上（真實成交價）。次檔位（中間價/快照污染）回 false。 */
export function isValidTwTick(price: number, isEtf = false): boolean {
  if (!(price > 0)) return false;
  const t = twTickSize(price, isEtf);
  const snapped = Math.round(price / t) * t;
  return Math.abs(snapped - price) < EPS;
}

/** 把 price snap 到最近的合法檔位（個股中間價 158.75 → 159；剛好中點走 round-half-up）。 */
export function snapTwTick(price: number, isEtf = false): number {
  if (!(price > 0)) return price;
  const t = twTickSize(price, isEtf);
  return Math.round(Math.round(price / t) * t * 100) / 100;
}
