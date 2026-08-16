/**
 * 關鍵資料源韌性登錄表。
 *
 * 目的不是宣稱每個來源都同口徑，而是把「精確備援、估算備援、最後成功快照」
 * 明確分級。任何關鍵資料若沒有安全降級路徑，契約測試必須失敗。
 */

export type FallbackQuality = 'exact' | 'approximate' | 'last_good';
export type FailureMode = 'block_signals' | 'show_stale' | 'show_approximate' | 'unavailable';

export interface DataSourceFallback {
  name: string;
  quality: FallbackQuality;
  independent: boolean;
}

export interface DataSourceResilienceEntry {
  id: string;
  label: string;
  primary: string;
  fallbacks: DataSourceFallback[];
  critical: boolean;
  failureMode: FailureMode;
}

export const DATA_SOURCE_RESILIENCE: readonly DataSourceResilienceEntry[] = [
  {
    id: 'tw-daily-candles', label: '台股日 K', primary: 'FinMind', critical: true,
    fallbacks: [
      { name: 'Fugle', quality: 'exact', independent: true },
      { name: 'TWSE/TPEx', quality: 'exact', independent: true },
      { name: 'Yahoo', quality: 'exact', independent: true },
    ],
    failureMode: 'show_stale',
  },
  {
    id: 'cn-daily-candles', label: '陸股日 K', primary: 'Tencent', critical: true,
    fallbacks: [
      { name: 'Baidu', quality: 'exact', independent: true },
      { name: 'Yahoo', quality: 'exact', independent: true },
      { name: 'EastMoney', quality: 'exact', independent: true },
    ],
    failureMode: 'show_stale',
  },
  {
    id: 'tw-realtime', label: '台股即時行情', primary: 'TWSE/TPEx MIS', critical: true,
    fallbacks: [
      { name: 'TWSE/TPEx OpenAPI', quality: 'exact', independent: false },
      { name: '最近成功 L2 快照', quality: 'last_good', independent: true },
    ],
    failureMode: 'show_stale',
  },
  {
    id: 'cn-realtime', label: '陸股即時行情', primary: 'Tencent', critical: true,
    fallbacks: [
      { name: 'EastMoney', quality: 'exact', independent: true },
      { name: 'Sina', quality: 'exact', independent: true },
      { name: '最近成功 L2 快照', quality: 'last_good', independent: true },
    ],
    failureMode: 'show_stale',
  },
  {
    id: 'tw-fundamentals', label: '台股基本面', primary: 'FinMind', critical: true,
    fallbacks: [
      { name: 'TWSE/MOPS OpenAPI', quality: 'exact', independent: true },
      { name: 'TPEx/MOPS OpenAPI', quality: 'exact', independent: true },
    ],
    failureMode: 'block_signals',
  },
  {
    id: 'cn-fundamentals', label: '陸股基本面', primary: 'EastMoney', critical: true,
    fallbacks: [{ name: 'AkShare/Sina', quality: 'approximate', independent: true }],
    failureMode: 'block_signals',
  },
  {
    id: 'tw-institutional', label: '台股三大法人／融資券', primary: 'TWSE/TPEx', critical: true,
    fallbacks: [{ name: '最近成功盤後快照', quality: 'last_good', independent: true }],
    failureMode: 'show_stale',
  },
  {
    id: 'tw-holder-distribution', label: '集保持股分布', primary: 'TDCC', critical: true,
    fallbacks: [
      { name: '本地每週歷史快照', quality: 'last_good', independent: true },
      { name: 'FinMind TDCC 轉載', quality: 'exact', independent: false },
    ],
    failureMode: 'show_stale',
  },
  {
    id: 'tw-broker-concentration', label: '主力分點集中度', primary: 'FinMind 全分點', critical: true,
    fallbacks: [
      { name: 'Yahoo 前 15 大每日快照', quality: 'approximate', independent: true },
      { name: '本地最後成功全分點快取', quality: 'last_good', independent: true },
    ],
    failureMode: 'show_approximate',
  },
  {
    id: 'tw-index-history', label: '台股指數歷史行情', primary: 'TWSE/TPEx', critical: true,
    fallbacks: [
      { name: 'Yahoo', quality: 'exact', independent: true },
      { name: '本地 L1 快照', quality: 'last_good', independent: true },
    ],
    failureMode: 'show_stale',
  },
  {
    id: 'tw-attention-list', label: '台股注意／處置名單', primary: 'TWSE/TPEx OpenAPI', critical: true,
    fallbacks: [{ name: '最近成功名單快照', quality: 'last_good', independent: true }],
    failureMode: 'show_stale',
  },
] as const;

export type ResilienceLevel = 'protected' | 'degraded' | 'unprotected';

export function assessDataSourceResilience(entry: DataSourceResilienceEntry): ResilienceLevel {
  const independentExact = entry.fallbacks.some((f) => f.independent && f.quality === 'exact');
  if (independentExact) return 'protected';
  if (entry.fallbacks.length > 0 && entry.failureMode !== 'unavailable') return 'degraded';
  return 'unprotected';
}

export function summarizeDataSourceResilience() {
  const entries = DATA_SOURCE_RESILIENCE.map((entry) => ({
    id: entry.id,
    label: entry.label,
    level: assessDataSourceResilience(entry),
    failureMode: entry.failureMode,
  }));
  return {
    total: entries.length,
    protected: entries.filter((entry) => entry.level === 'protected').length,
    degraded: entries.filter((entry) => entry.level === 'degraded').length,
    unprotected: entries.filter((entry) => entry.level === 'unprotected').length,
    entries,
  };
}
