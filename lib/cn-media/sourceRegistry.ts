import type { CnMediaSource } from './types';

/** 第一財經完整節目與可公開轉錄的 B站 A 股創作者；分析時會保留來源層級。 */
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
  {
    source_id: 'bilibili-yami-dad-stocks',
    display_name: 'B站・娅米爸爸講股市',
    platform: 'bilibili',
    url: 'https://space.bilibili.com/397589042/video',
    expected_cadence: 'weekday',
    active: true,
    default_analysts: ['娅米爸爸'],
    source_tier: 'creator',
    include_title_keywords: ['股市', '股票', 'A股', '大盘', '板块', 'ETF', '复盘'],
    search_query: '娅米爸爸讲股市',
    search_pages: 3,
  },
  {
    source_id: 'bilibili-fintalk-industry',
    display_name: 'B站・FinTalk 財智新聲',
    platform: 'bilibili',
    url: 'https://space.bilibili.com/3546656144362381/video',
    expected_cadence: 'weekly',
    active: true,
    default_analysts: ['拆解橘'],
    source_tier: 'creator',
    search_query: '拆解橘',
    search_pages: 10,
  },
];

export function defaultCnMediaSources(): CnMediaSource[] {
  return DEFAULT_CN_MEDIA_SOURCES.map(source => ({
    ...source,
    default_analysts: [...source.default_analysts],
  }));
}
