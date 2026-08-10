// 2026-05-08：Next.js 16 把 middleware 改名 proxy（功能不變）。
// 從 middleware.ts rename 過來，build warning 消除。
import { NextRequest, NextResponse } from 'next/server';
import { checkApiRateLimit } from '@/lib/rateLimit';

/** Extract client IP from request headers */
function getClientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  );
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Only rate-limit API routes
  if (!pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  // Skip cron routes (already protected by bearer token)
  if (pathname.startsWith('/api/cron/')) {
    return NextResponse.next();
  }

  const ip = getClientIp(req);

  const result = checkApiRateLimit(pathname, ip);

  if (!result.success) {
    return NextResponse.json(
      { error: '請求過於頻繁，請稍後再試' },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil((result.retryAfter ?? 1000) / 1000)),
          'X-RateLimit-Remaining': '0',
        },
      }
    );
  }

  const response = NextResponse.next();
  response.headers.set('X-RateLimit-Remaining', String(result.remaining));
  return response;
}

export const config = {
  matcher: '/api/:path*',
};
