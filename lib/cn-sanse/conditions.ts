// ============================================================
// 三色資金 — 條件層「單一事實來源」。
//
// 把選股拆成三組可見條件：🟦雙B / 🟪主力狀態 / 🟩捕撈季節，每組各有買進 + 賣出。
//   - kind='signal' 的買進條件才會觸發「進名單 / 算共振組數」；
//   - kind='state' 是位階/背景（如站上多空線、動能多頭區），只顯示不計入選股。
//   - 主力組用「階段」表達強度：點火🔥(紫剛翻正) → 發展📈(三色齊揚) → 滿分⭐(三色強+控盤+牛熊線+剛啟動)。
//   - 賣出條件 signal 命中 → 進 sellWarnings（高亮警示，不剔除）。
//
// 雙B / XYS 公式共用 ./dualB（與走圖同源），分數共用 computeSanSe；皆吃 p: SanSeParams。
// 不帶 p ⇒ 預設 PRODUCTION_PARAMS ⇒ 與重構前 byte-identical（sanse-params-frozen 釘死）。
// ============================================================

import { MA, BARSLAST, gt, isNum } from './tdx';
import { computeSanSe, evalLatest, type SanSeSeries } from './selectors';
import { computeDualB, computeXys, computeCatchVolSurge } from './dualB';
import { PRODUCTION_PARAMS, type SanSeParams } from './params';
import type { Candle } from '@/types';

export type CondGroup = 'doubleB' | 'mainforce' | 'catch';
export type MainStage = 'ignite' | 'develop' | 'full';

export const STAGE_LABEL: Record<MainStage, string> = { ignite: '點火', develop: '發展', full: '滿分' };
export const STAGE_ICON: Record<MainStage, string> = { ignite: '🔥', develop: '📈', full: '⭐' };

export interface Cond { id: string; label: string; met: boolean; kind: 'signal' | 'state' }
export interface GroupReport { buy: Cond[]; sell: Cond[]; buyHit: boolean; sellHit: boolean }
export type ResLevel = 'strong' | 'medium' | 'weak';

/**
 * 使用順序評級 — 回測推導（data/sanse-combo-playbook.md，scripts/research-sanse-combo.ts）。
 * 結論：① 紅色(中線機構)在場當「前提」(紫色單獨當前提是最弱的) → ② 捕撈/雙B 金叉「觸發」進場
 * (0軸下底部反彈金叉勝率較高) → ③ 三燈全亮＋雙B金叉＋捕撈金叉的「全共振」最強。
 * 純衍生自三色分數與既有訊號，不另算指標。
 */
export type ComboGrade = 'top' | 'prime' | 'mid' | 'watch' | 'weak';
export interface ComboGuide {
  grade: ComboGrade;
  rank: number;            // top=5 … weak=1（排序用，高＝勝出順序在前）
  label: string;
  redGate: boolean;        // 紅(中線機構)在場＝勝出順序的前提
  trigger: boolean;        // 捕撈金叉 或 雙B金叉/突破＝進場觸發
  bottomReversal: boolean; // 捕撈 0 軸下空頭區金叉（底部反彈，回測勝率較高）
  midline: boolean;        // 紅＋黃＝做中線骨架
}
export const COMBO_LABEL: Record<ComboGrade, string> = {
  top: '全共振⭐', prime: '紅當前提+觸發', mid: '紅+黃中線', watch: '紅待觸發', weak: '無紅·低勝率',
};
export const COMBO_RANK: Record<ComboGrade, number> = { top: 5, prime: 4, mid: 3, watch: 2, weak: 1 };
/** 每級的一句判讀（給訊號面板/掃描清單/條件面板共用，回測推導）。 */
export const COMBO_HINT: Record<ComboGrade, string> = {
  top: '紅／紫／黃三燈全亮，且雙B金叉＋捕撈金叉同日成立＝全共振（回測最強但稀有）',
  prime: '紅(機構)在場＋金叉觸發＝主進場（回測勝出組）',
  mid: '紅＋黃中線骨架，無金叉觸發→等捕撈/雙B金叉或續抱',
  watch: '紅在場、尚無觸發→等捕撈/雙B金叉再進',
  weak: '紅(機構)未在場→純紫/單指標進場回測最弱，謹慎',
};

export interface ConditionReport {
  doubleB: GroupReport;
  mainforce: GroupReport;
  catch: GroupReport;
  mainStage: MainStage | null;
  groupBuyCount: number;          // 觸發買進的組數 0–3
  level: ResLevel | null;         // 3→強 2→中 1→弱；0→null（不入選）
  selected: boolean;              // groupBuyCount ≥ 1
  conflict: boolean;              // 有買進同時有賣出
  sellWarnings: string[];         // 命中的賣出條件 label
  scores: { shortAttack: number; midStrength: number; midControl: number; kongPan: number };
  combo?: ComboGuide;             // 使用順序評級（衍生；舊固化紀錄可能無此欄 → optional）
}

/**
 * 「全共振」的唯一語意：紅／紫／黃三燈全亮，且雙 B 金叉與捕撈金叉同日成立。
 * groupBuyCount===3 只代表三個群組各有任一訊號，不能冒充這個更嚴格的組合。
 */
export function isFullResonance(r: ConditionReport): boolean {
  const has = (conds: Cond[], id: string) => conds.some((c) => c.id === id && c.met);
  return has(r.mainforce.buy, 'm_three')
    && has(r.doubleB.buy, 'b_gold')
    && has(r.catch.buy, 'c_gold');
}

const r2 = (x: number): number => (isNum(x) ? Math.round(x * 100) / 100 : 0);
const sig = (id: string, label: string, met: boolean): Cond => ({ id, label, met, kind: 'signal' });
const st = (id: string, label: string, met: boolean): Cond => ({ id, label, met, kind: 'state' });

function mkGroup(buy: Cond[], sell: Cond[]): GroupReport {
  return {
    buy, sell,
    buyHit: buy.some((c) => c.kind === 'signal' && c.met),
    sellHit: sell.some((c) => c.kind === 'signal' && c.met),
  };
}

export function evalConditions(
  candles: Candle[],
  indexClose?: number[],
  series?: SanSeSeries,
  limitPct: number = 0.10,
  p: SanSeParams = PRODUCTION_PARAMS,
): ConditionReport {
  const n = candles.length;
  const i = n - 1;
  const H = candles.map((c) => c.high);
  const C = candles.map((c) => c.close);

  // ── 🟦 雙B戰法（共用 ./dualB）──
  const db = computeDualB(candles, p);
  const { zb4, zb5, ma60 } = db;
  // 兩套箭頭雙重共振（同根）：買=均線金叉 且 交易線突破同日；賣=死叉 且 跌破同日（書本：雙重共振提高勝率）
  const dualBuyResonance = !!(db.goldCross[i] && db.breakUp[i]);
  const dualSellResonance = !!(db.deadCross[i] && db.breakDn[i]);
  const aboveMa60 = isNum(ma60[i]) && C[i] > ma60[i];
  const belowMa60 = isNum(ma60[i]) && C[i] < ma60[i];
  // 黃紅雙線向上（雙線都上彎＝持有）
  const dualUp = i > 0 && isNum(zb4[i]) && isNum(zb4[i - 1]) && isNum(zb5[i]) && isNum(zb5[i - 1]) && zb4[i] > zb4[i - 1] && zb5[i] > zb5[i - 1];
  // K線變色（漲停洋紅 / 大漲黃 / 大跌長黑）— 與 indicators.ts 配色一致。
  // 漲停門檻＝幅度 −0.5%（主板 10%→9.5%、創業板/科創 20%→19.5%）；掃描宇宙排除創業板/科創，
  // 走圖可看任何股 → limitPct 由 caller 依代號傳入（getLimitMovePct），預設 10%（主板/台股）。
  const prevC = i > 0 ? C[i - 1] : NaN;
  const chg = isNum(prevC) && prevC > 0 ? (C[i] - prevC) / prevC : NaN;
  const limitThr = limitPct - 0.005;
  const limitUp = isNum(chg) && chg > limitThr && C[i] === H[i];
  const bigUp = isNum(chg) && chg > 0.07 && chg <= limitThr;
  const bigDown = isNum(chg) && chg < -0.07;
  const doubleB = mkGroup(
    [
      sig('b_gold', '黃紅金叉', !!db.goldCross[i]),
      sig('b_break', '突破智能交易線', !!db.breakUp[i]),
      sig('b_resonance', '雙箭頭共振(金叉+突破同日)', dualBuyResonance),
      st('b_dualup', '黃紅雙線向上', dualUp),
      st('b_above', '站上多空線', aboveMa60),
      st('b_limitup', '漲停', limitUp),
      st('b_bigup', '大漲', bigUp),
    ],
    [
      sig('b_dead', '黃紅死叉', !!db.deadCross[i]),
      sig('b_breakdn', '跌破智能交易線', !!db.breakDn[i]),
      sig('b_sresonance', '雙箭頭共振(死叉+跌破同日)', dualSellResonance),
      st('b_below', '跌破多空線', belowMa60),
      st('b_bigdown', '大跌長黑', bigDown),
    ],
  );

  // ── 🟩 捕撈季節（XYS 動能，共用 ./dualB）──
  const xys = computeXys(candles, p);
  const XYS1 = xys.xys1;
  const goldX = xys.goldCross[i]; // 快慢動能線金叉
  const deadX = xys.deadCross[i]; // 快慢動能線死叉
  const xysAbove0 = isNum(XYS1[i]) && XYS1[i] > 0; // 0軸上＝安全做多區
  const xysBelow0 = isNum(XYS1[i]) && XYS1[i] < 0; // 0軸下＝風險區
  // 量價強勢 proxy：金叉當日爆量（今日量 > 5日均量 1.5 倍）。走圖的換手率 4 級色柱全市場掃描抓不到，
  // 用掃描有的 candle volume 近似「金叉配爆量＝量價齊揚」。非走圖色柱本尊，數值會有出入。
  const volSurge = computeCatchVolSurge(candles, p)[i];
  const catchG = mkGroup(
    [
      sig('c_gold', '動能金叉', !!goldX),
      st('c_gold_bull', '多頭區金叉(趨勢延續)', !!goldX && xysAbove0),
      st('c_gold_bear', '空頭區金叉(底部反彈)', !!goldX && xysBelow0),
      st('c_gold_vol', '量價強勢(金叉+爆量)', !!goldX && volSurge),
      st('c_above', '安全做多區(0軸上)', xysAbove0),
    ],
    [
      sig('c_dead', '動能死叉', !!deadX),
      st('c_dead_bull', '多頭區死叉(短期見頂)', !!deadX && xysAbove0),
      st('c_dead_bear', '空頭區死叉(下跌加速)', !!deadX && xysBelow0),
      st('c_below', '風險區(0軸下)', xysBelow0),
    ],
  );

  // ── 🟪 主力狀態F（三色資金分數 + 階段）──
  const s = series ?? (indexClose ? computeSanSe(candles, indexClose, NaN, p) : undefined);
  const sa = s ? r2(s.shortAttack[i]) : 0;
  const ms = s ? r2(s.midStrength[i]) : 0;
  const mc = s ? r2(s.midControl[i]) : 0;
  const kp = s ? r2(s.kongPan[i]) : 0;
  let mainStage: MainStage | null = null;
  if (s) {
    if (evalLatest(s, 'strict').hit) mainStage = 'full';
    else if (evalLatest(s, 'medium').hit) mainStage = 'develop';
    else if (evalLatest(s, 'loose').hit) mainStage = 'ignite';
  }
  const stageLabel = mainStage ? `主力${STAGE_LABEL[mainStage]}${STAGE_ICON[mainStage]}` : '主力資金啟動';
  // 三色資金：紅=中線主力(機構)、紫=短線游資、黃=控盤、藍=散戶資金；
  //   做短線=紅+紫、做中線=紅+黃、三色戰法=紅+紫+黃(最強)；藍主導=散戶資金當家、易跌橫盤。
  const redOn = ms > 0;
  const purpleOn = sa > 0;
  const yellowOn = mc > 0;
  // 藍色 散戶資金（短線超跌）— computeSanSe 未算，依 indicators.ts 同式補算最後一根
  let blue = 0;
  if (s) {
    const ma20 = MA(C, 20);
    const bl20 = BARSLAST(gt(C, ma20));
    if (isNum(ma20[i]) && C[i] < ma20[i] && isNum(bl20[i])) {
      const lag = Math.min(34, bl20[i]);
      if (lag >= 1 && i - lag >= 0) {
        const base = C[i - lag];
        let s3 = 0, s4 = 0;
        for (let j = i - lag + 1; j <= i; j++) {
          const cj = candles[j];
          s3 += cj.close > cj.open ? (cj.open - cj.low) / cj.open : (cj.close - cj.low) / cj.open;
          s4 += cj.close > cj.open ? (cj.high - cj.close) / cj.open : (cj.high - cj.open) / cj.open;
        }
        if (base > 0) blue = r2(((base - C[i]) / base + s3 - s4) * 20);
      }
    }
  }
  const blueOn = blue > 0;
  const mainforce = mkGroup(
    [
      sig('m_stage', stageLabel, mainStage != null),
      st('m_red', '中線主力(紅·機構)', redOn),
      st('m_purple', '短線游資(紫)', purpleOn),
      st('m_yellow', '主力控盤(黃)', yellowOn),
      st('m_short', '做短線(紅+紫)', redOn && purpleOn),
      st('m_mid', '做中線(紅+黃)', redOn && yellowOn),
      st('m_three', '三色戰法(紅+紫+黃·最強)', redOn && purpleOn && yellowOn),
    ],
    [
      sig('m_weak', '中線主力轉弱(紅<0·機構撤)', s ? ms < 0 : false),
      st('m_blue', '散戶資金(藍·散戶主導易跌橫盤)', blueOn),
      st('m_loose', '主力鬆手(控盤=0)', s ? kp === 0 : false),
    ],
  );

  // ── 共振彙整 ──
  const groupBuyCount = [doubleB.buyHit, mainforce.buyHit, catchG.buyHit].filter(Boolean).length;
  const level: ResLevel | null = groupBuyCount >= 3 ? 'strong' : groupBuyCount === 2 ? 'medium' : groupBuyCount === 1 ? 'weak' : null;
  const selected = groupBuyCount >= 1;
  const sellWarnings = [doubleB, mainforce, catchG]
    .flatMap((g) => g.sell.filter((c) => c.kind === 'signal' && c.met).map((c) => c.label));
  const conflict = selected && sellWarnings.length > 0;

  // ── 使用順序評級（衍生自上面三色 redOn/purpleOn/yellowOn + 雙B/捕撈觸發；回測推導）──
  const comboTrigger = doubleB.buyHit || catchG.buyHit;            // 捕撈金叉 或 雙B金叉/突破
  const comboBottom = catchG.buy.some((c) => c.id === 'c_gold_bear' && c.met); // 捕撈0軸下底部反彈金叉
  const comboMid = redOn && yellowOn;
  const fullResonance = redOn && purpleOn && yellowOn && !!db.goldCross[i] && !!goldX;
  let comboGrade: ComboGrade;
  if (fullResonance) comboGrade = 'top';                                  // 三燈＋雙B金叉＋捕撈金叉同日，才是真全共振
  else if (redOn && comboTrigger) comboGrade = 'prime';                    // 紅當前提＋觸發（主進場）
  else if (redOn && yellowOn) comboGrade = 'mid';                          // 紅＋黃中線骨架（待觸發/續抱）
  else if (redOn) comboGrade = 'watch';                                    // 紅在場，等金叉觸發
  else comboGrade = 'weak';                                                // 無紅（純紫/純指標）＝低勝率警示
  const combo: ComboGuide = {
    grade: comboGrade, rank: COMBO_RANK[comboGrade], label: COMBO_LABEL[comboGrade],
    redGate: redOn, trigger: comboTrigger, bottomReversal: comboBottom, midline: comboMid,
  };

  return {
    doubleB, mainforce, catch: catchG,
    mainStage, groupBuyCount, level, selected, conflict, sellWarnings,
    scores: { shortAttack: sa, midStrength: ms, midControl: mc, kongPan: kp },
    combo,
  };
}

export type TradeVerdict = 'buy' | 'sell' | 'conflict' | 'wait' | 'skip';

/**
 * 底反該買 = 該買(combo grade top/prime) 且 捕撈 0 軸下空頭區金叉(底部反彈) 且 無出場事件。
 * 回測推導（scripts/optimize-sanse-grade.ts，train 挑/OOS 驗）：這是兩市場 OOS 唯一守得住的「收緊」——
 * 台股把該買集 d5 勝率 lift 從 +7pp 拉到 +15pp（bull+14/chop+16）、陸股從 −2pp 拉到 +1pp（bear +9pp）。
 * 純衍生自既有 combo.bottomReversal，不另算指標、不進選股集合（只升「該買裡的最高把握」優先）。
 */
export function isReversalBuy(r: ConditionReport): boolean {
  const g = r.combo?.grade;
  if ((g !== 'top' && g !== 'prime') || !r.combo?.bottomReversal) return false;
  return ![...r.doubleB.sell, ...r.catch.sell].some((c) => c.kind === 'signal' && c.met);
}

/**
 * 一眼結論：該買 / 該賣 / 衝突 / 觀望 / 不建議。給訊號面板＋條件面板＋通知共用，
 * 讓使用者看一眼就知道動作，不必自己拼湊各指標。衍生自 combo 評級 + 賣出警示。
 * reversal=true ⇒ 該買裡的最高把握「底反該買」（見 isReversalBuy）。
 */
export function tradeVerdict(r: ConditionReport): { tone: TradeVerdict; reason: string; reversal: boolean } {
  const g = r.combo?.grade;
  const buyable = g === 'top' || g === 'prime';                 // 紅在場 ＋ 金叉觸發
  // 出場「事件」＝ 雙B死叉/跌破智能線/捕撈死叉（不含 m_weak 紅<0 這種「持續狀態」，否則沒在漲的股都會被標該賣）
  const exitConds = [...r.doubleB.sell, ...r.catch.sell].filter((c) => c.kind === 'signal' && c.met);
  const exitEvent = exitConds.length > 0;
  const exitLabels = exitConds.map((c) => c.label).join('、');
  if (buyable) {
    if (exitEvent) return { tone: 'conflict', reason: `有買也有賣（${exitLabels}）→ 謹慎、別追`, reversal: false };
    const reversal = isReversalBuy(r);
    return {
      tone: 'buy',
      reason: reversal
        ? `${g === 'top' ? '全共振' : '紅(機構)在場'} ＋ 捕撈0軸下底部反彈金叉（回測兩市場 OOS 最高把握）`
        : (g === 'top' ? '三燈＋雙B金叉＋捕撈金叉全共振＝最高把握' : '紅(機構)在場 ＋ 金叉觸發'),
      reversal,
    };
  }
  if (r.combo?.redGate) {                                        // 紅在場但今天不是買進設定（紅+黃中線 / 紅待觸發）
    if (exitEvent) return { tone: 'sell', reason: `出現賣出訊號（${exitLabels}）`, reversal: false };
    return { tone: 'wait', reason: '紅(機構)在場、今天還沒金叉觸發 → 等', reversal: false };
  }
  return { tone: 'skip', reason: '沒有紅(機構)、回測勝率最低 → 不建議', reversal: false };       // 無紅（含紅<0/機構撤）一律不建議
}
