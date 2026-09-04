/**
 * Same-origin guard for mutation endpoints.
 *
 * Browser fetch 對同源請求自動帶 Origin header，可以用來區分：
 *   ✅ 我們自己的 UI 透過 fetch 呼叫（Origin = self）
 *   ❌ 匿名 curl / 跨站攻擊（Origin 缺漏或 cross-origin）
 *
 * 不阻擋 server-side cron（無 Origin header）— 透過 checkCronAuth bearer token
 * 處理。同一個 endpoint 可同時接受兩種來源。
 *
 * 2026-05-08：原本 middleware 只 rate-limit、lib/auth.ts session 系統 dead code，
 *   POST /api/strategy/active 等任何匿名 curl 可改 active strategy 跑壞 cron。
 *   這個守門是 CSRF-style 補丁，不打壞既有 UI。
 *
 * 限制：
 *   - 無法區分「同站不同 user」（個人專案不需要）
 *   - 攻擊者在 browser 控制台發 fetch 仍通過（社交工程攻擊不擋）
 *   - 想要更強保護應上 Vercel Project Password Protection
 */

import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from './response';

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

function isLoopbackHost(host: string): boolean {
  try {
    const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '');
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

/**
 * 檢查請求是否來自同源 browser fetch。
 *
 * @returns NextResponse 表示拒絕；null 表示通過。
 *
 * 通過條件（任一）：
 *   1. Origin / Referer header 跟 host 同源（browser 同站 fetch）
 *   2. 帶有效 cron bearer token（server-side cron）
 *   3. dev 環境（NODE_ENV !== 'production'）— 方便 local 測試
 */
export function checkSameOriginOrCron(req: NextRequest): NextResponse | null {
  const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
  if (!isProd) return null; // dev 不擋，方便本地測試

  // Server-side cron 帶 bearer token：放行
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) return null;

  // Browser fetch 同源檢查
  const host = req.headers.get('host');
  const origin = req.headers.get('origin');
  const referer = req.headers.get('referer');

  if (!host) return apiError('Bad request: missing host', 400);

  // 接受 Origin（fetch 自動帶）OR Referer（form 提交帶）匹配 host
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      if (originHost === host) return null;
    } catch { /* fallthrough */ }
  }
  if (referer) {
    try {
      const refererHost = new URL(referer).host;
      if (refererHost === host) return null;
    } catch { /* fallthrough */ }
  }

  return apiError('Forbidden: same-origin or cron token required', 403);
}

/**
 * Guard for endpoints that can spend paid API quota, start expensive local work,
 * or mutate durable data.
 *
 * Production access is deliberately narrower than the legacy same-origin guard:
 *   1. local browser requests must be both loopback-hosted and same-origin;
 *   2. automation may use CRON_SECRET as a bearer token;
 *   3. operators may use ADMIN_SECRET / UPLOAD_SECRET headers.
 *
 * A public reverse tunnel therefore cannot turn an Origin header into authority.
 */
export function checkSensitiveMutationAuth(req: Request): NextResponse | null {
  const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
  if (!isProd) return null;

  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader?.startsWith('Bearer ')) {
    const supplied = authHeader.slice('Bearer '.length);
    if (safeEqual(supplied, cronSecret)) return null;
  }

  const adminSecret = process.env.ADMIN_SECRET;
  const suppliedAdmin = req.headers.get('x-admin-secret');
  if (adminSecret && suppliedAdmin && safeEqual(suppliedAdmin, adminSecret)) return null;

  const uploadSecret = process.env.UPLOAD_SECRET;
  const suppliedUpload = req.headers.get('x-upload-secret');
  if (uploadSecret && suppliedUpload && safeEqual(suppliedUpload, uploadSecret)) return null;

  const host = req.headers.get('host');
  if (!host) return apiError('Bad request: missing host', 400);
  if (!isLoopbackHost(host)) {
    return apiError('Unauthorized: sensitive mutations require a local browser or operator token', 401);
  }

  const origin = req.headers.get('origin');
  const referer = req.headers.get('referer');
  for (const candidate of [origin, referer]) {
    if (!candidate) continue;
    try {
      if (new URL(candidate).host === host) return null;
    } catch {
      // Try the other browser header, then reject below.
    }
  }

  return apiError('Forbidden: local same-origin request required', 403);
}
