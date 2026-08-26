import { ensureServerL1Visibility } from '@/lib/datasource/eodSettlementVisibility';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const candidate = { symbol: '3081.TWO', date: '2026-08-26', close: 3255 };

describe('EOD API visibility postcondition', () => {
  test('cache 清空且 API 日期/收盤價一致才算成功', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, cleared: true, before: 120, after: 0 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, date: '2026-08-26', close: 3255 }));

    await expect(ensureServerL1Visibility({
      secret: 'test-secret', candidate, fetchImpl, retryDelayMs: 0,
    })).resolves.toEqual({ ok: true, attempts: 1 });
  });

  test('API 第一次仍是舊日期時會再清一次 cache 並重驗', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, cleared: true, after: 0 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, date: '2026-08-25', close: 2960 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, cleared: true, after: 0 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, date: '2026-08-26', close: 3255 }));

    await expect(ensureServerL1Visibility({
      secret: 'test-secret', candidate, fetchImpl, retryDelayMs: 0,
    })).resolves.toEqual({ ok: true, attempts: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  test('cache endpoint 未真的清成 0 時整輪失敗，不得靜默當成功', async () => {
    const fetchImpl = jest.fn()
      .mockImplementation(async () => jsonResponse({ ok: true, cleared: true, after: 3 }));

    const result = await ensureServerL1Visibility({
      secret: 'test-secret', candidate, fetchImpl, retries: 2, retryDelayMs: 0,
    });

    expect(result).toMatchObject({ ok: false, attempts: 2 });
    expect(result.error).toContain('after=3');
  });

  test('沒有 CRON_SECRET 直接失敗', async () => {
    await expect(ensureServerL1Visibility({ candidate })).resolves.toMatchObject({
      ok: false,
      attempts: 0,
      error: 'CRON_SECRET 未設定',
    });
  });
});
