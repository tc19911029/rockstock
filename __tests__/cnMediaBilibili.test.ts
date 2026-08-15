import {
  expandBilibiliSearchQuery,
  filterBilibiliSearchItems,
  parseBilibiliSearchHtml,
  selectBilibiliMediaUrl,
} from '@/lib/cn-media/bilibili';
import { DEFAULT_CN_MEDIA_SOURCES } from '@/lib/cn-media/sourceRegistry';
import type { CnMediaSource } from '@/lib/cn-media/types';

const source: CnMediaSource = {
  source_id: 'bilibili-test',
  display_name: 'B站測試來源',
  platform: 'bilibili',
  url: 'https://space.bilibili.com/397589042/video',
  expected_cadence: 'weekday',
  active: true,
  default_analysts: ['測試分析師'],
  source_tier: 'creator',
  include_title_keywords: ['A股', '股市'],
  search_query: '測試分析師 A股',
};

describe('B站陸股節目解析', () => {
  test('從手機搜尋頁擷取影片並移除標題標籤', () => {
    const state = {
      search: {
        searchAllResult: {
          totalrank: {
            result: [{
              bvid: 'BV11Pgp6NE7p',
              title: '每日<em class="keyword">股市</em>分析',
              duration: 1200,
              owner: { mid: 397589042, name: '作者' },
            }],
          },
        },
      },
    };
    const html = `<script>window.__INITIAL_STATE__=${JSON.stringify(state)};(function(){})();</script>`;
    expect(parseBilibiliSearchHtml(html)).toEqual([expect.objectContaining({
      bvid: 'BV11Pgp6NE7p',
      title: '每日股市分析',
    })]);
  });

  test('只保留正確作者且符合 A 股標題的影片', () => {
    const items = [
      { bvid: 'BV1correct001', title: '今日A股復盤', owner: { mid: 397589042, name: '作者' } },
      { bvid: 'BV1wrongmid01', title: '今日A股復盤', owner: { mid: 999, name: '搬運者' } },
      { bvid: 'BV1offtopic01', title: '日常生活紀錄', owner: { mid: 397589042, name: '作者' } },
    ];
    expect(filterBilibiliSearchItems(source, items).map(item => item.bvid)).toEqual(['BV1correct001']);
  });

  test('頁面缺少初始資料時明確失敗', () => {
    expect(() => parseBilibiliSearchHtml('<html></html>')).toThrow('search state unavailable');
  });

  test('分離音訊不存在時改用 B站單檔 MP4', () => {
    expect(selectBilibiliMediaUrl({ durl: [{ url: 'https://example.com/video.mp4' }] }))
      .toBe('https://example.com/video.mp4');
  });

  test('來源搜尋詞可帶入目標月日', () => {
    expect(expandBilibiliSearchQuery('作者 {year} {month_day}', '2026-08-03'))
      .toBe('作者 2026 8月3日');
  });

  test('個股密集的新增來源使用固定作者 ID，避免抓到搬運帳號', () => {
    const expectedMids: Record<string, string> = {
      'bilibili-laicongxin-review': '11430504',
      'bilibili-niusan-zhaoge': '1593359860',
      'bilibili-xueliang-short-review': '345681438',
      'bilibili-zhujijiaoyiyuan-review': '497120492',
      'bilibili-guwangjinshi168-stock-review': '1252590958',
    };

    for (const [sourceId, mid] of Object.entries(expectedMids)) {
      const item = DEFAULT_CN_MEDIA_SOURCES.find(candidate => candidate.source_id === sourceId);
      expect(item).toBeDefined();
      expect(item?.active).toBe(true);
      expect(item?.url).toContain(`space.bilibili.com/${mid}/video`);
      expect(item?.search_query || item?.search_queries?.length).toBeTruthy();
    }
  });
});
