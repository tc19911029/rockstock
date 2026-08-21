import { readJsonResponse } from '@/lib/api/clientResponse';

describe('readJsonResponse', () => {
  it('returns a successful JSON body', async () => {
    const response = new Response(JSON.stringify({ ok: true, value: 7 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    await expect(readJsonResponse<{ ok: boolean; value: number }>(response)).resolves.toEqual({
      ok: true,
      value: 7,
    });
  });

  it('uses the API error message for a JSON failure', async () => {
    const response = new Response(JSON.stringify({ error: '排行榜計算失敗' }), {
      status: 500,
      statusText: 'Internal Server Error',
    });

    await expect(readJsonResponse(response)).rejects.toThrow('排行榜計算失敗');
  });

  it('reports the HTTP failure instead of leaking a JSON.parse error', async () => {
    const response = new Response('Internal Server Error', {
      status: 500,
      statusText: 'Internal Server Error',
    });

    await expect(readJsonResponse(response)).rejects.toThrow(
      'HTTP 500 Internal Server Error，回應不是 JSON：Internal Server Error',
    );
  });

  it('describes an empty non-JSON response', async () => {
    const response = new Response('', { status: 503, statusText: 'Service Unavailable' });

    await expect(readJsonResponse(response)).rejects.toThrow(
      'HTTP 503 Service Unavailable，回應不是 JSON：伺服器沒有回傳內容',
    );
  });
});
