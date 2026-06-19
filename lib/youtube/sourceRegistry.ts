/**
 * YouTube source registry — 18 個追蹤的理財節目來源（2026-05-22 v2 改版）。
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
    default_analysts: ['蔡萬得'],
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
    default_analysts: ['李兆華'],
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
    default_analysts: ['李兆華', '艾綸'],
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
    default_analysts: ['鄭明娟'],
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
    default_analysts: ['涂敏峰'],
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
    default_analysts: ['藍登耀'],
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
    default_analysts: ['許毓玲'],
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
    default_analysts: ['陳威良'],
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
    default_analysts: [],
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
    default_analysts: ['劉育綸', '艾綸'],
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
    default_analysts: ['楚河'],
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
    default_analysts: ['王志郁'],
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
    default_analysts: [],
  },
  {
    source_id: 'lei-laoban-podcast',
    display_name: '雷老闆週末 Podcast',
    kind: 'playlist',
    url: 'https://www.youtube.com/playlist?list=PLP2IvX27mr6Z4zVWx_QwF5NbfzDf-4QE7',
    expected_cadence: 'irregular',  // 週末節目，不是每天
    market_type: 'TW_STOCK',
    first_scan_done: false,
    active: true,
    created_at: '2026-05-24T13:50:00.000Z',
    default_analysts: ['雷老闆'],
  },
  {
    source_id: 'gooaye',
    display_name: '股癌 Gooaye',
    kind: 'playlist',
    // YouTube channel uploads playlist：UU + channel_id 去掉 UC 前綴
    url: 'https://www.youtube.com/playlist?list=UU23rnlQU_qE3cec9x709peA',
    expected_cadence: 'irregular',  // user 說「不是固定的」
    market_type: 'TW_STOCK',
    first_scan_done: false,
    active: true,
    created_at: '2026-05-24T16:20:00.000Z',
    default_analysts: ['謝孟恭'],  // 股癌主持人
  },
  {
    source_id: 'jinrong-manhadun',
    display_name: '金融曼哈頓（阮蕙慈）',
    kind: 'playlist',
    url: 'https://www.youtube.com/playlist?list=PLSg6_lakxpXFGQYu1eZWw5GMk030Rv3rb',
    expected_cadence: 'daily',  // 非凡電視每日台股節目
    market_type: 'TW_STOCK',
    first_scan_done: false,
    active: true,
    created_at: '2026-06-04T09:15:58.000Z',
    default_analysts: ['阮蕙慈'],  // 大華國際投顧
  },
  {
    source_id: 'gushi-quanfangwei',
    display_name: '股市全芳位（李蜀芳）',
    kind: 'playlist',
    url: 'https://www.youtube.com/playlist?list=PLSg6_lakxpXEC7U3BgUX3TIAnQbdmbgYG',
    expected_cadence: 'daily',  // 非凡電視每日台股節目
    market_type: 'TW_STOCK',
    first_scan_done: false,
    active: true,
    created_at: '2026-06-04T09:15:58.000Z',
    default_analysts: ['李蜀芳'],  // 永誠國際投顧
  },
  {
    source_id: 'touzi-jiandan',
    display_name: '投資明明很簡單（紀緯明）',
    kind: 'playlist',
    url: 'https://www.youtube.com/playlist?list=PLrUyRbPQ6eoDPZZbL3pQ1RqQvs1aLQuus',
    expected_cadence: 'daily',  // 每日台股節目
    market_type: 'TW_STOCK',
    first_scan_done: false,
    active: true,
    created_at: '2026-06-18T00:00:00.000Z',
    default_analysts: ['紀緯明'],
  },
];

export function defaultSources(): YouTubeSource[] {
  return DEFAULT_SOURCES.map(s => ({ ...s }));
}
