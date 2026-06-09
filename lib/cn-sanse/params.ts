// ============================================================
// 三色資金 — 指標參數「單一事實來源」（純物件、無 IO，client/script/route 皆可 import）。
//
// 把三個指標（雙B / 主力狀態F / 捕撈季節）原本硬寫死的魔術數字全部收進 SanSeParams。
//   - PRODUCTION_PARAMS = 現行通達信原碼值，逐字搬入。
//   - computeSanSe / evalConditions / dualB.ts 的 helper 都吃 `p: SanSeParams = PRODUCTION_PARAMS`，
//     不帶參數呼叫 ⇒ 與重構前 byte-identical（合約測試 sanse-params-frozen 釘死此不變量）。
//   - scale 乘數（sa.slopeMult / ms.mult / kp.mult）對「分數 > 門檻」這種布林判斷與門檻數學上冗餘，
//     搜尋時凍結（見 scripts/optimize-sanse-params.ts 的 PARAM_SPACE），只調門檻；報告分數軸才與 production 同軸。
//
// ⚠️ 三色是自創因子（鐵則 #5/#10）。本檔只是把既有公式參數化，不改變預設行為、不接新選股邏輯。
// ============================================================

export type TierThresholds = [number, number, number, number];

export interface SanSeParams {
  /** 短线上攻（紫·游资） */
  sa: {
    maShort: number;    // MA(close,5)
    ma20: number;       // MA(low,20)
    ma20Mult: number;   // ×1.1（var9 = MA(low,20)×1.1）
    recentGate: number; // BARSLAST(...) < 4（condA 站上、condC 創高 共用）
    hhvClose: number;   // HHV(close,21)
    slopeMult: number;  // ma5 斜率 ×300 ← SCALE（搜尋凍結）
  };
  /** 中线强势（紅·主力／剔除大盤同步後相對強弱） */
  ms: {
    ma240: number;      // MA(close,240)；同時是 midControl 的 240 基準（共用一條）
    idxSmooth: number;  // MA(INDEXC/MA(INDEXC,240)-1, 3)
    mult: number;       // ×50 ← SCALE（搜尋凍結）
  };
  /** 中线控盘（黃） */
  mc: {
    cnt: number;        // COUNT(close>0,250)（凍結）
    cntGate: number;    // < 240 → capital 分支（凍結；流動股幾乎不觸發）
    sumVol: number;     // SUM(vol,480)
    sumVolDiv: number;  // var7 = sumVol480 / 8
    sumVar1: number;    // SUM(VAR1,20)
    volMaLen: number;   // MA(vol/var7,20)
    denomFloor: number; // 1e-4 防呆下限（凍結；安全非 alpha）
    div2: number;       // /2.5 ← SCALE（搜尋凍結）
    smaLen: number;     // midControl = MA(...,10)
  };
  /** 控盘程度（威廉指標式震盪，餵 A3） */
  kp: {
    hhvllv: number;     // HHV(high,35)/LLV(low,35)
    b1Offset: number;   // b1 = williamsR − 35（中心化位移；非 inert，會穿過 SMA 進 b6）
    sma1N: number;      // SMA(b1,35,1)
    smaFastN: number;   // SMA(b3,3,1)
    smaFast2N: number;  // SMA(b4,3,1)
    gate: number;       // b6 > 3
    mult: number;       // ×2.5 ← SCALE（搜尋凍結）
  };
  /** XYS 動能（雙B 副圖 + 捕撈金叉 + 主力 A11 共用） */
  xys: {
    emaLen: number;     // X4 = EMA³(X1,3)
    slowMa: number;     // XYS2 = MA(XYS0,2)
    countGoldN: number; // A11: COUNT(CROSS(gold),5)
    countDeadN: number; // A11: COUNT(CROSS(dead),4)
  };
  /** 雙B戰法 */
  dualB: {
    zhinengHHV: number;  // HHV(ZB,13)
    zhinengMult: number; // ×0.95
    zb4Span: number;     // 線性加權跨距（權重與正規化常數由此 derived，非自由參數）
    zb5Ma: number;       // zb5 = MA(zb4,6)
    ma60: number;        // 多空線 MA(close,60)
  };
  /** A 閘門（站上牛熊線 / 控盤 / 剛啟動 / 洗過盤 / 持續控盤） */
  gates: {
    bullBearHHVLLV: number; // LLV(close×1.1,21)/HHV(close×0.9,21)
    bullMult: number;       // 牛線 ×1.1
    bearMult: number;       // 熊線 ×0.9
    a3KongPan: number;      // A3: kongPan > 80（在 kp 尺度上）
    a4Recent: number;       // A4: REF(shortAttack,1) < 0.1（在 SA 尺度上）
    a5CountN: number;       // A5: COUNT(midStrength<0,50) ≥ 1（sign-based → 尺度不變）
    a7CountN: number;       // A7: COUNT(kongPan=0,30)
    a7CountMax: number;     // A7: ... ≤ 1
  };
  /** 嚴/中/寬 選股切點 */
  level: {
    strictSA: number;   // shortAttack > 2.8（SA 尺度）
    strictMS: number;   // midStrength > 3.9（MS 尺度）
    strictMC: number;   // midControl > 0（sign）
    mediumEps: number;  // 三分數 > 0.01
  };
  /** 捕撈量價強勢 proxy（c_gold_vol；全市場掃描抓不到真換手率彩柱，用 candle volume 近似） */
  catch: {
    volMa: number;        // MA(vol,5)
    volSurgeMult: number; // vol > MA5 × 1.5
  };
  /** 捕撈季節 4 級量能彩柱（走圖；回測腳本本地重算，逐市場門檻不同） */
  tier: {
    amountEma: number;        // EMA(amount,13)
    volEma: number;           // EMA(vol,13)
    turnoverEma: number;      // EMA(turnover,13)
    devGate: number;          // X10 > 5（偏離成本門檻）
    thresholds: TierThresholds; // [green, yellow, cyan, blue] 換手率門檻
  };
}

/** 陸股 4 級彩柱門檻（通達信原碼值）。 */
export const CN_TIER_THRESHOLDS: TierThresholds = [6.1, 3.8, 2.1, 1.8];
/** 台股 4 級彩柱門檻（scripts/calibrate-tw-season-tiers.ts 百分位對齊；台股周轉率結構性偏低）。 */
export const TW_TIER_THRESHOLDS: TierThresholds = [2.25, 1.08, 0.66, 0.6];

/** 現行通達信原碼值（逐字）。不帶參數呼叫指標函式時的預設 ⇒ 與重構前 byte-identical。 */
export const PRODUCTION_PARAMS: SanSeParams = {
  sa: { maShort: 5, ma20: 20, ma20Mult: 1.1, recentGate: 4, hhvClose: 21, slopeMult: 300 },
  ms: { ma240: 240, idxSmooth: 3, mult: 50 },
  mc: { cnt: 250, cntGate: 240, sumVol: 480, sumVolDiv: 8, sumVar1: 20, volMaLen: 20, denomFloor: 1e-4, div2: 2.5, smaLen: 10 },
  kp: { hhvllv: 35, b1Offset: 35, sma1N: 35, smaFastN: 3, smaFast2N: 3, gate: 3, mult: 2.5 },
  xys: { emaLen: 3, slowMa: 2, countGoldN: 5, countDeadN: 4 },
  dualB: { zhinengHHV: 13, zhinengMult: 0.95, zb4Span: 20, zb5Ma: 6, ma60: 60 },
  gates: { bullBearHHVLLV: 21, bullMult: 1.1, bearMult: 0.9, a3KongPan: 80, a4Recent: 0.1, a5CountN: 50, a7CountN: 30, a7CountMax: 1 },
  level: { strictSA: 2.8, strictMS: 3.9, strictMC: 0, mediumEps: 0.01 },
  catch: { volMa: 5, volSurgeMult: 1.5 },
  tier: { amountEma: 13, volEma: 13, turnoverEma: 13, devGate: 5, thresholds: CN_TIER_THRESHOLDS },
};

/** 深 clone（搜尋時每組候選參數獨立修改，不污染 PRODUCTION_PARAMS）。 */
export function cloneParams(p: SanSeParams): SanSeParams {
  return {
    sa: { ...p.sa }, ms: { ...p.ms }, mc: { ...p.mc }, kp: { ...p.kp },
    xys: { ...p.xys }, dualB: { ...p.dualB }, gates: { ...p.gates },
    level: { ...p.level }, catch: { ...p.catch },
    tier: { ...p.tier, thresholds: [...p.tier.thresholds] as TierThresholds },
  };
}

// ── 最佳化結果落點（research-only；import 它的地方＝0；promotion 是另一個 PR 的決定，鐵則 #5/#10）──
// 看完 data/{cn,tw}-sanse/optimize-report-*.md 後，把 optimize-result-*.json 的參數手填進來。
// NOT WIRED — 任何 production 掃描/走圖/cron 都不讀這兩個常數。
export const EXPERIMENTAL_PARAMS_CN: SanSeParams | null = null;
export const EXPERIMENTAL_PARAMS_TW: SanSeParams | null = null;
