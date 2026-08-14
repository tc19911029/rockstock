import { mapYicaiItems, parseYicaiDuration, parseYicaiFirstList } from '@/lib/cn-media/yicai';
import type { CnMediaSource } from '@/lib/cn-media/types';

const source: CnMediaSource = {
  source_id: 'yicai-test',
  display_name: '測試節目',
  platform: 'yicai',
  url: 'https://www.yicai.com/video/test/',
  expected_cadence: 'weekday',
  active: true,
  default_analysts: ['主持人'],
  source_tier: 'official_media',
};

describe('第一財經節目解析', () => {
  test('從頁面 script 擷取 firstlist JSON', () => {
    const html = '<script>var firstlist = [{"NewsID":123,"NewsTitle":"盤後分析"}];</script>';
    expect(parseYicaiFirstList(html)).toEqual([{ NewsID: 123, NewsTitle: '盤後分析' }]);
  });

  test.each([
    ["29' 05''", 1745],
    ["1h 02' 03''", 3723],
    ['', null],
  ])('解析節目時長 %s', (raw, expected) => {
    expect(parseYicaiDuration(raw || undefined)).toBe(expected);
  });

  test('只映射目標上海日期並去除重複影片', () => {
    const now = new Date('2026-08-14T15:00:00.000Z');
    const items = [
      {
        NewsID: 123,
        NewsTitle: '今日股市',
        EntityPublishDate: '2026-08-14 20:55:00',
        NewsLengtho: 1800,
        ShareUrl: 'https://www.yicai.com/video/123.html',
        VideoUrl: 'https://example.com/index.m3u8',
      },
      {
        NewsID: 123,
        NewsTitle: '今日股市（重複）',
        EntityPublishDate: '2026-08-14 20:55:00',
      },
      {
        NewsID: 999,
        NewsTitle: '前一日節目',
        EntityPublishDate: '2026-08-13 20:55:00',
      },
    ];

    expect(mapYicaiItems(source, items, '2026-08-14', now)).toEqual([
      expect.objectContaining({
        video_id: 'yicai-123',
        source_id: 'yicai-test',
        program_date: '2026-08-14',
        published_at: '2026-08-14T12:55:00.000Z',
        duration_sec: 1800,
        analysts: ['主持人'],
      }),
    ]);
  });
});
