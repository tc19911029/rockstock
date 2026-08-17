import { NextRequest } from 'next/server';
import type { DigestResponse } from '@/lib/ai/zhuTypes';

const mockRunCodexAnalysis = jest.fn();
const mockPrefetchZhuChart = jest.fn(async (..._args: unknown[]) => ({}));

const mockDigest: DigestResponse = {
  schemaVersion: 3,
  overview: '測試完成',
  verdict: '觀望',
  verdictReason: '等待確認',
  reasoning: [],
  dataPoints: [],
  timestamp: '2026-08-17T12:00:00.000Z',
  generatedBy: 'codex',
};

jest.mock('@/lib/ai/codexCliRunner', () => ({
  CodexUnavailableError: class CodexUnavailableError extends Error {},
  runCodexAnalysis: (...args: unknown[]) => mockRunCodexAnalysis(...args),
}));

jest.mock('@/lib/ai/zhuPrefetch', () => ({
  prefetchZhuChart: (...args: unknown[]) => mockPrefetchZhuChart(...args),
}));

jest.mock('@/lib/ai/zhuDigestValidation', () => ({
  parseZhuDigest: () => mockDigest,
}));

import { GET, POST } from '@/app/api/coach/chart-digest/route';

function requestBody(symbol: string) {
  return {
    market: 'TW',
    symbol,
    name: '測試股',
    date: '2026-08-17',
    ohlcv: { open: 100, high: 102, low: 99, close: 101, volume: 1000 },
    ma: { ma5: 100, ma10: 99, ma20: 98, ma60: 97 },
    signals: [],
    hasPosition: false,
    asyncProgress: true,
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('condition timeout');
}

describe('chart-digest background jobs', () => {
  test('POST 立即回 jobId，相同分析共用工作，GET 可取得完成結果', async () => {
    let finishCodex!: (value: string) => void;
    mockRunCodexAnalysis.mockImplementationOnce(() => new Promise<string>(resolve => {
      finishCodex = resolve;
    }));
    const body = requestBody('JOB-TEST-1');

    const firstResponse = await POST(new NextRequest('http://localhost/api/coach/chart-digest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    expect(firstResponse.status).toBe(202);
    const first = await firstResponse.json() as { jobId: string; state: string };
    expect(first.jobId).toBeTruthy();

    const secondResponse = await POST(new NextRequest('http://localhost/api/coach/chart-digest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    const second = await secondResponse.json() as { jobId: string };
    expect(second.jobId).toBe(first.jobId);

    await waitUntil(() => mockRunCodexAnalysis.mock.calls.length === 1);
    finishCodex('{}');

    let completed: { state?: string; result?: DigestResponse } | null = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const statusResponse = await GET(new NextRequest(
        `http://localhost/api/coach/chart-digest?jobId=${first.jobId}`,
      ));
      completed = await statusResponse.json() as { state?: string; result?: DigestResponse };
      if (completed.state === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    expect(completed).toMatchObject({
      state: 'completed',
      result: { schemaVersion: 3, generatedBy: 'codex' },
    });
    expect(mockRunCodexAnalysis).toHaveBeenCalledTimes(1);
  });
});
