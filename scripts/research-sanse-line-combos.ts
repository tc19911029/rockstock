// ============================================================
// 三色（雙B戰法 + 主力狀態F + 捕撈季節）— 窮舉「所有買進組合」實證回測（研究腳本，TW / CN 通用）
//
// 為什麼寫這支（與既有 research-sanse-combo.ts 的差別）：
//   既有腳本只測「使用順序」幾個模型、且是 raw 報酬 + 單一時間窗。這支把三個指標的「所有買訊」
//   當字母，用「資格(gate)×觸發(trigger)×確認(filter)」自動展開成 ~200 個具名組合（不手挑、不漏），
//   每個組合都過四道誠實 edge 關卡：
//     1) 超額報酬（減大盤同期，open→close 對齊）— raw 含大盤 beta 不算本事
//     2) 賠少單獨量（最大回撤分布 + 賠超 -10% 比例 + 套 -10% 停損重算）
//     3) 分大盤 régime（多頭/盤整/空頭）— 防過擬合、解釋陸股牛市稀釋
//     4) train/test 時序切 70/30 — 兩段同號為正才算「穩賺」
//
//   新增之前漏掉的訊號族：捕撈季節底部量能彩柱（--tiers，需換手率）、主力狀態紅/黃翻正那根、
//   智能線翻上黃紅 + 智能>黃>紅 排序、頂/底背離。
//
// ⚠️ 三色是自創因子（鐵則 #5/#10）。此腳本只供研究三指標搭配，不改 production、不接選股鏈路。
//    是否 promote 由使用者看完報告決定（誠實 edge 紀律）。
//
// 用法：
//   npx tsx scripts/research-sanse-line-combos.ts [TW|CN] [days=480] [--tiers]
//   --tiers：連網抓換手率算「捕撈彩柱」（台股 FinMind 發行股數 / 陸股騰訊），較慢；不帶=純本地快版
// ============================================================

import { promises as fs } from 'fs';
import path from 'path';
import { getLocalCandleDir } from '@/lib/datasource/LocalCandleStore';
import { computeSanSe } from '@/lib/cn-sanse/selectors';
import { computeDualB, computeXys, computeCatchVolSurge, computeTiers, type DayExtrasArr } from '@/lib/cn-sanse/dualB';
import { PRODUCTION_PARAMS, cloneParams, CN_TIER_THRESHOLDS, TW_TIER_THRESHOLDS, type TierThresholds } from '@/lib/cn-sanse/params';
import { MA, CROSS, isNum } from '@/lib/cn-sanse/tdx';
import { fetchTwDayExtras } from '@/lib/cn-sanse/twDayExtras';
import { fetchDayExtrasCached } from '@/lib/cn-sanse/cnDayExtras';
import type { Candle } from '@/types';

type Market = 'TW' | 'CN';

const FWD_WINDOW = 32;         // forward 量測窗：maxLoss 掃此窗、確保 d10 有空間
const STOP_HOLD = 10;          // 停損情境的持有窗（d10）
const STOP_PCT = -10;          // 固定停損 %（記憶證實 -10% 是甜蜜點）
const ENTRY_MIN_IDX = 480;     // 黃(midControl) 吃 SUM(vol,480)，所有模型同起點才公平
const MIN_BARS = ENTRY_MIN_IDX + FWD_WINDOW + 8;
const LIMIT_GAP = 0.095;       // 隔日開相對訊號日收 ≥9.5% 視為追停買不到
const REGIME_BAND = 0.015;     // 指數 close/MA60 偏離 ±1.5% 內算盤整
const SPLIT_FRAC = 0.70;       // train/test 時序切點（前 70% train）
const DIV_L = 3, DIV_R = 3, DIV_LOOKBACK = 60; // 背離 pivot 參數

// ── 逐日全訊號（與 candle index 對齊） ───────────────────────────
interface G {
  n: number; dates: string[];
  O: number[]; H: number[]; L: number[]; C: number[];
  // 主力狀態（紅紫黃 + 翻正交叉 + 階段）
  red: boolean[]; purple: boolean[]; yellow: boolean[];
  redCross: boolean[]; yellowCross: boolean[];
  ignite: boolean[]; develop: boolean[]; full: boolean[]; mainBuy: boolean[];
  redNeg: boolean[]; redTurnNeg: boolean[];
  // 雙B戰法
  bGold: boolean[]; bDead: boolean[]; bBreak: boolean[]; bBreakDn: boolean[]; bRes: boolean[];
  aboveMa60: boolean[]; ma60Cross: boolean[]; dualUp: boolean[];
  zCross: boolean[]; stackZHY: boolean[]; zb4gt5: boolean[];
  limitUp: boolean[]; bigUp: boolean[];
  // 捕撈季節
  cGold: boolean[]; cDead: boolean[]; xAbove0: boolean[]; xBelow0: boolean[]; volSurge: boolean[];
  tierAny: boolean[]; tierGreen: boolean[];
  // 背離
  bottomDiv: boolean[]; topDiv: boolean[];
}

// ── 背離：pivot（左L右R 局部極值）比價與指標，訊號記在 cur+R（右側確認、防前視）──
function findPivots(close: number[], L: number, R: number): { highs: number[]; lows: number[] } {
  const n = close.length; const highs: number[] = []; const lows: number[] = [];
  for (let i = L; i < n - R; i++) {
    let isHi = true, isLo = true;
    for (let j = i - L; j <= i + R; j++) {
      if (j === i) continue;
      if (!(close[j] < close[i])) isHi = false;
      if (!(close[j] > close[i])) isLo = false;
    }
    if (isHi) highs.push(i);
    if (isLo) lows.push(i);
  }
  return { highs, lows };
}

function detectDivergence(price: number[], indicator: number[]): { bottomDiv: boolean[]; topDiv: boolean[] } {
  const n = price.length;
  const bottomDiv = new Array(n).fill(false);
  const topDiv = new Array(n).fill(false);
  const { highs, lows } = findPivots(price, DIV_L, DIV_R);
  for (let k = 1; k < highs.length; k++) {
    const cur = highs[k], prev = highs[k - 1];
    if (cur - prev > DIV_LOOKBACK) continue;
    if (!isNum(indicator[cur]) || !isNum(indicator[prev])) continue;
    if (price[cur] > price[prev] && indicator[cur] <= indicator[prev]) {
      const idx = cur + DIV_R; if (idx < n) topDiv[idx] = true;           // 價創高、指標沒創高 → 頂背離
    }
  }
  for (let k = 1; k < lows.length; k++) {
    const cur = lows[k], prev = lows[k - 1];
    if (cur - prev > DIV_LOOKBACK) continue;
    if (!isNum(indicator[cur]) || !isNum(indicator[prev])) continue;
    if (price[cur] < price[prev] && indicator[cur] >= indicator[prev]) {
      const idx = cur + DIV_R; if (idx < n) bottomDiv[idx] = true;        // 價創低、指標沒創低 → 底背離
    }
  }
  return { bottomDiv, topDiv };
}

function crossUp0(arr: number[]): boolean[] {
  return arr.map((x, i) => i > 0 && isNum(arr[i - 1]) && arr[i - 1] <= 0 && isNum(x) && x > 0);
}

function computeSignals(candles: Candle[], indexClose: number[], tier?: { tierAny: boolean[]; tierGreen: boolean[] }): G {
  const n = candles.length;
  const O = candles.map((c) => c.open), H = candles.map((c) => c.high), L = candles.map((c) => c.low), C = candles.map((c) => c.close);
  const dates = candles.map((c) => c.date);

  // 主力狀態（紅=midStrength>0、紫=shortAttack>0、黃=midControl>0）
  const s = computeSanSe(candles, indexClose);
  const ms = s.midStrength, mc = s.midControl;
  const red = ms.map((x) => isNum(x) && x > 0);
  const purple = s.shortAttack.map((x) => isNum(x) && x > 0);
  const yellow = mc.map((x) => isNum(x) && x > 0);
  const redCross = crossUp0(ms);        // 紅翻正（機構剛進）
  const yellowCross = crossUp0(mc);     // 黃翻正（剛控盤）
  const ignite = s.loose, develop = s.medium, full = s.strict;
  const mainBuy = ignite.map((g, i) => g || develop[i] || full[i]);
  const redNeg = ms.map((x) => isNum(x) && x < 0);
  const redTurnNeg = ms.map((x, i) => i > 0 && isNum(ms[i - 1]) && ms[i - 1] >= 0 && isNum(x) && x < 0);

  // 雙B戰法
  const db = computeDualB(candles);
  const { zb4, zb5, zhineng, ma60 } = db;
  const bGold = db.goldCross, bDead = db.deadCross, bBreak = db.breakUp, bBreakDn = db.breakDn;
  const bRes = bGold.map((g, i) => g && bBreak[i]);                       // 雙箭頭共振（金叉+突破同日）
  const aboveMa60 = C.map((c, i) => isNum(ma60[i]) && c > ma60[i]);
  const ma60Cross = CROSS(C, ma60);
  const dualUp = zb4.map((_, i) => i > 0 && isNum(zb4[i]) && isNum(zb4[i - 1]) && isNum(zb5[i]) && isNum(zb5[i - 1]) && zb4[i] > zb4[i - 1] && zb5[i] > zb5[i - 1]);
  const zb4gt5 = zb4.map((_, i) => isNum(zb4[i]) && isNum(zb5[i]) && zb4[i] > zb5[i]); // 黃線在紅線之上（多方）
  const stackZHY = zhineng.map((_, i) => isNum(zhineng[i]) && isNum(zb4[i]) && isNum(zb5[i]) && zhineng[i] > zb4[i] && zb4[i] > zb5[i]); // 智能>黃>紅
  const zCross = stackZHY.map((st, i) => {                                // 智能線「剛」翻上黃且紅那根
    const aboveBoth = isNum(zhineng[i]) && isNum(zb4[i]) && isNum(zb5[i]) && zhineng[i] > zb4[i] && zhineng[i] > zb5[i];
    const prevAbove = i > 0 && isNum(zhineng[i - 1]) && isNum(zb4[i - 1]) && isNum(zb5[i - 1]) && zhineng[i - 1] > zb4[i - 1] && zhineng[i - 1] > zb5[i - 1];
    return aboveBoth && !prevAbove;
  });
  // K 線變色（漲停洋紅 / 大漲黃）— 與 indicators.ts 一致（主板/台股 10%）
  const limitUp = C.map((c, i) => { if (i < 1 || !(C[i - 1] > 0)) return false; const chg = (c - C[i - 1]) / C[i - 1]; return chg > 0.095 && c === H[i]; });
  const bigUp = C.map((c, i) => { if (i < 1 || !(C[i - 1] > 0)) return false; const chg = (c - C[i - 1]) / C[i - 1]; return chg > 0.07 && chg <= 0.095; });

  // 捕撈季節
  const xys = computeXys(candles);
  const XYS1 = xys.xys1;
  const cGold = xys.goldCross, cDead = xys.deadCross;
  const xAbove0 = XYS1.map((x) => isNum(x) && x > 0);
  const xBelow0 = XYS1.map((x) => isNum(x) && x < 0);
  const volSurge = computeCatchVolSurge(candles);
  const tierAny = tier?.tierAny ?? new Array(n).fill(false);
  const tierGreen = tier?.tierGreen ?? new Array(n).fill(false);

  // 背離（價 close vs 捕撈動能 XYS1）
  const { bottomDiv, topDiv } = detectDivergence(C, XYS1);

  return {
    n, dates, O, H, L, C,
    red, purple, yellow, redCross, yellowCross, ignite, develop, full, mainBuy, redNeg, redTurnNeg,
    bGold, bDead, bBreak, bBreakDn, bRes, aboveMa60, ma60Cross, dualUp, zCross, stackZHY, zb4gt5, limitUp, bigUp,
    cGold, cDead, xAbove0, xBelow0, volSurge, tierAny, tierGreen,
    bottomDiv, topDiv,
  };
}

// ── 彩柱：把 extras 轉成逐根「任一級彩柱 / 最強綠柱」布林 ──────────
function computeTierSignals(market: Market, candles: Candle[], extras: DayExtrasArr): { tierAny: boolean[]; tierGreen: boolean[] } {
  const n = candles.length;
  const pTier = cloneParams(PRODUCTION_PARAMS);
  pTier.tier.thresholds = (market === 'TW' ? TW_TIER_THRESHOLDS : CN_TIER_THRESHOLDS) as TierThresholds;
  const xys = computeXys(candles);
  const tiers = computeTiers(candles, extras, xys, pTier);
  const anyDates = new Set<string>();
  for (const arr of [tiers.green, tiers.yellow, tiers.cyan, tiers.blue]) for (const p of arr) anyDates.add(p.time);
  const greenDates = new Set(tiers.green.map((p) => p.time));
  const tierAny = candles.map((c) => anyDates.has(c.date));
  const tierGreen = candles.map((c) => greenDates.has(c.date));
  void n;
  return { tierAny, tierGreen };
}

// ── 組合定義：gate × trigger × filter（自動展開）+ 官方/使用者具名 + 避雷 ──
type Pred = (g: G, i: number) => boolean;
interface Def { id: string; label: string; fn: Pred }

const GATES: Def[] = [
  { id: 'red', label: '紅(機構)在', fn: (g, i) => g.red[i] },
  { id: 'yellow', label: '黃(控盤)在', fn: (g, i) => g.yellow[i] },
  { id: 'redYellow', label: '紅+黃(中線骨架)', fn: (g, i) => g.red[i] && g.yellow[i] },
  { id: 'redPurple', label: '紅+紫(短線)', fn: (g, i) => g.red[i] && g.purple[i] },
  { id: 'three', label: '三色全亮(紅+紫+黃)', fn: (g, i) => g.red[i] && g.purple[i] && g.yellow[i] },
  { id: 'purple', label: '只紫在', fn: (g, i) => g.purple[i] },
  { id: 'full', label: '主力滿分階段', fn: (g, i) => g.full[i] },
  { id: 'none', label: '無資格門檻', fn: () => true },
];
const TRIGGERS: Def[] = [
  { id: 'bGold', label: '黃紅金叉', fn: (g, i) => g.bGold[i] },
  { id: 'bBreak', label: '突破智能線', fn: (g, i) => g.bBreak[i] },
  { id: 'bRes', label: '雙箭頭共振', fn: (g, i) => g.bRes[i] },
  { id: 'zCross', label: '智能線翻上黃紅', fn: (g, i) => g.zCross[i] },
  { id: 'cGold', label: '捕撈金叉', fn: (g, i) => g.cGold[i] },
  { id: 'cGoldBull', label: '多頭區金叉', fn: (g, i) => g.cGold[i] && g.xAbove0[i] },
  { id: 'cGoldBear', label: '空頭區金叉(底反)', fn: (g, i) => g.cGold[i] && g.xBelow0[i] },
  { id: 'tier', label: '捕撈彩柱出現', fn: (g, i) => g.tierAny[i] },
  { id: 'redCross', label: '紅翻正(機構剛進)', fn: (g, i) => g.redCross[i] },
  { id: 'yellowCross', label: '黃翻正(剛控盤)', fn: (g, i) => g.yellowCross[i] },
  { id: 'bottomDiv', label: '底背離', fn: (g, i) => g.bottomDiv[i] },
];
const FILTERS: Def[] = [
  { id: 'ma60', label: '站上多空線', fn: (g, i) => g.aboveMa60[i] },
  { id: 'stack', label: '智能>黃>紅排序', fn: (g, i) => g.stackZHY[i] },
  { id: 'zb4gt5', label: '黃線在紅線上', fn: (g, i) => g.zb4gt5[i] },
  { id: 'xAbove', label: '安全做多區', fn: (g, i) => g.xAbove0[i] },
  { id: 'dualUp', label: '黃紅雙線向上', fn: (g, i) => g.dualUp[i] },
  { id: 'tierGreen', label: '最強綠彩柱', fn: (g, i) => g.tierGreen[i] },
  { id: 'volSurge', label: '爆量', fn: (g, i) => g.volSurge[i] },
];

const anySell: Pred = (g, i) => g.bDead[i] || g.bBreakDn[i] || g.cDead[i] || g.redTurnNeg[i];

// 近 LB 根內某訊號曾觸發（給「先穿越、幾天內再突破金叉」的序列型組合用）
const SEQ_LB = 5;
const anyBack = (a: boolean[], i: number, lb = SEQ_LB): boolean => { for (let j = Math.max(0, i - lb + 1); j <= i; j++) if (a[j]) return true; return false; };

interface NamedModel { id: string; label: string; fn: Pred; bucket: 'named' | 'avoid' }
const NAMED: NamedModel[] = [
  // 官方教的買法（逐條驗證）
  { id: 'off_redPurple', label: '官方·做短線(紅+紫)', fn: (g, i) => g.red[i] && g.purple[i], bucket: 'named' },
  { id: 'off_redYellow', label: '官方·做中線(紅+黃)', fn: (g, i) => g.red[i] && g.yellow[i], bucket: 'named' },
  { id: 'off_three', label: '官方·三色全亮最強', fn: (g, i) => g.red[i] && g.purple[i] && g.yellow[i], bucket: 'named' },
  { id: 'off_bRes', label: '官方·雙箭頭共振', fn: (g, i) => g.bRes[i], bucket: 'named' },
  { id: 'off_cGoldTier', label: '官方·捕撈金叉+彩柱確認', fn: (g, i) => g.cGold[i] && g.tierAny[i], bucket: 'named' },
  { id: 'reson3', label: '三組齊發(雙B+主力+捕撈同日)', fn: (g, i) => g.mainBuy[i] && (g.bGold[i] || g.bBreak[i]) && g.cGold[i], bucket: 'named' },
  { id: 'bottomRev', label: '底反(紅+空頭區金叉)·既有最強基準', fn: (g, i) => g.red[i] && g.cGold[i] && g.xBelow0[i], bucket: 'named' },
  // ★使用者圖示序列：智能線穿過黃紅 → 突破 + 金叉（同日版 + 近5日序列版 + 紅燈/捕撈版）
  { id: 'seq_bg_stack', label: '突破+金叉同日 ＋ 智能在黃紅上(多頭排列)', fn: (g, i) => g.bRes[i] && g.stackZHY[i], bucket: 'named' },
  { id: 'seq_bg_stack_red', label: '突破+金叉 ＋ 智能排列 ＋ 紅燈', fn: (g, i) => g.bRes[i] && g.stackZHY[i] && g.red[i], bucket: 'named' },
  { id: 'seq_cross_then_bg', label: '近5日穿越黃紅 → 今日突破+金叉', fn: (g, i) => anyBack(g.zCross, i) && g.bRes[i], bucket: 'named' },
  { id: 'seq_cross_then_bg_red', label: '近5日穿越 → 突破+金叉 ＋ 紅燈', fn: (g, i) => anyBack(g.zCross, i) && g.bRes[i] && g.red[i], bucket: 'named' },
  { id: 'seq_cross_then_bORg', label: '近5日穿越 → 今日突破或金叉(放寬)', fn: (g, i) => anyBack(g.zCross, i) && (g.bBreak[i] || g.bGold[i]), bucket: 'named' },
  { id: 'seq_full_cgold', label: '穿越 → 突破+金叉 ＋ 捕撈金叉(你完整描述)', fn: (g, i) => anyBack(g.zCross, i) && g.bRes[i] && g.cGold[i], bucket: 'named' },
  // 使用者觀察的滿配 + 逐步放寬
  { id: 'user_full', label: '你的滿配(智能排序+紅+雙箭頭+空頭金叉)', fn: (g, i) => g.stackZHY[i] && g.red[i] && g.bRes[i] && g.cGold[i] && g.xBelow0[i], bucket: 'named' },
  { id: 'user_relax1', label: '你·放寬(智能排序+紅+雙B擇一+捕撈金叉)', fn: (g, i) => g.stackZHY[i] && g.red[i] && (g.bGold[i] || g.bBreak[i]) && g.cGold[i], bucket: 'named' },
  { id: 'user_relax2', label: '你·去排序(紅+雙箭頭+捕撈金叉)', fn: (g, i) => g.red[i] && g.bRes[i] && g.cGold[i], bucket: 'named' },
  { id: 'user_stackRed', label: '你·智能>黃>紅+紅在', fn: (g, i) => g.stackZHY[i] && g.red[i], bucket: 'named' },
  { id: 'bottomDivRev', label: '底背離+紅+底反金叉', fn: (g, i) => g.bottomDiv[i] && g.red[i] && g.cGold[i], bucket: 'named' },
  // 避雷 / 反指標（故意測，期望負超額）
  { id: 'av_topDiv', label: '避雷·頂背離追進', fn: (g, i) => g.topDiv[i], bucket: 'avoid' },
  { id: 'av_topDivChase', label: '避雷·頂背離+追突破', fn: (g, i) => g.topDiv[i] && g.bBreak[i], bucket: 'avoid' },
  { id: 'av_stackNoRed', label: '避雷·智能>黃>紅但無紅(追高?)', fn: (g, i) => g.stackZHY[i] && !g.red[i], bucket: 'avoid' },
  { id: 'av_bullNoRed', label: '避雷·多頭區金叉無紅', fn: (g, i) => g.cGold[i] && g.xAbove0[i] && !g.red[i], bucket: 'avoid' },
  { id: 'av_purpleChase', label: '避雷·純紫追(無紅+觸發)', fn: (g, i) => g.purple[i] && !g.red[i] && (g.bBreak[i] || g.cGold[i]), bucket: 'avoid' },
  { id: 'av_limitChase', label: '避雷·漲停/大漲當天追', fn: (g, i) => g.limitUp[i] || g.bigUp[i], bucket: 'avoid' },
  { id: 'av_conflict', label: '避雷·有買也有賣(同日)', fn: (g, i) => (g.red[i] && (g.bGold[i] || g.bBreak[i] || g.cGold[i])) && anySell(g, i), bucket: 'avoid' },
];

const LABELS = new Map<string, string>();
function buildModelList(): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  const add = (id: string, label: string) => { if (!LABELS.has(id)) { LABELS.set(id, label); out.push({ id, label }); } };
  add('ALL', '全體可進場K棒(大盤基準)');
  for (const t of TRIGGERS) add(`0t_${t.id}`, `單·觸發 ${t.label}`);
  for (const ga of GATES) if (ga.id !== 'none') add(`0g_${ga.id}`, `單·資格 ${ga.label}`);
  for (const f of FILTERS) add(`0f_${f.id}`, `單·狀態 ${f.label}`);
  for (const ga of GATES) for (const t of TRIGGERS) add(`1_${ga.id}__${t.id}`, `${ga.label} ＋ ${t.label}`);
  for (const t of TRIGGERS) for (const f of FILTERS) add(`2_red__${t.id}__${f.id}`, `紅 ＋ ${t.label} ＋ ${f.label}`);
  for (const m of NAMED) add(m.id, m.label);
  return out;
}

function entryHits(g: G, i: number): string[] {
  const hits: string[] = ['ALL'];
  // Level 0 單因子
  const gateVal = new Map<string, boolean>();
  for (const ga of GATES) { const v = ga.fn(g, i); gateVal.set(ga.id, v); if (ga.id !== 'none' && v) hits.push(`0g_${ga.id}`); }
  const trigVal = new Map<string, boolean>();
  for (const t of TRIGGERS) { const v = t.fn(g, i); trigVal.set(t.id, v); if (v) hits.push(`0t_${t.id}`); }
  for (const f of FILTERS) if (f.fn(g, i)) hits.push(`0f_${f.id}`);
  // Level 1 資格×觸發
  for (const ga of GATES) { if (!gateVal.get(ga.id)) continue; for (const t of TRIGGERS) if (trigVal.get(t.id)) hits.push(`1_${ga.id}__${t.id}`); }
  // Level 2 紅 × 觸發 × 確認
  if (gateVal.get('red')) for (const t of TRIGGERS) { if (!trigVal.get(t.id)) continue; for (const f of FILTERS) if (f.fn(g, i)) hits.push(`2_red__${t.id}__${f.id}`); }
  // Level 3 + E 具名
  for (const m of NAMED) if (m.fn(g, i)) hits.push(m.id);
  return hits;
}

// ── forward（隔日開進場；漲停買不到 → tradable=false）──────────────
interface Fwd { tradable: boolean; raw5: number | null; d10: number | null; ml32: number; stopped10: boolean; entryDate: string; d5Date: string | null; d10Date: string | null; }
function forwardMetrics(g: G, i: number): Fwd | null {
  if (i + 1 >= g.n) return null;
  const base = g.O[i + 1];
  if (!(base > 0)) return null;
  const eH = g.H[i + 1], eL = g.L[i + 1], eO = g.O[i + 1];
  const locked = eL > 0 && eO === eH && (eH - eL) / eL < 0.005;
  const gapUp = (g.O[i + 1] - g.C[i]) / g.C[i];
  const tradable = !(locked || gapUp >= LIMIT_GAP);
  const closeRet = (k: number): number | null => { const idx = i + 1 + k; return idx < g.n ? +(((g.C[idx] - base) / base) * 100).toFixed(3) : null; };
  const dateAt = (k: number): string | null => { const idx = i + 1 + k; return idx < g.n ? g.dates[idx] : null; };
  let ml32 = 0, stopped10 = false;
  for (let k = 0; k < FWD_WINDOW && i + 1 + k < g.n; k++) {
    const lo = ((g.L[i + 1 + k] - base) / base) * 100;
    if (lo < ml32) ml32 = lo;
    if (k < STOP_HOLD && lo <= STOP_PCT) stopped10 = true;
  }
  return { tradable, raw5: closeRet(4), d10: closeRet(9), ml32: +ml32.toFixed(3), stopped10, entryDate: g.dates[i + 1], d5Date: dateAt(4), d10Date: dateAt(9) };
}

// ── 指數 date→{open,close,ma60} ───────────────────────────────────
interface IdxRow { open: number; close: number; ma60: number }
function buildIdxMap(cs: Candle[] | null): Map<string, IdxRow> {
  const m = new Map<string, IdxRow>();
  if (!cs || !cs.length) return m;
  const sorted = [...cs].sort((a, b) => (a.date < b.date ? -1 : 1));
  const ma60 = MA(sorted.map((c) => c.close), 60);
  sorted.forEach((c, i) => m.set(c.date, { open: c.open, close: c.close, ma60: ma60[i] }));
  return m;
}
function indexRet(idx: Map<string, IdxRow>, entryDate: string, targetDate: string | null): number | null {
  if (!targetDate) return null;
  const e = idx.get(entryDate), t = idx.get(targetDate);
  if (!e || !t || !(e.open > 0)) return null;
  return ((t.close - e.open) / e.open) * 100;
}
type Regime = 'bull' | 'chop' | 'bear' | 'unknown';
function regimeAt(idx: Map<string, IdxRow>, sigDate: string): Regime {
  const r = idx.get(sigDate);
  if (!r || !isNum(r.ma60) || !(r.ma60 > 0)) return 'unknown';
  const dev = r.close / r.ma60 - 1;
  return dev > REGIME_BAND ? 'bull' : dev < -REGIME_BAND ? 'bear' : 'chop';
}

// ── 累積器：all 存陣列(中位/分位)，train/test/régime 存計數 ──────────
interface SegArr { ex5: number[]; ml: number[]; sumEx: number; nEx: number; winEx: number; sumRaw: number; nRaw: number; sumD10: number; nD10: number; winD10: number; sumStop: number; nStop: number; winStop: number; bigLoss10: number; bigLoss20: number; }
interface SegCnt { n: number; sumEx: number; winEx: number; }
interface Acc { all: SegArr; train: SegCnt; test: SegCnt; bull: SegCnt; chop: SegCnt; bear: SegCnt; }
const mkArr = (): SegArr => ({ ex5: [], ml: [], sumEx: 0, nEx: 0, winEx: 0, sumRaw: 0, nRaw: 0, sumD10: 0, nD10: 0, winD10: 0, sumStop: 0, nStop: 0, winStop: 0, bigLoss10: 0, bigLoss20: 0 });
const mkCnt = (): SegCnt => ({ n: 0, sumEx: 0, winEx: 0 });
const mkAcc = (): Acc => ({ all: mkArr(), train: mkCnt(), test: mkCnt(), bull: mkCnt(), chop: mkCnt(), bear: mkCnt() });

interface Sample { ex5: number | null; raw5: number | null; d10: number | null; stop10: number | null; ml32: number; regime: Regime; isTest: boolean; }
function pushSample(a: Acc, sm: Sample) {
  const s = a.all;
  if (sm.ex5 != null) { s.ex5.push(sm.ex5); s.sumEx += sm.ex5; s.nEx++; if (sm.ex5 > 0) s.winEx++; }
  if (sm.raw5 != null) { s.sumRaw += sm.raw5; s.nRaw++; }
  if (sm.d10 != null) { s.sumD10 += sm.d10; s.nD10++; if (sm.d10 > 0) s.winD10++; }
  if (sm.stop10 != null) { s.sumStop += sm.stop10; s.nStop++; if (sm.stop10 > 0) s.winStop++; }
  s.ml.push(sm.ml32); if (sm.ml32 <= -10) s.bigLoss10++; if (sm.ml32 <= -20) s.bigLoss20++;
  if (sm.ex5 != null) {
    const seg = sm.isTest ? a.test : a.train; seg.n++; seg.sumEx += sm.ex5; if (sm.ex5 > 0) seg.winEx++;
    const r = sm.regime; if (r !== 'unknown') { const rs = a[r]; rs.n++; rs.sumEx += sm.ex5; if (sm.ex5 > 0) rs.winEx++; }
  }
}

// ── 統計 ────────────────────────────────────────────────────────
function median(xs: number[]): number | null { if (!xs.length) return null; const v = [...xs].sort((a, b) => a - b); const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; }
function pct(xs: number[], p: number): number | null { if (!xs.length) return null; const v = [...xs].sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.max(0, Math.floor(p * v.length)))]; }
const mean = (sum: number, n: number): number | null => (n > 0 ? sum / n : null);
const fmtPct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
const fmt1 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(1));

// ── universe ────────────────────────────────────────────────────
async function readRaw(dir: string, symbol: string): Promise<Candle[] | null> {
  try {
    const raw = await fs.readFile(path.join(dir, `${symbol}.json`), 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.candles)) return null;
    const cs = data.candles as Candle[];
    for (const c of cs) if (typeof c.date === 'string' && c.date.endsWith('*')) c.date = c.date.slice(0, -1);
    return cs;
  } catch { return null; }
}
const CN_INDEX_SH = '000001.SS', CN_INDEX_SZ = '399001.SZ', TW_INDEX = '^TWII';
function isCommonTw(file: string): boolean { const m = file.match(/^(\d{4})\.(TW|TWO)\.json$/); if (!m) return false; if (m[1].startsWith('00')) return false; return true; }
function isExcludedCn(symbol: string, name: string): boolean { const code = symbol.split('.')[0]; if (/^(30|688|8|4)/.test(code)) return true; if (name.includes('ST') || name.startsWith('*') || name.startsWith('S')) return true; if (name.includes('退')) return true; return false; }
async function loadUniverse(market: Market, dir: string): Promise<string[]> {
  if (market === 'TW') { const files = await fs.readdir(dir); return files.filter(isCommonTw).map((f) => f.replace(/\.json$/, '')); }
  const raw = await fs.readFile(path.join(process.cwd(), 'data/cn_stocklist.json'), 'utf8');
  const seen = new Set<string>(); const out: string[] = [];
  for (const s of (JSON.parse(raw).stocks ?? []) as { symbol: string; name: string }[]) {
    if (!s.symbol || s.symbol === CN_INDEX_SH || s.symbol === CN_INDEX_SZ) continue;
    if (isExcludedCn(s.symbol, s.name)) continue;
    if (seen.has(s.symbol)) continue; seen.add(s.symbol); out.push(s.symbol);
  }
  return out;
}

// ── 主流程 ──────────────────────────────────────────────────────
async function main() {
  const market = (process.argv[2] ?? 'TW').toUpperCase() as Market;
  if (market !== 'TW' && market !== 'CN') throw new Error('market 只能 TW 或 CN');
  const days = parseInt(process.argv[3] ?? '480', 10) || 480;
  const useTiers = process.argv.includes('--tiers');
  const stamp = new Date().toISOString().slice(0, 10);
  const dir = getLocalCandleDir(market);
  const outDir = path.join(process.cwd(), 'data', market === 'TW' ? 'tw-sanse' : 'cn-sanse');
  await fs.mkdir(outDir, { recursive: true });

  const idxSH = buildIdxMap(await readRaw(dir, market === 'TW' ? TW_INDEX : CN_INDEX_SH));
  if (idxSH.size === 0) throw new Error(`找不到指數本地K線（${market === 'TW' ? TW_INDEX : CN_INDEX_SH}）`);
  const idxSZ = market === 'CN' ? buildIdxMap(await readRaw(dir, CN_INDEX_SZ)) : idxSH;
  const idxSZeff = idxSZ.size > 0 ? idxSZ : idxSH;

  const universe = await loadUniverse(market, dir);
  console.log(`[line-combo] ${market} universe ${universe.length} 檔｜起點 ${ENTRY_MIN_IDX} 根｜每檔最近 ${days} 進場日｜彩柱=${useTiers ? '開(連網)' : '關'}`);

  const models = buildModelList();
  const acc = new Map<string, Acc>();
  for (const m of models) acc.set(m.id, mkAcc());
  const newSigCnt = { stackZHY: 0, zCross: 0, redCross: 0, yellowCross: 0, bottomDiv: 0, topDiv: 0, tierAny: 0, totalBars: 0 };
  let tierHit = 0, tierMiss = 0;

  // 第一遍只蒐集 tradable 進場日 → splitDate（全市場共用一條時間線）
  const allEntryDates: string[] = [];

  let stocksUsed = 0, stocksSkipped = 0, tradableBars = 0, limitUpExcluded = 0;
  let entryDateMin = '9999', entryDateMax = '0000';

  // 為了 train/test 切點，需先知道所有進場日。用兩遍：第一遍算 splitDate，第二遍累積。
  // 但載入 K 線昂貴 → 單遍收集樣本到記憶體，最後再切。樣本量大 → 只暫存「每檔的 hits + sample」太重；
  // 改：單遍先把每檔算好的 (entryDate, regime, ex5, raw5, d10, stop10, ml32, hits) 立即累積到「未定 train/test」，
  // 同時記錄 entryDate；第二步用 splitDate 重標 train/test。為此 all 段先全收，train/test 在「暫存樣本」後切。
  // 折衷（省記憶體）：先掃一遍只算 splitDate（不需報酬、只判 tradable 很快），再正式掃一遍。
  const pass = async (collectOnly: boolean) => {
    const BATCH = 80;
    for (let b = 0; b < universe.length; b += BATCH) {
      const batch = universe.slice(b, b + BATCH);
      const loaded = await Promise.all(batch.map((sym) => readRaw(dir, sym)));
      const tierData = useTiers && !collectOnly
        ? await Promise.all(batch.map(async (sym, k) => {
            const cs = loaded[k]; if (!cs || cs.length < MIN_BARS) return undefined;
            try {
              if (market === 'TW') return await fetchTwDayExtras(sym, cs);
              const map = await fetchDayExtrasCached(sym, cs);
              if (!map.size) return undefined;
              const amount = cs.map((c) => map.get(c.date)?.amount ?? NaN);
              const vol = cs.map((c) => map.get(c.date)?.vol ?? NaN);
              const turnover = cs.map((c) => map.get(c.date)?.turnover ?? NaN);
              return { amount, vol, turnover } as DayExtrasArr;
            } catch { return undefined; }
          }))
        : null;

      for (let k = 0; k < batch.length; k++) {
        const symbol = batch[k]; const candles = loaded[k];
        if (!candles || candles.length < MIN_BARS) { if (!collectOnly) stocksSkipped++; continue; }
        // 第一遍（collectOnly）只為算 splitDate：用 K 線輕量判 tradable，不重算昂貴的三色訊號
        if (collectOnly) {
          const n = candles.length; const hi = n - 1 - FWD_WINDOW; const lo = Math.max(ENTRY_MIN_IDX, hi - days + 1);
          for (let i = lo; i <= hi; i++) {
            const e = candles[i + 1]; if (!e || !(e.open > 0)) continue;
            const locked = e.low > 0 && e.open === e.high && (e.high - e.low) / e.low < 0.005;
            const gapUp = (e.open - candles[i].close) / candles[i].close;
            if (locked || gapUp >= LIMIT_GAP) continue;
            allEntryDates.push(e.date);
          }
          continue;
        }
        try {
          const homeIdx = market === 'CN' && symbol.endsWith('.SZ') ? idxSZeff : idxSH;
          let last = NaN;
          const indexClose = candles.map((c) => { const v = homeIdx.get(c.date)?.close; if (v != null) last = v; return last; });
          let tierSig: { tierAny: boolean[]; tierGreen: boolean[] } | undefined;
          if (tierData) { const ex = tierData[k]; if (ex) { tierSig = computeTierSignals(market, candles, ex); tierHit++; } else tierMiss++; }
          const g = computeSignals(candles, indexClose, tierSig);
          const hi = g.n - 1 - FWD_WINDOW;
          const lo = Math.max(ENTRY_MIN_IDX, hi - days + 1);
          if (hi < lo) { if (!collectOnly) stocksSkipped++; continue; }
          let used = false;
          for (let i = lo; i <= hi; i++) {
            const f = forwardMetrics(g, i);
            if (!f) continue;
            if (!f.tradable) { limitUpExcluded++; continue; }
            tradableBars++; used = true;
            if (g.dates[i] < entryDateMin) entryDateMin = g.dates[i];
            if (g.dates[i] > entryDateMax) entryDateMax = g.dates[i];
            newSigCnt.totalBars++;
            if (g.stackZHY[i]) newSigCnt.stackZHY++; if (g.zCross[i]) newSigCnt.zCross++;
            if (g.redCross[i]) newSigCnt.redCross++; if (g.yellowCross[i]) newSigCnt.yellowCross++;
            if (g.bottomDiv[i]) newSigCnt.bottomDiv++; if (g.topDiv[i]) newSigCnt.topDiv++;
            if (g.tierAny[i]) newSigCnt.tierAny++;
            const ex5 = f.raw5 == null ? null : (() => { const ir = indexRet(homeIdx, f.entryDate, f.d5Date); return ir == null ? null : +(f.raw5! - ir).toFixed(3); })();
            const stop10 = f.d10 == null ? null : (f.stopped10 ? STOP_PCT : f.d10);
            const sm: Sample = { ex5, raw5: f.raw5, d10: f.d10, stop10, ml32: f.ml32, regime: regimeAt(homeIdx, g.dates[i]), isTest: g.dates[i + 1] > splitDate };
            const hits = entryHits(g, i);
            for (const id of hits) { const a = acc.get(id); if (a) pushSample(a, sm); }
          }
          if (!collectOnly) { if (used) stocksUsed++; else stocksSkipped++; }
        } catch (e) { if (!collectOnly) { stocksSkipped++; console.error(`[line-combo] ${symbol} ✗ ${e instanceof Error ? e.message : e}`); } }
      }
      if (!collectOnly && (b / BATCH) % 5 === 0) console.log(`[line-combo] ${market} 進度 ${Math.min(b + BATCH, universe.length)}/${universe.length}｜用 ${stocksUsed} 檔｜可進場 ${tradableBars} 筆`);
    }
  };

  let splitDate = '9999';
  await pass(true);
  allEntryDates.sort();
  splitDate = allEntryDates.length ? allEntryDates[Math.floor(allEntryDates.length * SPLIT_FRAC)] : '9999';
  console.log(`[line-combo] ${market} train/test 切點 splitDate=${splitDate}（前 ${Math.round(SPLIT_FRAC * 100)}% train，共 ${allEntryDates.length} 進場日）`);
  await pass(false);

  const limitPct = tradableBars + limitUpExcluded > 0 ? (limitUpExcluded / (tradableBars + limitUpExcluded)) * 100 : 0;
  console.log(`[line-combo] ${market} 完成：用 ${stocksUsed} 檔 / 跳過 ${stocksSkipped}｜可進場 ${tradableBars} 筆｜漲停剔除 ${limitUpExcluded}（${limitPct.toFixed(1)}%）｜進場日 ${entryDateMin}~${entryDateMax}`);
  if (useTiers) console.log(`[line-combo] 彩柱 extras 命中 ${tierHit} / 缺 ${tierMiss}（命中率 ${tierHit + tierMiss > 0 ? ((tierHit / (tierHit + tierMiss)) * 100).toFixed(0) : 0}%）`);
  const pc = (x: number) => `${((x / Math.max(1, newSigCnt.totalBars)) * 100).toFixed(2)}%`;
  console.log(`[line-combo] 新訊號出現率（佔可進場K棒）：智能>黃>紅 ${pc(newSigCnt.stackZHY)}(${newSigCnt.stackZHY})｜智能翻上黃紅 ${pc(newSigCnt.zCross)}(${newSigCnt.zCross})｜紅翻正 ${pc(newSigCnt.redCross)}(${newSigCnt.redCross})｜黃翻正 ${pc(newSigCnt.yellowCross)}(${newSigCnt.yellowCross})｜底背離 ${pc(newSigCnt.bottomDiv)}(${newSigCnt.bottomDiv})｜頂背離 ${pc(newSigCnt.topDiv)}(${newSigCnt.topDiv})｜彩柱 ${pc(newSigCnt.tierAny)}(${newSigCnt.tierAny})`);

  // ── 落地 ──
  const meta = { market, stamp, days, useTiers, splitDate, stocksUsed, stocksSkipped, tradableBars, limitUpExcluded, limitPct: +limitPct.toFixed(1), entryDateMin, entryDateMax, newSigCnt, tierHit, tierMiss };
  const rows = models.map((m) => {
    const a = acc.get(m.id)!; const s = a.all;
    return {
      id: m.id, label: m.label,
      n: s.nEx, winEx: s.nEx ? (s.winEx / s.nEx) * 100 : null,
      meanEx: mean(s.sumEx, s.nEx), medEx: median(s.ex5), meanRaw: mean(s.sumRaw, s.nRaw),
      mlMed: median(s.ml), mlP25: pct(s.ml, 0.25),
      bigLoss10: s.ml.length ? (s.bigLoss10 / s.ml.length) * 100 : null,
      bigLoss20: s.ml.length ? (s.bigLoss20 / s.ml.length) * 100 : null,
      meanD10: mean(s.sumD10, s.nD10), winD10: s.nD10 ? (s.winD10 / s.nD10) * 100 : null,
      meanStop: mean(s.sumStop, s.nStop), winStop: s.nStop ? (s.winStop / s.nStop) * 100 : null,
      trainN: a.train.n, trainEx: mean(a.train.sumEx, a.train.n), testN: a.test.n, testEx: mean(a.test.sumEx, a.test.n),
      bullN: a.bull.n, bullEx: mean(a.bull.sumEx, a.bull.n), chopN: a.chop.n, chopEx: mean(a.chop.sumEx, a.chop.n), bearN: a.bear.n, bearEx: mean(a.bear.sumEx, a.bear.n),
    };
  });
  await fs.writeFile(path.join(outDir, 'line-combo-entry-stats.json'), JSON.stringify({ meta, models: rows }), 'utf8');
  const report = buildReport(meta, rows);
  await fs.writeFile(path.join(outDir, `line-combo-report-${stamp}.md`), report, 'utf8');
  console.log(`[line-combo] ${market} 已寫 → ${path.relative(process.cwd(), outDir)}/line-combo-{entry-stats.json,report-${stamp}.md}`);
  console.log('\n' + report);
}

const MIN_N = 50, MIN_SEG_N = 30;
// ✅會賺清單的樣本下限拉高（防小樣本假發現佔頭條）：train≥150 且 test≥100
const WIN_MIN_TRAIN = 150, WIN_MIN_TEST = 100;

function buildReport(meta: any, rows: any[]): string {
  const L: string[] = [];
  const mk = meta.market === 'TW' ? '台股' : '陸股';
  const get = (id: string) => rows.find((r: any) => r.id === id);
  // ✅會賺：避雷組(av_)不列入「該買」榜（它們是反指標假設，為正另闢一段說明）
  // 三段 régime（多頭/盤整/空頭）都不可為負（對稱守門，含空頭）
  const consistentWin = (r: any) => !r.id.startsWith('av_') && r.trainN >= WIN_MIN_TRAIN && r.testN >= WIN_MIN_TEST && r.trainEx != null && r.testEx != null && r.trainEx > 0 && r.testEx > 0 && (r.bullEx == null || r.bullEx >= 0) && (r.chopEx == null || r.chopEx >= 0) && (r.bearEx == null || r.bearEx >= 0);
  // 排序用「訓練、測試兩段較弱那段」當穩定度分數（避免被測試段小樣本暴衝拉到頭條）
  const wScore = (r: any) => Math.min(r.trainEx, r.testEx);
  const consistentLose = (r: any) => r.trainN >= MIN_SEG_N && r.testN >= MIN_SEG_N && r.trainEx != null && r.testEx != null && r.trainEx < 0 && r.testEx < 0;
  const eligible = rows.filter((r: any) => r.id !== 'ALL' && r.n >= MIN_N);

  L.push(`# 三色窮舉買法 — ${mk}「怎麼買比較會賺、會少賠」實證（${meta.stamp}）`);
  L.push('');
  L.push(`用 ${meta.stocksUsed} 檔（跳過 ${meta.stocksSkipped} 檔歷史不足 ${MIN_BARS} 根）｜可進場 ${meta.tradableBars} 筆｜進場日 ${meta.entryDateMin} ~ ${meta.entryDateMax}`);
  L.push(`進場=隔日開盤、漲停買不到剔除 ${meta.limitUpExcluded} 筆（${meta.limitPct}%）｜train/test 切點=${meta.splitDate}（前 70% train）｜彩柱=${meta.useTiers ? '開' : '關'}`);
  L.push(`**報酬=超額（已減大盤同期 open→close）**，不是帳面。régime 用指數收盤 vs 指數60日線分多頭/盤整/空頭。`);
  L.push('');

  // 一句話結論
  const winners = eligible.filter(consistentWin).sort((a: any, b: any) => wScore(b) - wScore(a));
  const losers = eligible.filter(consistentLose).sort((a: any, b: any) => a.testEx - b.testEx);
  const stack = meta.newSigCnt.stackZHY, totalB = meta.newSigCnt.totalBars;
  const userStack = get('user_stackRed');
  L.push('## 一句話結論');
  const top = winners[0], worst = losers[0];
  L.push(`- 最穩的買法：${top ? `**${top.label}**（測試段 ${top.testN} 筆、比大盤多賺 ${fmtPct(top.testEx)}、訓練段 ${fmtPct(top.trainEx)}、勝率 ${fmt1(top.winEx)}%）。⚠️注意中位數超額 ${fmtPct(top.medEx)}＝典型一筆其實小賠，正報酬靠少數大贏拉起。` : '（這段資料沒有任何組合通過 train/test+régime 全部關卡 → 都別太當真）'}`);
  L.push(`- 最該避開：${worst ? `**${worst.label}**（訓練、測試兩段都輸大盤，測試段 ${fmtPct(worst.testEx)}）` : '（無明確兩段皆負的組合）'}`);
  L.push(`- 你的「智能>黃>紅 排序」：全市場出現 ${((stack / Math.max(1, totalB)) * 100).toFixed(2)}%（${stack} 筆）${stack < 200 ? '＝偏少、結論僅供參考' : '＝夠常見、可測'}。${userStack && userStack.n >= MIN_N ? `配紅燈後比大盤 ${fmtPct(userStack.meanEx)}（${userStack.n} 筆）。` : ''}`);
  L.push('');

  // ✅ 會賺
  L.push('## ✅ 會賺的買法（超額為正 + 訓練/測試同號 + 多頭&盤整不輸）');
  L.push('');
  if (!winners.length) { L.push('（這段市場沒有組合通過全部關卡。三色 alpha 不穩、別硬做。）'); }
  else {
    L.push(`| 買法 | 樣本(訓/測) | 勝率 | 比大盤(訓) | 比大盤(測) | 中位超額 | 賠超10%比例 | 套-10%停損後均報 |`);
    L.push(`|---|---:|---:|---:|---:|---:|---:|---:|`);
    for (const r of winners.slice(0, 18)) L.push(`| ${r.label} | ${r.trainN}/${r.testN} | ${fmt1(r.winEx)}% | ${fmtPct(r.trainEx)} | ${fmtPct(r.testEx)} | ${fmtPct(r.medEx)} | ${fmt1(r.bigLoss10)}% | ${fmtPct(r.meanStop)} |`);
  }
  L.push('');

  // ☠️ 會賠
  L.push('## ☠️ 會賠的買法（訓練+測試兩段都輸大盤，當避雷）');
  L.push('');
  if (!losers.length) L.push('（無兩段皆負組合。）');
  else {
    L.push(`| 買法 | 樣本(訓/測) | 比大盤(訓) | 比大盤(測) | 賠超10%比例 |`);
    L.push(`|---|---:|---:|---:|---:|`);
    for (const r of losers.slice(0, 15)) L.push(`| ${r.label} | ${r.trainN}/${r.testN} | ${fmtPct(r.trainEx)} | ${fmtPct(r.testEx)} | ${fmt1(r.bigLoss10)}% |`);
  }
  L.push('');

  // 原本當避雷測、卻為正的反指標（特別是陸股動能市場：頂背離不靈）
  const avoidPos = rows.filter((r: any) => r.id.startsWith('av_') && r.n >= MIN_N && r.trainN >= MIN_SEG_N && r.testN >= MIN_SEG_N && r.trainEx != null && r.testEx != null && r.trainEx >= 0 && r.testEx >= 0).sort((a: any, b: any) => b.testEx - a.testEx);
  if (avoidPos.length) {
    L.push('## ⚠️ 原本當「避雷」測、這段反而不算雷（別當買訊、但也別當賣訊）');
    L.push('');
    L.push(`| 反指標 | 樣本(訓/測) | 比大盤(訓) | 比大盤(測) |`);
    L.push(`|---|---:|---:|---:|`);
    for (const r of avoidPos) L.push(`| ${r.label} | ${r.trainN}/${r.testN} | ${fmtPct(r.trainEx)} | ${fmtPct(r.testEx)} |`);
    L.push(`> ${mk === '陸股' ? '陸股是散戶/動能市場，「頂背離、追突破」這類在台股該避的訊號這段反而不跌 → 不是賣點，但勝率仍低、別當買法。' : '這幾個原本以為該避，這段沒跌；樣本/期間敏感，別據此追高。'}`);
    L.push('');
  }

  // 你的觀察逐條
  L.push('## 你的觀察逐條驗證');
  const verify = (id: string, name: string) => { const r = get(id); if (!r) { L.push(`- ${name}：無此模型`); return; } L.push(`- ${name}：${r.n < MIN_N ? `樣本只 ${r.n} 筆、不下結論` : `${r.n} 筆，比大盤平均 ${fmtPct(r.meanEx)}、勝率 ${fmt1(r.winEx)}%、測試段 ${fmtPct(r.testEx)}`}`); };
  verify('user_stackRed', '智能>黃>紅 + 紅在');
  verify('seq_bg_stack', '突破+金叉同日 + 智能在黃紅上');
  verify('seq_bg_stack_red', '突破+金叉 + 智能排列 + 紅燈');
  verify('seq_cross_then_bg', '近5日穿越 → 突破+金叉');
  verify('seq_cross_then_bg_red', '近5日穿越 → 突破+金叉 + 紅燈');
  verify('seq_full_cgold', '穿越 → 突破+金叉 + 捕撈金叉');
  verify('user_full', '你的滿配(排序+紅+雙箭頭+空頭金叉)');
  verify('0t_bBreak', '突破智能線(單用)');
  verify('0t_bGold', '黃紅金叉(單用)');
  verify('0t_cGold', '捕撈金叉(單用)');
  verify('1_red__cGoldBear', '紅 + 空頭區金叉(底反)');
  verify('1_red__cGoldBull', '紅 + 多頭區金叉');
  verify('1_red__redCross', '紅在 + 紅翻正');
  verify('0t_bottomDiv', '底背離(單用)');
  verify('av_topDiv', '頂背離(避雷組)');
  verify('0t_tier', '捕撈彩柱(單用)');
  L.push('');

  // 官方買法逐條
  L.push('## 官方教的買法逐條驗證');
  for (const [id, name] of [['off_redPurple', '做短線=紅+紫'], ['off_redYellow', '做中線=紅+黃'], ['off_three', '三色全亮最強'], ['off_bRes', '雙箭頭共振'], ['off_cGoldTier', '捕撈金叉+彩柱確認'], ['bottomRev', '底反=紅+空頭區金叉'], ['reson3', '三組齊發']]) verify(id, name);
  L.push('');

  // régime 對照（取會賺前幾 + 幾個關鍵）
  L.push('## 行情(régime)對照 — 同買法在多頭/盤整/空頭各自表現');
  L.push('');
  L.push(`| 買法 | 多頭(n/超額) | 盤整(n/超額) | 空頭(n/超額) |`);
  L.push(`|---|---:|---:|---:|`);
  const regimeShow = [...new Set([...winners.slice(0, 6).map((r: any) => r.id), 'bottomRev', 'off_three', 'user_stackRed', '1_red__cGoldBear'])];
  for (const id of regimeShow) { const r = get(id); if (!r || r.n < MIN_N) continue; L.push(`| ${r.label} | ${r.bullN}/${fmtPct(r.bullEx)} | ${r.chopN}/${fmtPct(r.chopEx)} | ${r.bearN}/${fmtPct(r.bearEx)} |`); }
  L.push('');

  // 停損效果（取會賺前幾）
  L.push('## 停損效果 — 死抱(10日) vs 套 -10% 停損（此表為帳面報酬、非超額，重點看尾部風險被砍多少）');
  L.push('');
  L.push(`| 買法 | 死抱10日均報 | 停損後均報 | 賠超10%比例 | 賠超20%比例 |`);
  L.push(`|---|---:|---:|---:|---:|`);
  const stopShow = winners.slice(0, 8).length ? winners.slice(0, 8) : eligible.slice(0, 8);
  for (const r of stopShow) L.push(`| ${r.label} | ${fmtPct(r.meanD10)} | ${fmtPct(r.meanStop)} | ${fmt1(r.bigLoss10)}% | ${fmt1(r.bigLoss20)}% |`);
  L.push('');

  L.push('## 方法與限制');
  L.push(`- 報酬=超額（減大盤 ^TWII/000001.SS 同期，open→close 對齊）；régime=指數收盤 vs 指數60日線 ±${(REGIME_BAND * 100).toFixed(1)}%。`);
  L.push(`- 賠少：最大回撤掃 ${FWD_WINDOW} 日窗；停損情境=持有 ${STOP_HOLD} 日內最低觸 ${STOP_PCT}% 即出。`);
  L.push(`- 背離 pivot 左${DIV_L}右${DIV_R}、訊號記在右側確認那根（防前視），主指標=捕撈動能 XYS1。`);
  L.push(`- 樣本門檻：總 n≥${MIN_N}、train/test 各 n≥${MIN_SEG_N} 才下結論；組合多=多重檢定風險，只信「兩段同號+多頭&盤整不輸」。`);
  L.push(`- 三色是自創因子，僅研究三指標搭配，不接選股鏈路（鐵則 #5）。`);
  return L.join('\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
