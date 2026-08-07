import type { ScanSession } from '@/lib/scanner/types';
import { loadPostCloseScanSession } from '@/lib/storage/scanStorage';
import { verifyPostCloseScanCompletion } from '@/lib/scanner/scanCompletion';

jest.mock('@/lib/storage/scanStorage', () => ({
  loadPostCloseScanSession: jest.fn(),
}));

const mockedLoad = jest.mocked(loadPostCloseScanSession);

function session(direction: 'long' | 'short', mtf: boolean, scanTime: string): ScanSession {
  return {
    id: ['TW', direction, mtf ? 'mtf' : 'daily', '2026-08-06'].join('-'),
    market: 'TW',
    date: '2026-08-06',
    direction,
    multiTimeframeEnabled: mtf,
    sessionType: 'post_close',
    scanTime,
    resultCount: 0,
    results: [],
  };
}

describe('post-close scan completion', () => {
  beforeEach(() => mockedLoad.mockReset());

  test('0 檔仍是合法完成，只要四份正式主檔存在且屬於本輪', async () => {
    mockedLoad.mockImplementation(async (_market, _date, direction, mode) =>
      session(direction === 'short' ? 'short' : 'long', mode === 'mtf', '2026-08-06T10:00:02.000Z')
    );

    await expect(verifyPostCloseScanCompletion({
      market: 'TW',
      date: '2026-08-06',
      directions: ['long', 'short'],
      mtfModes: ['daily', 'mtf'],
      startedAt: Date.parse('2026-08-06T10:00:00.000Z'),
    })).resolves.toEqual({ completed: true, missing: [], stale: [] });
  });

  test('缺正式主檔時不可回報完成', async () => {
    mockedLoad.mockImplementation(async (_market, _date, direction, mode) =>
      direction === 'short' && mode === 'mtf'
        ? null
        : session(direction === 'short' ? 'short' : 'long', mode === 'mtf', '2026-08-06T10:00:02.000Z')
    );

    const result = await verifyPostCloseScanCompletion({
      market: 'TW',
      date: '2026-08-06',
      directions: ['long', 'short'],
      mtfModes: ['daily', 'mtf'],
    });
    expect(result).toEqual({ completed: false, missing: ['short-mtf'], stale: [] });
  });

  test('只找到前一輪舊檔時不可回報本輪成功', async () => {
    mockedLoad.mockImplementation(async (_market, _date, direction, mode) =>
      session(direction === 'short' ? 'short' : 'long', mode === 'mtf', '2026-08-06T09:59:00.000Z')
    );

    const result = await verifyPostCloseScanCompletion({
      market: 'TW',
      date: '2026-08-06',
      directions: ['long', 'short'],
      mtfModes: ['daily', 'mtf'],
      startedAt: Date.parse('2026-08-06T10:00:00.000Z'),
    });
    expect(result.completed).toBe(false);
    expect(result.stale).toEqual(['long-daily', 'long-mtf', 'short-daily', 'short-mtf']);
  });
});
