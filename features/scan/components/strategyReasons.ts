import type { StockScanResult } from '@/lib/scanner/types';
import { LETTER_NAMES } from '@/lib/scanner/buyMethodTracks';
import {
  BOOK_BODY_PCT_MIN,
  BOOK_VOL_RATIO_MIN,
  KLINE_CONSOL_MAX_RANGE_PCT,
  TRUE_BREAKOUT_PCT,
} from '@/lib/analysis/bookThresholds';
import { BASE_THRESHOLDS } from '@/lib/strategy/StrategyConfig';
import { getLegacyBookAchievementRate } from '@/lib/analysis/patternCatalog';
import { getPatternDisplayName } from '@/lib/chart/patternDisplay';

export interface StrategyReasonRow {
  /** 用於 A 六條件子條件：true=pass、false=fail；其他策略不填 */
  pass?: boolean;
  /** 子標籤（例如「①趨勢」、「型態」、「目標價」），可選 */
  label?: string;
  /** 主要文字描述 */
  text: string;
  /** 強調色：'good' 綠 / 'bad' 紅 / 'warn' 黃 / undefined 預設 */
  tone?: 'good' | 'bad' | 'warn';
}

export interface StrategyReasonBlock {
  method: string;
  title: string;          // 中文策略名（例如「六條件」）
  summary?: string;       // 一行小結（例如 "5/6 通過"）
  rows: StrategyReasonRow[];
}

// 字母→名稱讀 lib/scanner/buyMethodTracks.ts 單一事實來源
const METHOD_NAMES = LETTER_NAMES;

/** 書本規則描述（無逐檔 detail 欄位的策略，先用靜態描述） */
const STATIC_BOOK_RULES: Record<string, string[]> = {
  B: [
    '多頭趨勢 + 曾跌破 MA5',
    '收盤站回 MA5（站回當日或隔 1-2 日內補量突破皆可，站回後不再跌破）',
    `紅 K 實體 ≥ ${BOOK_BODY_PCT_MIN}%、量 ≥ 前日 × ${BOOK_VOL_RATIO_MIN}`,
    '突破前一根 K 線高點',
  ],
  C: [
    `盤整 N 日（高低差 ≤ ${KLINE_CONSOL_MAX_RANGE_PCT + 2}%）`,
    '收盤突破盤整高點',
    `量能放大（≥ 前日 × ${BOOK_VOL_RATIO_MIN}）`,
  ],
  E: [
    '今日 low > 昨日 high（向上跳空缺口）',
    `紅 K + 實體 ≥ ${BOOK_BODY_PCT_MIN}%`,
    `量能放大（≥ 前日 × ${BOOK_VOL_RATIO_MIN}）`,
  ],
  J: [
    'ABC 修正結構（修正段頭頭低、底底低）',
    '收盤突破 ABC 修正的下降切線，並站上 MA20',
    `紅 K 實體 ≥ ${BOOK_BODY_PCT_MIN}%、量 ≥ 前日 × ${BOOK_VOL_RATIO_MIN}`,
  ],
  K: [
    `K 線橫盤 N 日（高低差 ≤ ${KLINE_CONSOL_MAX_RANGE_PCT}%）`,
    '突破橫盤區間高點',
    '量能放大',
  ],
  L: [
    '前期出現過大量黑 K（量 ≥ 前日 × 2、黑體 ≥ 3%）',
    '後續紅 K 收盤站回黑 K 高點',
    '量能配合',
  ],
  M: [
    '多頭趨勢，股價站上 MA20 且 MA20 不下彎',
    '連接 2 個上升 pivot low，經中間最高點畫平行上升軌道壓力線',
    '收盤突破軌道線 3%，紅 K 實體 ≥ 2% 且量 ≥ 前日 × 1.3',
  ],
  P: [
    '多頭先漲至少 5%，再高檔淺回 1–2 天',
    '拉回低點不破 MA20（月線），也不破前一個 pivot low',
    '紅 K 實體 ≥ 2%、量 ≥ 前日 × 1.3，收盤突破前 K 高',
  ],
  D: [
    `狹幅盤整至少 40 天，區間寬度 < 10%`,
    '盤整末段 MA5/10/20 至少 5 天糾結，且盤整量縮',
    '大量紅 K 收盤突破上頸線與三條均線',
  ],
  O: [
    '過去由空頭轉盤整，打底至少 10 天且曾有大量',
    '今日首次翻多，站上 MA20 且 MA20 上揚',
    '紅 K 帶量，收盤突破打底高點 3%；站上 MA60 為長多加分',
  ],
  Q: [
    '股價在 MA24 之上，且 MA24 上揚',
    '今日 MA3 黃金交叉 MA10，收盤同時站上 MA3',
    '紅 K 實體 ≥ 2%；原戰法 detector 不要求量比',
  ],
  G: [
    'ABC 三段結構（A 高 → B 低 → C）',
    'C 段突破 A 高',
    'C 段量增',
  ],
  H: [
    '前期出現過大量黑 K',
    '後續紅 K 收盤站回黑 K 高點',
  ],
  I: [
    'K 線橫盤 N 日',
    '突破橫盤區間高點',
  ],
};

function buildSixConditions(r: StockScanResult): StrategyReasonBlock {
  const isShort = r.direction === 'short';
  const b = isShort ? r.shortSixConditionsBreakdown : r.sixConditionsBreakdown;
  const score = isShort ? (r.shortSixConditionsScore ?? 0) : (r.sixConditionsScore ?? 0);
  const rows: StrategyReasonRow[] = [
    { pass: b?.trend, label: '①趨勢', text: isShort ? '頭頭低底底低（空頭結構）' : '頭頭高底底高（多頭結構）' },
    { pass: b?.ma, label: '②均線', text: isShort ? 'MA5/10/20 三線空排 + MA10/20 向下' : 'MA5/10/20 三線多排 + MA10/20 向上' },
    { pass: b?.position, label: '③位置', text: isShort ? '收盤 < MA10 AND MA20' : '收盤 > MA10 AND MA20' },
    { pass: b?.kbar, label: isShort ? '④黑K' : '④紅K', text: isShort ? '黑 K 實體與低收盤符合空方條件' : '紅 K 實體 ≥ 2% + 高收盤 + 上影 ≤ 實體' },
    { pass: b?.volume, label: '⑤量能', text: `當日量 ≥ 前日 × ${BASE_THRESHOLDS.volumeRatioMin}` },
    { pass: b?.indicator, label: '⑥指標', text: isShort ? 'MACD / KD 空方動能確認' : 'MACD 綠縮 / 紅延 + KD 金叉向上' },
  ];
  return {
    method: 'A',
    title: isShort ? '空方六條件' : METHOD_NAMES.A,
    summary: `${score}/6 通過`,
    rows,
  };
}

function buildPatternConfirm(r: StockScanResult): StrategyReasonBlock {
  const lw = r.lockWatchPayload;
  if (!lw?.patternType) {
    return {
      method: 'N',
      title: METHOD_NAMES.N,
      rows: [{ text: '型態確認觸發但無 lockWatch 細節' }],
    };
  }
  const name = getPatternDisplayName(lw.patternType);
  const ratePct = getLegacyBookAchievementRate(lw.patternType);
  const target = lw.patternTargetPrice;
  const trigger = lw.triggerPrice;
  const upsidePct = target != null
    ? ((target - r.price) / r.price) * 100
    : null;

  const rows: StrategyReasonRow[] = [
    { label: '型態', text: name, tone: 'good' },
  ];
  if (ratePct != null) {
    rows.push({
      label: '舊書達標統計',
      text: `${ratePct}%（《抓住飆股》附錄的型態達標統計，非 Rockstock 回測勝率）`,
    });
  }
  if (trigger != null) {
    rows.push({ label: '頸線', text: trigger.toFixed(2) });
    rows.push({
      label: '真突破門檻',
      text: `${(trigger * (1 + TRUE_BREAKOUT_PCT)).toFixed(2)}（收盤站上頸線 3%，訊號才成立）`,
      tone: 'good',
    });
  }
  if (target != null) {
    rows.push({ label: '突破後測量目標', text: `${target.toFixed(2)}（型態等幅估算，不保證到價）` });
    if (upsidePct != null) {
      if (upsidePct > 0) {
        rows.push({
          label: '理論距離',
          text: `+${upsidePct.toFixed(1)}%（現價 ${r.price.toFixed(2)} → 測量目標 ${target.toFixed(2)}）`,
          tone: 'good',
        });
      } else {
        rows.push({
          label: '理論距離',
          text: `目標已達標（現價超過目標 ${Math.abs(upsidePct).toFixed(1)}%）`,
          tone: 'warn',
        });
      }
    }
  }
  return { method: 'N', title: METHOD_NAMES.N, rows };
}

function buildVReversal(r: StockScanResult): StrategyReasonBlock {
  const lw = r.lockWatchPayload;
  const rows: StrategyReasonRow[] = [
    { text: '連跌（≥ 5 根、跌幅 ≥ 10%）+ 變盤線止跌' },
    { text: '紅 K 帶量（量 ≥ 前日 × 1.5）+ 突破前 K 高' },
  ];
  if (lw?.triggerPrice != null) {
    rows.push({
      label: '訊號成立收盤',
      text: `${lw.triggerPrice.toFixed(2)}（系統確認 V 反轉時的收盤價；不是停損價或目標價）`,
      tone: 'good',
    });
  }
  if (lw?.vBottom != null) {
    rows.push({
      label: 'V 底防守',
      text: `${lw.vBottom.toFixed(2)}（任一後續 K 棒 low 跌破，V 反轉結構才失效）`,
    });
  }
  return { method: 'F', title: METHOD_NAMES.F, rows };
}

function buildStaticBookRule(method: string, r: StockScanResult, activeBuyMethod?: string | null): StrategyReasonBlock {
  const rows: StrategyReasonRow[] = (STATIC_BOOK_RULES[method] ?? ['書本規則觸發']).map((t) => ({ text: t }));

  // 若是當前 active method，優先補上 triggeredRules[0].reason 提供的具體數字
  if (activeBuyMethod && method === activeBuyMethod) {
    const liveReason = r.triggeredRules?.[0]?.reason;
    if (liveReason && liveReason.trim().length > 0) {
      rows.push({ label: '本檔', text: liveReason, tone: 'good' });
    }
  }

  return {
    method,
    title: METHOD_NAMES[method] ?? method,
    rows,
  };
}

const V11_ALIAS_OF_V12: Record<string, string> = { G: 'J', H: 'L', I: 'K' };

/**
 * 產生整張卡的「符合策略原因」區塊。
 *
 * 順序：A 六條件（若命中）→ 其他字母按 matchedMethods 出現順序去重後列出。
 * v11 alias（G/H/I）合併到 v12 字母（J/L/K）。
 */
export function buildAllStrategyReasons(
  r: StockScanResult,
  activeBuyMethod?: string | null,
): StrategyReasonBlock[] {
  const matched = r.matchedMethods ?? [];
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const m of matched) {
    const canonical = V11_ALIAS_OF_V12[m] ?? m;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    ordered.push(canonical);
  }

  const blocks: StrategyReasonBlock[] = [];
  for (const m of ordered) {
    if (m === 'A') {
      blocks.push(buildSixConditions(r));
    } else if (m === 'N') {
      blocks.push(buildPatternConfirm(r));
    } else if (m === 'F') {
      blocks.push(buildVReversal(r));
    } else {
      blocks.push(buildStaticBookRule(m, r, activeBuyMethod));
    }
  }
  return blocks;
}
