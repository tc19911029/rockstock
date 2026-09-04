import { NextRequest } from 'next/server';
import { checkSameOriginOrCron, checkSensitiveMutationAuth } from '@/lib/api/sameOriginAuth';

describe('checkSameOriginOrCron', () => {
  const originalVercelEnv = process.env.VERCEL_ENV;
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.VERCEL_ENV = 'production';
    process.env.CRON_SECRET = 'test-cron-secret';
  });

  afterAll(() => {
    if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercelEnv;
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalCronSecret;
  });

  test('allows a same-origin browser request', () => {
    const request = new NextRequest('https://rockstock.example/api/portfolio/account', {
      method: 'POST',
      headers: { host: 'rockstock.example', origin: 'https://rockstock.example' },
    });
    expect(checkSameOriginOrCron(request)).toBeNull();
  });

  test('rejects a cross-origin or headerless production request', () => {
    const crossOrigin = new NextRequest('https://rockstock.example/api/portfolio/account', {
      method: 'POST',
      headers: { host: 'rockstock.example', origin: 'https://attacker.example' },
    });
    const headerless = new NextRequest('https://rockstock.example/api/portfolio/account', { method: 'POST' });
    expect(checkSameOriginOrCron(crossOrigin)?.status).toBe(403);
    expect(checkSameOriginOrCron(headerless)?.status).toBe(400);
  });

  test('allows the configured cron bearer token', () => {
    const request = new NextRequest('https://rockstock.example/api/portfolio/account', {
      method: 'POST',
      headers: { authorization: 'Bearer test-cron-secret' },
    });
    expect(checkSameOriginOrCron(request)).toBeNull();
  });
});

describe('checkSensitiveMutationAuth', () => {
  const originalVercelEnv = process.env.VERCEL_ENV;
  const originalCronSecret = process.env.CRON_SECRET;
  const originalAdminSecret = process.env.ADMIN_SECRET;

  beforeEach(() => {
    process.env.VERCEL_ENV = 'production';
    process.env.CRON_SECRET = 'test-cron-secret';
    process.env.ADMIN_SECRET = 'test-admin-secret';
  });

  afterAll(() => {
    if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercelEnv;
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalCronSecret;
    if (originalAdminSecret === undefined) delete process.env.ADMIN_SECRET;
    else process.env.ADMIN_SECRET = originalAdminSecret;
  });

  test('allows a loopback same-origin browser request', () => {
    const request = new NextRequest('http://localhost:3000/api/chat', {
      method: 'POST',
      headers: { host: 'localhost:3000', origin: 'http://localhost:3000' },
    });
    expect(checkSensitiveMutationAuth(request)).toBeNull();
  });

  test('rejects a public same-origin request', () => {
    const request = new NextRequest('https://random.trycloudflare.com/api/chat', {
      method: 'POST',
      headers: {
        host: 'random.trycloudflare.com',
        origin: 'https://random.trycloudflare.com',
      },
    });
    expect(checkSensitiveMutationAuth(request)?.status).toBe(401);
  });

  test('allows operator tokens from a public host', () => {
    const cronRequest = new NextRequest('https://rockstock.example/api/chat', {
      method: 'POST',
      headers: { authorization: 'Bearer test-cron-secret' },
    });
    const adminRequest = new NextRequest('https://rockstock.example/api/chat', {
      method: 'POST',
      headers: { 'x-admin-secret': 'test-admin-secret' },
    });
    expect(checkSensitiveMutationAuth(cronRequest)).toBeNull();
    expect(checkSensitiveMutationAuth(adminRequest)).toBeNull();
  });
});
