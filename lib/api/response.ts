/**
 * Standardized API response helpers.
 *
 * All API routes should use these helpers to ensure consistent
 * response shapes across the application:
 *
 *   Success: { success: true, data: T }
 *   Error:   { success: false, error: string }
 *
 * Usage:
 *   return apiOk({ candles, ticker });
 *   return apiError('找不到股票資料', 404);
 *   return apiValidationError(zodResult.error);
 */

import { NextResponse } from 'next/server';
import type { ZodError } from 'zod';

interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

interface ApiErrorResponse {
  success: false;
  error: string;
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

/** Return a success response — spreads data at top level for backwards compatibility */
export function apiOk<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: true, ...(data as object) }, init);
}

/** Return an error response — uses { error } for backwards compatibility */
export function apiError(
  message: string,
  status = 500,
  headers?: Record<string, string>,
): NextResponse {
  return NextResponse.json(
    { error: message },
    { status, headers },
  );
}

/** Return a validation error from Zod */
export function apiValidationError(
  error: ZodError,
): NextResponse {
  const message = error.issues[0]?.message ?? '輸入格式錯誤';
  return apiError(message, 400);
}

/** Return a rate limit error */
export function apiRateLimited(retryAfterMs: number): NextResponse {
  return apiError('請求過於頻繁，請稍後再試', 429, {
    'Retry-After': String(Math.ceil(retryAfterMs / 1000)),
    'X-RateLimit-Remaining': '0',
  });
}
