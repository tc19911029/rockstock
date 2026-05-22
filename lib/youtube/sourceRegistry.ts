/**
 * YouTube source registry — 13 個追蹤的理財節目來源（2026-05-22 v2 改版）。
 *
 * 設計：seed-or-load
 *   - 首次呼叫 loadSources() 時若 sources.json 不存在 → 寫入 DEFAULT_SOURCES 並回傳
 *   - 之後手動編輯 data/youtube/sources.json 即可（或透過 PATCH /api/youtube/sources）
 */

import type { YouTubeSource } from './types';

const CREATED_V1 = '2026-05-22T00:00:00.000Z';
const CREATED_V2 = '2026-05-22T09:10:00.000Z';

export const DEFAULT_SOURCES: YouTubeSource[] = [
  {
    source_id: 'tsai-wan-de',
    display_name: '股市得意（蔡萬得）',
    kind: 'playlist',
    url: 'https://www.youtube.com/playlist?list=PLijVh2Y9Y3JDsxn3Ls-Xp87atH81kBCjG',
    expected_cadence: 'daily',
    market_type: 'TW_STOCK',
    first_scan_done: false,
    active: true,
    created_at: CREATED_V2,
  },
  {
    source_id: 'ebc-moneyshow',
    display_name: '理財達人秀',
    kind: 'playlist',
    url: 'https://www.youtube.com/playlist?list=PLVu0pIxQ7F-yvxR_dCP_zBgChK3s84b99',
    expected_cadence: 'daily',
    market_type: 'TW_STOCK',
    first_scan_done: false,
    active: true,
    created_at: CREATED_V1,
  },
  {
    source_id: 'zhaohua-ailun',
    display_name: '兆華艾綸說',
    kind: 'playlist',
    url: 'https://www.youtube.com/playlist?list=PLVu0pIxQ7F-y5amt3ePI8nlFGLvMZtBPF',
    expected_cadence: 'irregular',  // 實測 5/13 後到 5/22 都沒更新
    market_type: 'TW_STOCK',
    first_scan_done: false,
    active: true,
    created_at: CREATED_V2,
  },
  {
    source_id: '57-stock-class',
    display_name: '57股市同學會',
    kind: 'playlist',
    url: 'https://www.youtube.com/playlist?list=PL9mUJWHev0Kmi4tZ77T9CwWVWr1DFewcn',
    expected_cadence: 'daily',
    market_type: 'TW_STOCK',
    first_scan_done: false,
    active: true,
    created_at: CREATED_V1,
  },
  {
    source_id: 'tu-min-feng',
    display_name: '超越巔峰（涂敏峰）',
    kind: 'playlist',
    url: 'https://www.youtube.com/playlist?list=PL9mUJWHev0KkQXddEXDyVADZnA-Rp9E1h',
    expected_cadence: 'daily',
    market_type: 'TW_STOCK',
    first_scan_done: false,
    active: true,
    created_at: CREATED_V2,
  },
  {
    source_id: 'lan-deng-yao',
    display_name: '金融鬼谷子（藍登耀）',
    kind: 'playlist',
    url: 'https://www.youtube.com/playlist?list=PL9mUJWHev0KnBm5mO9DKLe21xu2ndrmfZ',
    expected_cadence: 'daily',
    market_type: 'TW_STOCK',
    first_scan_done: false,
    active: true,
    created_at: CREATED_V2,
  },
  {
    source_id: 'xu-yu-ling',
    display_name: '股市易點靈（許毓玲）',
    kind: 'playlist',
    url: 'https://www.youtube.com/playlist?list=PL9mUJWHev0Kmbq3PSCxeVCuaHvVrHaWBI',
    expected_cadence: 'daily',
    market_type: 'TW_STOCK',
    first_scan_done: false,
    active: true,
    created_at: CREATED_V2,
  },
  {
    source_id: 'chen-wei-liang',
    display_name: '股市全威（陳威良）',
    kind: 'playlist',
    url: 'https://www.youtube.com/playlist?list=PL9mUJWHev0KnG3t12uzb3aDos-escrcj3',
    expected_cadence: 'daily',
    market_type: 'TW_STOCK',
    first_scan_done: false,
    active: true,
    created_at: CREATED_V2,
  },
  {
    source_id: 'ustvmoney100',
    display_name: '錢線百分百',
    kind: 'playlist',
    url: 'https://www.youtube.com/playlist?list=PLlAWMYbuVkC_x_Hfk6vuA8FhWicFgzCN6',
    expected_cadence: 'daily',
    market_type: 'TW_STOCK',
    first_scan_done: false,
    active: true,
    created_at: CREATED_V1,
  },
  {
    source_id: 'ailun-live',
    display_name: '艾綸說直播',
    kind: 'playlist',
    url: 'https://www.youtube.com/playlist?list=PLp0IB59l1u5Citxln_ISIj1XGMFHRIBWK',
    expected_cadence: 'irregular',  // 實測 5/21 後沒每日更新
    market_type: 'TW_STOCK',
    first_scan_done: false,
    active: true,
    created_at: CREATED_V2,
  },
  {
    source_id: 'winning-key',
    display_name: '決勝關鍵（每日台股解盤）',
    kind: 'playlist',
    url: 'https://www.youtube.com/playlist?list=PLRROh2YGtYe_NUur0SpD32aAAxOb1CeQ-',
    expected_cadence: 'daily',
    market_type: 'TW_STOCK',
    first_scan_done: false,
    active: true,
    created_at: CREATED_V2,
  },
  {
    source_id: 'jinlin-tianxia',
    display_name: '金臨天下搶先看',
    kind: 'playlist',
    url: 'https://www.youtube.com/playlist?list=PLmVlUjKuEG7SM6e27F-sDTUh4Ylqu_wzQ',
    expected_cadence: 'daily',
    market_type: 'TW_STOCK',
    first_scan_done: false,
    active: true,
    created_at: CREATED_V2,
  },
  {
    source_id: 'gumin-kaijiang',
    display_name: '股民開講',
    kind: 'playlist',
    url: 'https://www.youtube.com/playlist?list=PL9mUJWHev0KlrCNSHwxclpc5wEZwJyDCq',
    expected_cadence: 'daily',
    market_type: 'TW_STOCK',
    first_scan_done: false,
    active: true,
    created_at: CREATED_V2,
  },
];

export function defaultSources(): YouTubeSource[] {
  return DEFAULT_SOURCES.map(s => ({ ...s }));
}
