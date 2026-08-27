import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const checks: Record<string, 'ok' | 'missing' | 'error'> = {
    blob: 'missing',
    finmind: 'missing',
    cronSecret: 'missing',
    quotes: 'missing',
  };

  // 1. Check env vars
  // （2026-06-13：EODHD 不續訂 — 移除 env 檢查，token 存在但 401 只會誤報 ok）
  if (process.env.BLOB_READ_WRITE_TOKEN) checks.blob = 'ok';
  if (process.env.FINMIND_API_TOKEN) checks.finmind = 'ok';
  if (process.env.CRON_SECRET) checks.cronSecret = 'ok';

  // 2. Actually test Blob connectivity if token exists
  if (checks.blob === 'ok') {
    try {
      const { list } = await import('@vercel/blob');
      await list({ prefix: 'scans/', limit: 1 });
    } catch {
      checks.blob = 'error';
    }
  }

  // 3. User-facing quote invariant. Infrastructure green alone is insufficient:
  // the browser surfaces can still disagree while Blob/env checks pass.
  try {
    const proto = req.headers.get('x-forwarded-proto') ?? 'http';
    const host = req.headers.get('host') ?? 'localhost:3000';
    const response = await fetch(`${proto}://${host}/api/health/quotes`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
    checks.quotes = response.ok ? 'ok' : 'error';
  } catch {
    checks.quotes = 'error';
  }

  const allOk = Object.values(checks).every(v => v === 'ok');

  return NextResponse.json({
    status: allOk ? 'healthy' : 'degraded',
    scope: 'infrastructure',
    note: '此端點同時檢查部署環境、Blob 與使用者實際行情出口；市場完整度與外部依賴另見子端點。',
    dataHealthEndpoints: ['/api/health/quotes', '/api/health/data', '/api/health/dependencies'],
    env: process.env.VERCEL ? 'vercel' : 'local',
    checks,
  }, { status: allOk ? 200 : 503 });
}
