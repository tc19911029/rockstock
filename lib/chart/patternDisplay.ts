import type { Pivot } from '@/lib/analysis/trendAnalysis';

/** 形態 patternType → 中文顯示名稱。純函式放在 chart 外，方便回歸測試。 */
export function getPatternDisplayName(patternType: string): string {
  const names: Record<string, string> = {
    'triple-bottom': '三重底',
    'head-shoulder': '頭肩底',
    'rounding-bottom': '圓弧底',
    'complex-head-shoulder': '複式頭肩底',
    'falling-diamond': '跌菱形',
    'descending-wedge': '下降楔形',
    'double-bottom': '雙重底',
    'n-shape': 'N 字底',
    'triple-top': '三重頂',
    'head-shoulder-top': '頭肩頂',
    'double-top': '雙重頂',
    'complex-head-shoulder-top': '複式頭肩頂',
    'inverted-n-top': '倒N字頂',
    'long-double-top': '長雙頭頂',
    'one-line-top': '一字頂',
  };
  return names[patternType] ?? patternType;
}

/** 形態 pivots 的中文標籤對照（順序與 v12LetterN.ts 各 detector 內部一致）。 */
export function getPivotLabels(patternType: string, pivots: Pivot[]): string[] {
  switch (patternType) {
    case 'triple-bottom':       return ['L1', 'L2', 'L3', 'H1', 'H2'];
    case 'head-shoulder':       return ['RS', '頭', 'LS', 'RN', 'LN'];
    case 'descending-wedge':    return ['H1', 'H2', 'L1', 'L2'];
    case 'falling-diamond':     return ['H1', 'H2', 'H3', 'H4', 'L1', 'L2', 'L3', 'L4'];
    case 'double-bottom':       return ['L1', 'L2', 'H'];
    case 'rounding-bottom':     return ['H1', '弧底', 'H2'];
    case 'n-shape':             return ['A', 'B'];
    case 'triple-top':          return ['H1', 'H2', 'H3', 'L1', 'L2'];
    case 'head-shoulder-top':   return ['RS', '頂', 'LS', 'RN', 'LN'];
    case 'double-top':          return ['H1', 'H2', 'L'];
    case 'long-double-top':     return ['H1', 'H2', 'L'];
    case 'inverted-n-top':      return ['C', 'A', 'B'];
    // 一字頂已由舊「島狀反轉」重寫為高檔橫盤；兩點是箱頂與箱底支撐。
    case 'one-line-top':        return ['箱頂', '支撐'];
    case 'complex-head-shoulder-top':
      return pivots.map((_, i) => (i === 0 ? '頭' : `肩${i}`));
    case 'complex-head-shoulder': {
      let headIdx = -1;
      let headPrice = Infinity;
      for (let i = 0; i < pivots.length; i++) {
        if (pivots[i].type === 'low' && pivots[i].price < headPrice) {
          headPrice = pivots[i].price;
          headIdx = i;
        }
      }
      const labels: string[] = [];
      let lowCount = 0;
      let highCount = 0;
      for (let i = 0; i < pivots.length; i++) {
        if (i === headIdx) labels.push('頭');
        else if (pivots[i].type === 'low') labels.push(`肩${++lowCount}`);
        else labels.push(`頸${++highCount}`);
      }
      return labels;
    }
    default:
      return pivots.map((_, i) => `P${i + 1}`);
  }
}

/** 圖上所有頭／底／型態腳位統一顯示到小數 2 位，避免只能看到名稱、無法驗算。 */
export function formatPivotPrice(price: number): string {
  return Number.isFinite(price) ? price.toFixed(2) : '—';
}

export function getPivotMarkerText(pivot: Pivot): string {
  return `${pivot.type === 'high' ? '頭' : '底'} ${formatPivotPrice(pivot.price)}`;
}
