/**
 * Fundamental Requirements — 不可覆寫的底層規則
 *
 * 此檔案編碼 docs/FUNDAMENTAL_REQUIREMENTS.md 中的規則為 TypeScript 常量。
 * 用於合約測試和健康監控。
 *
 * ⚠️  不可刪除或修改此檔案（見 CLAUDE.md）
 */

export const FUNDAMENTAL_RULES = {
  R1: {
    id: 'R1',
    name: '歷史日K封存後不可被盤中覆蓋',
    description: 'Layer 1 歷史資料一旦 sealed，不得被 Layer 2 盤中資料覆蓋',
    enforcedBy: ['CandleStorageAdapter.ts'],
    testedBy: ['data-separation.test.ts'],
  },
  R2: {
    id: 'R2',
    name: 'API 策略由底層設計',
    description: '收盤後/盤中/走圖三條資料鏈路分工明確，不可因新功能改變 Provider 路由',
    enforcedBy: ['MultiMarketProvider.ts', 'IntradayCache.ts'],
    testedBy: ['api-strategy.test.ts'],
  },
  R3: {
    id: 'R3',
    name: '盤中快取獨立於歷史主表',
    description: 'Layer 2 (IntradayCache) 與 Layer 1 (CandleStorage) 分離存放',
    enforcedBy: ['IntradayCache.ts'],
    testedBy: ['data-separation.test.ts'],
  },
  R4: {
    id: 'R4',
    name: '盤中掃描是核心能力',
    description: '系統必須支援台股與陸股盤中掃描，可反覆執行',
    enforcedBy: ['scanner/coarse/route.ts', 'scanner/chunk/route.ts'],
    testedBy: ['coarse-scan.test.ts'],
  },
  R5: {
    id: 'R5',
    name: '掃描紀錄用複合主鍵',
    description: 'market + direction + mtfMode + date + sessionType + timestamp，不同日期不互相覆蓋',
    enforcedBy: ['scanStorage.ts'],
    testedBy: ['scan-session-key.test.ts'],
  },
  R6: {
    id: 'R6',
    name: '走圖/掃描/持倉分流',
    description: '走圖用 Layer 3 高頻通道，掃描用 Layer 2 快照，不共用',
    enforcedBy: ['ChartDataChannel.ts', 'IntradayCache.ts'],
    testedBy: [],
  },
  R7: {
    id: 'R7',
    name: '全市場掃描用快照粗掃',
    description: '不可逐檔讀取 Blob（會導致 Vercel 超時），必須讀單一快照檔',
    enforcedBy: ['CoarseScanner.ts', 'scanner/coarse/route.ts'],
    testedBy: ['coarse-scan.test.ts'],
  },
  R8: {
    id: 'R8',
    name: '任何新功能不得破壞以上規則',
    description: '所有後續需求都視為增量，不得重寫 Fundamental Requirements',
    enforcedBy: ['CLAUDE.md', 'test:contracts'],
    testedBy: ['all contract tests'],
  },
} as const;

/** 資料分層常量 */
export const DATA_LAYERS = {
  LAYER_1: { name: '歷史日K主資料庫', blobPrefix: 'candles/', mutable: false },
  LAYER_2: { name: '盤中即時快取層', blobPrefix: 'intraday/', mutable: true },
  LAYER_3: { name: '個股高頻走圖層', blobPrefix: null, mutable: true },
  LAYER_4: { name: '掃描結果層', blobPrefix: 'scans/', mutable: true },
} as const;

/** 兩級掃描效能目標 */
export const SCAN_PERFORMANCE = {
  COARSE_MAX_MS: 3000,   // 粗掃 < 3 秒
  FINE_MAX_MS: 30000,    // 精掃 < 30 秒
} as const;
