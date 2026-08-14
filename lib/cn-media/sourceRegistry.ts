import type { CnMediaSource } from './types';

/**
 * 第一版只啟用第一財經完整節目回放：來源穩定、節目邊界清楚、日期與影音網址可驗證。
 * B站個人創作者會走同一份型別，但預設不混入官方節目的共識票數。
 */
export const DEFAULT_CN_MEDIA_SOURCES: CnMediaSource[] = [
  {
    source_id: 'yicai-investment-view',
    display_name: '第一財經・投資有看頭',
    platform: 'yicai',
    url: 'https://www.yicai.com/video/youkantou/',
    expected_cadence: 'weekday',
    active: true,
    default_analysts: ['投資有看頭'],
    source_tier: 'official_media',
  },
  {
    source_id: 'yicai-today-market',
    display_name: '第一財經・今日股市',
    platform: 'yicai',
    url: 'https://www.yicai.com/video/jinrigushi/',
    expected_cadence: 'weekday',
    active: true,
    default_analysts: ['今日股市'],
    source_tier: 'official_media',
  },
  {
    source_id: 'yicai-company-industry',
    display_name: '第一財經・公司與行業',
    platform: 'yicai',
    url: 'https://www.yicai.com/video/gongsiyuhangye/',
    expected_cadence: 'weekday',
    active: true,
    default_analysts: ['公司與行業'],
    source_tier: 'official_media',
  },
  {
    source_id: 'yicai-stock-talk',
    display_name: '第一財經・談股論金',
    platform: 'yicai',
    url: 'https://www.yicai.com/video/tangulunjin/',
    expected_cadence: 'weekday',
    active: true,
    default_analysts: ['談股論金'],
    source_tier: 'official_media',
  },
];

export function defaultCnMediaSources(): CnMediaSource[] {
  return DEFAULT_CN_MEDIA_SOURCES.map(source => ({
    ...source,
    default_analysts: [...source.default_analysts],
  }));
}
