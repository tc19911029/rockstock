// ============================================================
// 通達信 (TDX) 原生函式庫 — 忠實重現選股/指標公式語意
//
// 為什麼獨立一套、不複用 lib/indicators.ts：
//  - 通達信 EMA 以「首值」起頭，lib/indicators.ts 以前 N 筆 SMA 起頭，數值會有差
//  - 通達信 SMA(X,N,M) 是加權遞迴，與一般 SMA 不同
//  - 三色資金是陸股自訂策略，依專案鐵則需與朱家泓書本選股完全隔離
//
// 慣例：所有函式吃 number[]、回傳等長 number[]，資料不足處填 NaN。
// ============================================================

const isNum = (x: number): boolean => Number.isFinite(x);

/** REF(X, N)：N 期前的值。REF(X,1) = 前一根。 */
export function REF(arr: number[], n: number): number[] {
  return arr.map((_, i) => (i - n >= 0 ? arr[i - n] : NaN));
}

/** MA(X, N)：N 期簡單移動平均。對 NaN 有韌性：遇 NaN 重置視窗，
 *  累積 N 個連續有效值後才輸出（避免資料缺口污染整條序列）。 */
export function MA(arr: number[], n: number): number[] {
  const out = new Array(arr.length).fill(NaN);
  let sum = 0, run = 0;
  for (let i = 0; i < arr.length; i++) {
    if (!isNum(arr[i])) { sum = 0; run = 0; out[i] = NaN; continue; }
    sum += arr[i]; run++;
    if (run > n) { sum -= arr[i - n]; run = n; }
    out[i] = run === n ? sum / n : NaN;
  }
  return out;
}

/** EMA(X, N)：通達信指數移動平均。Y = (2·X + (N-1)·Y') / (N+1)，首值起頭。 */
export function EMA(arr: number[], n: number): number[] {
  const out = new Array(arr.length).fill(NaN);
  const k = 2 / (n + 1);
  let prev = NaN;
  for (let i = 0; i < arr.length; i++) {
    if (!isNum(arr[i])) { out[i] = prev; continue; }
    prev = isNum(prev) ? arr[i] * k + prev * (1 - k) : arr[i];
    out[i] = prev;
  }
  return out;
}

/** SMA(X, N, M)：通達信加權遞迴。Y = (M·X + (N-M)·Y') / N，首值起頭。 */
export function SMA(arr: number[], n: number, m: number): number[] {
  const out = new Array(arr.length).fill(NaN);
  let prev = NaN;
  for (let i = 0; i < arr.length; i++) {
    if (!isNum(arr[i])) { out[i] = prev; continue; }
    prev = isNum(prev) ? (m * arr[i] + (n - m) * prev) / n : arr[i];
    out[i] = prev;
  }
  return out;
}

/** HHV(X, N)：最近 N 期最高值。 */
export function HHV(arr: number[], n: number): number[] {
  return arr.map((_, i) => {
    if (i < n - 1) return NaN;
    let h = -Infinity;
    for (let j = i - n + 1; j <= i; j++) h = Math.max(h, arr[j]);
    return h;
  });
}

/** LLV(X, N)：最近 N 期最低值。 */
export function LLV(arr: number[], n: number): number[] {
  return arr.map((_, i) => {
    if (i < n - 1) return NaN;
    let l = Infinity;
    for (let j = i - n + 1; j <= i; j++) l = Math.min(l, arr[j]);
    return l;
  });
}

/** SUM(X, N)：最近 N 期總和。對 NaN 有韌性（同 MA）。 */
export function SUM(arr: number[], n: number): number[] {
  const out = new Array(arr.length).fill(NaN);
  let sum = 0, run = 0;
  for (let i = 0; i < arr.length; i++) {
    if (!isNum(arr[i])) { sum = 0; run = 0; out[i] = NaN; continue; }
    sum += arr[i]; run++;
    if (run > n) { sum -= arr[i - n]; run = n; }
    out[i] = run === n ? sum : NaN;
  }
  return out;
}

/** COUNT(COND, N)：最近 N 期內條件成立次數。 */
export function COUNT(cond: boolean[], n: number): number[] {
  const out = new Array(cond.length).fill(NaN);
  let c = 0;
  const buf: number[] = cond.map((b) => (b ? 1 : 0));
  for (let i = 0; i < buf.length; i++) {
    c += buf[i];
    if (i >= n) c -= buf[i - n];
    if (i >= n - 1) out[i] = c;
  }
  return out;
}

/** BARSLAST(COND)：距上次條件成立的期數（當期成立=0；從未成立=自起點計）。 */
export function BARSLAST(cond: boolean[]): number[] {
  const out = new Array(cond.length).fill(NaN);
  let since = NaN;
  for (let i = 0; i < cond.length; i++) {
    if (cond[i]) since = 0;
    else if (isNum(since)) since += 1;
    out[i] = since;
  }
  return out;
}

/** CROSS(A, B)：A 上穿 B（前一根 A<B，當根 A>B）。 */
export function CROSS(a: number[], b: number[]): boolean[] {
  return a.map((_, i) => {
    if (i < 1) return false;
    const pa = a[i - 1], pb = b[i - 1], ca = a[i], cb = b[i];
    if (![pa, pb, ca, cb].every(isNum)) return false;
    return pa < pb && ca > cb;
  });
}

/** FORCAST(X, N)：N 期線性回歸的「端點預測值」(LINEARREG endpoint)。
 *  通達信語意 = 用最近 N 點最小平方擬合直線，回傳當前 bar 的擬合值。
 *  N=2 時恰好等於當前值（兩點連線過該點）。 */
export function FORCAST(arr: number[], n: number): number[] {
  return arr.map((_, i) => {
    if (i < n - 1) return NaN;
    // x = 0..n-1, y = arr[i-n+1..i]
    const meanX = (n - 1) / 2;
    let meanY = 0;
    for (let j = 0; j < n; j++) meanY += arr[i - n + 1 + j];
    meanY /= n;
    let cov = 0, varX = 0;
    for (let j = 0; j < n; j++) {
      const dx = j - meanX;
      cov += dx * (arr[i - n + 1 + j] - meanY);
      varX += dx * dx;
    }
    const slope = varX === 0 ? 0 : cov / varX;
    // 端點 x = n-1
    return meanY + slope * (n - 1 - meanX);
  });
}

// ── 元素級算術（讓公式翻譯可逐行對照） ──────────────────────────
type AoN = number[] | number;
const at = (v: AoN, i: number): number => (typeof v === 'number' ? v : v[i]);
const len = (...vs: AoN[]): number => {
  for (const v of vs) if (Array.isArray(v)) return v.length;
  return 0;
};

export function add(a: AoN, b: AoN): number[] {
  return Array.from({ length: len(a, b) }, (_, i) => at(a, i) + at(b, i));
}
export function sub(a: AoN, b: AoN): number[] {
  return Array.from({ length: len(a, b) }, (_, i) => at(a, i) - at(b, i));
}
export function mul(a: AoN, b: AoN): number[] {
  return Array.from({ length: len(a, b) }, (_, i) => at(a, i) * at(b, i));
}
export function div(a: AoN, b: AoN): number[] {
  return Array.from({ length: len(a, b) }, (_, i) => {
    const d = at(b, i);
    return d === 0 ? NaN : at(a, i) / d;
  });
}
export function MAXv(a: AoN, b: AoN): number[] {
  return Array.from({ length: len(a, b) }, (_, i) => Math.max(at(a, i), at(b, i)));
}
export function ABS(a: number[]): number[] {
  return a.map((x) => Math.abs(x));
}

// ── 比較（回傳 boolean[]） ───────────────────────────────────────
export function gt(a: AoN, b: AoN): boolean[] {
  return Array.from({ length: len(a, b) }, (_, i) => isNum(at(a, i)) && isNum(at(b, i)) && at(a, i) > at(b, i));
}
export function lt(a: AoN, b: AoN): boolean[] {
  return Array.from({ length: len(a, b) }, (_, i) => isNum(at(a, i)) && isNum(at(b, i)) && at(a, i) < at(b, i));
}
export function and(...conds: boolean[][]): boolean[] {
  return Array.from({ length: conds[0]?.length ?? 0 }, (_, i) => conds.every((c) => c[i]));
}
export function or(...conds: boolean[][]): boolean[] {
  return Array.from({ length: conds[0]?.length ?? 0 }, (_, i) => conds.some((c) => c[i]));
}

/** IF(cond, a, b) 元素級。 */
export function IFF(cond: boolean[], a: AoN, b: AoN): number[] {
  return Array.from({ length: cond.length }, (_, i) => (cond[i] ? at(a, i) : at(b, i)));
}

export { isNum };
